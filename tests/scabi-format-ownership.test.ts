/* Who refuses a malformed manifest, and how many layers do.
 *
 * The native format has one owner: the compiler defines its closed semantics,
 * and this repository asks the question through the layer that speaks the
 * compiler's vocabulary. The envelope — reachability, unique inputs, imports,
 * canonical form — is SCABI's, and is a different question about a different
 * document.
 *
 * Both questions were asked in both places until record 0006. The measurement
 * that justified deleting one copy was that every rule sampled here was
 * enforced twice; this test keeps that from coming back, in both directions:
 *
 *   - a rule NO layer refuses is a rule that was lost in the move;
 *   - a format rule BOTH layers refuse is the duplication growing back.
 *
 * Adding a case is how a new format rule earns its keep. If a rule cannot be
 * violated by mutating this fixture, it has no program behind it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parseScabiManifest, validateScabiManifest } from "@native-typescript/scabi";
import type { ScabiManifest } from "@native-typescript/scabi";
import { translateScabiNativeProgram } from "@native-typescript/scriptc";

const fixture = resolve(import.meta.dirname, "../fixtures/scabi-c-v1/package.scabi.json");
const base = parseScabiManifest(readFileSync(fixture, "utf8"));

/* The fixture declares bindings that are valid SCABI and outside the slice
 * this repository compiles, so "select everything" is not a program. The
 * measurable subset is the largest selection that translates, found by
 * dropping whatever the translator names until it stops naming anything. */
const translatable: readonly string[] = (() => {
  let selection = Object.keys(base.bindings);
  for (let round = 0; round < Object.keys(base.bindings).length; round += 1) {
    const attempt = translateScabiNativeProgram(base, { imports: selection, exports: [] });
    if (attempt.ok) return Object.freeze(selection);
    const blamed = new Set(
      attempt.diagnostics
        .map(({ path }) => /^\/bindings\/([^/]+)/u.exec(path)?.[1])
        .filter((id): id is string => id !== undefined),
    );
    if (blamed.size === 0) break;
    selection = selection.filter((id) => !blamed.has(id));
  }
  throw new Error("no subset of the fixture translates");
})();

/* A mutation edits a parsed manifest as ordinary JSON. These documents are
 * the ones the type system exists to reject, so it cannot describe them; the
 * looseness is the point rather than an omission. */
type Json = { [key: string]: any };

type Mutate = (manifest: Json) => void;

/** A mutation that could not find its shape in the fixture would silently
 * assert nothing, so an unapplied one fails instead.
 *
 * `compiler` names where a rule is enforced when the enforcement point is the
 * compiler rather than this repository's translator. Reaching it from here
 * would mean compiling, so the citation is the evidence — checked by hand
 * against the fork at the revision this test was written, and re-checkable by
 * reading the line it names. A case without one asserts the refusal directly. */
interface Case {
  readonly name: string;
  readonly apply: Mutate;
  readonly compiler?: string;
}

function bindings(manifest: unknown): [string, Json][] {
  return Object.entries((manifest as { bindings: Record<string, Json> }).bindings);
}
/** Only the bindings a program actually selects; the rest are never lowered. */
function selected(manifest: unknown): [string, Json][] {
  return bindings(manifest).filter(([id]) => translatable.includes(id));
}
/* Only the types a SELECTED binding reaches. Mutating one nothing reaches
 * measures nothing: no layer downstream of the envelope ever looks at it, so
 * the case would report a gap that does not exist. */
function types(manifest: unknown): Json[] {
  const all = (manifest as { types: Record<string, Json> }).types;
  const reached = new Set<string>();
  const visit = (id: unknown): void => {
    if (typeof id !== "string" || reached.has(id) || all[id] === undefined) return;
    reached.add(id);
    const type = all[id] as Json;
    visit(type.underlying);
    visit(type.pointee);
    for (const field of type.fields ?? []) visit(field.type);
    for (const upcast of type.upcasts ?? []) visit(upcast.target);
    for (const parameter of type.signature?.parameters ?? []) visit(parameter.type);
    visit(type.signature?.result);
  };
  for (const [id, binding] of bindings(manifest)) {
    if (!translatable.includes(id)) continue;
    visit(binding.type);
    visit(binding.signature?.result?.type);
    for (const parameter of parameters(binding)) visit(parameter.type);
  }
  return [...reached].map((id) => all[id] as Json);
}
function parameters(binding: unknown): Json[] {
  return ((binding as { signature?: { parameters?: [] } }).signature?.parameters ?? []) as [];
}
/** Every parameter of every callable, which is where most of the format is. */
function everyParameter(manifest: unknown): Json[] {
  return selected(manifest).flatMap(([, binding]) => parameters(binding));
}

