import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * The constraint block in `application-build.ts` names a lane per
 * constraint. This checks those names point at lanes that exist.
 *
 * It exists because of a gap identified in the block itself and then left
 * open: if one of the lanes backing those comments is deleted or renamed,
 * the comment beside it becomes false and NOTHING notices. A comment
 * claiming a proof that no longer exists is worse than no comment, because
 * the next person reads it as a reason not to look.
 *
 * What this proves is narrow and worth stating exactly: that every lane
 * NAMED there is a file that exists. It does not prove the lane still
 * asserts the constraint — a test can be gutted and keep its filename —
 * and no reading of a comment could establish that. It closes the failure
 * that is silent (a lane disappears) and leaves the one that is loud (a
 * lane's assertion changes and the suite goes red).
 *
 * The pattern is `tests/fork-test-lanes.test.ts`, which asserts that every
 * fork test file is named by a script. Same shape: a claim about the tree
 * that a person wrote down, turned into a claim the suite makes.
 */
const repositoryRoot = resolve(import.meta.dirname, "..");

/** The file whose header carries the constraints. */
const CARRIER = "packages/target-jvm/src/application-build.ts";

function constraintBlock(): string {
  const source = readFileSync(resolve(repositoryRoot, CARRIER), "utf8");
  const start = source.indexOf("PLATFORM CONSTRAINTS THIS FILE CARRIES");
  assert.notEqual(
    start,
    -1,
    `${CARRIER} no longer carries a constraint block; if the constraints ` +
      "moved, this check must move with them rather than be deleted",
  );
  const end = source.indexOf("*/", start);
  assert.notEqual(end, -1, "the constraint block is unterminated");
  return source.slice(start, end);
}

test("the preventive link flag is still written, and still Android-only", () => {
  /* `-Wl,--no-undefined` is the one constraint no behavioural lane can
   * hold. It makes a link FAIL that would otherwise succeed, so deleting
   * it changes no artifact as long as every symbol resolves — which is
   * every build here. Nothing goes red.
   *
   * So this is a SOURCE-LEVEL check and says so: it catches a refactor
   * dropping the flag or applying it to both products, and it proves
   * nothing whatever about the linker. The asymmetry is the half worth
   * guarding, because a shared build path is exactly where someone would
   * normalise it — the desktop hosted library genuinely needs the
   * permissive link, since the host supplies its undefined JNI symbols. */
  const source = readFileSync(resolve(repositoryRoot, CARRIER), "utf8");
  const emitted = source.slice(source.indexOf("*/"));
  assert.match(
    emitted,
    /androidTarget\s*\?\s*\[Object\.freeze\(\{\s*kind: "literal" as const,\s*value: "-Wl,--no-undefined",/u,
    "the strict link flag is emitted under the Android branch; if this " +
      "moved, the check must move with it rather than be deleted, and if " +
      "it became unconditional the desktop hosted product would refuse to " +
      "link against JNI symbols its host supplies at runtime",
  );
});

test("every lane the constraint block names is a lane that exists", () => {
  const block = constraintBlock();
  const named = [
    ...new Set(
      [...block.matchAll(/`(tests\/[\w-]+\.test\.ts)`/gu)].map(
        ([, path]) => path!,
      ),
    ),
  ].sort();

  /* A block that names NO lane would pass every assertion below while
   * proving nothing, so the count is checked first. This is the same
   * failure the block is about: a check whose subject has quietly
   * vanished still reports success. */
  assert.ok(
    named.length >= 3,
    `the constraint block names ${named.length} lanes, which is too few to ` +
      "be the block this check was written for — it has been rewritten, " +
      "and this check has not kept up",
  );

  for (const path of named) {
    assert.ok(
      existsSync(resolve(repositoryRoot, path)),
      `the constraint block cites '${path}' as proving a platform ` +
        "constraint, and no such lane exists; either the lane was renamed " +
        "and the comment is now false, or the constraint lost its proof",
    );
  }
});
