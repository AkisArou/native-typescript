import assert from "node:assert/strict";
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  parseChromiumRevision,
  readPinnedChromiumRevision,
} from "@native-typescript/target-chromium";

const packageRoot = resolve(
  import.meta.dirname,
  "../packages/target-chromium",
);
const prototypeRoot = join(packageRoot, "prototype");
const patchRoot = join(packageRoot, "chromium", "patches");

function executable(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching the explicit PATH entries.
    }
  }
  throw new Error(`Required executable is unavailable: ${name}`);
}

function run(command: string, arguments_: readonly string[]): void {
  const result = spawnSync(command, arguments_, {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
}

test("Chromium revision pin is validated and immutable", () => {
  const revision = readPinnedChromiumRevision();
  assert.equal(
    revision.revision,
    "96324a4012fe62f48b9463a67486eeb645bc5c78",
  );
  assert.equal(Object.isFrozen(revision), true);
  assert.throws(
    () => parseChromiumRevision({ ...revision, observedAt: "23 August 2026" }),
    /YYYY-MM-DD/u,
  );
  assert.throws(
    () => parseChromiumRevision({ ...revision, branch: "main" }),
    /fields must be exactly/u,
  );
});

test("portable direct-Blink prototype contracts compile and execute", (context) => {
  const buildRoot = mkdtempSync(join(tmpdir(), "nts-chromium-prototype-"));
  context.after(() => rmSync(buildRoot, { recursive: true, force: true }));

  const compiler = executable("clang");
  const common = [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Wpedantic",
    "-Werror",
    "-I",
    join(prototypeRoot, "include"),
    "-I",
    join(prototypeRoot, "src"),
  ];

  const handleTest = join(buildRoot, "handle-table");
  run(compiler, [
    ...common,
    join(prototypeRoot, "src/runtime/nts_handle_table.c"),
    join(prototypeRoot, "tests/handle_table.c"),
    "-o",
    handleTest,
  ]);
  run(handleTest, []);

  const counterTest = join(buildRoot, "counter-contract");
  run(compiler, [
    ...common,
    join(prototypeRoot, "src/runtime/nts_handle_table.c"),
    join(prototypeRoot, "src/runtime/nts_web_exception.c"),
    join(prototypeRoot, "examples/counter/app.c"),
    join(prototypeRoot, "tests/counter_contract.c"),
    "-o",
    counterTest,
  ]);
  run(counterTest, []);

  run(compiler, [
    ...common,
    "-c",
    join(prototypeRoot, "examples/create-element/app.c"),
    "-o",
    join(buildRoot, "create-element.o"),
  ]);
});

test("prototype bridge has no V8 or source-evaluation carrier", () => {
  run(process.execPath, [
    join(packageRoot, "scripts/check-no-v8-bridge.ts"),
  ]);
});

test("Chromium mutation helpers expose their TypeScript command surface", () => {
  run(process.execPath, [
    join(packageRoot, "scripts/apply-chromium.ts"),
    "--help",
  ]);
  run(process.execPath, [
    join(packageRoot, "scripts/build-chromium-counter.ts"),
    "--help",
  ]);
});

test("Chromium patch series is complete and syntactically valid", () => {
  const git = executable("git");
  const names = readFileSync(join(patchRoot, "series"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  assert.deepEqual(names, [
    "0001-binding-neutral-web-exception-state.patch",
    "0002-native-event-listener-without-v8-logger.patch",
    "0003-content-shell-native-counter-harness.patch",
  ]);
  for (const name of names) {
    run(git, ["apply", "--numstat", join(patchRoot, name)]);
  }
});
