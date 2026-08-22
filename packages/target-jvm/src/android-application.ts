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

import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
  readJarClassSources,
  readZipEntries,
  requiredJvmAncestry,
} from "@native-typescript/bindgen-jvm";
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
  /* The platform classes the selection names are read out of android.jar
   * and written where ingestion can see them. They are INPUTS to the
   * build and not part of the package: the device has them already, and
   * an APK carrying android/app/Activity.class would be refused. */
  const platformClassesRoot = join(input.scratch, "platform-classes");
  const jarEntries = readJarClassSources(
    readFileSync(input.androidJarPath),
    "android-sdk/android.jar",
  );
  /* What the selection names, PLUS the ancestry those classes need to be
   * themselves. Ingestion implies an ancestor it can see, but this decides
   * what it can see: an ancestor whose bytes were never pulled out of the
   * jar is not present-but-unselected, it is absent, and absence is
   * invisible to the guard inside ingestion. Without this a selection
   * naming TextView and not View projects TextView with an EXTERNAL
   * superclass and silently loses every inherited member. */
  const bytesByBinaryName = new Map<string, Uint8Array>();
  for (const entry of jarEntries) {
    bytesByBinaryName.set(
      entry.logicalPath
        .slice(entry.logicalPath.indexOf("!/") + 2)
        .replace(/\.class$/u, ""),
      entry.bytes,
    );
  }
  const named = project.classes.map(({ binaryName }) => binaryName);
  const ancestry = requiredJvmAncestry(
    (binaryName) => bytesByBinaryName.get(binaryName),
    named,
  );
  /* android.jar carries the superclass of every class it defines, so a
   * chain it cannot complete is an anomaly rather than a boundary — and
   * stopping quietly at one is exactly the silent ancestry loss implying
   * the chain exists to prevent. Named with WHO needed it, because the
   * selection never wrote that class and an error about a name absent
   * from the caller's input explains nothing on its own. */
  if (ancestry.unavailable.length > 0) {
    throw new Error(
      `The platform jar does not carry ${
        ancestry.unavailable
          .map(({ binaryName, superclass }) =>
            `${superclass}, required as the superclass of ${binaryName}`
          )
          .join("; ")
      }. An ancestor is not optional: without it the projected class loses ` +
        "every inherited member and the upcast that reaches them",
    );
  }
  const wanted = new Set([...named, ...ancestry.required]);
  const platformSources: { logicalPath: string; path: string }[] = [];
  for (const entry of jarEntries) {
    const binaryName = entry.logicalPath
      .slice(entry.logicalPath.indexOf("!/") + 2)
      .replace(/\.class$/u, "");
    if (!wanted.has(binaryName)) continue;
    const path = join(platformClassesRoot, `${binaryName}.class`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, entry.bytes);
    platformSources.push({
      logicalPath: `android-sdk/${binaryName}.class`,
      path,
    });
  }
  const missing = [...wanted].filter((binaryName) =>
    !platformSources.some(({ logicalPath }) =>
      logicalPath === `android-sdk/${binaryName}.class`
    )
  );
  if (missing.length > 0) {
    throw new Error(
      `The platform jar does not carry ${missing.join(", ")}; an Android ` +
        "selection names classes android.jar defines",
    );
  }
  const built = await buildJvmApplication({
    projectRoot: input.projectRoot,
    project: {
      ...project,
      classSources: [...(project.classSources ?? []), ...platformSources],
      javaClasspathJar: input.androidJarPath,
    },
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
  if (built.builtSubclassesPath === undefined) {
    throw new Error(
      "An Android package needs a generated Activity: the launcher " +
        "constructs a class, and that class is the subclass this build " +
        "generates",
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
  /* Every entry the APK carries, in the order the archive states them.
   * The manifest and the resource table come out of aapt2's archive, the
   * dex out of d8's, and the library is copied straight in. */
  const apkEntries = [
    "AndroidManifest.xml",
    "resources.arsc",
    "classes.dex",
    libraryEntry,
  ];
  const stagingRoot = join(input.scratch, "staging");
  const stagedLibrary = join(stagingRoot, libraryEntry);
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
  const d8JarId = "sdk/android-d8-jar";
  const stagingId = "source/android/apk-staging";
  const apksignerJarId = "sdk/android-apksigner-jar";
  const primaryClassesId = "source/android/classes-primary";
  const subclassClassesId = "source/android/classes-subclass";
  const androidJarId = "sdk/android-platform-jar";
  /* An Android application need not ship Java of its own: its only
   * classes may be the generated Activity, with everything else coming
   * from the platform. */
  const primaryClassesPath = built.builtClassesPath;
  const [
    manifest,
    keystore,
    subclassClasses,
    androidJar,
    d8Jar,
    apksignerJar,
  ] =
    await Promise.all([
      sourceFile(
        ids.manifest,
        manifestPath,
        "text/xml",
        "AndroidManifest.xml",
        "generated/android/AndroidManifest.xml",
      ),

      sourceFile(
        ids.keystore,
        input.keystore.path,
        "application/octet-stream",
        "signing.jks",
        "android/signing.jks",
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
      /* The build-tools jars, run through the JDK rather than through
       * their shell wrappers: a wrapper needs `java` on PATH, and a
       * sandboxed action has no PATH to give it. */
      sourceFile(
        d8JarId,
        join(input.tools.d8, "../lib/d8.jar"),
        "application/java-archive",
        "d8.jar",
        "android-sdk/d8.jar",
      ),
      sourceFile(
        apksignerJarId,
        join(input.tools.apksigner, "../lib/apksigner.jar"),
        "application/java-archive",
        "apksigner.jar",
        "android-sdk/apksigner.jar",
      ),
    ]);

  const primaryClasses = primaryClassesPath === undefined
    ? undefined
    : await sourceTree(
        primaryClassesId,
        primaryClassesPath,
        "android-classes-primary",
        "generated/android/classes-primary",
      );
  const plan = planAndroidApk({
    target,
    executionPlatform,
    libraryEntry,
    classes: [
      ...(primaryClassesPath === undefined
        ? []
        : classFiles(primaryClassesPath).map((path) => ({
            artifact: primaryClassesId,
            path,
          }))),
      ...classFiles(built.builtSubclassesPath).map((path) => ({
        artifact: subclassClassesId,
        path,
      })),
    ],
    androidJarArtifact: androidJarId,
    minSdk: project.android.minSdk,
    tools: {
      aapt2: await toolIdentity("tool/aapt2", input.tools.aapt2),
      java: await toolIdentity("tool/java", join(input.javaHome, "bin/java")),
      jar: await toolIdentity("tool/jar", join(input.javaHome, "bin/jar")),
      zipalign: await toolIdentity("tool/zipalign", input.tools.zipalign),
    },
    jars: { d8: d8JarId, apksigner: apksignerJarId },
    stagingArtifact: stagingId,
    entries: apkEntries,
    keyAlias: input.keystore.alias,
    keyPassword: input.keystore.password,
  });

  const commonInputs = {
    tools: {
      "tool/aapt2": { path: input.tools.aapt2 },
      "tool/java": { path: join(input.javaHome, "bin/java") },
      "tool/jar": { path: join(input.javaHome, "bin/jar") },
      "tool/zipalign": { path: input.tools.zipalign },
    },
    sandbox: { kind: "bubblewrap" as const, path: input.tools.sandbox },
    ...(input.cachePath === undefined
      ? {}
      : { cache: { kind: "local" as const, path: input.cachePath } }),
  };
  const sharedSources = {
    [ids.manifest]: manifestPath,
    [ids.keystore]: input.keystore.path,
    ...(primaryClassesPath === undefined
      ? {}
      : { [primaryClassesId]: primaryClassesPath }),
    [subclassClassesId]: built.builtSubclassesPath,
    [androidJarId]: input.androidJarPath,
    [d8JarId]: join(input.tools.d8, "../lib/d8.jar"),
    [apksignerJarId]: join(input.tools.apksigner, "../lib/apksigner.jar"),
  };
  const compiled = await executeArtifactGraph(
    defineArtifactGraph({
      artifacts: [
        manifest,
        ...(primaryClasses === undefined ? [] : [primaryClasses]),
        subclassClasses,
        androidJar,
        d8Jar,
        ...plan.compile.artifacts,
      ],
      actions: [...plan.compile.actions],
    }),
    {
      buildRoot: join(input.scratch, "compile"),
      sourcePaths: sharedSources,
      ...commonInputs,
    },
  );
  /* Stage what the two archives carry. The same ZIP reader that ingests
   * jars and jmods reads them, so packaging gains no tool for a job this
   * build already knows how to do. */
  function stageEntries(archivePath: string, wanted: readonly string[]): void {
    const entries = readZipEntries(readFileSync(archivePath), archivePath);
    for (const name of wanted) {
      const entry = entries.find((candidate) => candidate.name === name);
      if (entry === undefined) {
        throw new Error(`${archivePath} carries no ${name}`);
      }
      const destination = join(stagingRoot, name);
      mkdirSync(join(destination, ".."), { recursive: true });
      writeFileSync(destination, entry.bytes);
    }
  }
  const linkedArchive = compiled.artifacts.find(({ id }) => id === ids.linked);
  const dexArchive = compiled.artifacts.find(({ id }) => id === ids.classes);
  if (linkedArchive === undefined || dexArchive === undefined) {
    throw new Error("the Android compile phase produced no archives");
  }
  stageEntries(linkedArchive.path, ["AndroidManifest.xml", "resources.arsc"]);
  stageEntries(dexArchive.path, ["classes.dex"]);
  const staging = await sourceTree(
    stagingId,
    stagingRoot,
    "android-apk-staging",
    "generated/android/staging",
  );

  const report = await executeArtifactGraph(
    defineArtifactGraph({
      artifacts: [
        manifest,
        keystore,
        androidJar,
        apksignerJar,
        staging,
        ...plan.package.artifacts,
      ],
      actions: [...plan.package.actions],
    }),
    {
      buildRoot: join(input.scratch, "package"),
      sourcePaths: {
        ...sharedSources,
        [stagingId]: stagingRoot,
      },
      ...commonInputs,
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
