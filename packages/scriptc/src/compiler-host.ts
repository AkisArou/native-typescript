import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { locateScriptCCheckout } from "./checkout.ts";
import type {
  ScriptCExecutableCompilationPlan,
  ScriptCExternalBuild,
  ScriptCLibraryCompilationPlan,
  ScriptCLibraryExternalBuild,
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
  ) => Promise<ScriptCExternalBuild>;
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

export type ScriptCLibraryCompilationResult =
  | {
      readonly ok: true;
      readonly plan: ScriptCLibraryCompilationPlan;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly { readonly message: string }[];
    };

export interface ScriptCLibraryPlanners {
  readonly planLibraryCompilation: (
    options: Record<string, unknown>,
  ) => Promise<ScriptCLibraryCompilationResult>;
  readonly planLibraryExternalCBuild: (
    plan: ScriptCLibraryCompilationPlan,
    artifacts: Record<string, unknown>,
  ) => Promise<ScriptCLibraryExternalBuild>;
}

/**
 * Loads the pinned ScriptC compiler's library planners.
 *
 * Separate from the executable loader because they are separate products: a
 * target that only ever builds executables must not fail to start because
 * the library surface moved, and one that only embeds must not carry the
 * executable's. Both share the runtime-import discipline — the compiler is a
 * submodule that has to be built, so a missing build is reported as the
 * actionable thing it is rather than as a module-resolution failure.
 *
 * The library planner takes a PROFILE path where the executable planner takes
 * a source path, because a library profile names its own entry. Both are
 * arguments to the planner; neither reaches the plan.
 */
export async function loadScriptCLibraryPlanners(): Promise<ScriptCLibraryPlanners> {
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
  )) as Partial<ScriptCLibraryPlanners>;
  const { planLibraryCompilation, planLibraryExternalCBuild } = module_;
  if (
    typeof planLibraryCompilation !== "function" ||
    typeof planLibraryExternalCBuild !== "function"
  ) {
    throw new Error(
      `The ScriptC compiler at ${distribution} does not export the library ` +
        "planners this workspace requires. The submodule is likely off the " +
        "native-typescript branch.",
    );
  }
  return Object.freeze({ planLibraryCompilation, planLibraryExternalCBuild });
}
