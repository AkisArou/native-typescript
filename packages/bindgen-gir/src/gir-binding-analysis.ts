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
  girPackageSlug,
  planGirBindingPackage,
  planGirClangEvidenceNormalization,
} from "./gir-binding-package.ts";
import type {
  GirBindingPackageArtifactPlan,
  GirBindingPackageRequest,
  GirClangEvidenceArtifactPlan,
} from "./gir-binding-package.ts";
import { generateGObjectAdapterSource } from "./gobject-adapter.ts";
import type { GObjectAdapterSource } from "./gobject-adapter.ts";

export interface GirBindingAnalysisArtifactIds {
  readonly probeSource: string;
  readonly rawAst: string;
  readonly rawLlvm: string;
  readonly evidence: string;
  readonly bindings: string;
}

/**
 * Artifact identities for one namespace's analysis subgraph. They are derived
 * from the namespace so a build that analyses Gtk-4.0 and Gio-2.0 together
 * produces two disjoint subgraphs rather than colliding on one set of IDs.
 */
export function girBindingAnalysisArtifactIds(namespace: {
  readonly name: string;
  readonly version: string;
}): GirBindingAnalysisArtifactIds {
  const slug = girPackageSlug(namespace);
  return Object.freeze({
    probeSource: `source/${slug}/clang-abi-probe`,
    rawAst: `metadata/${slug}/clang-abi-ast`,
    rawLlvm: `metadata/${slug}/clang-abi-llvm`,
    evidence: `metadata/${slug}/normalized-clang-abi-evidence`,
    bindings: `package/${slug}/bindings`,
  });
}

export interface GirBindingAnalysisPlan {
  readonly adapter: GObjectAdapterSource;
  readonly probe: ClangAbiProbe;
  readonly clang: ClangAbiProbeArtifactPlan;
  readonly evidence: GirClangEvidenceArtifactPlan;
  readonly bindings: GirBindingPackageArtifactPlan;
  readonly artifacts: readonly ArtifactDefinition[];
  readonly actions: readonly ArtifactActionDefinition[];
}

export function planGirBindingAnalysis(input: {
  readonly snapshot: GirSnapshot;
  readonly request: GirBindingPackageRequest;
  readonly snapshotArtifact: string;
  readonly requestArtifact: string;
  readonly generatorArtifact: string;
  /**
   * One snapshot artifact per entry in `request.importedNamespaces`, in the
   * same order, so a class whose parent lives in another namespace can be
   * projected across the package boundary.
   */
  readonly importedSnapshotArtifacts?: readonly string[];
  /**
   * The imported snapshots themselves, needed at plan time because the probe
   * source is generated here and must cover the foreign candidates the
   * package reaches.
   */
  readonly importedSnapshots?: readonly GirSnapshot[];
  readonly clangArguments: readonly ArtifactActionInputArgument[];
  readonly clangTool: ArtifactActionDefinition["tool"];
  readonly nodeTool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
}): GirBindingAnalysisPlan {
  if (input.request.generation.target.triple !== input.target) {
    throw new Error(
      `GIR binding request targets ${input.request.generation.target.triple}, ` +
        `but analysis targets ${input.target}`,
    );
  }
  if (
    input.clangTool.id !== input.request.clang.toolId ||
    input.clangTool.version !== input.request.clang.version ||
    input.clangTool.digest !== input.request.clang.digest
  ) {
    throw new Error("GIR binding analysis Clang tool does not match its request snapshot");
  }
  if (input.request.clang.target !== input.target) {
    throw new Error(
      `GIR binding request snapshots Clang for ${input.request.clang.target}, ` +
        `but analysis targets ${input.target}`,
    );
  }
  // The request declares the namespace independently of the snapshot so the
  // two must agree. A namespace version is not an SDK version; Gio-2.0 and
  // Gtk-4.0 are both reached through one GTK SDK.
  if (
    input.snapshot.namespace.name !== input.request.namespace.name ||
    input.snapshot.namespace.version !== input.request.namespace.version
  ) {
    throw new Error(
      `GIR binding request declares ${input.request.namespace.name}-` +
        `${input.request.namespace.version}, but the snapshot is ` +
        `${input.snapshot.namespace.name}-${input.snapshot.namespace.version}`,
    );
  }
  const artifactIds = girBindingAnalysisArtifactIds(input.snapshot.namespace);
  const slug = girPackageSlug(input.snapshot.namespace);

  const adapter = generateGObjectAdapterSource(input.snapshot);
  const probe = generateGirClangAbiProbe(
    input.snapshot,
    adapter,
    input.importedSnapshots,
  );
  const clang = planClangAbiProbe({
    probe,
    sourceArtifactId: artifactIds.probeSource,
    rawAstArtifactId: artifactIds.rawAst,
    rawLlvmArtifactId: artifactIds.rawLlvm,
    astActionId: `inspect/${slug}/clang-abi`,
    llvmActionId: `inspect/${slug}/clang-calling-convention`,
    logicalPath: `generated/${slug}/clang-abi-probe.c`,
    arguments: input.clangArguments,
    tool: input.clangTool,
    executionPlatform: input.executionPlatform,
    target: input.target,
  });
  const evidence = planGirClangEvidenceNormalization({
    request: input.request,
    requestArtifact: input.requestArtifact,
    snapshotArtifact: input.snapshotArtifact,
    rawAstArtifact: clang.rawAst.id,
    rawLlvmArtifact: clang.rawLlvm.id,
    generatorArtifact: input.generatorArtifact,
    importedSnapshotArtifacts: input.importedSnapshotArtifacts,
    artifactId: artifactIds.evidence,
    actionId: `normalize/${slug}/clang-abi-evidence`,
    tool: input.nodeTool,
    executionPlatform: input.executionPlatform,
    target: input.target,
  });
  const bindings = planGirBindingPackage({
    request: input.request,
    requestArtifact: input.requestArtifact,
    snapshotArtifact: input.snapshotArtifact,
    normalizedEvidenceArtifact: evidence.artifact.id,
    generatorArtifact: input.generatorArtifact,
    importedSnapshotArtifacts: input.importedSnapshotArtifacts,
    artifactId: artifactIds.bindings,
    actionId: `generate/${slug}/binding-package`,
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
