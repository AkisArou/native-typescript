/**
 * Packages the Android product: the same hosted library the desktop lane
 * proves, plus the application's dexed classes and a generated manifest,
 * assembled into a signed APK.
 *
 * Every stage is an ordinary artifact-graph action over authoritative
 * platform tools — aapt2, d8, jar, zipalign, apksigner — orchestrated,
 * never reimplemented. That constraint is what shaped the pipeline: the
 * obvious spelling of "add the dex and the library to the APK" is
 * `jar --update`, which mutates a file in place and therefore cannot be
 * an action at all. `aapt2 link --output-to-dir` is what makes the honest
 * shape possible: the linked manifest lands as a FILE, so the APK is
 * CREATED once from named entries rather than edited, and every stage
 * stays a pure function from its inputs.
 *
 * The entries are named individually rather than swept from a directory,
 * which is what makes the zip deterministic: `jar` walks a directory in
 * readdir order, and an APK whose entry order depends on the filesystem
 * would be a different artifact on every machine.
 */

import { createHash } from "node:crypto";
import type {
  ArtifactActionDefinition,
  ArtifactDefinition,
} from "@native-typescript/core";

/** The zip timestamp every generated entry carries. A zip records
 * modification times, and a build that stamped "now" would produce a
 * different artifact every run — so the stamp is a constant, and the
 * artifact is a function of its inputs. */
const APK_ENTRY_DATE = "2000-01-01T00:00:00Z";

/** `zipalign -P 16`: the library is mapped straight out of the APK
 * (extractNativeLibs="false"), so its entry must start on a page
 * boundary, and this machine's system images are 16KB-page. The
 * manifest's declaration and this alignment are two halves of one
 * decision. */
const APK_PAGE_ALIGNMENT_KB = "16";

export const androidApkArtifactIds = Object.freeze({
  manifest: "source/android/manifest",
  linked: "generated/android/linked-resources",
  classes: "generated/android/dex",
  library: "source/android/native-library",
  keystore: "source/android/keystore",
  unaligned: "generated/android/apk-unaligned",
  aligned: "generated/android/apk-aligned",
  signed: "product/android/apk",
});

function action(
  definition: Omit<
    ArtifactActionDefinition,
    "environment" | "standardOutput" | "workingDirectory" | "network" |
      "deterministic" | "cacheable"
  > & { readonly cacheable?: boolean },
): ArtifactActionDefinition {
  return Object.freeze({
    ...definition,
    environment: Object.freeze([]),
    standardOutput: Object.freeze({ kind: "report" as const }),
    workingDirectory: "isolated" as const,
    network: "denied" as const,
    deterministic: true,
    cacheable: definition.cacheable ?? true,
  });
}

function fileArtifact(
  id: string,
  actionId: string,
  fileName: string,
  mediaType: string,
  target: string,
): ArtifactDefinition {
  return Object.freeze({
    id,
    kind: "native-object",
    entryType: "file",
    mediaType,
    target,
    domain: "target",
    cache: "exportable",
    origin: Object.freeze({ kind: "action", action: actionId, fileName }),
  });
}

export interface AndroidApkPlan {
  readonly artifacts: readonly ArtifactDefinition[];
  readonly actions: readonly ArtifactActionDefinition[];
  /** Everything up to and including the dex archive. */
  readonly compile: {
    readonly artifacts: readonly ArtifactDefinition[];
    readonly actions: readonly ArtifactActionDefinition[];
  };
  /** Everything after the dex entry has been staged. */
  readonly package: {
    readonly artifacts: readonly ArtifactDefinition[];
    readonly actions: readonly ArtifactActionDefinition[];
  };
  /** The id to ask the executor for. */
  readonly productId: string;
}

/**
 * Plans the whole packaging chain over artifacts the caller has already
 * defined: the generated manifest, the compiled class directories, the
 * built .so, the platform android.jar, and a signing keystore.
 */
