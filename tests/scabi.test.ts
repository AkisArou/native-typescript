import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  ScabiValidationError,
  canonicalizeJson,
  digestScabiManifest,
  parseScabiManifest,
  validateScabiManifest,
} from "@native-typescript/scabi";
import type { ScabiManifest } from "@native-typescript/scabi";
import { translateScabiNativeProgram } from "@native-typescript/scriptc";

const repositoryRoot = resolve(import.meta.dirname, "..");
const fixtureRoot = resolve(repositoryRoot, "fixtures/scabi-c-v1");
const manifestSource = readFileSync(
  resolve(fixtureRoot, "package.scabi.json"),
  "utf8",
);
const manifest = parseScabiManifest(manifestSource);

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/* A malformed manifest is refused by whichever layer owns the rule it breaks.
 * The envelope's rules — reachability, unique inputs, imports, canonical form —
 * are SCABI's and answer NTS20xx. The FORMAT's rules are the compiler's, and
 * this repository asks them through the layer that speaks its vocabulary, which
 * answers NTS3002. Record 0006 is why they are not asked in both places.
 *
 * Either refusal is a refusal; a manifest neither layer objects to is the
 * failure this helper exists to catch. */
function validationCodes(value: unknown): readonly string[] {
  const envelope = validateScabiManifest(value);
  if (!envelope.ok) return envelope.diagnostics.map(({ code }) => code);
  const format = translateScabiNativeProgram(
    value as ScabiManifest,
    {
      imports: Object.keys((value as ScabiManifest).bindings),
      exports: [],
    },
  );
  assert.equal(format.ok, false, "neither the envelope nor the format objected");
  /* Distinct codes: the envelope reports a rule once, and the format layer
   * reports it once per binding it reaches, so multiplicity says which layer
   * answered rather than anything about the manifest. */
  return format.ok ? [] : [...new Set(format.diagnostics.map(({ code }) => code))];
}

function emptyDependencies(): {
  adapterInputs: never[];
  bindings: never[];
  linkInputs: never[];
  permissions: never[];
} {
  return {
    adapterInputs: [],
    bindings: [],
    linkInputs: [],
    permissions: [],
  };
}

interface ExecutionResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function compileAndRun(
  sources: readonly string[],
  compilerOptions: readonly string[] = [],
): ExecutionResult {
  const buildDirectory = mkdtempSync(join(tmpdir(), "nts-scabi-c-v1-"));
  const executable = resolve(buildDirectory, "fixture");
  const compiler = process.env.CC ?? "cc";

  try {
    const compilation = spawnSync(
      compiler,
      [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pedantic",
        "-pthread",
        ...compilerOptions,
        `-I${resolve(fixtureRoot, "include")}`,
        ...sources.map((source) => resolve(fixtureRoot, "src", source)),
        "-o",
        executable,
      ],
      { encoding: "utf8" },
    );
    assert.equal(compilation.status, 0, compilation.stderr);

    const execution = spawnSync(executable, [], { encoding: "utf8" });
    return {
      status: execution.status,
      stdout: execution.stdout,
      stderr: execution.stderr,
    };
  } finally {
    rmSync(buildDirectory, { force: true, recursive: true });
  }
}

test("SCABI fixture is canonical, immutable, and content-addressable", () => {
  assert.equal(canonicalizeJson(manifest), manifestSource);
  assert.equal(
    digestScabiManifest(manifest),
    "sha256:1d98ac1022904add169b147e1f203373038dfe6e1a72e36fcc7d08da9f66b9cd",
  );
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.bindings.subscription_create), true);
  assert.equal(Object.isFrozen(manifest.bindings.counter_label), true);
  assert.equal(Object.isFrozen(manifest.types.padded), true);
});

