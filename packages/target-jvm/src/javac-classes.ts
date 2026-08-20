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
}): JavacClassesPlan {
  if (input.files.length === 0) {
    throw new Error("A Java compilation names at least one source file");
  }
  const sources: ArtifactDefinition = Object.freeze({
    id: javacArtifactIds.sources,
    kind: "source-tree",
    entryType: "directory",
    mediaType: "inode/directory",
    target: input.target,
    domain: "target",
    cache: "exportable",
    origin: Object.freeze({
      kind: "source",
      digest: input.sourcesDigest,
      fileName: "jvm-java-sources",
      logicalPath: input.logicalPath,
    }),
  });
  const classes: ArtifactDefinition = Object.freeze({
    id: javacArtifactIds.classes,
    kind: "source-tree",
    entryType: "directory",
    mediaType: "inode/directory",
    target: input.target,
    domain: "target",
    cache: "exportable",
    origin: Object.freeze({
      kind: "action",
      action: "compile/jvm-java/classes",
      fileName: "jvm-java-classes",
    }),
  });
  return Object.freeze({
    sources,
    classes,
    action: Object.freeze({
      id: "compile/jvm-java/classes",
      implementation: Object.freeze({
        id: "native-typescript/javac-classes",
        version: "1",
      }),
      tool: Object.freeze({ ...input.tool }),
      arguments: Object.freeze([
        Object.freeze({ kind: "literal" as const, value: "-d" }),
        Object.freeze({
          kind: "output-path" as const,
          artifact: javacArtifactIds.classes,
        }),
        ...input.files.map((file) =>
          Object.freeze({
            kind: "input-path" as const,
            artifact: javacArtifactIds.sources,
            path: file,
          })
        ),
      ]),
      environment: Object.freeze([]),
      inputs: Object.freeze([javacArtifactIds.sources]),
      outputs: Object.freeze([javacArtifactIds.classes]),
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
