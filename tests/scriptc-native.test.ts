import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parseScabiManifest } from "@native-typescript/scabi";
import {
  composeScriptCNativePrograms,
  translateScabiNativeProgram,
  type ScriptCNativeBinding,
  type ScriptCNativeValueType,
} from "@native-typescript/scriptc";

const fixtureRoot = resolve(import.meta.dirname, "../fixtures/scabi-c-v1");
const manifest = parseScabiManifest(
  readFileSync(resolve(fixtureRoot, "package.scabi.json"), "utf8"),
);
const gtkCounterManifest = parseScabiManifest(
  readFileSync(resolve(import.meta.dirname, "../fixtures/gtk-counter/package.scabi.json"), "utf8"),
);

function selectImports(imports: readonly string[]) {
  return { imports, exports: [] } as const;
}

type DirectNativeParameter = Omit<
  ScriptCNativeBinding["parameters"][number],
  "projection" | "type"
> & { readonly type: ScriptCNativeValueType };

function directSignature(parameters: readonly DirectNativeParameter[]) {
  return {
    arguments: parameters.map(({ name, type }) => ({ name, type })),
    parameters: parameters.map((parameter, argument) => ({
      ...parameter,
      projection: { kind: "argument" as const, argument },
    })),
  };
}

test("translated native packages compose canonically with build requirements", () => {
  const scalar = translateScabiNativeProgram(manifest, selectImports(["i32_identity"]));
  const runtime = translateScabiNativeProgram(
    gtkCounterManifest,
    selectImports(["runtime_start"]),
  );
  assert.equal(scalar.ok, true);
  assert.equal(runtime.ok, true);
  if (!scalar.ok || !runtime.ok) return;

  const left = composeScriptCNativePrograms([scalar, runtime]);
  const right = composeScriptCNativePrograms([runtime, scalar]);
  assert.deepEqual(left, right);
  assert.equal(left.ok, true);
  if (!left.ok) return;
  assert.deepEqual(
    left.input.bindings.map(({ id }) => id),
    [
      "native-typescript.fixture.c-v1@0.0.0#i32_identity",
      "native-typescript.fixture.gtk-counter@0.0.0#runtime_start",
    ],
  );
  assert.deepEqual(left.build, runtime.build);
  assert.equal(Object.isFrozen(left.input), true);
  assert.equal(Object.isFrozen(left.input.target), true);
  assert.equal(Object.isFrozen(left.input.bindings), true);
  assert.equal(Object.isFrozen(left.build), true);
  assert.equal(Object.isFrozen(left.build.linkInputs), true);
  const deduplicated = composeScriptCNativePrograms([scalar, scalar]);
  assert.equal(deduplicated.ok, true);
  if (deduplicated.ok) assert.equal(deduplicated.input.bindings.length, 1);

  const withOperation = structuredClone(scalar);
  Object.assign(withOperation.input, {
    operations: [{
      id: "native-typescript.fixture.c-v1@0.0.0#i32_combine",
      declaration: {
        module: "@native-typescript/scabi-c-v1-fixture",
        name: "FixtureValue.combine",
      },
      kind: "integer-reduce",
      operator: "|",
      type: { kind: "nativeScalar", scalar: "i32" },
    }],
  });
  const operationComposition = composeScriptCNativePrograms([withOperation, withOperation]);
  assert.equal(operationComposition.ok, true);
  if (operationComposition.ok) {
    assert.equal(operationComposition.input.operations.length, 1);
    assert.equal(Object.isFrozen(operationComposition.input.operations), true);
  }

  const shiftedRuntime = structuredClone(runtime);
  shiftedRuntime.build.linkInputs.forEach((input) => {
    Object.assign(input, { order: input.order + 100 });
  });
  const shifted = composeScriptCNativePrograms([runtime, shiftedRuntime]);
  assert.deepEqual(shifted, runtime);
});

test("native package composition rejects target and source identity collisions", () => {
  const translated = translateScabiNativeProgram(manifest, selectImports(["i32_identity"]));
  assert.equal(translated.ok, true);
  if (!translated.ok) return;

  const conflictingTarget = structuredClone(translated);
  Object.assign(conflictingTarget.input.target, { abi: "aarch64" });
  const targetResult = composeScriptCNativePrograms([translated, conflictingTarget]);
  assert.equal(targetResult.ok, false);
  if (targetResult.ok) return;
  assert.deepEqual(
    targetResult.diagnostics.map(({ path }) => path),
    ["/programs/1/input/target"],
  );

  const conflictingBinding = structuredClone(translated);
  Object.assign(conflictingBinding.input.bindings[0]!, {
    id: "other-package#same-declaration",
  });
  const bindingResult = composeScriptCNativePrograms([translated, conflictingBinding]);
  assert.equal(bindingResult.ok, false);
  if (bindingResult.ok) return;
  assert.deepEqual(
    bindingResult.diagnostics.map(({ path }) => path),
    ["/programs/1/input/bindings/0"],
  );

  const withOperation = structuredClone(translated);
  Object.assign(withOperation.input, {
    operations: [{
      id: "native-typescript.fixture.c-v1@0.0.0#i32_combine",
      declaration: {
        module: "@native-typescript/scabi-c-v1-fixture",
        name: "FixtureValue.combine",
      },
      kind: "integer-reduce",
      operator: "|",
      type: { kind: "nativeScalar", scalar: "i32" },
    }],
  });
  const conflictingOperation = structuredClone(withOperation);
  Object.assign(conflictingOperation.input.operations[0]!, { operator: "^" });
  const operationResult = composeScriptCNativePrograms([withOperation, conflictingOperation]);
  assert.equal(operationResult.ok, false);
  if (operationResult.ok) return;
  assert.deepEqual(
    operationResult.diagnostics.map(({ path }) => path),
    ["/programs/1/input/operations/0", "/programs/1/input/operations/0"],
  );

  const runtime = translateScabiNativeProgram(
    gtkCounterManifest,
    selectImports(["runtime_start"]),
  );
  assert.equal(runtime.ok, true);
  if (!runtime.ok) return;
  const conflictingLinkInput = structuredClone(runtime);
  Object.assign(conflictingLinkInput.build.linkInputs[0]!, { name: "other-runtime" });
  const linkInputResult = composeScriptCNativePrograms([runtime, conflictingLinkInput]);
  assert.equal(linkInputResult.ok, false);
  if (linkInputResult.ok) return;
  assert.equal(
    linkInputResult.diagnostics.some(({ path }) =>
      path === "/programs/1/build/linkInputs/0"
    ),
    true,
  );

  const reversedLinkInputs = structuredClone(runtime);
  reversedLinkInputs.build.linkInputs.forEach((input) => {
    Object.assign(input, { order: runtime.build.linkInputs.length - input.order });
  });
  const linkOrderResult = composeScriptCNativePrograms([runtime, reversedLinkInputs]);
  assert.equal(linkOrderResult.ok, false);
  if (linkOrderResult.ok) return;
  assert.equal(
    linkOrderResult.diagnostics.some(({ path }) => path === "/build/linkInputs"),
    true,
  );
});

