/**
 * Builds the Android product end to end: the hosted library, then the APK
 * around it.
 *
 * The library half is not re-implemented here — it is the SAME
 * `buildJvmApplication` the desktop lane proves, asked for an Android
 * triple. Packaging is a second graph over what that produced, which is
 * why the built .so, the compiled class directories and the platform
 * android.jar all re-enter as source artifacts carrying their digests:
 * the packaging graph is a function of bytes it can name, exactly as the
 * JDK's libjvm enters the desktop link.
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { copyFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  defineArtifactGraph,
  digestArtifactPath,
  executeArtifactGraph,
  resolveSourceArtifact,
} from "@native-typescript/core";
import type { ArtifactDefinition } from "@native-typescript/core";
import {
  androidApkArtifactIds,
  planAndroidApk,
} from "./android-apk.ts";
import { generateAndroidManifest } from "./android-manifest.ts";
import { buildJvmApplication } from "./application-build.ts";
import type { JvmApplicationProject } from "./application-build.ts";

export interface AndroidApplicationProject extends JvmApplicationProject {
  readonly android: {
    readonly applicationId: string;
    /** The launcher activity's binary name — the generated bridge. */
    readonly activityBinaryName: string;
    readonly label: string;
    readonly minSdk: number;
    readonly targetSdk: number;
    /** The ABI directory the library is packaged under. */
    readonly abi: string;
  };
}

export interface AndroidApplicationBuildResult {
  readonly apkPath: string;
  readonly libraryPath: string;
  readonly manifestSource: string;
}

/** Every `.class` under a directory, as paths relative to it, sorted so
 * the dex action names the same list on every machine. */
function classFiles(root: string): string[] {
  const found: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".class")) found.push(relative(root, path));
    }
  }
  walk(root);
  return found.sort();
}

