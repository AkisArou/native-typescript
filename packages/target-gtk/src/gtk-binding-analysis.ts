import { planClangAbiProbe } from "@native-typescript/bindgen-c";
import type {
  ClangAbiProbe,
  ClangAbiProbeArtifactPlan,
} from "@native-typescript/bindgen-c";
import type {
  ArtifactActionDefinition,
  ArtifactActionInputArgument,
  ArtifactDefinition,
} from "@native-typescript/core";
import { generateGirClangAbiProbe } from "./gir-clang.ts";
import type { GirSnapshot } from "./gir-model.ts";
import {
  planGtkBindingPackage,
  planGtkClangEvidenceNormalization,
} from "./gtk-binding-package.ts";
import type {
  GtkBindingPackageArtifactPlan,
  GtkBindingPackageRequest,
  GtkClangEvidenceArtifactPlan,
} from "./gtk-binding-package.ts";
import { generateGObjectAdapterSource } from "./gobject-adapter.ts";
import type { GObjectAdapterSource } from "./gobject-adapter.ts";

export const gtkBindingAnalysisArtifactIds = Object.freeze({
  probeSource: "source/gtk4/clang-abi-probe",
  rawAst: "metadata/gtk4/clang-abi-ast",
  rawLlvm: "metadata/gtk4/clang-abi-llvm",
  evidence: "metadata/gtk4/normalized-clang-abi-evidence",
  bindings: "package/gtk4/bindings",
});

export interface GtkBindingAnalysisPlan {
  readonly adapter: GObjectAdapterSource;
  readonly probe: ClangAbiProbe;
  readonly clang: ClangAbiProbeArtifactPlan;
  readonly evidence: GtkClangEvidenceArtifactPlan;
  readonly bindings: GtkBindingPackageArtifactPlan;
  readonly artifacts: readonly ArtifactDefinition[];
  readonly actions: readonly ArtifactActionDefinition[];
}

export function planGtkBindingAnalysis(input: {
  readonly snapshot: GirSnapshot;
  readonly request: GtkBindingPackageRequest;
  readonly snapshotArtifact: string;
  readonly requestArtifact: string;
  readonly generatorArtifact: string;
  readonly clangArguments: readonly ArtifactActionInputArgument[];
  readonly clangTool: ArtifactActionDefinition["tool"];
  readonly nodeTool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
}): GtkBindingAnalysisPlan {
  if (input.request.generation.target.triple !== input.target) {
    throw new Error(
      `GTK binding request targets ${input.request.generation.target.triple}, ` +
        `but analysis targets ${input.target}`,
    );
  }
  if (
    input.clangTool.id !== input.request.clang.toolId ||
    input.clangTool.version !== input.request.clang.version ||
    input.clangTool.digest !== input.request.clang.digest
  ) {
    throw new Error("GTK binding analysis Clang tool does not match its request snapshot");
  }
  if (input.request.clang.target !== input.target) {
    throw new Error(
      `GTK binding request snapshots Clang for ${input.request.clang.target}, ` +
        `but analysis targets ${input.target}`,
    );
  }
  if (input.snapshot.namespace.name !== "Gtk") {
    throw new Error(
      `GTK binding analysis requires the Gtk namespace, but received ${input.snapshot.namespace.name}`,
    );
  }
  if (input.snapshot.namespace.version !== input.request.generation.sdk.version) {
    throw new Error(
      `GTK GIR ${input.snapshot.namespace.version} does not match SDK ` +
        input.request.generation.sdk.version,
    );
  }

  const adapter = generateGObjectAdapterSource(input.snapshot);
  const probe = generateGirClangAbiProbe(input.snapshot, adapter);
  const clang = planClangAbiProbe({
    probe,
    sourceArtifactId: gtkBindingAnalysisArtifactIds.probeSource,
    rawAstArtifactId: gtkBindingAnalysisArtifactIds.rawAst,
    rawLlvmArtifactId: gtkBindingAnalysisArtifactIds.rawLlvm,
    astActionId: "inspect/gtk4/clang-abi",
    llvmActionId: "inspect/gtk4/clang-calling-convention",
    logicalPath: "generated/gtk4/clang-abi-probe.c",
    arguments: input.clangArguments,
    tool: input.clangTool,
    executionPlatform: input.executionPlatform,
    target: input.target,
  });
  const evidence = planGtkClangEvidenceNormalization({
    request: input.request,
    requestArtifact: input.requestArtifact,
    snapshotArtifact: input.snapshotArtifact,
    rawAstArtifact: clang.rawAst.id,
    rawLlvmArtifact: clang.rawLlvm.id,
    generatorArtifact: input.generatorArtifact,
    artifactId: gtkBindingAnalysisArtifactIds.evidence,
    actionId: "normalize/gtk4/clang-abi-evidence",
    tool: input.nodeTool,
    executionPlatform: input.executionPlatform,
    target: input.target,
  });
  const bindings = planGtkBindingPackage({
    request: input.request,
    requestArtifact: input.requestArtifact,
    snapshotArtifact: input.snapshotArtifact,
    normalizedEvidenceArtifact: evidence.artifact.id,
    generatorArtifact: input.generatorArtifact,
    artifactId: gtkBindingAnalysisArtifactIds.bindings,
    actionId: "generate/gtk4/binding-package",
    tool: input.nodeTool,
    executionPlatform: input.executionPlatform,
    target: input.target,
  });

  return Object.freeze({
    adapter,
    probe,
    clang,
    evidence,
    bindings,
    artifacts: Object.freeze([
      clang.source,
      clang.rawAst,
      clang.rawLlvm,
      evidence.artifact,
      bindings.artifact,
    ]),
    actions: Object.freeze([
      clang.astAction,
      clang.llvmAction,
      evidence.action,
      bindings.action,
    ]),
  });
}