test("SCABI exact i32 translates to immutable generic ScriptC input", () => {
  const result = translateScabiNativeProgram(manifest, selectImports(["i32_identity"]));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.input, {
    target: { pointerBits: 64, abi: "sysv-amd64" },
    sourceTypes: [
      {
        declaration: {
          module: "@native-typescript/scabi-c-v1-fixture",
          name: "i32",
        },
        type: { kind: "nativeScalar", scalar: "i32" },
      },
    ],
    constants: [],
    operations: [],
    types: [],
    bindings: [
      {
        id: "native-typescript.fixture.c-v1@0.0.0#i32_identity",
        declaration: {
          module: "@native-typescript/scabi-c-v1-fixture",
          name: "i32Identity",
        },
        entry: { kind: "c-symbol", symbol: "nts_i32_identity" },
        callingConvention: "c",
        variadic: false,
        sourceCall: { kind: "function" },
        error: { kind: "no-fail" },
        ...directSignature([
          {
            name: "value",
            type: { kind: "nativeScalar", scalar: "i32" },
            passMode: "value",
            ownership: { kind: "value" },
          },
        ]),
        result: {
          type: { kind: "nativeScalar", scalar: "i32" },
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "direct" },
        },
      },
    ],
    exports: [],
  });
  assert.deepEqual(result.build, { linkInputs: [], adapterInputs: [] });
  assert.equal(Object.isFrozen(result.input), true);
  assert.equal(Object.isFrozen(result.input.bindings[0]), true);
});