export async function buildAndroidApk(input: {
  readonly projectRoot: string;
  readonly project: AndroidApplicationProject;
  readonly scratch: string;
  readonly backend: "c" | "llvm";
  /** The HOST JDK: javac and jar are execution-platform tooling. */
  readonly javaHome: string;
  /** The platform jar the manifest links against and d8 desugars with. */
  readonly androidJarPath: string;
  /** A keystore to sign with; its bytes are an input, because a key is
   * not something a build may invent on each run. */
  readonly keystore: {
    readonly path: string;
    readonly alias: string;
    readonly password: string;
  };
  readonly tools: {
    /** The NDK wrapper for the target triple. */
    readonly clang: string;
    readonly node: string;
    readonly sandbox: string;
    readonly ar: string;
    readonly aapt2: string;
    readonly d8: string;
    readonly zipalign: string;
    readonly apksigner: string;
  };
  readonly cachePath?: string;
}): Promise<AndroidApplicationBuildResult> {
  const { project } = input;
  mkdirSync(input.scratch, { recursive: true });
  const built = await buildJvmApplication({
    projectRoot: input.projectRoot,
    project,
    scratch: join(input.scratch, "library"),
    backend: input.backend,
    product: "hosted-library",
    javaHome: input.javaHome,
    tools: {
      clang: input.tools.clang,
      node: input.tools.node,
      sandbox: input.tools.sandbox,
      ar: input.tools.ar,
    },
    ...(input.cachePath === undefined ? {} : { cachePath: input.cachePath }),
  });
  if (
    built.builtClassesPath === undefined ||
    built.builtSubclassesPath === undefined
  ) {
    throw new Error(
      "An Android package needs compiled classes: the project must ship " +
        "Java sources and a generated Activity subclass",
    );
  }

  const manifestSource = generateAndroidManifest({
    applicationId: project.android.applicationId,
    activityBinaryName: project.android.activityBinaryName,
    label: project.android.label,
    minSdk: project.android.minSdk,
    targetSdk: project.android.targetSdk,
  });
  const manifestPath = join(input.scratch, "AndroidManifest.xml");
  writeFileSync(manifestPath, manifestSource);

  /* The library is staged under the entry name it will carry inside the
   * APK, so the assembly names one path that is both its location in the
   * input tree and its name in the archive. */
  const libraryEntry = `lib/${project.android.abi}/lib${project.output}.so`;
  const libraryRoot = join(input.scratch, "native");
  const stagedLibrary = join(libraryRoot, libraryEntry);
  mkdirSync(join(stagedLibrary, ".."), { recursive: true });
  copyFileSync(built.productPath, stagedLibrary);

  const target = project.target.triple;
  const executionPlatform = project.target.executionPlatform;
  async function sourceFile(
    id: string,
    path: string,
    mediaType: string,
    fileName: string,
    logicalPath: string,
  ): Promise<ArtifactDefinition> {
    const resolved = await resolveSourceArtifact({
      id,
      path,
      kind: "native-object",
      entryType: "file",
      mediaType,
      target,
      domain: "target",
      cache: "none",
      fileName,
      logicalPath,
    });
    return resolved.artifact;
  }
  async function sourceTree(
    id: string,
    path: string,
    fileName: string,
    logicalPath: string,
  ): Promise<ArtifactDefinition> {
    const digest = await digestArtifactPath(path, "directory");
    return Object.freeze({
      id,
      kind: "source-tree",
      entryType: "directory",
      mediaType: "inode/directory",
      target,
      domain: "target",
      cache: "none",
      origin: Object.freeze({
        kind: "source",
        digest: digest.digest,
        fileName,
        logicalPath,
      }),
    });
  }

  const ids = androidApkArtifactIds;
  const primaryClassesId = "source/android/classes-primary";
  const subclassClassesId = "source/android/classes-subclass";
  const androidJarId = "sdk/android-platform-jar";
  const [manifest, library, keystore, primaryClasses, subclassClasses, androidJar] =
    await Promise.all([
      sourceFile(
        ids.manifest,
        manifestPath,
        "text/xml",
        "AndroidManifest.xml",
        "generated/android/AndroidManifest.xml",
      ),
      sourceTree(ids.library, libraryRoot, "android-native", "generated/android/native"),
      sourceFile(
        ids.keystore,
        input.keystore.path,
        "application/octet-stream",
        "signing.jks",
        "android/signing.jks",
      ),
      sourceTree(
        primaryClassesId,
        built.builtClassesPath,
        "android-classes-primary",
        "generated/android/classes-primary",
      ),
      sourceTree(
        subclassClassesId,
        built.builtSubclassesPath,
        "android-classes-subclass",
        "generated/android/classes-subclass",
      ),
      sourceFile(
        androidJarId,
        input.androidJarPath,
        "application/java-archive",
        "android.jar",
        "android-sdk/android.jar",
      ),
    ]);

  const plan = planAndroidApk({
    target,
    executionPlatform,
    libraryEntry,
    classes: [
      ...classFiles(built.builtClassesPath).map((path) => ({
        artifact: primaryClassesId,
        path,
      })),
      ...classFiles(built.builtSubclassesPath).map((path) => ({
        artifact: subclassClassesId,
        path,
      })),
    ],
    androidJarArtifact: androidJarId,
    minSdk: project.android.minSdk,
    tools: {
      aapt2: await toolIdentity("tool/aapt2", input.tools.aapt2),
      d8: await toolIdentity("tool/d8", input.tools.d8),
      jar: await toolIdentity("tool/jar", join(input.javaHome, "bin/jar")),
      zipalign: await toolIdentity("tool/zipalign", input.tools.zipalign),
      apksigner: await toolIdentity("tool/apksigner", input.tools.apksigner),
    },
    keyAlias: input.keystore.alias,
    keyPassword: input.keystore.password,
  });

  const report = await executeArtifactGraph(
    defineArtifactGraph({
      artifacts: [
        manifest,
        library,
        keystore,
        primaryClasses,
        subclassClasses,
        androidJar,
        ...plan.artifacts,
      ],
      actions: [...plan.actions],
    }),
    {
      buildRoot: join(input.scratch, "package"),
      sourcePaths: {
        [ids.manifest]: manifestPath,
        [ids.library]: libraryRoot,
        [ids.keystore]: input.keystore.path,
        [primaryClassesId]: built.builtClassesPath,
        [subclassClassesId]: built.builtSubclassesPath,
        [androidJarId]: input.androidJarPath,
      },
      tools: {
        "tool/aapt2": { path: input.tools.aapt2 },
        "tool/d8": { path: input.tools.d8 },
        "tool/jar": { path: join(input.javaHome, "bin/jar") },
        "tool/zipalign": { path: input.tools.zipalign },
        "tool/apksigner": { path: input.tools.apksigner },
      },
      sandbox: { kind: "bubblewrap", path: input.tools.sandbox },
      ...(input.cachePath === undefined
        ? {}
        : { cache: { kind: "local" as const, path: input.cachePath } }),
    },
  );
  const apk = report.artifacts.find(({ id }) => id === plan.productId);
  if (apk === undefined) throw new Error("The Android packaging produced no APK");
  return Object.freeze({
    apkPath: apk.path,
    libraryPath: built.productPath,
    manifestSource,
  });
}

async function toolIdentity(id: string, path: string) {
  const content = await digestArtifactPath(path, "file");
  return Object.freeze({ id, version: "1", digest: content.digest });
}