test("SCABI handle upcasts are explicit, canonical, and representation-safe", () => {
  const hierarchy = structuredClone(manifest);
  Object.assign(hierarchy.types, {
    base_handle: {
      kind: "handle" as const,
      nativeName: "BaseHandle",
      threadSafety: "confined" as const,
      identity: "pointer" as const,
      upcasts: [],
    },
    derived_handle: {
      kind: "handle" as const,
      nativeName: "DerivedHandle",
      threadSafety: "confined" as const,
      identity: "pointer" as const,
      upcasts: [{ kind: "identity" as const, target: "base_handle" }],
    },
  });
  assert.equal(validateScabiManifest(hierarchy).ok, true);

  const wrongKind = structuredClone(hierarchy);
  const wrongKindDerived = wrongKind.types.derived_handle;
  assert.equal(wrongKindDerived?.kind, "handle");
  if (wrongKindDerived?.kind !== "handle") return;
  Object.assign(wrongKindDerived, {
    upcasts: [{ kind: "identity" as const, target: "i32" }],
  });
  assert.equal(validationCodes(wrongKind).includes("NTS3002"), true);

  const incompatible = structuredClone(hierarchy);
  const incompatibleBase = incompatible.types.base_handle;
  assert.equal(incompatibleBase?.kind, "handle");
  if (incompatibleBase?.kind !== "handle") return;
  Object.assign(incompatibleBase, { identity: "platform" as const });
  assert.equal(validationCodes(incompatible).includes("NTS3002"), true);

  const cyclic = structuredClone(hierarchy);
  const cyclicBase = cyclic.types.base_handle;
  assert.equal(cyclicBase?.kind, "handle");
  if (cyclicBase?.kind !== "handle") return;
  Object.assign(cyclicBase, {
    upcasts: [{ kind: "identity" as const, target: "derived_handle" }],
  });
  assert.equal(validationCodes(cyclic).includes("NTS3002"), true);
});

test("SCABI handle upcasts may target a type another package owns", () => {
  // Gtk.Application extends Gio.Application. GIR namespaces are package
  // boundaries, so the base handle is defined by a different package and this
  // manifest only imports it.
  const basePackage = {
    name: "@example/base",
    version: "1.0.0",
    namespace: "example.base",
    instance: "example.base@1.0.0",
  };
  const imported = structuredClone(manifest) as typeof manifest & {
    imports?: Record<string, unknown>;
  };
  Object.assign(imported.types, {
    derived_handle: {
      kind: "handle" as const,
      nativeName: "DerivedHandle",
      threadSafety: "confined" as const,
      identity: "platform" as const,
      upcasts: [{ kind: "identity" as const, target: "base_handle" }],
    },
  });
  Object.assign(imported.declarations.types, {
    derived_handle: { module: ".", name: "Derived" },
    base_handle: { module: "@example/base", name: "Base" },
  });
  imported.imports = {
    base_handle: { package: basePackage, type: "base_handle" },
  };
  assert.equal(validateScabiManifest(imported).ok, true);

  // The import record is what makes the reference legal. Without it the target
  // is simply dangling.
  const undeclared = structuredClone(imported);
  delete undeclared.imports;
  assert.equal(validationCodes(undeclared).includes("NTS3002"), true);

  // A package cannot both import and define one identity.
  const alsoDefined = structuredClone(imported);
  Object.assign(alsoDefined.types, {
    base_handle: {
      kind: "handle" as const,
      nativeName: "BaseHandle",
      threadSafety: "confined" as const,
      identity: "platform" as const,
      upcasts: [],
    },
  });
  assert.deepEqual(validationCodes(alsoDefined), ["NTS2010"]);

  // Importing from this package's own instance is incoherent.
  const selfImport = structuredClone(imported);
  selfImport.imports = {
    base_handle: { package: imported.package, type: "base_handle" },
  };
  assert.deepEqual(validationCodes(selfImport), ["NTS2010"]);

  /* An imported type is opaque here, and a handle is the one thing a
   * signature can carry without its definition: the pointer is the whole
   * representation, so a parameter naming one is as complete as a local
   * handle's. What it may not do is cross any other way. */
  const inSignature = structuredClone(imported);
  const callable = Object.values(inSignature.bindings).find(
    (binding) => "signature" in binding,
  );
  assert.ok(callable && "signature" in callable);
  if (!callable || !("signature" in callable)) return;
  Object.assign(callable.signature, {
    parameters: [
      {
        name: "base",
        type: "base_handle",
        passMode: "pointer",
        nullable: false,
        ownership: { kind: "borrowed", scope: "call" },
      },
    ],
  });
  assert.equal(validateScabiManifest(inSignature).ok, true);

  const byValue = structuredClone(inSignature);
  const byValueCallable = byValue.bindings[
    Object.keys(byValue.bindings).find((id) => "signature" in byValue.bindings[id]!)!
  ]!;
  assert.ok("signature" in byValueCallable);
  if (!("signature" in byValueCallable)) return;
  Object.assign(byValueCallable.signature.parameters[0]!, { passMode: "value" });
  assert.equal(validationCodes(byValue).includes("NTS3002"), true);
});