const FORMAT: readonly Case[] = [
  { name: "struct size not a multiple of its alignment", compiler: "ir/validate.ts, size % alignment !== 0", apply: (m) => {
      for (const t of types(m)) if (t.kind === "struct") { t.size += 1; return; } } },
  { name: "struct alignment that is not a power of two", compiler: "ir/validate.ts, (alignment & (alignment - 1)) !== 0", apply: (m) => {
      for (const t of types(m)) if (t.kind === "struct") { t.alignment = 3; return; } } },
  { name: "field offset past the end of its struct", compiler: "ir/validate.ts, fields exceed its declared size", apply: (m) => {
      for (const t of types(m))
        if (t.kind === "struct" && t.fields?.length) {
          t.fields[t.fields.length - 1].offset = t.size + 64; return;
        } } },
  { name: "integer of a width no slot has", apply: (m) => {
      for (const t of types(m)) if (t.kind === "integer") { t.bits = 7; return; } } },
  { name: "boolean whose two representations are the same", compiler: "ir/validate.ts, falseValue !== trueValue on both positions", apply: (m) => {
      for (const t of types(m)) if (t.kind === "boolean") { t.trueValue = t.falseValue; return; } } },
  { name: "handle upcast naming a type that does not exist", apply: (m) => {
      for (const t of types(m))
        if (t.kind === "handle" && t.upcasts?.length) { t.upcasts[0].target = "nts_absent"; return; } } },
  { name: "handle whose type names no destructor", apply: (m) => {
      for (const t of types(m)) if (t.kind === "handle" && t.destructor) { delete t.destructor; return; } } },
  { name: "parameter naming a type that does not exist", apply: (m) => {
      for (const p of everyParameter(m)) { p.type = "nts_absent"; return; } } },
  { name: "two parameters with one name", apply: (m) => {
      for (const [, b] of selected(m)) {
        const ps = parameters(b);
        if (ps.length >= 2) { ps[1]!.name = ps[0]!.name; return; }
      } } },
  { name: "handle parameter passed by value", apply: (m) => {
      const declared = (m as { types: Record<string, { kind: string }> }).types;
      for (const p of everyParameter(m))
        if (declared[p.type]?.kind === "handle") { p.passMode = "value"; return; } } },
  { name: "nullable parameter that is not a pointer", apply: (m) => {
      for (const p of everyParameter(m)) if (p.passMode === "value") { p.nullable = true; return; } } },
  { name: "void result claiming ownership", apply: (m) => {
      for (const [, b] of selected(m))
        if (b.signature?.result?.type === "void") {
          b.signature.result.ownership = { kind: "owned", transfer: "to-runtime" }; return;
        } } },
  { name: "void result passed by pointer", apply: (m) => {
      for (const [, b] of selected(m))
        if (b.signature?.result?.type === "void") { b.signature.result.passMode = "pointer"; return; } } },
  { name: "conversion on a result no number carries", apply: (m) => {
      for (const [, b] of selected(m))
        if (b.signature?.result?.type === "void") { b.signature.result.conversion = "number"; return; } } },
  { name: "string marshalling on a value parameter", apply: (m) => {
      for (const p of everyParameter(m))
        if (p.passMode === "value") {
          p.marshal = { kind: "string", encoding: "utf-8", length: { kind: "nul" },
                        termination: "nul", embeddedNul: "reject" };
          return;
        } } },
  { name: "callback contract on a parameter that is not one", apply: (m) => {
      for (const p of everyParameter(m))
        if (p.callback === undefined) {
          p.callback = { allowedInvocationExecutors: [{ kind: "same-as-caller" }],
                         arguments: [], registrationOwner: "native-call",
                         synchronousReturn: true };
          return;
        } } },
  { name: "callback context naming a parameter it has not got", apply: (m) => {
      for (const p of everyParameter(m))
        if (p.callback?.contextParameter) { p.callback.contextParameter = "absent"; return; } } },
  { name: "callback argument naming a parameter it has not got", apply: (m) => {
      for (const p of everyParameter(m))
        if (p.callback?.arguments?.length) { p.callback.arguments[0].parameter = "absent"; return; } } },
  { name: "callback argument with a transport nothing implements", apply: (m) => {
      for (const p of everyParameter(m))
        if (p.callback?.arguments?.length) { p.callback.arguments[0].transport = "teleport"; return; } } },
  { name: "callback owned by nothing that can own one", apply: (m) => {
      for (const p of everyParameter(m))
        if (p.callback?.registrationOwner) { p.callback.registrationOwner = "nobody"; return; } } },
  { name: "callback no executor may invoke", apply: (m) => {
      for (const p of everyParameter(m))
        if (p.callback?.allowedInvocationExecutors) {
          p.callback.allowedInvocationExecutors = []; return;
        } } },
  { name: "owner-scoped callback keeping a synchronous return", apply: (m) => {
      for (const p of everyParameter(m))
        if (p.callback?.registrationOwner === "native-call") {
          p.callback.registrationOwner = "result-handle"; return;
        } } },
  /* A registration nothing owns returns nothing and cancels through no owner,
   * and both follow from the same fact rather than being two rules: there is
   * no receiver whose lifetime bounds it. Keeping either the handle result or
   * the cancellation binding while claiming process ownership is a contract
   * that says two incompatible things about who ends the registration. */
  { name: "process-owned callback still returning a registration handle", apply: (m) => {
      for (const p of everyParameter(m))
        if (p.callback?.registrationOwner) {
          p.callback.registrationOwner = "process";
          delete p.callback.cancellationBinding;
          return;
        } } },
  { name: "process-owned callback keeping a cancellation binding", apply: (m) => {
      for (const [, b] of selected(m))
        for (const p of b.signature?.parameters ?? [])
          if (p.callback?.cancellationBinding) {
            p.callback.registrationOwner = "process";
            b.signature.result = {
              type: "void", passMode: "value", nullable: false,
              ownership: { kind: "value" },
            };
            return;
          } } },
  { name: "borrowed result anchored to a parameter that does not exist", apply: (m) => {
      for (const [, b] of selected(m))
        if (b.signature?.result?.ownership?.kind === "borrowed") {
          b.signature.result.ownership.anchor = "absent"; return;
        } } },
  { name: "entry symbol that is not a C identifier", compiler: "ir/validate.ts, cIdentifier.test(binding.entry.symbol)", apply: (m) => {
      for (const [, b] of selected(m)) if (b.entry) { b.entry.symbol = "not a symbol!"; return; } } },
];

