import assert from "node:assert/strict";
import test from "node:test";
import { planScriptCExecutable } from "@native-typescript/core";
import type { ScriptCExternalCcPlan } from "@native-typescript/scriptc";

const externalPlan: ScriptCExternalCcPlan = {
  schema: "scriptc.external-cc-plan",
  schemaVersion: 1,
  driver: { command: "clang" },
  targetPlatform: "linux",
  inputs: ["runtime/scriptc", "generated/program", "object/platform"],
  output: "product/application",
  arguments: [
    { kind: "input-path", input: "generated/program" },
    {
      kind: "input-path",
      input: "runtime/scriptc",
      path: "src/scr_async.c",
    },
    { kind: "input-path", input: "object/platform" },
    { kind: "literal", value: "-o" },
    { kind: "output-path", output: "product/application" },
  ],
};

const tool = {
  id: "tool/clang",
  version: "20.1.8",
  digest: `sha256:${"0".repeat(64)}`,
};

test("ScriptC external commands become immutable artifact actions", () => {
  const result = planScriptCExecutable({
    actionId: "link/application",
    plan: externalPlan,
    artifactFileName: "application",
    tool,
    driverPlatform: "linux",
    executionPlatform: "x86_64-linux",
    target: "x86_64-unknown-linux-gnu",
  });

  assert.equal(result.action.id, "link/application");
  assert.deepEqual(result.action.inputs, externalPlan.inputs);
  assert.deepEqual(result.action.arguments[1], {
    kind: "input-path",
    artifact: "runtime/scriptc",
    path: "src/scr_async.c",
  });
  assert.deepEqual(result.action.arguments.at(-1), {
    kind: "output-path",
    artifact: "product/application",
  });
  assert.equal(result.artifact.origin.kind, "action");
  assert.equal(result.artifact.origin.action, "link/application");
  assert.equal(result.action.cacheable, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.action.arguments), true);
});

test("ScriptC executable planning rejects a mismatched driver tool", () => {
  assert.throws(
    () => planScriptCExecutable({
      actionId: "link/application",
      plan: externalPlan,
      artifactFileName: "application",
      tool: { ...tool, id: "tool/gcc" },
      driverPlatform: "linux",
      executionPlatform: "x86_64-linux",
      target: "x86_64-unknown-linux-gnu",
    }),
    /ScriptC requested clang, but received tool\/gcc/u,
  );
});

test("ScriptC executable planning rejects undeclared output arguments", () => {
  const invalidPlan: ScriptCExternalCcPlan = {
    ...externalPlan,
    arguments: [
      ...externalPlan.arguments.slice(0, -1),
      { kind: "output-path", output: "product/other" },
    ],
  };
  assert.throws(
    () => planScriptCExecutable({
      actionId: "link/application",
      plan: invalidPlan,
      artifactFileName: "application",
      tool,
      driverPlatform: "linux",
      executionPlatform: "x86_64-linux",
      target: "x86_64-unknown-linux-gnu",
    }),
    /ScriptC plan references unknown output product\/other/u,
  );
});

test("ScriptC executable planning rejects a mismatched target platform", () => {
  assert.throws(
    () => planScriptCExecutable({
      actionId: "link/application",
      plan: externalPlan,
      artifactFileName: "application",
      tool,
      driverPlatform: "darwin",
      executionPlatform: "x86_64-linux",
      target: "x86_64-apple-darwin",
    }),
    /ScriptC planned linux, but the product requires darwin/u,
  );
});
