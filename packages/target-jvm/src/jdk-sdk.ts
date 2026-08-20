import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { digestArtifactPath } from "@native-typescript/core";
import type {
  ArtifactActionInputArgument,
  ArtifactDefinition,
} from "@native-typescript/core";

/**
 * The resolved JDK an application build compiles and links against.
 *
 * jni.h and jni_md.h enter compilation as directory artifacts; libjvm
 * enters the LINK as a file artifact passed positionally, because it lives
 * outside the default linker search path and a `-L` path may not enter a
 * plan. At run time the dynamic loader resolves the recorded soname, so the
 * runner supplies `libraryPath` (lib/server) via LD_LIBRARY_PATH — a
 * runtime input, exactly like the classpath.
 */
export interface JdkSdk {
  readonly javaHome: string;
  readonly libraryPath: string;
  readonly artifacts: readonly ArtifactDefinition[];
  readonly sourcePaths: Readonly<Record<string, string>>;
  readonly compileArguments: readonly ArtifactActionInputArgument[];
  readonly libjvmArtifactId: string;
}

export const jdkArtifactIds = Object.freeze({
  include: "sdk/jdk-include",
  includePlatform: "sdk/jdk-include-linux",
  libjvm: "sdk/jdk-libjvm",
});

/** JAVA_HOME when set, else the home the `java` on PATH reports. */
export function discoverJavaHome(): string | null {
  const fromEnvironment = process.env["JAVA_HOME"];
  if (
    fromEnvironment !== undefined &&
    existsSync(join(fromEnvironment, "include/jni.h"))
  ) {
    return fromEnvironment;
  }
  const settings = spawnSync(
    "sh",
    ["-c", "java -XshowSettings:properties -version 2>&1 >/dev/null"],
    { encoding: "utf8" },
  );
  const match = settings.stdout?.match(/java\.home = (.+)/u);
  if (match == null) return null;
  const home = match[1]!.trim();
  return existsSync(join(home, "include/jni.h")) ? home : null;
}

export async function resolveJdkSdk(input: {
  readonly javaHome: string;
  readonly target: string;
}): Promise<JdkSdk> {
  const includeRoot = join(input.javaHome, "include");
  const includePlatform = join(includeRoot, "linux");
  const libraryPath = join(input.javaHome, "lib/server");
  const libjvmPath = join(libraryPath, "libjvm.so");
  if (!existsSync(libjvmPath)) {
    throw new Error(`The JDK at ${input.javaHome} ships no lib/server/libjvm.so`);
  }

  function directoryArtifact(
    id: string,
    digest: string,
    fileName: string,
    logicalPath: string,
  ): ArtifactDefinition {
    return Object.freeze({
      id,
      kind: "sdk",
      entryType: "directory",
      mediaType: "inode/directory",
      target: input.target,
      domain: "target",
      cache: "none",
      origin: Object.freeze({ kind: "source", digest, fileName, logicalPath }),
    });
  }

  const [includeDigest, platformDigest, libjvmDigest] = await Promise.all([
    digestArtifactPath(includeRoot, "directory"),
    digestArtifactPath(includePlatform, "directory"),
    digestArtifactPath(libjvmPath, "file"),
  ]);
  const include = directoryArtifact(
    jdkArtifactIds.include,
    includeDigest.digest,
    "jdk-include",
    "jdk/include",
  );
  const platform = directoryArtifact(
    jdkArtifactIds.includePlatform,
    platformDigest.digest,
    "jdk-include-linux",
    "jdk/include/linux",
  );
  const libjvm: ArtifactDefinition = Object.freeze({
    id: jdkArtifactIds.libjvm,
    /* A prebuilt shared library is a native binary the linker consumes;
     * `sdk` is reserved for directory trees. */
    kind: "native-object",
    entryType: "file",
    mediaType: "application/x-sharedlib",
    target: input.target,
    domain: "target",
    cache: "none",
    origin: Object.freeze({
      kind: "source",
      digest: libjvmDigest.digest,
      fileName: "libjvm.so",
      logicalPath: "jdk/lib/server/libjvm.so",
    }),
  });
  return Object.freeze({
    javaHome: input.javaHome,
    libraryPath,
    artifacts: Object.freeze([include, platform, libjvm]),
    sourcePaths: Object.freeze({
      [jdkArtifactIds.include]: includeRoot,
      [jdkArtifactIds.includePlatform]: includePlatform,
      [jdkArtifactIds.libjvm]: libjvmPath,
    }),
    compileArguments: Object.freeze([
      Object.freeze({ kind: "literal" as const, value: "-I" }),
      Object.freeze({
        kind: "input-path" as const,
        artifact: jdkArtifactIds.include,
      }),
      Object.freeze({ kind: "literal" as const, value: "-I" }),
      Object.freeze({
        kind: "input-path" as const,
        artifact: jdkArtifactIds.includePlatform,
      }),
    ]),
    libjvmArtifactId: jdkArtifactIds.libjvm,
  });
}