test("a handle type names the destructor its owners use", () => {
  /* How a handle is released follows the object rather than the call that
   * produced one, so the type says it once and every owned position of that
   * type inherits it. */
  const valid = structuredClone(manifest);
  assert.equal(validateScabiManifest(valid).ok, true);

  // Repeating it on the position is refused rather than tolerated: two places
  // to say one thing is two places for them to disagree.
  const onPosition = structuredClone(manifest);
  const create = onPosition.bindings.counter_create;
  assert.ok(create && "signature" in create);
  if (!create || !("signature" in create)) return;
  Object.assign(create.signature.result.ownership, { destructor: "counter_destroy" });
  assert.equal(validationCodes(onPosition).includes("NTS3002"), true);

  // A type that names none cannot be owned at all.
  const unnamed = structuredClone(manifest);
  const counter = unnamed.types.counter;
  assert.ok(counter && counter.kind === "handle");
  if (!counter || counter.kind !== "handle") return;
  delete (counter as { destructor?: string }).destructor;
  assert.equal(validationCodes(unnamed).includes("NTS3002"), true);

  // And what it names has to be a destructor of that type.
  const wrong = structuredClone(manifest);
  const wrongCounter = wrong.types.counter;
  assert.ok(wrongCounter && wrongCounter.kind === "handle");
  if (!wrongCounter || wrongCounter.kind !== "handle") return;
  Object.assign(wrongCounter, { destructor: "counter_value" });
  /* Twice: the type's own shape rule, and the owning position, which now
   * depends on a binding its own dependency list does not name. */
  assert.equal(validationCodes(wrong).includes("NTS3002"), true);
});