export function planAndroidApk(input: {
  readonly target: string;
  readonly executionPlatform: string;
  /** Entry name inside the APK: `lib/x86_64/libfoo.so`. */
  readonly libraryEntry: string;
  /** Class files to dex, as paths inside their class-directory artifacts. */
  readonly classes: readonly {
    readonly artifact: string;
    readonly path: string;
  }[];
  readonly androidJarArtifact: string;
  readonly minSdk: number;
  readonly tools: {
    readonly aapt2: ArtifactActionDefinition["tool"];
    /* d8 and apksigner ship as shell wrappers around a jar, and a wrapper
     * needs `java` on PATH — which a sandboxed action does not have, and
     * must not be given, because a PATH naming a JDK is a physical path
     * entering a plan. So the TOOL is the JVM itself and the jar is an
     * ordinary input artifact. */
    readonly java: ArtifactActionDefinition["tool"];
    readonly jar: ArtifactActionDefinition["tool"];
    readonly zipalign: ArtifactActionDefinition["tool"];
  };
  /** Artifact ids for the two build-tools jars run through `java`. */
  readonly jars: {
    readonly d8: string;
    readonly apksigner: string;
  };
  /** A directory holding every entry the APK carries, staged by the build
   * out of the linked archive, the dex archive and the built library:
   * the assembly NAMES entries, and an entry inside an archive is not
   * one. */
  readonly stagingArtifact: string;
  /** The entry names, in the order the archive will carry them. */
  readonly entries: readonly string[];
  readonly keyAlias: string;
  readonly keyPassword: string;
}): AndroidApkPlan {
  if (input.classes.length === 0) {
    throw new Error("An Android package names at least one class to dex");
  }
  const ids = androidApkArtifactIds;
  const common = {
    executionPlatform: input.executionPlatform,
    target: input.target,
  };

  const linkActionId = "link/android/resources";
  /* aapt2 and d8 both write an ARCHIVE, or into a directory that already
   * exists — and an action's output directory does not exist when the
   * tool starts, because nothing pre-creates it. Both therefore produce
   * files here, and the build stages the entries it needs out of them
   * between graphs, exactly as it stages the library. That also keeps
   * every stage pure: the obvious `jar --update` would edit an archive in
   * place, which an artifact action cannot be. */
  const linked = fileArtifact(
    ids.linked,
    linkActionId,
    "base.apk",
    "application/vnd.android.package-archive",
    input.target,
  );
  const linkAction = action({
    id: linkActionId,
    implementation: Object.freeze({
      id: "native-typescript/android-aapt2-link",
      version: "1",
    }),
    tool: Object.freeze({ ...input.tools.aapt2 }),
    arguments: Object.freeze([
      Object.freeze({ kind: "literal" as const, value: "link" }),
      Object.freeze({ kind: "literal" as const, value: "--manifest" }),
      Object.freeze({
        kind: "input-path" as const,
        artifact: ids.manifest,
      }),
      Object.freeze({ kind: "literal" as const, value: "-I" }),
      Object.freeze({
        kind: "input-path" as const,
        artifact: input.androidJarArtifact,
      }),
      Object.freeze({ kind: "literal" as const, value: "-o" }),
      Object.freeze({ kind: "output-path" as const, artifact: ids.linked }),
    ]),
    inputs: Object.freeze([ids.manifest, input.androidJarArtifact]),
    outputs: Object.freeze([ids.linked]),
    ...common,
  });

  const dexActionId = "compile/android/dex";
  /* d8 writes either an ARCHIVE or an existing directory, and an action's
   * output directory does not exist when the tool starts — nothing
   * pre-creates it, and a tool that will not create its own output cannot
   * be handed one. So the dex stage produces the archive d8 offers, and
   * the entry inside it is staged for assembly the same way the library
   * is: by the build, between graphs, with a digest. */
  const dex = fileArtifact(
    ids.classes,
    dexActionId,
    "classes.zip",
    "application/zip",
    input.target,
  );
  /* The class files are named individually rather than handed a
   * directory, because d8 takes files and because a named list is the
   * same list on every machine. */
  const dexAction = action({
    id: dexActionId,
    implementation: Object.freeze({
      id: "native-typescript/android-d8",
      version: "1",
    }),
    tool: Object.freeze({ ...input.tools.java }),
    arguments: Object.freeze([
      Object.freeze({ kind: "literal" as const, value: "-cp" }),
      Object.freeze({ kind: "input-path" as const, artifact: input.jars.d8 }),
      Object.freeze({
        kind: "literal" as const,
        value: "com.android.tools.r8.D8",
      }),
      Object.freeze({ kind: "literal" as const, value: "--min-api" }),
      Object.freeze({ kind: "literal" as const, value: `${input.minSdk}` }),
      Object.freeze({ kind: "literal" as const, value: "--lib" }),
      Object.freeze({
        kind: "input-path" as const,
        artifact: input.androidJarArtifact,
      }),
      Object.freeze({ kind: "literal" as const, value: "--output" }),
      Object.freeze({ kind: "output-path" as const, artifact: ids.classes }),
      ...input.classes.map((entry) =>
        Object.freeze({
          kind: "input-path" as const,
          artifact: entry.artifact,
          path: entry.path,
        })
      ),
    ]),
    inputs: Object.freeze([
      ...new Set([
        input.jars.d8,
        input.androidJarArtifact,
        ...input.classes.map(({ artifact }) => artifact),
      ]),
    ]),
    outputs: Object.freeze([ids.classes]),
    ...common,
  });

  const assembleActionId = "package/android/apk-assemble";
  const unaligned = fileArtifact(
    ids.unaligned,
    assembleActionId,
    "app-unaligned.apk",
    "application/vnd.android.package-archive",
    input.target,
  );
  const assembleAction = action({
    id: assembleActionId,
    implementation: Object.freeze({
      id: "native-typescript/android-apk-assemble",
      version: "1",
    }),
    tool: Object.freeze({ ...input.tools.jar }),
    arguments: Object.freeze([
      Object.freeze({ kind: "literal" as const, value: "--create" }),
      Object.freeze({ kind: "literal" as const, value: "--file" }),
      Object.freeze({ kind: "output-path" as const, artifact: ids.unaligned }),
      /* No JAR manifest: an APK's metadata is its AndroidManifest, and a
       * META-INF/MANIFEST.MF here would be a second, meaningless one. */
      Object.freeze({ kind: "literal" as const, value: "--no-manifest" }),
      /* STORED, not deflated: a mapped library cannot be decompressed on
       * the fly, so extractNativeLibs="false" requires it — and only a
       * stored entry can be page-aligned at all. */
      Object.freeze({ kind: "literal" as const, value: "--no-compress" }),
      Object.freeze({ kind: "literal" as const, value: "--date" }),
      Object.freeze({ kind: "literal" as const, value: APK_ENTRY_DATE }),
      ...input.entries.flatMap((entry) => [
        Object.freeze({ kind: "literal" as const, value: "-C" }),
        Object.freeze({
          kind: "input-path" as const,
          artifact: input.stagingArtifact,
        }),
        Object.freeze({ kind: "literal" as const, value: entry }),
      ]),
    ]),
    inputs: Object.freeze([input.stagingArtifact]),
    outputs: Object.freeze([ids.unaligned]),
    ...common,
  });

  const alignActionId = "package/android/apk-align";
  const aligned = fileArtifact(
    ids.aligned,
    alignActionId,
    "app-aligned.apk",
    "application/vnd.android.package-archive",
    input.target,
  );
  const alignAction = action({
    id: alignActionId,
    implementation: Object.freeze({
      id: "native-typescript/android-zipalign",
      version: "1",
    }),
    tool: Object.freeze({ ...input.tools.zipalign }),
    arguments: Object.freeze([
      Object.freeze({ kind: "literal" as const, value: "-f" }),
      Object.freeze({ kind: "literal" as const, value: "-P" }),
      Object.freeze({
        kind: "literal" as const,
        value: APK_PAGE_ALIGNMENT_KB,
      }),
      Object.freeze({ kind: "literal" as const, value: "4" }),
      Object.freeze({ kind: "input-path" as const, artifact: ids.unaligned }),
      Object.freeze({ kind: "output-path" as const, artifact: ids.aligned }),
    ]),
    inputs: Object.freeze([ids.unaligned]),
    outputs: Object.freeze([ids.aligned]),
    ...common,
  });

  const signActionId = "package/android/apk-sign";
  const signed = fileArtifact(
    ids.signed,
    signActionId,
    "app.apk",
    "application/vnd.android.package-archive",
    input.target,
  );
  /* Signing is deterministic given the same key and the same input — two
   * signings of one APK are byte-identical — so it caches like any other
   * action rather than being re-run for a fresh signature. */
  const signAction = action({
    id: signActionId,
    implementation: Object.freeze({
      id: "native-typescript/android-apksigner",
      version: "1",
    }),
    tool: Object.freeze({ ...input.tools.java }),
    arguments: Object.freeze([
      Object.freeze({ kind: "literal" as const, value: "-jar" }),
      Object.freeze({
        kind: "input-path" as const,
        artifact: input.jars.apksigner,
      }),
      Object.freeze({ kind: "literal" as const, value: "sign" }),
      Object.freeze({ kind: "literal" as const, value: "--ks" }),
      Object.freeze({ kind: "input-path" as const, artifact: ids.keystore }),
      Object.freeze({ kind: "literal" as const, value: "--ks-pass" }),
      Object.freeze({
        kind: "literal" as const,
        value: `pass:${input.keyPassword}`,
      }),
      Object.freeze({ kind: "literal" as const, value: "--key-pass" }),
      Object.freeze({
        kind: "literal" as const,
        value: `pass:${input.keyPassword}`,
      }),
      Object.freeze({ kind: "literal" as const, value: "--ks-key-alias" }),
      Object.freeze({ kind: "literal" as const, value: input.keyAlias }),
      /* v1 is JAR signing, whose signature files would land INSIDE the
       * zip and undo the alignment this chain just established; v2 signs
       * the archive as bytes and leaves entry offsets alone. */
      Object.freeze({
        kind: "literal" as const,
        value: "--v1-signing-enabled",
      }),
      Object.freeze({ kind: "literal" as const, value: "false" }),
      Object.freeze({
        kind: "literal" as const,
        value: "--v2-signing-enabled",
      }),
      Object.freeze({ kind: "literal" as const, value: "true" }),
      /* v4 writes a SECOND file beside the APK — an .idsig for incremental
       * install — which this action never declared and the executor is
       * right to refuse. It is an install-time optimisation, not a
       * signature the package needs to be valid. */
      Object.freeze({
        kind: "literal" as const,
        value: "--v4-signing-enabled",
      }),
      Object.freeze({ kind: "literal" as const, value: "false" }),
      Object.freeze({ kind: "literal" as const, value: "--out" }),
      Object.freeze({ kind: "output-path" as const, artifact: ids.signed }),
      Object.freeze({ kind: "input-path" as const, artifact: ids.aligned }),
    ]),
    inputs: Object.freeze([ids.aligned, ids.keystore, input.jars.apksigner]),
    outputs: Object.freeze([ids.signed]),
    ...common,
  });

  return Object.freeze({
    artifacts: Object.freeze([linked, dex, unaligned, aligned, signed]),
    actions: Object.freeze([
      linkAction,
      dexAction,
      assembleAction,
      alignAction,
      signAction,
    ]),
    compile: Object.freeze({
      artifacts: Object.freeze([linked, dex]),
      actions: Object.freeze([linkAction, dexAction]),
    }),
    package: Object.freeze({
      artifacts: Object.freeze([unaligned, aligned, signed]),
      actions: Object.freeze([assembleAction, alignAction, signAction]),
    }),
    productId: ids.signed,
  });
}

/** The digest of a generated manifest, for its source artifact. */
export function manifestDigest(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}
