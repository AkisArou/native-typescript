/* Which of the fork's test files are OURS to keep green, and which lane runs
 * each.
 *
 * A test file this fork added relative to upstream is one we are obliged to
 * gate; upstream's own suites are not, and several are deliberately red — a
 * blanket "every test file" rule would need an exception list immediately, and
 * an exception list is where the next omission would hide.
 *
 * Lives under `tests/` because that is the only tree `tests/tsconfig.json`
 * roots, and both readers need types: the lane runner in `scripts/` imports it
 * for the set it runs, and `fork-test-lanes.test.ts` imports it for the claims
 * it checks.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const scriptcRoot = resolve(import.meta.dirname, "../../third_party/scriptc");

/** Files a dedicated lane already runs, each naming the lane that runs it.
 *
 * These are EXCLUDED from the computed lane rather than merely duplicated by
 * it: two of them are reached through a `.mjs` that also supplies an
 * environment — a substituted frontend input, a sanitizer build — so running
 * them plainly here would prove something weaker while looking like coverage.
 *
 * Kept out of the lane scripts themselves so the check cannot satisfy itself:
 * a claim has to be backed by a lane's own text, and it would be if the claim
 * lived there. */
export const COVERED_BY_OTHER_LANES: ReadonlyMap<string, string> = new Map([
  ["packages/compiler/test/native-manifest.test.ts", "scriptc:test:manifest"],
  ["tests/harness/native-ir.test.ts", "scriptc:test:native-ir, :export, :sanitized"],
  ["tests/harness/owner-gateway.test.ts", "scriptc:test:owner-gateway"],
  ["tests/harness/callback-token.test.ts", "scriptc:test:callback-token"],
  ["tests/harness/callback-table.test.ts", "scriptc:test:callback-table"],
  ["tests/harness/callback-handle.test.ts", "scriptc:test:callback-handle"],
]);

/** Test files this fork ADDED, or null when `upstream/main` does not resolve —
 * a plain `submodule update --init` creates no upstream remote, which is a
 * missing input rather than a failing tree. */
export function forkOwnedTestFiles(): readonly string[] | null {
  const listed = spawnSync(
    "git",
    ["diff", "--name-only", "--diff-filter=A", "upstream/main...HEAD", "--", "*.test.ts"],
    { cwd: scriptcRoot, encoding: "utf8" },
  );
  if (listed.status !== 0) return null;
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** The ones no dedicated lane runs — the computed lane's set. */
export function ungatedForkTestFiles(owned: readonly string[]): readonly string[] {
  return owned.filter((file) => !COVERED_BY_OTHER_LANES.has(file));
}
