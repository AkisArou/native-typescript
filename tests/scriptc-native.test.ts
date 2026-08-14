import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parseScabiManifest } from "@native-typescript/scabi";
import {
  translateScabiNativeProgram,
  type ScriptCNativeBinding,
  type ScriptCNativeValueType,
} from "@native-typescript/scriptc";

const fixtureRoot = resolve(import.meta.dirname, "../fixtures/scabi-c-v1");
const manifest = parseScabiManifest(
  readFileSync(resolve(fixtureRoot, "package.scabi.json"), "utf8"),
);

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

test("SCABI exact i32 translates to immutable generic ScriptC input", () => {
  const result = translateScabiNativeProgram(manifest, ["i32_identity"]);
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
        },
      },
    ],
  });
  assert.deepEqual(result.linkInputIds, []);
  assert.equal(Object.isFrozen(result.input), true);
  assert.equal(Object.isFrozen(result.input.bindings[0]), true);
});

test("SCABI translates every reached integer with exact signedness and width", () => {
  const result = translateScabiNativeProgram(manifest, [
    "i8_identity",
    "u8_identity",
    "i16_identity",
    "u16_identity",
    "i32_identity",
    "u32_identity",
    "i64_identity",
    "u64_identity",
    "usize_identity",
  ]);
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

test("SCABI projects one borrowed UTF-8 string into pointer and byte-length ABI slots", () => {
  const result = translateScabiNativeProgram(manifest, ["hash_utf8"]);
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
      },
    },
  ]);
});

test("SCABI refuses UTF-8 contracts that require adapter work", () => {
  const terminated = structuredClone(manifest);
  const binding = terminated.bindings.hash_utf8;
  assert.notEqual(binding?.kind, "constant");
  if (binding === undefined || binding.kind === "constant") return;
  const data = binding.signature.parameters[0];
  assert.equal(data?.marshal?.kind, "string");
  if (data?.marshal?.kind !== "string") return;
  Object.assign(data.marshal, { termination: "nul" as const });

  const result = translateScabiNativeProgram(terminated, ["hash_utf8"]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("no terminator")
    ),
    true,
  );
});

test("SCABI projects one borrowed Uint8Array into exact data and byte-length slots", () => {
  const result = translateScabiNativeProgram(manifest, ["hash_bytes"]);
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

  const result = translateScabiNativeProgram(mutable, ["hash_bytes"]);
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
  const result = translateScabiNativeProgram(manifest, ["call_scoped"]);
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
      arguments: [
        { name: "callback", type: { kind: "func", params: [i32], ret: i32 } },
        { name: "value", type: i32 },
      ],
      parameters: [
        {
          name: "callback",
          type: { kind: "nativeCallback", signature },
          passMode: "pointer",
          ownership: { kind: "callScoped" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callScoped" },
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
      },
    },
  ]);
});

test("SCABI refuses callbacks whose lifetime or executor needs an adapter", () => {
  const retained = structuredClone(manifest);
  const retainedBinding = retained.bindings.call_scoped;
  assert.notEqual(retainedBinding?.kind, "constant");
  if (retainedBinding === undefined || retainedBinding.kind === "constant") return;
  const callback = retainedBinding.signature.parameters[0]?.callback;
  assert.notEqual(callback, undefined);
  if (callback === undefined) return;
  Object.assign(callback, { lifetime: "retained" as const });

  const retainedResult = translateScabiNativeProgram(retained, ["call_scoped"]);
  assert.equal(retainedResult.ok, false);
  if (!retainedResult.ok) {
    assert.equal(
      retainedResult.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("same-caller call-lifetime callbacks")
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

  const foreignResult = translateScabiNativeProgram(foreign, ["call_scoped"]);
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
  const supported = translateScabiNativeProgram(manifest, ["usize_identity"]);
  assert.equal(supported.ok, true);

  const unsupported = translateScabiNativeProgram(manifest, ["f32_identity"]);
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

test("SCABI translates authoritative padded layout and by-value ABI metadata", () => {
  const result = translateScabiNativeProgram(manifest, ["padded_roundtrip"]);
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
      abi: { kind: "indirect", alignment: 8 },
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
    ...directSignature([{ name: "value", type: { kind: "nativeStruct", typeId }, passMode: "value", ownership: { kind: "value" } }]),
    result: { type: { kind: "nativeStruct", typeId }, passMode: "value", ownership: { kind: "value" } },
  });
});

test("SCABI closes owned handle factories over their exact destructor", () => {
  const result = translateScabiNativeProgram(manifest, ["counter_create"]);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const instance = "native-typescript.fixture.c-v1@0.0.0";
  const typeId = `${instance}#type:counter`;
  assert.deepEqual(result.input.types, [
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
    },
  });
  assert.deepEqual(result.linkInputIds, []);
});

test("SCABI keeps the first opaque-handle slice owner-confined and destructor-only", () => {
  const nonConfined = structuredClone(manifest);
  const counterType = nonConfined.types.counter;
  assert.equal(counterType?.kind, "handle");
  if (counterType?.kind !== "handle") return;
  Object.assign(counterType, { threadSafety: "shared" as const });
  const nonConfinedResult = translateScabiNativeProgram(nonConfined, ["counter_create"]);
  assert.equal(nonConfinedResult.ok, false);
  if (nonConfinedResult.ok) return;
  assert.equal(
    nonConfinedResult.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("outside the owner-confined slice")
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
  const wrongExecutorResult = translateScabiNativeProgram(wrongExecutor, ["counter_create"]);
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
  const generalConsumerResult = translateScabiNativeProgram(generalConsumer, ["counter_add"]);
  assert.equal(generalConsumerResult.ok, false);
  if (generalConsumerResult.ok) return;
  assert.equal(
    generalConsumerResult.diagnostics.some((diagnostic) =>
      diagnostic.path === "/bindings/counter_add/signature/parameters"
    ),
    true,
  );
});
