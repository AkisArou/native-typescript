import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectWorkspace } from "@native-typescript/core";

const cliPath = fileURLToPath(
  new URL("../packages/cli/src/main.ts", import.meta.url),
);

test("workspace resolves the pinned scriptc checkout", () => {
  const workspace = inspectWorkspace();

  assert.equal(workspace.compiler.branch, "native-typescript");
  assert.equal(existsSync(workspace.compiler.path), true);
  assert.deepEqual(workspace.targets, []);
});

test("CLI help is available through Node type stripping", () => {
  const result = spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /native-typescript 0\.0\.0/);
  assert.match(result.stdout, /doctor/);
});

test("CLI doctor verifies the scriptc submodule", () => {
  const result = spawnSync(process.execPath, [cliPath, "doctor"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status: ready/);
  assert.match(result.stdout, /branch: native-typescript/);
});

