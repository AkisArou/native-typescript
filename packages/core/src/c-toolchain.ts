import type {
  ArtifactActionArgument,
  ArtifactActionDefinition,
  ArtifactDefinition,
} from "./artifact-graph.ts";

export interface CObjectCompilationPlan {
  readonly artifact: ArtifactDefinition;
  readonly action: ArtifactActionDefinition;
}

export interface ArtifactInputPath {
  readonly artifact: string;
  readonly path?: string;
}

export function planCObjectCompilation(input: {
  readonly actionId: string;
  readonly artifactId: string;
  readonly artifactFileName: string;
  readonly source: ArtifactInputPath;
  readonly arguments: readonly ArtifactActionArgument[];
  readonly tool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
  readonly deterministic: boolean;
  readonly cacheable: boolean;
}): CObjectCompilationPlan {
  if (input.arguments.some(({ kind }) => kind === "output-path")) {
    throw new Error("C object compiler arguments cannot predeclare output paths");
  }
  const arguments_: ArtifactActionArgument[] = [...input.arguments];
  /* A C compile reads headers no graph declares. Recording them is what lets
   * its result be cached at all: the entry is reused only when every file the
   * compiler opened is still byte-for-byte what it was. */
  if (input.cacheable) {
    arguments_.push(
      { kind: "literal", value: "-MD" },
      { kind: "literal", value: "-MF" },
      { kind: "dependency-path" },
    );
  }
  arguments_.push(
    { kind: "literal", value: "-c" },
    { kind: "input-path", ...input.source },
    { kind: "literal", value: "-o" },
    { kind: "output-path", artifact: input.artifactId },
  );

  return Object.freeze({
    artifact: Object.freeze({
      id: input.artifactId,
      kind: "native-object",
      entryType: "file",
      mediaType: "application/x-object",
      target: input.target,
      domain: "target",
      cache: input.cacheable ? "local" : "none",
      origin: Object.freeze({
        kind: "action",
        action: input.actionId,
        fileName: input.artifactFileName,
      }),
    }),
    action: Object.freeze({
      id: input.actionId,
      implementation: Object.freeze({
        id: "native-typescript/clang-c-object",
        version: "1",
      }),
      tool: Object.freeze({ ...input.tool }),
      arguments: Object.freeze(arguments_.map((argument) => Object.freeze(argument))),
      environment: Object.freeze([]),
      inputs: Object.freeze([...new Set([
        input.source.artifact,
        ...input.arguments.flatMap((argument) =>
          argument.kind === "input-path" ? [argument.artifact] : []
        ),
      ])]),
      outputs: Object.freeze([input.artifactId]),
      standardOutput: Object.freeze({ kind: "report" }),
      workingDirectory: "isolated",
      network: "denied",
      executionPlatform: input.executionPlatform,
      target: input.target,
      deterministic: input.deterministic,
      cacheable: input.cacheable,
      ...(input.cacheable ? { recordsDependencies: true } : {}),
    }),
  });
}
