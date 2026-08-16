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
  readonly rawLlvm: ArtifactDefinition;
  readonly astAction: ArtifactActionDefinition;
  readonly llvmAction: ArtifactActionDefinition;
}

export function planClangAbiProbe(input: {
  readonly probe: ClangAbiProbe;
  readonly sourceArtifactId: string;
  readonly rawAstArtifactId: string;
  readonly rawLlvmArtifactId: string;
  readonly astActionId: string;
  readonly llvmActionId: string;
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
      action: input.astActionId,
      fileName: "clang-abi-ast.json",
    }),
  });
  const rawLlvm: ArtifactDefinition = Object.freeze({
    id: input.rawLlvmArtifactId,
    kind: "metadata",
    entryType: "file",
    mediaType: "text/x-llvm",
    target: input.target,
    domain: "target",
    cache: "none",
    origin: Object.freeze({
      kind: "action",
      action: input.llvmActionId,
      fileName: "clang-abi-classification.ll",
    }),
  });
  const sdkInputs = input.arguments.flatMap((argument) =>
    argument.kind === "input-path" ? [argument.artifact] : []
  );
  const arguments_: ArtifactActionArgument[] = [
    { kind: "literal", value: `--target=${input.target}` },
    { kind: "literal", value: "-std=gnu11" },
    { kind: "literal", value: "-Wall" },
    { kind: "literal", value: "-Wextra" },
    { kind: "literal", value: "-Werror" },
    /* Deprecation is a library's opinion about its own API, not a fact about
     * that API's ABI. A deprecated function has a layout and a calling
     * convention like any other, and the probe exists to read exactly those
     * from the real headers. Letting -Werror stop on one would mean an
     * application could not bind a working symbol because the vendor would
     * rather it did not — reported, at that, as Clang internals rather than as
     * anything the caller could act on. The generated declaration carries the
     * deprecation instead, which is where a caller can see it. */
    { kind: "literal", value: "-Wno-deprecated-declarations" },
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
  const astAction: ArtifactActionDefinition = Object.freeze({
    id: input.astActionId,
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
  const llvmAction: ArtifactActionDefinition = Object.freeze({
    id: input.llvmActionId,
    implementation: Object.freeze({
      id: "native-typescript/clang-abi-classification",
      version: "1",
    }),
    tool: Object.freeze({ ...input.tool }),
    arguments: Object.freeze([
      Object.freeze({ kind: "literal" as const, value: `--target=${input.target}` }),
      Object.freeze({ kind: "literal" as const, value: "-std=gnu11" }),
      Object.freeze({ kind: "literal" as const, value: "-O0" }),
      Object.freeze({ kind: "literal" as const, value: "-S" }),
      Object.freeze({ kind: "literal" as const, value: "-emit-llvm" }),
      ...input.arguments.map((argument) => Object.freeze(argument)),
      Object.freeze({ kind: "literal" as const, value: "-x" }),
      Object.freeze({ kind: "literal" as const, value: "c" }),
      Object.freeze({ kind: "input-path" as const, artifact: input.sourceArtifactId }),
      Object.freeze({ kind: "literal" as const, value: "-o" }),
      Object.freeze({ kind: "output-path" as const, artifact: input.rawLlvmArtifactId }),
    ]),
    environment: Object.freeze([]),
    inputs: Object.freeze([...new Set([input.sourceArtifactId, ...sdkInputs])]),
    outputs: Object.freeze([input.rawLlvmArtifactId]),
    standardOutput: Object.freeze({ kind: "report" as const }),
    workingDirectory: "isolated",
    network: "denied",
    executionPlatform: input.executionPlatform,
    target: input.target,
    deterministic: false,
    cacheable: false,
  });
  return Object.freeze({ source, rawAst, rawLlvm, astAction, llvmAction });
}
