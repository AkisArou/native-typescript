import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  digestClangAbiEvidence,
  renderCFunctionPointerType,
} from "@native-typescript/bindgen-c";
import type {
  ClangAbiEvidenceSnapshot,
  ClangAbiProbe,
} from "@native-typescript/bindgen-c";
import {
  JvmGenerationError,
  generateJvmAdapterSource,
  generateJvmClangAbiProbe,
  generateJvmScabiPackage,
  ingestJvmClasses,
} from "@native-typescript/bindgen-jvm";
import type { JvmClassSelection } from "@native-typescript/bindgen-jvm";

/**
 * A compile-time constant comes with its class.
 *
 * Listing each one was bookkeeping for a fact the class file already
 * states, and it cost a build per omission — the acceptance application
 * needed three rounds to discover it wanted `Gravity.CENTER`. A static
 * final carrying a ConstantValue IS its value: no call, no generated C,
 * no runtime, and the manifest grows by a literal.
 *
 * THE SUBSTANCE IS WHAT HAPPENS TO A CONSTANT THAT CANNOT BE PROJECTED,
 * because implying them means meeting many more of those. Under the old
 * rule every one was a hard refusal, which is correct when a program
 * asked and absurd when it did not: selecting `android/view/View` would
 * fail on thirteen String constants nobody mentioned.
 *
 * So it turns on who asked. A NAMED field was asked about, and not
 * projecting it is an answer to that question — it refuses. An IMPLIED
 * one was never asked about, so not projecting it is not a refusal at
 * all; it is recorded next to its class with the reason. Absence with a
 * reason beside it is not silence, and the reason is per constant,
 * because "String constants are not projected" and "f32 has no value
 * form" are different futures and a reader deserves to know which one
 * they are waiting on.
 *
 * The fixture carries every ConstantValue kind for exactly this: two that
 * project and three that cannot, each for its own reason.
 */
const repositoryRoot = resolve(import.meta.dirname, "..");

function snapshotOf(selection: JvmClassSelection) {
  return ingestJvmClasses(
    [
      {
        logicalPath: "fixtures/jvm/classes/fixture/Widget.class",
        bytes: readFileSync(
          resolve(repositoryRoot, "fixtures/jvm/classes/fixture/Widget.class"),
        ),
      },
    ],
    { classes: [selection] },
  );
}

const bare: JvmClassSelection = { binaryName: "fixture/Widget" };

test("a constant comes with its class, and a non-constant does not", () => {
  const class_ = snapshotOf(bare).classes[0]!;
  const implied = class_.fields
    .filter((field) => field.selection === "implied")
    .map(({ name }) => name);

  /* All five, without any of them being named. */
  assert.deepEqual(
    [...implied].sort(),
    ["MAX_DEPTH", "NAME", "RATIO", "SCALE", "SEED"],
  );
  assert.equal(
    class_.fields.some((field) => field.selection === "named"),
    false,
    "nothing was named, so nothing reads as named",
  );

  /* `depth` is a protected instance field. Implying it would mean a JNI
   * field access against a live class — state crossing rather than a
   * value the metadata states — which is its own slice. */
  assert.equal(
    class_.fields.some((field) => field.name === "depth"),
    false,
    "an instance field is not a compile-time constant",
  );
});

/* Synthesized evidence, as the sibling manifest suites synthesize it. */
function evidence(probe: ClangAbiProbe): ClangAbiEvidenceSnapshot {
  const clang = Object.freeze({
    toolId: "tool/clang",
    version: "test",
    digest: `sha256:${"a".repeat(64)}`,
    target: "x86_64-unknown-linux-gnu",
  });
  const functions = Object.freeze(probe.functions.map((function_) => {
    const type = renderCFunctionPointerType(function_, "");
    return Object.freeze({
      id: function_.id,
      symbol: function_.symbol,
      expectedType: type,
      clangType: type,
    });
  }));
  return Object.freeze({
    schema: "native-typescript.clang-abi-evidence" as const,
    schemaVersion: 3 as const,
    probeDigest: probe.sourceDigest,
    semanticDigest: digestClangAbiEvidence({
      probeDigest: probe.sourceDigest,
      clang,
      functions,
      records: [],
      enums: [],
    }),
    clang,
    functions,
    records: Object.freeze([]),
    enums: Object.freeze([]),
  });
}

