/* A lane list cannot observe its own omissions, so this observes it for them.
 *
 * `packages/compiler/test/executable-plan.test.ts` sat red for days after our
 * own commit changed the API it tests. Nothing caught it: the file existed, was
 * correct, and was asked by nobody — which is nastier than a missing test,
 * because its presence reads as coverage. Six more of this fork's own test
 * files were in the same state; five were green by luck.
 *
 * `scriptc:test:owned` fixes the general case by COMPUTING its set rather than
 * listing it: a test file this fork added relative to upstream is one we are
 * obliged to keep green, so a new one is picked up the day it appears. What
 * that lane cannot check is its own exclusions — the files it skips because a
 * dedicated lane runs them with an environment this one would drop. A stale
 * claim there removes a file from BOTH lanes and says nothing, which is the
 * original failure wearing a different hat. That claim is what this asserts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  COVERED_BY_OTHER_LANES,
  forkOwnedTestFiles,
  ungatedForkTestFiles,
} from "./support/fork-owned-tests.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** Every lane's text, including the `.mjs` a lane may delegate to: two of them
 * reach their test file through a script that also supplies an environment. */
function laneText(): string {
  const packageJson = readFileSync(join(repositoryRoot, "package.json"), "utf8");
  const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;
  const parts = [packageJson];
  for (const command of Object.values(scripts)) {
    const delegated = /scripts\/[\w-]+\.mjs/.exec(command);
    if (delegated === null) continue;
    parts.push(readFileSync(join(repositoryRoot, delegated[0]), "utf8"));
  }
  return parts.join("\n");
}

test("every fork-owned test file is named by a lane", () => {
  const owned = forkOwnedTestFiles();
  if (owned === null) {
    /* The comparison needs the fork's upstream remote, which a plain
     * `submodule update --init` does not create. Naming the reason beats a
     * failure that looks like the tree's. */
    console.log(
      "    skipped: third_party/scriptc has no resolvable upstream/main " +
        "(git -C third_party/scriptc fetch upstream)",
    );
    return;
  }
  assert.ok(owned.length > 0, "expected this fork to have added test files");

  const text = laneText();
  for (const [file, lane] of COVERED_BY_OTHER_LANES) {
    /* The claim is "another lane runs this", so the file has to be findable in
     * some lane's text. A renamed file or a deleted lane breaks this before it
     * can silently drop the file from every lane. */
    assert.ok(
      text.includes(file),
      `${file} is excluded from scriptc:test:owned as covered by ${lane}, ` +
        "but no lane names it",
    );
    assert.ok(
      owned.includes(file),
      `${file} is claimed as fork-owned but upstream has it; the exclusion is stale`,
    );
  }

  /* The partition is total by construction, and asserting it says so out loud:
   * a file is run by a dedicated lane or by the computed one, never neither. */
  const ungated = ungatedForkTestFiles(owned);
  assert.deepEqual(
    [...ungated, ...COVERED_BY_OTHER_LANES.keys()].sort(),
    [...owned].sort(),
  );
});