test("SCABI constants and scalar member representations are validated eagerly", () => {
  const valid = structuredClone(manifest);
  Object.assign(valid.types, {
    access: {
      kind: "flags" as const,
      underlying: "u8",
      members: { None: "0", Read: "1", Write: "2", ReadWrite: "3" },
    },
    orientation: {
      kind: "enum" as const,
      underlying: "i8",
      members: { Unknown: "-1", Horizontal: "0", Vertical: "1" },
    },
  });
  Object.assign(valid.bindings, {
    access_read_write: {
      kind: "constant" as const,
      declaration: { module: ".", name: "Access.ReadWrite" },
      type: "access",
      value: "3",
      dependencies: emptyDependencies(),
    },
    boolean_true: {
      kind: "constant" as const,
      declaration: { module: ".", name: "nativeTrue" },
      type: "native_boolean",
      value: true,
      dependencies: emptyDependencies(),
    },
    exact_f32: {
      kind: "constant" as const,
      declaration: { module: ".", name: "exactF32" },
      type: "f32",
      value: 1.5,
      dependencies: emptyDependencies(),
    },
    exact_f64: {
      kind: "constant" as const,
      declaration: { module: ".", name: "exactF64" },
      type: "f64",
      value: 0.1,
      dependencies: emptyDependencies(),
    },
    i64_minimum: {
      kind: "constant" as const,
      declaration: { module: ".", name: "i64Minimum" },
      type: "i64",
      value: "-9223372036854775808",
      dependencies: emptyDependencies(),
    },
    orientation_unknown: {
      kind: "constant" as const,
      declaration: { module: ".", name: "Orientation.Unknown" },
      type: "orientation",
      value: "-1",
      dependencies: emptyDependencies(),
    },
    u64_maximum: {
      kind: "constant" as const,
      declaration: { module: ".", name: "u64Maximum" },
      type: "u64",
      value: "18446744073709551615",
      dependencies: emptyDependencies(),
    },
  });
  assert.equal(validateScabiManifest(valid).ok, true);

  const malformedMembers = structuredClone(valid);
  const malformedOrientation = malformedMembers.types.orientation;
  assert.equal(malformedOrientation?.kind, "enum");
  if (malformedOrientation?.kind !== "enum") return;
  Object.assign(malformedOrientation, {
    members: { LeadingZero: "01", Overflow: "128" },
  });
  /* A member value that is not canonical, and a constant naming no member, are
   * both format questions now. The paths they report belong to the layer that
   * answers, so this pins the refusal rather than its wording. */
  /* Two independent problems: the member values are not canonical, and the
   * constant that named one can no longer resolve. Both are refused; the
   * assertion pins the format one because that is the rule under test. */
  assert.equal(validationCodes(malformedMembers).includes("NTS3002"), true);

  const invalidBooleanStorage = structuredClone(valid);
  const nativeBoolean = invalidBooleanStorage.types.native_boolean;
  assert.equal(nativeBoolean?.kind, "boolean");
  if (nativeBoolean?.kind !== "boolean") return;
  Object.assign(nativeBoolean, { falseValue: "0", trueValue: "0" });
  assert.equal(validationCodes(invalidBooleanStorage).includes("NTS3002"), true);

  const invalidCases: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly value: string | number | boolean;
    readonly expectedPath: string;
  }> = [
    {
      id: "integer_noncanonical",
      type: "i32",
      value: "+1",
      expectedPath: "/bindings/integer_noncanonical/value",
    },
    {
      id: "integer_overflow",
      type: "u8",
      value: "256",
      expectedPath: "/bindings/integer_overflow/value",
    },
    {
      id: "enum_unnamed",
      type: "orientation",
      value: "2",
      expectedPath: "/bindings/enum_unnamed/value",
    },
    {
      id: "flags_undeclared_composite",
      type: "access",
      value: "4",
      expectedPath: "/bindings/flags_undeclared_composite/value",
    },
    {
      id: "boolean_physical_value",
      type: "native_boolean",
      value: "1",
      expectedPath: "/bindings/boolean_physical_value/value",
    },
    {
      id: "rounded_f32",
      type: "f32",
      value: 0.1,
      expectedPath: "/bindings/rounded_f32/value",
    },
    {
      id: "pointer_constant",
      type: "void_ptr",
      value: "0",
      expectedPath: "/bindings/pointer_constant/type",
    },
  ];
  for (const invalidCase of invalidCases) {
    const invalid = structuredClone(valid);
    Object.assign(invalid.bindings, {
      [invalidCase.id]: {
        kind: "constant" as const,
        declaration: { module: ".", name: invalidCase.id },
        type: invalidCase.type,
        value: invalidCase.value,
        dependencies: emptyDependencies(),
      },
    });
    /* A constant's value inhabiting its declared type is a format question, so
     * the refusal comes from the layer that would have to lower it. What the
     * case still pins is that EVERY one of these is refused, individually. */
    assert.equal(validationCodes(invalid).includes("NTS3002"), true, invalidCase.id);
  }

  const dependent = structuredClone(valid);
  Object.assign(dependent.bindings, {
    dependent_constant: {
      kind: "constant" as const,
      declaration: { module: ".", name: "dependentConstant" },
      type: "i32",
      value: "1",
      dependencies: {
        ...emptyDependencies(),
        bindings: ["i32_identity"],
      },
    },
  });
  const dependentResult = validateScabiManifest(dependent);
  assert.equal(dependentResult.ok, false);
  if (dependentResult.ok) return;
  assert.deepEqual(
    dependentResult.diagnostics.map(({ code, path }) => ({ code, path })),
    [{ code: "NTS2021", path: "/bindings/dependent_constant/dependencies" }],
  );
});

test("SCABI fixture provenance matches declarations and header", () => {
  const declarationDigest = sha256File(resolve(fixtureRoot, "package.d.ts"));
  const headerDigest = sha256File(
    resolve(fixtureRoot, "include/nts_scabi_fixture.h"),
  );

  assert.equal(manifest.declarations.digest, declarationDigest);
  assert.deepEqual(manifest.declarations.types.i32, {
    module: ".",
    name: "i32",
  });
  assert.equal(manifest.sdk.metadataDigest, headerDigest);
  assert.deepEqual(manifest.generator.inputDigests, [headerDigest]);
});

test("SCABI admits only coherent implicit-length C strings", () => {
  const cString = structuredClone(manifest);
  const binding = cString.bindings.hash_utf8;
  assert.notEqual(binding?.kind, "constant");
  if (binding === undefined || binding.kind === "constant") return;
  const data = binding.signature.parameters[0];
  assert.equal(data?.marshal?.kind, "string");
  if (data?.marshal?.kind !== "string") return;
  Object.assign(data.marshal, {
    length: { kind: "nul" as const },
    termination: "nul" as const,
    embeddedNul: "reject" as const,
  });
  Object.assign(binding.signature, {
    parameters: binding.signature.parameters.slice(0, 1),
  });
  assert.equal(validateScabiManifest(cString).ok, true);

  Object.assign(data.marshal, { embeddedNul: "allow" as const });
  assert.equal(validationCodes(cString).includes("NTS3002"), true);
});

