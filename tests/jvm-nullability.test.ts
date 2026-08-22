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
  generateJvmAdapterSource,
  generateJvmClangAbiProbe,
  generateJvmScabiPackage,
  ingestJvmClasses,
} from "@native-typescript/bindgen-jvm";
import type { ScabiManifest } from "@native-typescript/scabi";

/**
 * What a class file STATES about null, carried from the bytes to the
 * surface a program types against.
 *
 * This spans on purpose. Nullability is read in the class-file parser,
 * decided in the model, spent in two different places — the manifest slot
 * and the generated C — and only visible to a person in the declarations.
 * A test at any one of those layers passes while the fact fails to arrive
 * at the next, which is the failure this suite exists to catch: the earlier
 * android.jar work shipped a library that could not load while every
 * artifact assertion about it passed.
 *
 * The asymmetry is the substance. An annotation is a CLAIM by the library,
 * not something the JVM enforces. For a slot the CALLER fills, the narrowed
 * TypeScript type is itself the enforcement, so narrowing is sound. For a
 * slot the PLATFORM fills, nothing stops the claim from being false, so the
 * generated adapter checks it and refuses by name. Both halves are asserted
 * here, because dropping either one silently is exactly the shape of bug
 * that survives a green suite.
 */
const repositoryRoot = resolve(import.meta.dirname, "..");

function snapshot() {
  return ingestJvmClasses(
    [
      {
        logicalPath: "fixtures/jvm/classes/fixture/Stated.class",
        bytes: readFileSync(
          resolve(repositoryRoot, "fixtures/jvm/classes/fixture/Stated.class"),
        ),
      },
    ],
    {
      classes: [
        {
          binaryName: "fixture/Stated",
          constructors: ["()V"],
          methods: ["echo", "maybe", "silent", "self", "confused", "counted"],
        },
      ],
    },
  );
}

function methodNamed(name: string) {
  const class_ = snapshot().classes.find(
    ({ binaryName }) => binaryName === "fixture/Stated",
  );
  assert.ok(class_ !== undefined);
  const method = class_.methods.find((candidate) => candidate.name === name);
  assert.ok(method !== undefined, `fixture/Stated declares ${name}`);
  return method;
}

test("ingestion records what the class file states, and only that", () => {
  /* Both retentions, because the fixture carries one of each: a parser
   * handling only RuntimeVisible* would pass every case built on RUNTIME
   * annotations and silently lose android.jar, which uses the other. */
  const echo = methodNamed("echo");
  assert.equal(echo.resultNullability, "non-null");
  assert.deepEqual(echo.parameterNullability, ["non-null"]);

  const maybe = methodNamed("maybe");
  assert.equal(maybe.resultNullability, "nullable");
  assert.deepEqual(maybe.parameterNullability, ["nullable"]);

  /* The common case, and the one that must not drift: a class file with no
   * annotations states nothing, which is different from stating nullable
   * even though both currently reach the same slot. */
  const silent = methodNamed("silent");
  assert.equal(silent.resultNullability, "unstated");
  assert.deepEqual(silent.parameterNullability, ["unstated"]);

  /* A contradiction is not a case to resolve. Picking a side would be
   * ingestion deciding what the library meant. */
  assert.equal(methodNamed("confused").resultNullability, "unstated");

  /* Nullability is not a property a primitive slot has. Recording an
   * annotation that landed on one would put meaningless variation into a
   * snapshot that feeds a cache key. */
  const counted = methodNamed("counted");
  assert.equal(counted.resultNullability, "unstated");
  assert.deepEqual(counted.parameterNullability, ["unstated"]);
});

/* Synthesized evidence, exactly as the sibling manifest suites synthesize
 * it: the unit under test is what the manifest says, and the real Clang
 * probe runs in the build-pipeline lanes. */
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
  const semanticInput = {
    probeDigest: probe.sourceDigest,
    clang,
    functions,
    records: [],
    enums: [],
  };
  return Object.freeze({
    schema: "native-typescript.clang-abi-evidence" as const,
    schemaVersion: 3 as const,
    probeDigest: probe.sourceDigest,
    semanticDigest: digestClangAbiEvidence(semanticInput),
    clang,
    functions,
    records: Object.freeze([]),
    enums: Object.freeze([]),
  });
}

