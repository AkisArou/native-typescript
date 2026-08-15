import type {
  ArtifactActionArgument,
  ArtifactActionDefinition,
  ArtifactDefinition,
  ArtifactActionInputArgument,
} from "@native-typescript/core";
import type { ClangFunctionProbe } from "./model.ts";

export interface ClangFunctionProbeArtifactPlan {
  readonly source: ArtifactDefinition;
  readonly evidence: ArtifactDefinition;
  readonly action: ArtifactActionDefinition;
}

export function planClangFunctionProbe(input: {
  readonly probe: ClangFunctionProbe;
  readonly sourceArtifactId: string;
  readonly evidenceArtifactId: string;
  readonly actionId: string;
  readonly logicalPath: string;
  readonly arguments: readonly ArtifactActionInputArgument[];
  readonly tool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
}): ClangFunctionProbeArtifactPlan {
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
      fileName: "clang-function-probe.c",
      logicalPath: input.logicalPath,
    }),
  });
  const evidence: ArtifactDefinition = Object.freeze({
    id: input.evidenceArtifactId,
    kind: "metadata",
    entryType: "file",
    mediaType: "application/vnd.native-typescript.clang-ast+json",
    target: input.target,
    domain: "target",
    cache: "none",
    origin: Object.freeze({
      kind: "action",
      action: input.actionId,
      fileName: "clang-function-evidence.json",
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
      id: "native-typescript/clang-function-probe",
      version: "1",
    }),
    tool: Object.freeze({ ...input.tool }),
    arguments: Object.freeze(arguments_.map((argument) => Object.freeze(argument))),
    environment: Object.freeze([]),
    inputs: Object.freeze([...new Set([input.sourceArtifactId, ...sdkInputs])]),
    outputs: Object.freeze([input.evidenceArtifactId]),
    standardOutput: Object.freeze({
      kind: "artifact",
      artifact: input.evidenceArtifactId,
    }),
    workingDirectory: "isolated",
    network: "denied",
    executionPlatform: input.executionPlatform,
    target: input.target,
    deterministic: false,
    cacheable: false,
  });
  return Object.freeze({ source, evidence, action });
}