test(
  "C fixture executes scalar, aggregate, ownership, error, and callback contracts",
  { skip: process.platform !== "linux" || process.arch !== "x64" },
  () => {
    const execution = compileAndRun([
      "nts_scabi_fixture.c",
      "fixture_test.c",
    ]);
    assert.equal(execution.status, 0, execution.stderr);
  },
);

test(
  "C fixture is clean under address and undefined-behavior sanitizers",
  { skip: process.platform !== "linux" || process.arch !== "x64" },
  () => {
    const execution = compileAndRun(
      ["nts_scabi_fixture.c", "fixture_test.c"],
      ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"],
    );
    assert.equal(execution.status, 0, execution.stderr);
  },
);

test(
  "authoritative C layout agrees with the SCABI aggregate",
  { skip: process.platform !== "linux" || process.arch !== "x64" },
  () => {
    const execution = compileAndRun(["layout_probe.c"]);
    assert.equal(execution.status, 0, execution.stderr);

    const layout = JSON.parse(execution.stdout) as {
      readonly alignment: number;
      readonly fields: Readonly<Record<string, number>>;
      readonly size: number;
    };
    const padded = manifest.types.padded;
    assert.equal(padded?.kind, "struct");
    if (padded?.kind !== "struct") {
      return;
    }

    assert.equal(padded.alignment, layout.alignment);
    assert.equal(padded.size, layout.size);
    assert.deepEqual(
      Object.fromEntries(padded.fields.map((field) => [field.name, field.offset])),
      layout.fields,
    );
  },
);

test("SCABI rejects non-canonical source", () => {
  assert.throws(
    () => parseScabiManifest(`${JSON.stringify(manifest, null, 2)}\n`),
    (error: unknown) => {
      assert.ok(error instanceof ScabiValidationError);
      assert.deepEqual(error.diagnostics.map(({ code }) => code), ["NTS2003"]);
      return true;
    },
  );
});

