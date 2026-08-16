import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { locateScriptCCheckout } from "./checkout.ts";
import type {
  ScriptCExecutableCompilationPlan,
  ScriptCExternalCcPlanResolution,
} from "./external-build.ts";

/**
 * Loads the pinned ScriptC compiler's executable planners.
 *
 * The compiler is a submodule that has to be built before it can be loaded, so
 * this is a runtime import rather than a static dependency: the workspace can
 * be typechecked and its own tests run without it. A missing build is reported
 * as the actionable thing it is rather than as a module-resolution failure.
 */

export type ScriptCExecutableCompilationResult =
  | { readonly ok: true; readonly plan: ScriptCExecutableCompilationPlan }
  | {
      readonly ok: false;
      readonly diagnostics: readonly { readonly message: string }[];
    };

export interface ScriptCExecutablePlanners {
  readonly planExecutableCompilation: (
    entry: string,
    options: Record<string, unknown>,
  ) => ScriptCExecutableCompilationResult;
  readonly planExecutableExternalCBuild: (
    plan: ScriptCExecutableCompilationPlan,
    options: Record<string, unknown>,
  ) => Promise<ScriptCExternalCcPlanResolution>;
}

export function scriptCCompilerDistribution(): string {
  return join(locateScriptCCheckout().path, "packages/compiler/dist");
}

export async function loadScriptCExecutablePlanners(): Promise<ScriptCExecutablePlanners> {
  const distribution = scriptCCompilerDistribution();
  const entry = join(distribution, "index.js");
  if (!existsSync(entry)) {
    throw new Error(
      `The pinned ScriptC compiler is not built at ${distribution}.\n` +
        "Run: pnpm scriptc:build",
    );
  }
  const module_ = (await import(
    pathToFileURL(entry).href
  )) as Partial<ScriptCExecutablePlanners>;
  const { planExecutableCompilation, planExecutableExternalCBuild } = module_;
  if (
    typeof planExecutableCompilation !== "function" ||
    typeof planExecutableExternalCBuild !== "function"
  ) {
    throw new Error(
      `The ScriptC compiler at ${distribution} does not export the executable ` +
        "planners this workspace requires. The submodule is likely off the " +
        "native-typescript branch.",
    );
  }
  return Object.freeze({
    planExecutableCompilation,
    planExecutableExternalCBuild,
  });
}
