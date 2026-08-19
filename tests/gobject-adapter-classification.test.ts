/* What the generated C is allowed to be, held to it.
 *
 * `docs/architecture.md` states the rule: generated C may turn a foreign
 * convention into something the neutral algebra expresses, and may not decide
 * anything the compiler would otherwise decide — when a value dies, whether it
 * escapes, what a failure means. That is a performance rule before a hygiene
 * one, because code deciding a lifetime from inside one call cannot see the
 * rest of the program and must be conservative every time.
 *
 * TypeScript already enforces the half that matters most: `GOBJECT_ADAPTER_FAMILIES`
 * is keyed by the adapter source's own fields, so a family nobody classified
 * does not compile. What it cannot enforce is the half a person has to look
 * at — that a `gap` is still worth its cost, and that a new one was noticed
 * rather than absorbed. This pins the gaps so adding one shows up in a diff.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GOBJECT_ADAPTER_FAMILIES } from "@native-typescript/bindgen-gir";

test("every family of generated C is a translation, except the recorded gaps", () => {
  const gaps = Object.entries(GOBJECT_ADAPTER_FAMILIES)
    .filter(([, family]) => family.kind === "gap")
    .map(([name]) => name);

  /* One gap, and it is the one the roadmap costs out: a caller-allocated
   * opaque value has no IR value kind, so a boxed record is copied to the
   * heap. Adding a second means a new allocation the SDK does not make, which
   * is a trade rather than a detail — hence this list rather than a count. */
  assert.deepEqual(gaps, ["boxedResultMethods"]);
});

test("a translation names the convention it translates", () => {
  /* The classification is only worth having if a reader can check it. A family
   * claiming to translate has to say WHICH custom, in the SDK's own terms,
   * because "translation" with nothing behind it is where a decision would
   * hide. */
  for (const [name, family] of Object.entries(GOBJECT_ADAPTER_FAMILIES)) {
    if (family.kind !== "translation") continue;
    assert.ok(
      family.custom.length > 40,
      `${name} claims to translate a convention without naming one`,
    );
  }
});

test("a gap names the missing primitive and what it costs", () => {
  for (const [name, family] of Object.entries(GOBJECT_ADAPTER_FAMILIES)) {
    if (family.kind !== "gap") continue;
    assert.ok(family.missing.length > 40, `${name} does not name the missing primitive`);
    assert.ok(family.cost.length > 40, `${name} does not state its cost`);
  }
});