test("canonical JSON rejects values without a portable JSON representation", () => {
  assert.throws(() => canonicalizeJson({ value: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalizeJson({ value: undefined }), /undefined/);
  assert.throws(() => canonicalizeJson("\ud800"), /unpaired surrogate/);
});

test("SCABI rejects a layout that omits required tail storage", () => {
  const padded = manifest.types.padded;
  assert.equal(padded?.kind, "struct");
  if (padded?.kind !== "struct") {
    return;
  }
  const invalid = {
    ...manifest,
    types: {
      ...manifest.types,
      padded: { ...padded, size: 16 },
    },
  };

  assert.equal(validationCodes(invalid).includes("NTS3002"), true);
});

test("SCABI enforces nested aggregate field alignment", () => {
  const nested = manifest.types.nested_pair32;
  assert.equal(nested?.kind, "struct");
  if (nested?.kind !== "struct") return;
  const invalid = {
    ...manifest,
    types: {
      ...manifest.types,
      nested_pair32: {
        ...nested,
        fields: [
          { ...nested.fields[0]!, offset: 1 },
          ...nested.fields.slice(1),
        ],
      },
    },
  };
  assert.equal(validationCodes(invalid).includes("NTS3002"), true);
});

test("SCABI applies explicit packing to field alignment", () => {
  const pair = manifest.types.pair32;
  assert.equal(pair?.kind, "struct");
  if (pair?.kind !== "struct") return;
  const packed = {
    ...manifest,
    types: {
      ...manifest.types,
      packed_pair32: {
        ...pair,
        size: 9,
        alignment: 1,
        packing: 1,
        fields: pair.fields.map((field, index) => ({
          ...field,
          offset: index === 0 ? 1 : 5,
        })),
      },
    },
  };
  assert.equal(validateScabiManifest(packed).ok, true);
});

test("SCABI rejects a void aggregate result without leading structure-return storage", () => {
  const padded = manifest.types.padded;
  assert.equal(padded?.kind, "struct");
  if (padded?.kind !== "struct") return;
  const invalid = {
    ...manifest,
    types: {
      ...manifest.types,
      padded: {
        ...padded,
        abiPassing: padded.abiPassing === undefined
          ? undefined
          : {
              ...padded.abiPassing,
              parameters: padded.abiPassing.parameters.map((parameter, index) =>
                index === 0 ? { ...parameter, structureReturn: false } : parameter
              ),
            },
      },
    },
  };

  assert.equal(validationCodes(invalid).includes("NTS3002"), true);
});

test("SCABI rejects unknown and ambiguous source type identities", () => {
  const unknown = {
    ...manifest,
    declarations: {
      ...manifest.declarations,
      types: {
        ...manifest.declarations.types,
        ghost: { module: ".", name: "Ghost" },
      },
    },
  };
  assert.equal(validationCodes(unknown).includes("NTS3002"), true);

  const duplicate = {
    ...manifest,
    declarations: {
      ...manifest.declarations,
      types: {
        ...manifest.declarations.types,
        u32: manifest.declarations.types.i32,
      },
    },
  };
  assert.equal(validationCodes(duplicate).includes("NTS3002"), true);
});

test("SCABI admits a number conversion wherever a number can carry the slot", () => {
  const identity = manifest.bindings.i32_identity;
  const wide = manifest.bindings.i64_identity;
  assert.notEqual(identity?.kind, "constant");
  assert.notEqual(wide?.kind, "constant");
  if (
    identity === undefined || identity.kind === "constant" ||
    wide === undefined || wide.kind === "constant"
  ) {
    return;
  }
  const converted = (
    binding: typeof identity,
    id: string,
    extra: Record<string, unknown> = {},
  ) => ({
    ...manifest,
    bindings: {
      ...manifest.bindings,
      [id]: {
        ...binding,
        ...extra,
        signature: {
          ...binding.signature,
          parameters: [
            { ...binding.signature.parameters[0]!, conversion: "number" },
          ],
          result: { ...binding.signature.result, conversion: "number" },
        },
      },
    },
  });

  /* 32 bits and narrower round-trip through a double exactly, so neither
   * direction can fail. */
  assert.equal(
    validateScabiManifest(converted(identity, "i32_identity")).ok,
    true,
  );
  /* 64 bits and pointer width carry a number too. Writing one is checked like
   * any other width; reading one is checked as well, because the value may be
   * one no double denotes — which is a throw the caller sees rather than a
   * silent 1-away answer. */
  assert.equal(
    validateScabiManifest(converted(wide, "i64_identity")).ok,
    true,
  );
  /* A struct field is the position that may not: a field read has nowhere to
   * fail, so its conversion stays where the widening cannot. */
  const wideField = {
    ...manifest,
    types: {
      ...manifest.types,
      pair32: {
        ...manifest.types.pair32,
        fields: [
          { name: "first", type: "i64", offset: 0, conversion: "number" },
          { name: "second", type: "i32", offset: 8 },
        ],
      },
    },
  };
  assert.equal(validationCodes(wideField).includes("NTS3002"), true);
  /* A failure contract is read from the exact scalar the source never sees. */
  assert.equal(validationCodes(converted(identity, "i32_identity", {
      error: { kind: "errno", failureValue: "-1" },
    })).includes("NTS3002"), true);
});

test("SCABI rejects implicit ownership for a native pointer", () => {
  const allocation = manifest.bindings.bytes_allocate;
  assert.notEqual(allocation?.kind, "constant");
  if (allocation === undefined || allocation.kind === "constant") {
    return;
  }
  const invalid = {
    ...manifest,
    bindings: {
      ...manifest.bindings,
      bytes_allocate: {
        ...allocation,
        signature: {
          ...allocation.signature,
          result: {
            ...allocation.signature.result,
            ownership: { kind: "value" },
          },
        },
      },
    },
  };

  assert.equal(validationCodes(invalid).includes("NTS3002"), true);
});

test("SCABI rejects borrowed arguments at foreign callback ingress", () => {
  const subscribe = manifest.bindings.subscription_create;
  assert.notEqual(subscribe?.kind, "constant");
  if (subscribe === undefined || subscribe.kind === "constant") {
    return;
  }
  const [callback, context] = subscribe.signature.parameters;
  assert.notEqual(callback?.callback, undefined);
  if (callback?.callback === undefined || context === undefined) {
    return;
  }
  const invalid = {
    ...manifest,
    bindings: {
      ...manifest.bindings,
      subscription_create: {
        ...subscribe,
        signature: {
          ...subscribe.signature,
          parameters: [
            {
              ...callback,
              callback: {
                ...callback.callback,
                arguments: [{ parameter: "value", transport: "borrow" }],
              },
            },
            context,
          ],
        },
      },
    },
  };

  assert.equal(validationCodes(invalid).includes("NTS3002"), true);
});
