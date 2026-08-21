/* The lane for this fork's OWN test files that no other lane names.
 *
 * Every named lane runs a file chosen deliberately, which is what made the
 * omissions invisible: `executable-plan.test.ts` sat red for days after our own
 * commit changed the API it tests, because no lane asked it and its existence
 * read as coverage. An instrument that is never consulted is worse than a
 * missing one.
 *
 * The set is COMPUTED rather than listed, so a test file added tomorrow is
 * gated the day it appears. The set and the exclusions live in
 * `tests/support/fork-owned-tests.ts`, which `fork-test-lanes.test.ts` reads
 * too — one description, two readers.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  forkOwnedTestFiles,
  ungatedForkTestFiles,
} from "../tests/support/fork-owned-tests.ts";

const scriptcRoot = fileURLToPath(new URL("../third_party/scriptc/", import.meta.url));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const owned = forkOwnedTestFiles();
if (owned === null) {
  console.error(
    "scriptc:test:owned needs the fork's upstream remote: " +
      "git -C third_party/scriptc fetch upstream",
  );
  process.exitCode = 1;
} else {
  const files = ungatedForkTestFiles(owned);
  console.log(`${files.length} fork-owned test file(s) with no other lane:`);
  for (const file of files) console.log(`  ${file}`);
  const result = spawnSync(pnpm, ["exec", "vitest", "run", ...files], {
    cwd: scriptcRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error !== undefined) throw result.error;
  process.exitCode = result.status ?? 1;
}
