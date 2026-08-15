import type {
  ArtifactActionArgument,
  ArtifactActionDefinition,
  ArtifactDefinition,
  ArtifactActionInputArgument,
} from "@native-typescript/core";
import type { ClangAbiProbe } from "./model.ts";

export interface ClangAbiProbeArtifactPlan {
  readonly source: ArtifactDefinition;
  readonly rawAst: ArtifactDefinition;
  readonly action: ArtifactActionDefinition;
}

export function planClangAbiProbe(input: {
  readonly probe: ClangAbiProbe;
  readonly sourceArtifactId: string;
  readonly rawAstArtifactId: string;
  readonly actionId: string;
  readonly logicalPath: string;
  readonly arguments: readonly ArtifactActionInputArgument[];
  readonly tool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
}): ClangAbiProbeArtifactPlan {
  const source: ArtifactDefinition = Object.freeze({
    id: input.sourceArtifactId,
    kind: "generated-source",
    entryType: "file",
    mediaType: "text/x-c",
    target: input.target,
    domain: "target",
    cache: "exportable",
    origin: Object.freeze({
      kind: "source",
      digest: input.probe.sourceDigest,
      fileName: "clang-abi-probe.c",
      logicalPath: input.logicalPath,
    }),
  });
  const rawAst: ArtifactDefinition = Object.freeze({
    id: input.rawAstArtifactId,
    kind: "metadata",
    entryType: "file",
    mediaType: "application/vnd.native-typescript.clang-abi-ast+json",
    target: input.target,
    domain: "target",
    cache: "none",
    origin: Object.freeze({
      kind: "action",
      action: input.actionId,
      fileName: "clang-abi-ast.json",
    }),
  });
  const sdkInputs = input.arguments.flatMap((argument) =>
    argument.kind === "input-path" ? [argument.artifact] : []
  );
  const arguments_: ArtifactActionArgument[] = [
    { kind: "literal", value: "-std=gnu11" },
    { kind: "literal", value: "-Wall" },
    { kind: "literal", value: "-Wextra" },
    { kind: "literal", value: "-Werror" },
    { kind: "literal", value: "-fsyntax-only" },
    { kind: "literal", value: "-Xclang" },
    { kind: "literal", value: "-ast-dump=json" },
    { kind: "literal", value: "-Xclang" },
    { kind: "literal", value: "-ast-dump-filter=nts_abi_probe_snapshot" },
    ...input.arguments,
    { kind: "literal", value: "-x" },
    { kind: "literal", value: "c" },
    { kind: "input-path", artifact: input.sourceArtifactId },
  ];
  const action: ArtifactActionDefinition = Object.freeze({
    id: input.actionId,
    implementation: Object.freeze({
      id: "native-typescript/clang-abi-probe",
      version: "1",
    }),
    tool: Object.freeze({ ...input.tool }),
    arguments: Object.freeze(arguments_.map((argument) => Object.freeze(argument))),
    environment: Object.freeze([]),
    inputs: Object.freeze([...new Set([input.sourceArtifactId, ...sdkInputs])]),
    outputs: Object.freeze([input.rawAstArtifactId]),
    standardOutput: Object.freeze({
      kind: "artifact",
      artifact: input.rawAstArtifactId,
    }),
    workingDirectory: "isolated",
    network: "denied",
    executionPlatform: input.executionPlatform,
    target: input.target,
    deterministic: false,
    cacheable: false,
  });
  return Object.freeze({ source, rawAst, action });
}
