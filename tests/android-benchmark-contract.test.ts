import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const workspace = join(import.meta.dirname, "..");

interface AndroidMapContract {
  readonly version: number;
  readonly scenarioCount: number;
  readonly uniqueScenarioCount: number;
  readonly iterations: number;
  readonly expectedChecksum: number;
  readonly actualChecksum: number;
  readonly repeated: boolean;
}

function readAndroidMapContract(): AndroidMapContract {
  const projectUrl = pathToFileURL(
    join(workspace, "benchmarks/android/native-project.ts"),
  ).href;
  const workloadUrl = pathToFileURL(
    join(workspace, "benchmarks/android/direct/map-operations.ts"),
  ).href;
  const program = `
    import {
      androidBenchmarkScenarios,
      androidBenchmarkWorkload,
      repeatedAndroidBenchmarkScenarios,
    } from ${JSON.stringify(projectUrl)};
    import { runMapOperationWorkload } from ${JSON.stringify(workloadUrl)};
    const scenario = androidBenchmarkScenarios.find(
      ({ name }) => name === "map-operations",
    );
    if (scenario === undefined) throw new Error("map scenario is absent");
    process.stdout.write(JSON.stringify({
      version: androidBenchmarkWorkload.version,
      scenarioCount: androidBenchmarkScenarios.length,
      uniqueScenarioCount: new Set(
        androidBenchmarkScenarios.map(({ name }) => name),
      ).size,
      iterations: scenario.iterations,
      expectedChecksum: scenario.expectedChecksum,
      actualChecksum: runMapOperationWorkload(scenario.iterations),
      repeated: repeatedAndroidBenchmarkScenarios.includes("map-operations"),
    }));
  `;
  return JSON.parse(execFileSync(process.execPath, [
    "--experimental-strip-types",
    "--no-warnings",
    "--input-type=module",
    "--eval",
    program,
  ], { encoding: "utf8" })) as AndroidMapContract;
}

test("the Android map benchmark is one matched four-application contract", () => {
  const contract = readAndroidMapContract();
  assert.equal(contract.version, 9);
  assert.equal(contract.scenarioCount, 20);
  assert.equal(contract.uniqueScenarioCount, contract.scenarioCount);
  assert.equal(contract.iterations, 50_000);
  assert.equal(contract.expectedChecksum, 83_989_039);
  assert.equal(contract.actualChecksum, contract.expectedChecksum);
  assert.equal(contract.repeated, true);

  for (const [implementation, relativePath, constant] of [
    [
      "native-typescript",
      "benchmarks/android/native/app.ts",
      /const MAP_OPERATION_ITERATIONS = 50000;/u,
    ],
    [
      "native-typescript-jvm",
      "benchmarks/android/direct/activity.ts",
      /const MAP_OPERATION_ITERATIONS = 50000;/u,
    ],
    [
      "kotlin",
      "benchmarks/android/kotlin/com/example/ntsbenchmark/baseline/MainActivity.kt",
      /private const val MAP_OPERATION_ITERATIONS = 50000/u,
    ],
    [
      "nativescript",
      "benchmarks/android/nativescript/app/app.ts",
      /const MAP_OPERATION_ITERATIONS = 50000;/u,
    ],
  ] as const) {
    const source = readFileSync(join(workspace, relativePath), "utf8");
    assert.match(source, constant, `${implementation} iteration count drifted`);
    assert.match(
      source,
      /map-operations/u,
      `${implementation} does not route the map scenario`,
    );
  }
});