function generate(selection: JvmClassSelection) {
  const selected = snapshotOf(selection);
  const adapter = generateJvmAdapterSource(selected, { packageSlug: "fixture" });
  return generateJvmScabiPackage({
    snapshot: selected,
    adapter,
    packageSlug: "fixture",
    evidence: evidence(generateJvmClangAbiProbe(adapter)),
    package: {
      name: "@native-typescript/jvm-fixture",
      version: "0.0.0",
      namespace: "native-typescript.jvm-fixture",
      instance: "native-typescript.jvm-fixture@0.0.0",
    },
    target: {
      triple: "x86_64-unknown-linux-gnu",
      architecture: "x86_64",
      pointerWidth: 64,
      endianness: "little",
      objectFormat: "elf",
      minimumPlatformVersion: "glibc-2.17",
      abi: "sysv-amd64",
      features: ["jvm"],
    },
    sdk: {
      vendor: "openjdk",
      name: "jdk",
      version: "21",
      deploymentTarget: "21",
      modules: ["fixture"],
    },
    linkInputs: [
      { id: "link.jvm", kind: "shared-library", name: "jvm", order: 0 },
    ],
    adapterInput: { id: "fixture.jvm-adapters", output: "jvm-adapters.o" },
  });
}

test("what projects is a value; what cannot says why, one reason each", () => {
  const { declarations, manifest } = generate(bare);

  /* Merged with the class, so `Widget.MAX_DEPTH` reads the way the
   * platform writes it while being a const the compiler can resolve. */
  assert.match(declarations, /export declare namespace Widget \{/u);
  assert.match(declarations, /const MAX_DEPTH: jint;/u);
  assert.match(declarations, /const RATIO: jdouble;/u);

  /* The three that cannot, each naming its OWN reason. A shared
   * "unsupported" line would tell a reader nothing about whether to wait
   * or to work around it. */
  assert.match(declarations, /'SEED' is a long constant/u);
  assert.match(declarations, /'SCALE' is a float constant/u);
  assert.match(declarations, /'NAME' is a String constant/u);

  const reasons = [...declarations.matchAll(/\/\* '\w+' is an? ([\w ]+)/gu)]
    .map(([, kind]) => kind!);
  assert.equal(reasons.length, 3, "three constants could not be projected");
  assert.equal(
    new Set(reasons).size,
    3,
    `three constants, three distinct reasons: ${JSON.stringify(reasons)}`,
  );

  /* The value itself, in the manifest, with nothing to call to obtain it. */
  const binding = manifest.bindings["fixture.fixture.widget.max_depth"];
  assert.ok(binding !== undefined && binding.kind === "constant");
  assert.equal(binding.value, 32);
  assert.deepEqual(binding.dependencies, {
    bindings: [],
    linkInputs: [],
    adapterInputs: [],
    permissions: [],
  });

  /* An unprojectable constant produces no binding at all — the comment is
   * documentation, not a declaration something could resolve. */
  assert.equal(manifest.bindings["fixture.fixture.widget.name"], undefined);
  assert.equal(manifest.bindings["fixture.fixture.widget.seed"], undefined);
});

test("naming a field is an assertion, and an unmet one refuses", () => {
  /* The same String constant that is merely absent when implied. Listing
   * it asks a question, and the answer is a refusal that names it — which
   * is what makes `fields:` worth keeping after constants arrive on their
   * own: it pins that these MUST project, so a platform version that
   * changes one is a diagnostic rather than a silent disappearance. */
  assert.throws(
    () => generate({ binaryName: "fixture/Widget", fields: ["NAME"] }),
    (error: unknown) => {
      assert.ok(error instanceof JvmGenerationError);
      assert.match(error.message, /'NAME' is a String constant/u);
      return true;
    },
  );

  /* And a field that is not a compile-time constant at all keeps its own
   * refusal, which is a different sentence for a different reason. */
  assert.throws(
    () => generate({ binaryName: "fixture/Widget", fields: ["depth"] }),
    (error: unknown) => {
      assert.ok(error instanceof JvmGenerationError);
      assert.match(error.message, /'depth' is not a compile-time constant/u);
      return true;
    },
  );
});

test("naming a constant that already comes with the class changes nothing", () => {
  /* Listing MAX_DEPTH is now redundant rather than wrong. The projection
   * must be identical either way, or a program would be punished for
   * having written the selection it needed before this rule existed. */
  const implied = generate(bare);
  const named = generate({ binaryName: "fixture/Widget", fields: ["MAX_DEPTH"] });
  assert.equal(named.declarationsDigest, implied.declarationsDigest);
  assert.equal(named.manifestDigest, implied.manifestDigest);
});