test("SCABI enum constants lower to exact declaration-backed literals", () => {
  const enumManifest = structuredClone(manifest);
  Object.assign(enumManifest.types, {
    fixture_orientation: {
      kind: "enum",
      underlying: "i32",
      members: { horizontal: "0", vertical: "1" },
    },
  });
  Object.assign(enumManifest.declarations.types, {
    fixture_orientation: { module: ".", name: "FixtureOrientation" },
  });
  Object.assign(enumManifest.bindings, {
    fixture_orientation_vertical: {
      kind: "constant",
      declaration: { module: ".", name: "FixtureOrientation.vertical" },
      type: "fixture_orientation",
      value: "1",
      dependencies: {
        adapterInputs: [],
        bindings: [],
        linkInputs: [],
        permissions: [],
      },
    },
  });

  const result = translateScabiNativeProgram(
    enumManifest,
    selectImports(["fixture_orientation_vertical"]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.input.sourceTypes, [{
    declaration: {
      module: "@native-typescript/scabi-c-v1-fixture",
      name: "FixtureOrientation",
    },
    type: { kind: "nativeScalar", scalar: "i32" },
  }]);
  assert.deepEqual(result.input.constants, [{
    id: "native-typescript.fixture.c-v1@0.0.0#fixture_orientation_vertical",
    declaration: {
      module: "@native-typescript/scabi-c-v1-fixture",
      name: "FixtureOrientation.vertical",
    },
    type: { kind: "nativeScalar", scalar: "i32" },
    value: "1",
  }]);
  assert.deepEqual(result.input.bindings, []);
  assert.deepEqual(result.build, { linkInputs: [], adapterInputs: [] });
  assert.equal(Object.isFrozen(result.input.constants), true);
  assert.equal(Object.isFrozen(result.input.constants[0]), true);

  const unnamedMember = structuredClone(enumManifest);
  const unnamedBinding = unnamedMember.bindings.fixture_orientation_vertical;
  assert.equal(unnamedBinding?.kind, "constant");
  if (unnamedBinding?.kind !== "constant") return;
  Object.assign(unnamedBinding, { value: "2" });
  const unnamedResult = translateScabiNativeProgram(
    unnamedMember,
    selectImports(["fixture_orientation_vertical"]),
  );
  assert.equal(unnamedResult.ok, false);
  if (!unnamedResult.ok) {
    assert.deepEqual(
      unnamedResult.diagnostics.map(({ path }) => path),
      ["/bindings/fixture_orientation_vertical/value"],
    );
  }

  const noncanonical = structuredClone(enumManifest);
  const noncanonicalBinding = noncanonical.bindings.fixture_orientation_vertical;
  assert.equal(noncanonicalBinding?.kind, "constant");
  if (noncanonicalBinding?.kind !== "constant") return;
  Object.assign(noncanonicalBinding, { value: "+1" });
  const noncanonicalResult = translateScabiNativeProgram(
    noncanonical,
    selectImports(["fixture_orientation_vertical"]),
  );
  assert.equal(noncanonicalResult.ok, false);
  if (!noncanonicalResult.ok) {
    assert.deepEqual(
      noncanonicalResult.diagnostics.map(({ path }) => path),
      ["/bindings/fixture_orientation_vertical/value"],
    );
  }

  const duplicate = composeScriptCNativePrograms([result, result]);
  assert.equal(duplicate.ok, true);
  if (duplicate.ok) assert.equal(duplicate.input.constants.length, 1);
  const conflicting = structuredClone(result);
  Object.assign(conflicting.input.constants[0]!, { value: "2" });
  const collision = composeScriptCNativePrograms([result, conflicting]);
  assert.equal(collision.ok, false);
  if (!collision.ok) {
    assert.deepEqual(
      collision.diagnostics.map(({ path }) => path),
      [
        "/programs/1/input/constants/0",
        "/programs/1/input/constants/0",
      ],
    );
  }
});

test("SCABI maps a TypeScript implementation onto an exact C export contract", () => {
  const result = translateScabiNativeProgram(manifest, {
    imports: [],
    exports: [{ bindingId: "ts_add_i32", sourceExport: "ntsTsAddI32" }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const i32 = { kind: "nativeScalar", scalar: "i32" } as const;
  assert.deepEqual(result.input, {
    target: { pointerBits: 64, abi: "sysv-amd64" },
    sourceTypes: [{
      declaration: {
        module: "@native-typescript/scabi-c-v1-fixture",
        name: "i32",
      },
      type: i32,
    }],
    constants: [],
    operations: [],
    types: [],
    bindings: [],
    exports: [{
      id: "native-typescript.fixture.c-v1@0.0.0#ts_add_i32",
      sourceExport: "ntsTsAddI32",
      declaration: {
        module: "@native-typescript/scabi-c-v1-fixture",
        name: "FixtureLibraryExports.ntsTsAddI32",
      },
      entry: { kind: "c-symbol", symbol: "nts_ts_add_i32" },
      callingConvention: "c",
      variadic: false,
      error: { kind: "no-fail" },
      parameters: [
        {
          name: "left",
          type: i32,
          passMode: "value",
          ownership: { kind: "value" },
        },
        {
          name: "right",
          type: i32,
          passMode: "value",
          ownership: { kind: "value" },
        },
      ],
      result: {
        type: i32,
        passMode: "value",
        ownership: { kind: "value" },
      },
    }],
  });
  assert.deepEqual(result.build.linkInputs, []);
  assert.deepEqual(
    result.build.adapterInputs.map(({ id }) => id),
    ["ts_export_adapter"],
  );
  assert.equal(Object.isFrozen(result.input.exports[0]), true);
  assert.equal(Object.isFrozen(result.input.exports[0]?.parameters), true);
});

test("SCABI refuses a selected export whose adapter contract is not C-export", () => {
  const invalid = structuredClone(manifest);
  const adapter = invalid.adapterInputs.find(({ id }) => id === "ts_export_adapter");
  assert.notEqual(adapter, undefined);
  if (adapter === undefined) return;
  Object.assign(adapter, { family: "jni" as const });

  const result = translateScabiNativeProgram(invalid, {
    imports: [],
    exports: [{ bindingId: "ts_add_i32", sourceExport: "ntsTsAddI32" }],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(
    result.diagnostics.map(({ code, path }) => ({ code, path })),
    [{ code: "NTS3002", path: "/bindings/ts_add_i32" }],
  );
});

test("SCABI translates every reached integer with exact signedness and width", () => {
  const result = translateScabiNativeProgram(manifest, selectImports([
    "i8_identity",
    "u8_identity",
    "i16_identity",
    "u16_identity",
    "i32_identity",
    "u32_identity",
    "i64_identity",
    "u64_identity",
    "usize_identity",
  ]));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(
    Object.fromEntries(
      result.input.sourceTypes.map(({ declaration, type }) => [
        declaration.name,
        type.kind === "nativeScalar" ? type.scalar : type.kind,
      ]),
    ),
    {
      i8: "i8",
      u8: "u8",
      i16: "i16",
      u16: "u16",
      i32: "i32",
      u32: "u32",
      i64: "i64",
      u64: "u64",
      usize: "usize",
    },
  );
  assert.deepEqual(
    Object.fromEntries(
      result.input.bindings.map((binding) => [
        binding.declaration.name,
        {
          parameter:
            binding.parameters[0]?.type.kind === "nativeScalar"
              ? binding.parameters[0].type.scalar
              : binding.parameters[0]?.type.kind,
          result:
            binding.result.type.kind === "nativeScalar"
              ? binding.result.type.scalar
              : binding.result.type.kind,
        },
      ]),
    ),
    {
      i8Identity: { parameter: "i8", result: "i8" },
      u8Identity: { parameter: "u8", result: "u8" },
      i16Identity: { parameter: "i16", result: "i16" },
      u16Identity: { parameter: "u16", result: "u16" },
      i32Identity: { parameter: "i32", result: "i32" },
      u32Identity: { parameter: "u32", result: "u32" },
      i64Identity: { parameter: "i64", result: "i64" },
      u64Identity: { parameter: "u64", result: "u64" },
      usizeIdentity: { parameter: "usize", result: "usize" },
    },
  );
});

test("SCABI projects integer-backed native boolean parameters and results", () => {
  const result = translateScabiNativeProgram(
    manifest,
    selectImports(["native_not"]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.input.sourceTypes, []);
  assert.deepEqual(result.input.bindings[0]?.declaration, {
    module: "@native-typescript/scabi-c-v1-fixture",
    name: "nativeNot",
  });
  assert.deepEqual(result.input.bindings[0]?.arguments, [
    { name: "value", type: { kind: "bool" } },
  ]);
  assert.deepEqual(result.input.bindings[0]?.parameters, [{
    name: "value",
    type: { kind: "nativeScalar", scalar: "i32" },
    passMode: "value",
    ownership: { kind: "value" },
    projection: {
      kind: "boolean",
      argument: 0,
      falseValue: "0",
      trueValue: "1",
    },
  }]);
  assert.deepEqual(result.input.bindings[0]?.result, {
    type: { kind: "nativeScalar", scalar: "i32" },
    passMode: "value",
    ownership: { kind: "value" },
    projection: { kind: "boolean", falseValue: "0", trueValue: "1" },
  });
});

test("SCABI projects one borrowed UTF-8 string into pointer and byte-length ABI slots", () => {
  const result = translateScabiNativeProgram(manifest, selectImports(["hash_utf8"]));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.input.sourceTypes, [
    {
      declaration: {
        module: "@native-typescript/scabi-c-v1-fixture",
        name: "u64",
      },
      type: { kind: "nativeScalar", scalar: "u64" },
    },
  ]);
  assert.deepEqual(result.input.bindings, [
    {
      id: "native-typescript.fixture.c-v1@0.0.0#hash_utf8",
      declaration: {
        module: "@native-typescript/scabi-c-v1-fixture",
        name: "hashUtf8",
      },
      entry: { kind: "c-symbol", symbol: "nts_hash_utf8" },
      callingConvention: "c",
      variadic: false,
      sourceCall: { kind: "function" },
      error: { kind: "no-fail" },
      arguments: [{ name: "data", type: { kind: "string" } }],
      parameters: [
        {
          name: "data",
          type: {
            kind: "nativePointer",
            pointee: "i8",
            const: true,
            addressSpace: 0,
          },
          passMode: "pointer",
          ownership: { kind: "borrowed", scope: "call" },
          projection: { kind: "utf8Data", argument: 0 },
        },
        {
          name: "length",
          type: { kind: "nativeScalar", scalar: "usize" },
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "utf8ByteLength", argument: 0 },
        },
      ],
      result: {
        type: { kind: "nativeScalar", scalar: "u64" },
        passMode: "value",
        ownership: { kind: "value" },
        projection: { kind: "direct" },
      },
    },
  ]);
});

test("SCABI projects a checked NUL-terminated UTF-8 string into one C pointer", () => {
  const terminated = structuredClone(manifest);
  const binding = terminated.bindings.hash_utf8;
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

  const result = translateScabiNativeProgram(terminated, selectImports(["hash_utf8"]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.input.bindings[0]?.arguments, [
    { name: "data", type: { kind: "string" } },
  ]);
  assert.deepEqual(result.input.bindings[0]?.parameters, [
    {
      name: "data",
      type: {
        kind: "nativePointer",
        pointee: "i8",
        const: true,
        addressSpace: 0,
      },
      passMode: "pointer",
      ownership: { kind: "borrowed", scope: "call" },
      projection: { kind: "utf8CString", argument: 0 },
    },
  ]);
});

test("SCABI projects receiver-borrowed C-string results with exact nullability", () => {
  const result = translateScabiNativeProgram(
    manifest,
    selectImports(["counter_label", "counter_required_label"]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const projections = Object.fromEntries(
    result.input.bindings.map((binding) => [binding.declaration.name, binding.result]),
  );
  const physical = {
    kind: "nativePointer",
    pointee: "i8",
    const: true,
    addressSpace: 0,
  } as const;
  const ownership = {
    kind: "borrowed",
    scope: "receiver",
    anchor: "counter",
  } as const;
  assert.deepEqual(projections["Counter.label"], {
    type: physical,
    passMode: "pointer",
    ownership,
    projection: { kind: "utf8CString", nullable: true },
  });
  assert.deepEqual(projections["Counter.requiredLabel"], {
    type: physical,
    passMode: "pointer",
    ownership,
    projection: { kind: "utf8CString", nullable: false },
  });
});

test("SCABI refuses a C-string result not anchored to its receiver", () => {
  const invalid = structuredClone(manifest);
  const binding = invalid.bindings.counter_label;
  assert.notEqual(binding?.kind, "constant");
  if (binding === undefined || binding.kind === "constant") return;
  Object.assign(binding.signature.result.ownership, { anchor: "missing" });

  const result = translateScabiNativeProgram(
    invalid,
    selectImports(["counter_label"]),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(
    result.diagnostics.map(({ code, path }) => ({ code, path })),
    [{ code: "NTS3002", path: "/bindings/counter_label/signature/result" }],
  );
});

test("SCABI adapter-symbol imports retain their generated adapter dependency", () => {
  const adapted = structuredClone(manifest);
  const binding = adapted.bindings.hash_utf8;
  assert.notEqual(binding?.kind, "constant");
  if (binding === undefined || binding.kind === "constant") return;
  Object.assign(binding.entry, { kind: "adapter-symbol" as const });
  Object.assign(binding.dependencies, {
    adapterInputs: ["adapter/hash-utf8"],
  });
  Object.assign(adapted, {
    adapterInputs: [
      {
        id: "adapter/hash-utf8",
        family: "test",
        language: "c" as const,
        bindings: ["hash_utf8"],
        outputs: ["hash-utf8.o"],
        options: {},
      },
    ],
  });

  const result = translateScabiNativeProgram(adapted, selectImports(["hash_utf8"]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.build.adapterInputs.map(({ id }) => id),
    ["adapter/hash-utf8"],
  );
  assert.deepEqual(result.input.bindings[0]?.entry, {
    kind: "c-symbol",
    symbol: "nts_hash_utf8",
  });
});

test("SCABI projects one borrowed Uint8Array into exact data and byte-length slots", () => {
  const result = translateScabiNativeProgram(manifest, selectImports(["hash_bytes"]));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.input.sourceTypes, [
    {
      declaration: {
        module: "@native-typescript/scabi-c-v1-fixture",
        name: "u64",
      },
      type: { kind: "nativeScalar", scalar: "u64" },
    },
  ]);
  assert.deepEqual(result.input.bindings, [
    {
      id: "native-typescript.fixture.c-v1@0.0.0#hash_bytes",
      declaration: {
        module: "@native-typescript/scabi-c-v1-fixture",
        name: "hashBytes",
      },
      entry: { kind: "c-symbol", symbol: "nts_hash_bytes" },
      callingConvention: "c",
      variadic: false,
      sourceCall: { kind: "function" },
      error: { kind: "no-fail" },
      arguments: [{ name: "data", type: { kind: "bytes", elem: "u8" } }],
      parameters: [
        {
          name: "data",
          type: {
            kind: "nativePointer",
            pointee: "u8",
            const: true,
            addressSpace: 0,
          },
          passMode: "pointer",
          ownership: { kind: "borrowed", scope: "call" },
          projection: { kind: "bytesData", argument: 0 },
        },
        {
          name: "length",
          type: { kind: "nativeScalar", scalar: "usize" },
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "bytesByteLength", argument: 0 },
        },
      ],
      result: {
        type: { kind: "nativeScalar", scalar: "u64" },
        passMode: "value",
        ownership: { kind: "value" },
        projection: { kind: "direct" },
      },
    },
  ]);
});

test("SCABI refuses byte contracts that require mutable native access", () => {
  const mutable = structuredClone(manifest);
  const binding = mutable.bindings.hash_bytes;
  assert.notEqual(binding?.kind, "constant");
  if (binding === undefined || binding.kind === "constant") return;
  const data = binding.signature.parameters[0];
  assert.equal(data?.marshal?.kind, "bytes");
  if (data?.marshal?.kind !== "bytes") return;
  Object.assign(data.marshal, { mutability: "mutable" as const });

  const result = translateScabiNativeProgram(mutable, selectImports(["hash_bytes"]));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("borrowed const byte spans")
    ),
    true,
  );
});

test("SCABI projects one call-scoped callback into function and context slots", () => {
  const result = translateScabiNativeProgram(manifest, selectImports(["call_scoped"]));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const i32 = { kind: "nativeScalar", scalar: "i32" } as const;
  const signature = {
    callingConvention: "c",
    parameters: [i32],
    result: i32,
    context: { placement: "last" },
  } as const;
  assert.deepEqual(result.input.sourceTypes, [
    {
      declaration: {
        module: "@native-typescript/scabi-c-v1-fixture",
        name: "i32",
      },
      type: i32,
    },
  ]);
  assert.deepEqual(result.input.bindings, [
    {
      id: "native-typescript.fixture.c-v1@0.0.0#call_scoped",
      declaration: {
        module: "@native-typescript/scabi-c-v1-fixture",
        name: "callScoped",
      },
      entry: { kind: "c-symbol", symbol: "nts_call_scoped" },
      callingConvention: "c",
      variadic: false,
      sourceCall: { kind: "function" },
      error: { kind: "no-fail" },
      arguments: [
        {
          name: "callback",
          type: { kind: "func", params: [i32], ret: i32 },
          callback: {
            lifetime: "call",
            registrationOwner: { kind: "native-call" },
            allowedInvocationExecutors: ["same-as-caller"],
            deliveryExecutor: "same-as-caller",
            synchronousReturn: true,
            transports: [{ kind: "borrow" }],
            sourceArguments: [{ kind: "callback-parameter", parameter: 0 }],
            reentrancy: "required",
            postDisposal: "not-invoked",
            shutdown: "drain",
          },
        },
        { name: "value", type: i32 },
      ],
      parameters: [
        {
          name: "callback",
          type: { kind: "nativeCallback", signature },
          passMode: "pointer",
          ownership: { kind: "callback", lifetime: "call" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callback", lifetime: "call" },
          projection: { kind: "callbackContext", argument: 0 },
        },
        {
          name: "value",
          type: i32,
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "argument", argument: 1 },
        },
      ],
      result: {
        type: i32,
        passMode: "value",
        ownership: { kind: "value" },
        projection: { kind: "direct" },
      },
    },
  ]);
});

test("SCABI translates an until-cancelled callback with exact result ownership", () => {
  const result = translateScabiNativeProgram(
    manifest,
    selectImports(["subscription_create"]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const instance = "native-typescript.fixture.c-v1@0.0.0";
  const i32 = { kind: "nativeScalar", scalar: "i32" } as const;
  const callback = {
    lifetime: "until-cancelled",
    registrationOwner: { kind: "result" },
    cancellationBinding: `${instance}#subscription_destroy`,
    allowedInvocationExecutors: ["same-as-caller", "any-attached-thread"],
    deliveryExecutor: "runtime-owner",
    synchronousReturn: false,
    transports: [{ kind: "copy" }],
    sourceArguments: [{ kind: "callback-parameter", parameter: 0 }],
    reentrancy: "allowed",
    postDisposal: "not-invoked",
    shutdown: "drain",
  } as const;
  const typeId = `${instance}#type:subscription`;
  assert.deepEqual(result.input.types, [{
    kind: "handle",
    id: typeId,
    declaration: {
      module: "@native-typescript/scabi-c-v1-fixture",
      name: "Subscription",
    },
    nativeName: "NtsSubscription",
    threadSafety: "shared",
    identity: "pointer",
    cycleCollection: "none",
    upcasts: [],
  }]);
  assert.deepEqual(result.input.bindings[0], {
    id: `${instance}#subscription_create`,
    declaration: {
      module: "@native-typescript/scabi-c-v1-fixture",
      name: "subscribe",
    },
    entry: { kind: "c-symbol", symbol: "nts_subscription_create" },
    callingConvention: "c",
    variadic: false,
    sourceCall: { kind: "function" },
    error: { kind: "nullable" },
    arguments: [{
      name: "callback",
      type: { kind: "func", params: [i32], ret: { kind: "void" } },
      callback,
    }],
    parameters: [
      {
        name: "callback",
        type: {
          kind: "nativeCallback",
          signature: {
            callingConvention: "c",
            parameters: [i32],
            result: { kind: "void" },
            context: { placement: "last" },
          },
        },
        passMode: "pointer",
        ownership: { kind: "callback", lifetime: "until-cancelled" },
        projection: { kind: "callbackFunction", argument: 0 },
      },
      {
        name: "context",
        type: { kind: "nativeContext", addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "callback", lifetime: "until-cancelled" },
        projection: { kind: "callbackContext", argument: 0 },
      },
    ],
    result: {
      type: { kind: "nativeHandle", typeId },
      passMode: "pointer",
      ownership: {
        kind: "owned",
        transfer: "to-runtime",
        destructor: `${instance}#subscription_destroy`,
      },
      projection: { kind: "direct" },
    },
  });
  assert.deepEqual(
    result.input.bindings.map(({ id }) => id),
    [`${instance}#subscription_create`, `${instance}#subscription_destroy`],
  );
  assert.deepEqual(result.build.linkInputs.map(({ id }) => id), ["pthread"]);
});

test("SCABI refuses callback contracts outside the two executable slices", () => {
  const retained = structuredClone(manifest);
  const retainedBinding = retained.bindings.call_scoped;
  assert.notEqual(retainedBinding?.kind, "constant");
  if (retainedBinding === undefined || retainedBinding.kind === "constant") return;
  const callback = retainedBinding.signature.parameters[0]?.callback;
  assert.notEqual(callback, undefined);
  if (callback === undefined) return;
  Object.assign(callback, { lifetime: "retained" as const });

  const retainedResult = translateScabiNativeProgram(retained, selectImports(["call_scoped"]));
  assert.equal(retainedResult.ok, false);
  if (!retainedResult.ok) {
    assert.equal(
      retainedResult.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("outside the implemented call and until-cancelled slice")
      ),
      true,
    );
  }

  const foreign = structuredClone(manifest);
  const foreignBinding = foreign.bindings.call_scoped;
  assert.notEqual(foreignBinding?.kind, "constant");
  if (foreignBinding === undefined || foreignBinding.kind === "constant") return;
  const foreignCallback = foreignBinding.signature.parameters[0]?.callback;
  assert.notEqual(foreignCallback, undefined);
  if (foreignCallback === undefined) return;
  Object.assign(foreignCallback, {
    deliveryExecutor: { kind: "foreign-attached-thread" as const },
  });

  const foreignResult = translateScabiNativeProgram(foreign, selectImports(["call_scoped"]));
  assert.equal(foreignResult.ok, false);
  if (foreignResult.ok) return;
  assert.equal(
    foreignResult.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("same-caller call-lifetime callbacks")
    ),
    true,
  );
});

test("SCABI translation rejects only requested unsupported bindings", () => {
  const supported = translateScabiNativeProgram(manifest, selectImports(["usize_identity"]));
  assert.equal(supported.ok, true);

  const unsupported = translateScabiNativeProgram(manifest, selectImports(["f32_identity"]));
  assert.equal(unsupported.ok, false);
  if (unsupported.ok) return;
  assert.deepEqual(
    unsupported.diagnostics.map(({ code, path }) => ({ code, path })),
    [
      { code: "NTS3002", path: "/bindings/f32_identity/signature/parameters/0/type" },
      { code: "NTS3002", path: "/bindings/f32_identity/signature/result/type" },
    ],
  );
});

test("SCABI lowers an exact errno sentinel without losing its physical result", () => {
  const result = translateScabiNativeProgram(manifest, selectImports(["fail_errno"]));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.input.bindings, [
    {
      id: "native-typescript.fixture.c-v1@0.0.0#fail_errno",
      declaration: {
        module: "@native-typescript/scabi-c-v1-fixture",
        name: "failErrno",
      },
      entry: { kind: "c-symbol", symbol: "nts_fail_errno" },
      callingConvention: "c",
      variadic: false,
      sourceCall: { kind: "function" },
      error: { kind: "errno", failureValue: "-1" },
      ...directSignature([
        {
          name: "error_number",
          type: { kind: "nativeScalar", scalar: "i32" },
          passMode: "value",
          ownership: { kind: "value" },
        },
      ]),
      result: {
        type: { kind: "nativeScalar", scalar: "i32" },
        passMode: "value",
        ownership: { kind: "value" },
        projection: { kind: "direct" },
      },
    },
  ]);

  const invalid = structuredClone(manifest);
  const binding = invalid.bindings.fail_errno;
  assert.notEqual(binding?.kind, "constant");
  if (binding === undefined || binding.kind === "constant") return;
  Object.assign(binding.error, { failureValue: "2147483648" });
  const rejected = translateScabiNativeProgram(invalid, selectImports(["fail_errno"]));
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.deepEqual(
    rejected.diagnostics.map(({ code, path }) => ({ code, path })),
    [{ code: "NTS3002", path: "/bindings/fail_errno/error/failureValue" }],
  );
});

test("SCABI translates authoritative padded layout and by-value ABI metadata", () => {
  const result = translateScabiNativeProgram(manifest, selectImports(["padded_roundtrip"]));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const typeId = "native-typescript.fixture.c-v1@0.0.0#type:padded";
  assert.deepEqual(result.input.types, [
    {
      kind: "struct",
      id: typeId,
      declaration: {
        module: "@native-typescript/scabi-c-v1-fixture",
        name: "Padded",
      },
      size: 24,
      alignment: 8,
      packing: "default",
      triviallyCopyable: true,
      destruction: "trivial",
      abi: {
        result: {
          type: { kind: "void" },
          alignment: null,
          stackAlignment: null,
          extension: null,
          inRegister: false,
          byValue: false,
          structureReturn: false,
        },
        parameters: [
          {
            type: { kind: "pointer", addressSpace: 0 },
            alignment: 8,
            stackAlignment: null,
            extension: null,
            inRegister: false,
            byValue: false,
            structureReturn: true,
          },
          {
            type: { kind: "pointer", addressSpace: 0 },
            alignment: 8,
            stackAlignment: null,
            extension: null,
            inRegister: false,
            byValue: true,
            structureReturn: false,
          },
        ],
      },
      fields: [
        { name: "tag", type: { kind: "nativeScalar", scalar: "u8" }, offset: 0 },
        { name: "value", type: { kind: "nativeScalar", scalar: "u64" }, offset: 8 },
        { name: "ratio", type: { kind: "nativeScalar", scalar: "f64" }, offset: 16 },
      ],
    },
  ]);
  assert.deepEqual(result.input.bindings[0], {
    id: "native-typescript.fixture.c-v1@0.0.0#padded_roundtrip",
    declaration: {
      module: "@native-typescript/scabi-c-v1-fixture",
      name: "paddedRoundtrip",
    },
    entry: { kind: "c-symbol", symbol: "nts_padded_roundtrip" },
    callingConvention: "c",
    variadic: false,
    sourceCall: { kind: "function" },
    error: { kind: "no-fail" },
    ...directSignature([{ name: "value", type: { kind: "nativeStruct", typeId }, passMode: "value", ownership: { kind: "value" } }]),
    result: {
      type: { kind: "nativeStruct", typeId },
      passMode: "value",
      ownership: { kind: "value" },
      projection: { kind: "direct" },
    },
  });
});

test("SCABI preserves a target-Clang direct-register aggregate signature", () => {
  const result = translateScabiNativeProgram(manifest, selectImports(["pair32_transform"]));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const typeId = "native-typescript.fixture.c-v1@0.0.0#type:pair32";
  assert.deepEqual(result.input.types, [{
    kind: "struct",
    id: typeId,
    declaration: {
      module: "@native-typescript/scabi-c-v1-fixture",
      name: "Pair32",
    },
    size: 8,
    alignment: 4,
    packing: "default",
    triviallyCopyable: true,
    destruction: "trivial",
    abi: {
      result: {
        type: { kind: "integer", bits: 64 },
        alignment: null,
        stackAlignment: null,
        extension: null,
        inRegister: false,
        byValue: false,
        structureReturn: false,
      },
      parameters: [{
        type: { kind: "integer", bits: 64 },
        alignment: null,
        stackAlignment: null,
        extension: null,
        inRegister: false,
        byValue: false,
        structureReturn: false,
      }],
    },
    fields: [
      { name: "first", type: { kind: "nativeScalar", scalar: "i32" }, offset: 0 },
      { name: "second", type: { kind: "nativeScalar", scalar: "i32" }, offset: 4 },
    ],
  }]);
  assert.equal(
    result.input.bindings[0]?.id,
    "native-typescript.fixture.c-v1@0.0.0#pair32_transform",
  );
});

test("SCABI closes nested nominal aggregate definitions transitively", () => {
  const result = translateScabiNativeProgram(
    manifest,
    selectImports(["nested_pair32_transform"]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const instance = "native-typescript.fixture.c-v1@0.0.0";
  const pairId = `${instance}#type:pair32`;
  const nestedId = `${instance}#type:nested_pair32`;
  assert.deepEqual(result.input.types.map(({ id }) => id), [pairId, nestedId]);
  const nested = result.input.types[1];
  assert.equal(nested?.kind, "struct");
  if (nested?.kind !== "struct") return;
  assert.deepEqual(nested.fields, [
    { name: "left", type: { kind: "nativeStruct", typeId: pairId }, offset: 0 },
    { name: "right", type: { kind: "nativeStruct", typeId: pairId }, offset: 8 },
    { name: "marker", type: { kind: "nativeScalar", scalar: "i64" }, offset: 16 },
  ]);
});

test("SCABI closes owned handle factories over their exact destructor", () => {
  const result = translateScabiNativeProgram(manifest, selectImports(["counter_create"]));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const instance = "native-typescript.fixture.c-v1@0.0.0";
  const typeId = `${instance}#type:counter`;
  const baseTypeId = `${instance}#type:counter_base`;
  const middleTypeId = `${instance}#type:counter_middle`;
  assert.deepEqual(result.input.types, [
    {
      kind: "handle",
      id: baseTypeId,
      declaration: {
        module: "@native-typescript/scabi-c-v1-fixture",
        name: "CounterBase",
      },
      nativeName: "NtsCounterBase",
      threadSafety: "confined",
      identity: "pointer",
      cycleCollection: "none",
      upcasts: [],
    },
    {
      kind: "handle",
      id: middleTypeId,
      declaration: {
        module: "@native-typescript/scabi-c-v1-fixture",
        name: "CounterMiddle",
      },
      nativeName: "NtsCounterMiddle",
      threadSafety: "confined",
      identity: "pointer",
      cycleCollection: "none",
      upcasts: [{ kind: "identity", target: baseTypeId }],
    },
    {
      kind: "handle",
      id: typeId,
      declaration: {
        module: "@native-typescript/scabi-c-v1-fixture",
        name: "Counter",
      },
      nativeName: "NtsCounter",
      threadSafety: "confined",
      identity: "pointer",
      cycleCollection: "none",
      upcasts: [{ kind: "identity", target: middleTypeId }],
    },
  ]);
  assert.deepEqual(
    result.input.bindings.map((binding) => binding.id),
    [`${instance}#counter_create`, `${instance}#counter_destroy`],
  );
  assert.deepEqual(result.input.bindings[0], {
    id: `${instance}#counter_create`,
    declaration: {
      module: "@native-typescript/scabi-c-v1-fixture",
      name: "createCounter",
    },
    entry: { kind: "c-symbol", symbol: "nts_counter_create" },
    callingConvention: "c",
    variadic: false,
    sourceCall: { kind: "function" },
    error: { kind: "no-fail" },
    ...directSignature([
      {
        name: "initial_value",
        type: { kind: "nativeScalar", scalar: "i32" },
        passMode: "value",
        ownership: { kind: "value" },
      },
    ]),
    result: {
      type: { kind: "nativeHandle", typeId },
      passMode: "pointer",
      ownership: {
        kind: "owned",
        transfer: "to-runtime",
        destructor: `${instance}#counter_destroy`,
      },
      projection: { kind: "direct" },
    },
  });
  assert.deepEqual(result.input.bindings[1], {
    id: `${instance}#counter_destroy`,
    declaration: {
      module: "@native-typescript/scabi-c-v1-fixture",
      name: "Counter.dispose",
    },
    entry: { kind: "c-symbol", symbol: "nts_counter_destroy" },
    callingConvention: "c",
    variadic: false,
    sourceCall: { kind: "method", receiverArgument: 0 },
    error: { kind: "no-fail" },
    ...directSignature([
      {
        name: "counter",
        type: { kind: "nativeHandle", typeId },
        passMode: "pointer",
        ownership: { kind: "owned", transfer: "to-native" },
      },
    ]),
    result: {
      type: { kind: "void" },
      passMode: "value",
      ownership: { kind: "value" },
      projection: { kind: "direct" },
    },
  });
  assert.deepEqual(result.build.linkInputs, []);
});

test("SCABI lowers explicit identity handle upcasts into nominal Native IR", () => {
  const result = translateScabiNativeProgram(
    manifest,
    selectImports(["counter_create"]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const instance = "native-typescript.fixture.c-v1@0.0.0";
  assert.deepEqual(
    result.input.types.map((definition) => ({
      id: definition.id,
      upcasts: definition.kind === "handle" ? definition.upcasts : [],
    })),
    [
      { id: `${instance}#type:counter_base`, upcasts: [] },
      {
        id: `${instance}#type:counter_middle`,
        upcasts: [{
          kind: "identity",
          target: `${instance}#type:counter_base`,
        }],
      },
      {
        id: `${instance}#type:counter`,
        upcasts: [{
          kind: "identity",
          target: `${instance}#type:counter_middle`,
        }],
      },
    ],
  );
});

test("SCABI lowers nullable owned handles as errors rather than nullable source values", () => {
  const nullable = structuredClone(manifest);
  const binding = nullable.bindings.counter_create;
  assert.notEqual(binding?.kind, "constant");
  if (binding === undefined || binding.kind === "constant") return;
  Object.assign(binding, { error: { kind: "nullable" } as const });
  Object.assign(binding.signature.result, { nullable: true });

  const result = translateScabiNativeProgram(nullable, selectImports(["counter_create"]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.input.bindings[0]?.error, { kind: "nullable" });
  assert.equal(result.input.bindings[0]?.result.type.kind, "nativeHandle");

  Object.assign(binding.signature.result, { nullable: false });
  const rejected = translateScabiNativeProgram(nullable, selectImports(["counter_create"]));
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.equal(
    rejected.diagnostics.some((diagnostic) =>
      diagnostic.path === "/bindings/counter_create/error"
    ),
    true,
  );
});

test("SCABI distinguishes native-resource sharing from managed handle transfer", () => {
  const nonConfined = structuredClone(manifest);
  const counterType = nonConfined.types.counter;
  assert.equal(counterType?.kind, "handle");
  if (counterType?.kind !== "handle") return;
  Object.assign(counterType, { threadSafety: "sendable" as const });
  const nonConfinedResult = translateScabiNativeProgram(nonConfined, selectImports(["counter_create"]));
  assert.equal(nonConfinedResult.ok, false);
  if (nonConfinedResult.ok) return;
  assert.equal(
    nonConfinedResult.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("ownership transfer between runtime executors")
    ),
    true,
  );

  const wrongExecutor = structuredClone(manifest);
  const counterCreate = wrongExecutor.bindings.counter_create;
  assert.notEqual(counterCreate?.kind, "constant");
  if (counterCreate === undefined || counterCreate.kind === "constant") return;
  Object.assign(counterCreate, {
    thread: {
      behavior: "any" as const,
      blocking: false,
      executor: { kind: "any-attached-thread" as const },
    },
  });
  const wrongExecutorResult = translateScabiNativeProgram(wrongExecutor, selectImports(["counter_create"]));
  assert.equal(wrongExecutorResult.ok, false);
  if (wrongExecutorResult.ok) return;
  assert.equal(
    wrongExecutorResult.diagnostics.some((diagnostic) =>
      diagnostic.path === "/bindings/counter_create/thread"
    ),
    true,
  );

  const generalConsumer = structuredClone(manifest);
  const counterAdd = generalConsumer.bindings.counter_add;
  assert.notEqual(counterAdd?.kind, "constant");
  if (counterAdd === undefined || counterAdd.kind === "constant") return;
  Object.assign(counterAdd.signature.parameters[0]!.ownership, {
    kind: "owned" as const,
    transfer: "to-native" as const,
  });
  const generalConsumerResult = translateScabiNativeProgram(generalConsumer, selectImports(["counter_add"]));
  assert.equal(generalConsumerResult.ok, false);
  if (generalConsumerResult.ok) return;
  assert.equal(
    generalConsumerResult.diagnostics.some((diagnostic) =>
      diagnostic.path === "/bindings/counter_add/signature/parameters"
    ),
    true,
  );
});