function mutated(apply: Mutate): ScabiManifest {
  const copy = structuredClone(base) as unknown as Json;
  apply(copy);
  assert.notDeepEqual(copy, base, "the mutation found no such shape in the fixture");
  return copy as unknown as ScabiManifest;
}

/* The JSON Schema is structural and legitimately SCABI's: it describes the
 * serialized document, not what the compiler emits. Only a SEMANTIC envelope
 * refusal means a rule is being enforced in two places. */
const SCHEMA_CODES: ReadonlySet<string> = new Set(["NTS2001", "NTS2002", "NTS2003"]);

function refusals(manifest: ScabiManifest): {
  readonly semantics: boolean;
  readonly format: boolean;
} {
  const envelope = validateScabiManifest(manifest);
  const format = translateScabiNativeProgram(manifest, {
    imports: translatable.filter((id) => manifest.bindings[id] !== undefined),
    exports: [],
  });
  return {
    semantics: !envelope.ok &&
      envelope.diagnostics.some(({ code }) => !SCHEMA_CODES.has(code)),
    format: !format.ok,
  };
}

test("the subset this measures against is itself well formed", () => {
  assert.ok(translatable.length > 0);
  const { semantics, format } = refusals(base);
  assert.equal(semantics, false);
  assert.equal(format, false);
});

for (const rule of FORMAT) {
  test(`one layer refuses it, and it is not the envelope: ${rule.name}`, () => {
    const { semantics, format } = refusals(mutated(rule.apply));
    assert.equal(
      semantics,
      false,
      "an envelope RULE refused it — the duplication record 0006 deleted is growing back",
    );
    if (rule.compiler === undefined) {
      assert.equal(format, true, "nothing downstream of the envelope refused it");
    }
  });
}

test("every rule the compiler owns says where", () => {
  /* The citations are the only part of this file that can rot silently: the
   * fork can move a check without anything here failing. Listing them keeps
   * them countable and reviewable in one place. */
  assert.deepEqual(
    FORMAT.filter(({ compiler }) => compiler !== undefined).map(({ compiler }) => compiler),
    [
      "ir/validate.ts, size % alignment !== 0",
      "ir/validate.ts, (alignment & (alignment - 1)) !== 0",
      "ir/validate.ts, fields exceed its declared size",
      "ir/validate.ts, falseValue !== trueValue on both positions",
      "ir/validate.ts, cIdentifier.test(binding.entry.symbol)",
    ],
  );
});