function generated() {
  const selected = snapshot();
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

test("a stated promise narrows the surface a program types against", () => {
  const { declarations } = generated();

  /* The payoff, and the whole reason to read annotations at all: a program
   * calling echo neither writes `| null` nor tests for one. */
  assert.match(declarations, /echo\(a0: string\): string;/u);
  assert.match(declarations, /self\(a0: Stated\): Stated;/u);

  /* Everything unstated keeps the honest slot. Java's type system says any
   * reference may be null, and an absent annotation narrows nothing. */
  assert.match(declarations, /maybe\(a0: string \| null\): string \| null;/u);
  assert.match(declarations, /silent\(a0: string \| null\): string \| null;/u);
  assert.match(declarations, /confused\(\): string \| null;/u);
});

/** What the manifest's own type says about null. Asserted through the
 * pointer arm rather than a bare property read, so a slot that stopped
 * being a pointer fails here instead of reading as `undefined !== false`. */
function pointerNullability(
  manifest: ScabiManifest,
  typeId: string,
): boolean {
  const type = manifest.types[typeId];
  assert.ok(type !== undefined, `manifest declares type ${typeId}`);
  assert.equal(type.kind, "pointer", `${typeId} is a pointer type`);
  assert.ok(type.kind === "pointer");
  return type.nullable;
}

test("the manifest slot carries the promise, not just the declaration", () => {
  const { manifest } = generated();
  const binding = manifest.bindings["fixture.fixture.stated.echo"];
  assert.ok(binding !== undefined && binding.kind !== "constant");

  const argument = binding.signature.parameters.find(
    ({ name }) => name === "a0",
  );
  assert.ok(argument !== undefined);
  assert.equal(argument.nullable, false);
  /* A narrowed slot must point at a type that agrees with it: a non-null
   * parameter typed by a pointer the manifest calls nullable would be two
   * statements about the same slot, and a validator is entitled to believe
   * either one. */
  assert.equal(pointerNullability(manifest, argument.type), false);
  assert.equal(binding.signature.result.nullable, false);
  assert.equal(
    pointerNullability(manifest, binding.signature.result.type),
    false,
  );

  const unstated = manifest.bindings["fixture.fixture.stated.silent"];
  assert.ok(unstated !== undefined && unstated.kind !== "constant");
  assert.equal(
    unstated.signature.parameters.find(({ name }) => name === "a0")?.nullable,
    true,
  );
  assert.equal(unstated.signature.result.nullable, true);
});

test("a promise the platform breaks refuses by name instead of crossing", () => {
  const c = generateJvmAdapterSource(snapshot(), {
    packageSlug: "fixture",
  }).source;

  /* The claim is checked exactly where it is spent. Without this the
   * boundary would hand over a null that the declared type says cannot
   * exist, and the program would fault somewhere with nothing to blame. */
  assert.match(
    c,
    /fixture\/Stated\.echo\(Ljava\/lang\/String;\)Ljava\/lang\/String; is annotated non-null but returned null/u,
    "a non-null string result names the member whose promise failed",
  );
  assert.match(
    c,
    /fixture\/Stated\.self\(Lfixture\/Stated;\)Lfixture\/Stated; is annotated non-null but returned null/u,
    "a non-null handle result names the member whose promise failed",
  );

  /* An unstated result keeps its successful-null arm: narrowing everything
   * would turn an ordinary absence into a failure. */
  assert.doesNotMatch(
    c,
    /fixture\/Stated\.silent[^\n]*is annotated non-null/u,
    "an unstated result is not checked",
  );
  assert.doesNotMatch(
    c,
    /fixture\/Stated\.maybe[^\n]*is annotated non-null/u,
    "a stated-nullable result is not checked",
  );
});
