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

/**
 * The compiler contract this workspace was written against.
 *
 * Checked at load rather than assumed, because the alternative already
 * failed: the loaders verified only that the expected FUNCTIONS existed, so
 * a distribution built from an incompatible revision passed and failed later
 * with a structurally wrong plan — at a distance from the mismatch that
 * caused it. A stale `dist` after a submodule repin is the ordinary way to
 * reach that state, and it is easy to reach by accident.
 *
 * Exact equality, no range. Before 1.0 a version that moved changed
 * something, and a workspace that guessed which changes it could survive
 * would be deciding on the compiler's behalf.
 */
const expectedProtocol = Object.freeze({
  protocol: "scriptc.embedder",
  protocolVersion: 1,
  irVersion: 46,
  executablePlanVersion: 1,
  libraryPlanVersion: 1,
  externalCcPlanVersion: 1,
} as const);

export type ScriptCEmbedderProtocol = typeof expectedProtocol;

/**
 * Refuses a compiler whose embedder contract differs from this workspace's.
 *
 * Exported because it is the check itself rather than a step inside loading:
 * a caller holding a distribution can ask whether it would be understood
 * without importing planners it may not need, and the answer is the same one
 * the loaders act on.
 *
 * The message names both sides and the remedy, because the overwhelmingly
 * likely cause is a `dist` older than the checkout rather than a genuinely
 * incompatible fork.
 */
export function verifyScriptCEmbedderProtocol(
  protocol: unknown,
  distribution: string,
): void {
  if (typeof protocol !== "object" || protocol === null) {
    throw new Error(
      `The ScriptC compiler at ${distribution} published a malformed embedder ` +
        "protocol.\nRun: pnpm scriptc:build",
    );
  }
  const actual = protocol as Record<string, unknown>;
  const disagreements = Object.entries(expectedProtocol)
    .filter(([key, value]) => actual[key] !== value)
    .map(([key, value]) => `${key}: expected ${String(value)}, found ${String(actual[key])}`);
  if (disagreements.length > 0) {
    throw new Error(
      `The ScriptC compiler at ${distribution} implements a different ` +
        `embedder contract than this workspace expects:\n` +
        disagreements.map((line) => `  ${line}`).join("\n") +
        "\nIf the submodule was repinned, its build is stale.\n" +
        "Run: pnpm scriptc:build",
    );
  }
}

function handshake(distribution: string, module_: Record<string, unknown>): void {
  const read = module_["getEmbedderProtocol"];
  if (typeof read !== "function") {
    throw new Error(
      `The ScriptC compiler at ${distribution} publishes no embedder ` +
        "protocol, so this workspace cannot tell whether its plans would be " +
        "understood. The submodule is likely off the native-typescript " +
        "branch, or its build predates the protocol.\n" +
        "Run: pnpm scriptc:build",
    );
  }
  verifyScriptCEmbedderProtocol(
    (read as () => unknown)(),
    distribution,
  );
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
  const module_ = (await import(pathToFileURL(entry).href)) as
    Partial<ScriptCExecutablePlanners> & Record<string, unknown>;
  handshake(distribution, module_);
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
  const module_ = (await import(pathToFileURL(entry).href)) as
    Partial<ScriptCLibraryPlanners> & Record<string, unknown>;
  handshake(distribution, module_);
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
