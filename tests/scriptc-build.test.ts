import assert from "node:assert/strict";
import test from "node:test";
import {
  planScriptCExecutable,
  planScriptCProgramEmission,
} from "@native-typescript/core";
import type {
  ScriptCExecutableCompilationPlan,
  ScriptCExternalCcPlan,
} from "@native-typescript/scriptc";

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

const compilationPlan: ScriptCExecutableCompilationPlan = {
  schema: "scriptc.executable-compilation-plan",
  schemaVersion: 1,
  backend: "llvm",
  target: { platform: "linux", pointerBits: 64, wasi: false },
  ir: "{}",
  entrySource: "console.log(42);\n",
  nativeBuild: {
    cacheIdentity: "scriptc-generated-v1",
    nativeHandle: true,
    linkInputs: ["object/platform"],
  },
};

const nodeTool = {
  id: "tool/node",
  version: "24.19.0",
  digest: `sha256:${"1".repeat(64)}`,
};

test("ScriptC compiler plans become cacheable program-emission actions", () => {
  const result = planScriptCProgramEmission({
    actionId: "emit/scriptc/llvm",
    plan: compilationPlan,
    planArtifact: "metadata/scriptc/llvm-plan",
    compilerArtifact: "tool-input/scriptc/emitter",
    artifactId: "generated/scriptc/llvm/program",
    artifactFileName: "program.ll",
    tool: nodeTool,
    executionPlatform: "x86_64-linux",
    targetPlatform: "linux",
    target: "x86_64-unknown-linux-gnu",
  });

  assert.deepEqual(result.action.inputs, [
    "tool-input/scriptc/emitter",
    "metadata/scriptc/llvm-plan",
  ]);
  assert.deepEqual(result.action.arguments, [
    {
      kind: "input-path",
      artifact: "tool-input/scriptc/emitter",
      path: "executable-emitter-cli.js",
    },
    { kind: "input-path", artifact: "metadata/scriptc/llvm-plan" },
    { kind: "output-path", artifact: "generated/scriptc/llvm/program" },
  ]);
  assert.equal(result.artifact.mediaType, "text/x-llvm");
  assert.equal(result.artifact.cache, "exportable");
  assert.equal(result.action.deterministic, true);
  assert.equal(result.action.cacheable, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.action.arguments), true);
});

test("ScriptC emission planning requires Node and the exact target platform", () => {
  const base = {
    actionId: "emit/scriptc/llvm",
    plan: compilationPlan,
    planArtifact: "metadata/scriptc/llvm-plan",
    compilerArtifact: "tool-input/scriptc/emitter",
    artifactId: "generated/scriptc/llvm/program",
    artifactFileName: "program.ll",
    tool: nodeTool,
    executionPlatform: "x86_64-linux",
    targetPlatform: "linux",
    target: "x86_64-unknown-linux-gnu",
  } as const;
  assert.throws(
    () => planScriptCProgramEmission({
      ...base,
      tool,
    }),
    /requires tool\/node/u,
  );
  assert.throws(
    () => planScriptCProgramEmission({
      ...base,
      targetPlatform: "darwin",
    }),
    /planned linux, but emission targets darwin/u,
  );
});

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
