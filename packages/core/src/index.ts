import { locateScriptCCheckout } from "@native-typescript/scriptc";
import type { ScriptCCheckout } from "@native-typescript/scriptc";
import type { TargetDefinition } from "@native-typescript/target-api";

export { planTarget, TargetPlanningError } from "./target-plan.ts";
export {
  planScriptCExecutable,
  planScriptCRuntimeObject,
  planScriptCLibraryEmission,
  planScriptCProgramEmission,
} from "./scriptc-build.ts";
export type {
  ScriptCExecutableArtifactPlan,
  ScriptCProgramEmissionArtifactPlan,
} from "./scriptc-build.ts";
export { planCObjectCompilation } from "./c-toolchain.ts";
export type {
  ArtifactInputPath,
  CObjectCompilationPlan,
} from "./c-toolchain.ts";
export { resolvePkgConfigSdk } from "./pkg-config.ts";
export type {
  PkgConfigModuleSnapshot,
  PkgConfigResolverSnapshot,
  ResolvedPkgConfigSdk,
} from "./pkg-config.ts";
export { resolveSourceArtifact } from "./source-artifact.ts";
export type { SourceArtifactResolution } from "./source-artifact.ts";
export {
  ArtifactExecutionError,
  ArtifactGraphPlanningError,
  digestArtifactPath,
  defineArtifactGraph,
  executeArtifactGraph,
} from "./artifact-graph.ts";
export type {
  ActionArtifactOrigin,
  ArtifactActionArgument,
  ArtifactActionInputArgument,
  ArtifactActionDefinition,
  ArtifactActionEnvironment,
  ArtifactActionStandardOutput,
  ArtifactActionReport,
  ArtifactCacheBinding,
  ArtifactDefinition,
  ArtifactExecutionOptions,
  ArtifactExecutionReport,
  ArtifactGraph,
  ArtifactGraphDiagnostic,
  ArtifactGraphDiagnosticCode,
  ArtifactKind,
  ArtifactSandboxBinding,
  ArtifactToolBinding,
  MaterializedArtifact,
  SourceArtifactOrigin,
} from "./artifact-graph.ts";
export type {
  CapabilitySource,
  ResolvedCapability,
  TargetPlan,
  TargetPlanDiagnostic,
  TargetPlanDiagnosticCode,
  TargetPlanInput,
} from "./target-plan.ts";

export interface WorkspaceInfo {
  readonly compiler: ScriptCCheckout;
  readonly targets: readonly TargetDefinition[];
}

export function inspectWorkspace(
  targets: readonly TargetDefinition[] = [],
): WorkspaceInfo {
  return {
    compiler: locateScriptCCheckout(),
    targets: [...targets],
  };
}

export type { ScriptCCheckout } from "@native-typescript/scriptc";

export { nativeRuntimeServices } from "./runtime-requirements.ts";
export type { NativeRuntimeService } from "./runtime-requirements.ts";
export type { UndeclaredDependency } from "./artifact-cache.ts";
