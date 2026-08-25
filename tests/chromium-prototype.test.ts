import assert from "node:assert/strict";
import {
  accessSync,
  constants,
  existsSync,
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
    join(packageRoot, "scripts/sync-chromium.ts"),
    "--help",
  ]);
  run(process.execPath, [
    join(packageRoot, "scripts/apply-chromium.ts"),
    "--help",
  ]);
  run(process.execPath, [
    join(packageRoot, "scripts/export-chromium-webidl.ts"),
    "--help",
  ]);
  run(process.execPath, [
    join(packageRoot, "scripts/generate-chromium-webidl.ts"),
    "--help",
  ]);
  run(process.execPath, [
    join(packageRoot, "scripts/verify-chromium-abi.ts"),
    "--help",
  ]);
  run(process.execPath, [
    join(packageRoot, "scripts/build-chromium-benchmark-libraries.ts"),
    "--help",
  ]);
  run(process.execPath, [
    join(packageRoot, "scripts/build-chromium-benchmark.ts"),
    "--help",
  ]);
  run(process.execPath, [
    join(packageRoot, "scripts/run-chromium-benchmark.ts"),
    "--help",
  ]);
  run(process.execPath, [
    join(packageRoot, "scripts/evaluate-chromium-performance.ts"),
    "--help",
  ]);
  run(process.execPath, [
    join(packageRoot, "scripts/build-chromium-counter.ts"),
    "--help",
  ]);
  run(process.execPath, [
    join(packageRoot, "scripts/run-chromium-counter.ts"),
    "--help",
  ]);
  run(process.execPath, [
    join(packageRoot, "scripts/verify-chromium-patches.ts"),
    "--help",
  ]);
});

test("Chromium builders pin their tools and runners close concrete targets", () => {
  const counterBuilder = readFileSync(
    join(packageRoot, "scripts/build-chromium-counter.ts"),
    "utf8",
  );
  const benchmarkBuilder = readFileSync(
    join(packageRoot, "scripts/build-chromium-benchmark.ts"),
    "utf8",
  );
  const benchmarkRunner = readFileSync(
    join(packageRoot, "scripts/run-chromium-benchmark.ts"),
    "utf8",
  );
  const support = readFileSync(join(packageRoot, "scripts/support.ts"), "utf8");
  for (const builder of [counterBuilder, benchmarkBuilder]) {
    assert.match(builder, /--depot-tools/u);
    assert.match(builder, /buildtools\/linux64\/gn/u);
    assert.match(builder, /runAutoninja/u);
    assert.match(builder, /--refresh/u);
    assert.doesNotMatch(builder, /runCommand\(\s*"(?:auto)?ninja"/u);
  }
  assert.match(benchmarkBuilder, /is_official_build=true/u);
  assert.match(benchmarkBuilder, /chrome_pgo_phase=0/u);
  assert.match(benchmarkRunner, /isTransientDomReadFailure/u);
  assert.match(benchmarkRunner, /Could not find/u);
  assert.match(support, /python-bin\/python3/u);
  assert.match(support, /autoninja\.py/u);

  for (const runner of ["run-chromium-counter.ts", "run-chromium-benchmark.ts"]) {
    const source = readFileSync(join(packageRoot, "scripts", runner), "utf8");
    assert.match(source, /Target\.closeTarget/u);
    assert.doesNotMatch(source, /Browser\.close|Page\.loadEventFired/u);
  }
});

function readSeries(name: string): readonly string[] {
  return readFileSync(join(patchRoot, name), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

test("Chromium patch profiles minimize and classify the required seams", () => {
  const git = executable("git");
  const productNames = readSeries("product.series");
  assert.deepEqual(productNames, [
    "0001-binding-neutral-exception-capture.patch",
  ]);
  const fixtureNames = readSeries("fixture.series");
  assert.deepEqual(fixtureNames, [
    "0003-content-shell-native-counter-harness.patch",
  ]);
  assert.equal(existsSync(join(patchRoot, "series")), false);
  assert.equal(
    existsSync(join(patchRoot, "0001-binding-neutral-web-exception-state.patch")),
    false,
  );
  assert.equal(
    existsSync(join(patchRoot, "0002-native-event-listener-without-v8-logger.patch")),
    false,
  );
  const exceptionPatch = readFileSync(
    join(patchRoot, productNames[0]!),
    "utf8",
  );
  const exceptionPatchFiles = exceptionPatch
    .split("\n")
    .filter((line) => line.startsWith("+++ b/"))
    .map((line) => line.slice("+++ b/".length));
  assert.deepEqual(exceptionPatchFiles, [
    "third_party/blink/renderer/platform/bindings/exception_state.cc",
    "third_party/blink/renderer/platform/bindings/exception_state_capture.h",
  ]);
  const addedExceptionCode = exceptionPatch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
  assert.doesNotMatch(addedExceptionCode, /\bv8::/u);
  assert.doesNotMatch(exceptionPatch, /CreateElementForBinding/u);
  for (const name of [...productNames, ...fixtureNames]) {
    run(git, ["apply", "--numstat", join(patchRoot, name)]);
  }
});
