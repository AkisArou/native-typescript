import type {
  ArtifactActionDefinition,
  ArtifactDefinition,
} from "@native-typescript/core";

export const javacArtifactIds = Object.freeze({
  sources: "source/jvm-java",
  classes: "generated/jvm-java-classes",
});

export interface JavacClassesPlan {
  readonly sources: ArtifactDefinition;
  readonly classes: ArtifactDefinition;
  readonly action: ArtifactActionDefinition;
}

/**
 * Plans compilation of the application's Java sources into a class
 * directory, as an ordinary artifact-graph action: javac is an
 * authoritative platform tool the planner orchestrates, never
 * reimplements. Given one JDK and the same sources, its output is
 * deterministic, so the action caches.
 */
export function planJavacClasses(input: {
  /** Digest of the Java source tree. */
  readonly sourcesDigest: string;
  /** Files to compile, relative to the source tree root. */
  readonly files: readonly string[];
  readonly logicalPath: string;
  readonly tool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
  /** Distinguishes a second compilation in the same build (generated
   * subclass sources beside the project's own); suffixes every id so the
   * two never collide. Empty for the primary compilation. */
  readonly variant?: string;
  /** A class directory the sources compile against — the id of an
   * artifact the caller adds to the graph. The generated-subclass
   * compilation names the primary compilation's output here. */
  readonly classpath?: { readonly artifact: string };
}): JavacClassesPlan {
  if (input.files.length === 0) {
    throw new Error("A Java compilation names at least one source file");
  }
  const variant = input.variant ?? "";
  const sourcesId = `${javacArtifactIds.sources}${variant}`;
  const classesId = `generated/jvm-java${variant}-classes`;
  const actionId = `compile/jvm-java${variant}/classes`;
  const sources: ArtifactDefinition = Object.freeze({
    id: sourcesId,
    kind: "source-tree",
    entryType: "directory",
    mediaType: "inode/directory",
    target: input.target,
    domain: "target",
    cache: "exportable",
    origin: Object.freeze({
      kind: "source",
      digest: input.sourcesDigest,
      fileName: `jvm-java${variant}-sources`,
      logicalPath: input.logicalPath,
    }),
  });
  const classes: ArtifactDefinition = Object.freeze({
    id: classesId,
    kind: "source-tree",
    entryType: "directory",
    mediaType: "inode/directory",
    target: input.target,
    domain: "target",
    cache: "exportable",
    origin: Object.freeze({
      kind: "action",
      action: actionId,
      fileName: `jvm-java${variant}-classes`,
    }),
  });
  return Object.freeze({
    sources,
    classes,
    action: Object.freeze({
      id: actionId,
      implementation: Object.freeze({
        id: "native-typescript/javac-classes",
        version: "2",
      }),
      tool: Object.freeze({ ...input.tool }),
      arguments: Object.freeze([
        ...(input.classpath === undefined
          ? []
          : [
              Object.freeze({ kind: "literal" as const, value: "-cp" }),
              Object.freeze({
                kind: "input-path" as const,
                artifact: input.classpath.artifact,
              }),
            ]),
        Object.freeze({ kind: "literal" as const, value: "-d" }),
        Object.freeze({
          kind: "output-path" as const,
          artifact: classesId,
        }),
        ...input.files.map((file) =>
          Object.freeze({
            kind: "input-path" as const,
            artifact: sourcesId,
            path: file,
          })
        ),
      ]),
      environment: Object.freeze([]),
      inputs: Object.freeze([
        sourcesId,
        ...(input.classpath === undefined ? [] : [input.classpath.artifact]),
      ]),
      outputs: Object.freeze([classesId]),
      standardOutput: Object.freeze({ kind: "report" as const }),
      workingDirectory: "isolated",
      network: "denied",
      executionPlatform: input.executionPlatform,
      target: input.target,
      deterministic: true,
      cacheable: true,
    }),
  });
}
