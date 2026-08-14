import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parseScabiManifest } from "@native-typescript/scabi";
import { translateScabiNativeProgram } from "@native-typescript/scriptc";

const fixtureRoot = resolve(import.meta.dirname, "../fixtures/scabi-c-v1");
const manifest = parseScabiManifest(
  readFileSync(resolve(fixtureRoot, "package.scabi.json"), "utf8"),
);

test("SCABI exact i32 translates to immutable generic ScriptC input", () => {
  const result = translateScabiNativeProgram(manifest, ["i32_identity"]);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.input, {
    sourceTypes: [
      {
        declaration: {
          module: "@native-typescript/scabi-c-v1-fixture",
          name: "i32",
        },
        type: { kind: "nativeScalar", scalar: "i32" },
      },
    ],
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
        parameters: [
          {
            name: "value",
            type: { kind: "nativeScalar", scalar: "i32" },
            passMode: "value",
          },
        ],
        result: {
          type: { kind: "nativeScalar", scalar: "i32" },
          passMode: "value",
        },
      },
    ],
  });
  assert.deepEqual(result.linkInputIds, []);
  assert.equal(Object.isFrozen(result.input), true);
  assert.equal(Object.isFrozen(result.input.bindings[0]), true);
});

test("SCABI translation rejects only requested unsupported bindings", () => {
  const supported = translateScabiNativeProgram(manifest, ["i32_identity"]);
  assert.equal(supported.ok, true);

  const unsupported = translateScabiNativeProgram(manifest, ["u32_identity"]);
  assert.equal(unsupported.ok, false);
  if (unsupported.ok) return;
  assert.deepEqual(
    unsupported.diagnostics.map(({ code, path }) => ({ code, path })),
    [
      { code: "NTS3002", path: "/bindings/u32_identity/signature/parameters/0/type" },
      { code: "NTS3002", path: "/bindings/u32_identity/signature/result/type" },
    ],
  );
});
