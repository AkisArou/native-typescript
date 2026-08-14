import { locateScriptCCheckout } from "@native-typescript/scriptc";
import type { ScriptCCheckout } from "@native-typescript/scriptc";
import type { TargetDefinition } from "@native-typescript/target-api";

export { planTarget, TargetPlanningError } from "./target-plan.ts";
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
