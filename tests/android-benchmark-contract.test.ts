import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const workspace = join(import.meta.dirname, "..");

interface AndroidLanguageContract {
  readonly version: number;
  readonly scenarioCount: number;
  readonly uniqueScenarioCount: number;
  readonly iterations: number;
  readonly expectedChecksum: number;
  readonly actualChecksum: number;
  readonly repeated: boolean;
  readonly setIterations: number;
  readonly setExpectedChecksum: number;
  readonly setActualChecksum: number;
  readonly setRepeated: boolean;
  readonly mathIterations: number;
  readonly mathExpectedChecksum: number;
  readonly mathActualChecksum: number;
  readonly mathRepeated: boolean;
  readonly numberParsingIterations: number;
  readonly numberParsingExpectedChecksum: number;
  readonly numberParsingActualChecksum: number;
  readonly numberParsingRepeated: boolean;
  readonly directApplicationId: string;
  readonly directActivityBinaryName: string;
  readonly nativeApplicationId: string;
  readonly kotlinApplicationId: string;
}

function readAndroidLanguageContract(): AndroidLanguageContract {
  const projectUrl = pathToFileURL(
    join(workspace, "benchmarks/android/native-project.ts"),
  ).href;
  const workloadUrl = pathToFileURL(
    join(workspace, "benchmarks/android/direct/map-operations.ts"),
  ).href;
  const setWorkloadUrl = pathToFileURL(
    join(workspace, "benchmarks/android/direct/set-operations.ts"),
  ).href;
  const mathWorkloadUrl = pathToFileURL(
    join(workspace, "benchmarks/android/direct/math-operations.ts"),
  ).href;
  const numberParsingWorkloadUrl = pathToFileURL(
    join(workspace, "benchmarks/android/direct/number-parsing.ts"),
  ).href;
  const program = `
    import {
      androidBenchmarkScenarios,
      androidBenchmarkWorkload,
      directJvmBenchmarkApplication,
      kotlinBenchmarkApplication,
      nativeTypescriptBenchmarkProject,
      repeatedAndroidBenchmarkScenarios,
    } from ${JSON.stringify(projectUrl)};
    import { runMapOperationWorkload } from ${JSON.stringify(workloadUrl)};
    import { runSetOperationWorkload } from ${JSON.stringify(setWorkloadUrl)};
    import { runMathOperationWorkload } from ${JSON.stringify(mathWorkloadUrl)};
    import { runNumberParsingWorkload } from ${JSON.stringify(numberParsingWorkloadUrl)};
    const scenario = androidBenchmarkScenarios.find(
      ({ name }) => name === "map-operations",
    );
    if (scenario === undefined) throw new Error("map scenario is absent");
    const setScenario = androidBenchmarkScenarios.find(
      ({ name }) => name === "set-operations",
    );
    if (setScenario === undefined) throw new Error("set scenario is absent");
    const mathScenario = androidBenchmarkScenarios.find(
      ({ name }) => name === "math-operations",
    );
    if (mathScenario === undefined) throw new Error("math scenario is absent");
    const numberParsingScenario = androidBenchmarkScenarios.find(
      ({ name }) => name === "number-parsing",
    );
    if (numberParsingScenario === undefined) throw new Error("number parsing scenario is absent");
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
      setIterations: setScenario.iterations,
      setExpectedChecksum: setScenario.expectedChecksum,
      setActualChecksum: runSetOperationWorkload(setScenario.iterations),
      setRepeated: repeatedAndroidBenchmarkScenarios.includes("set-operations"),
      mathIterations: mathScenario.iterations,
      mathExpectedChecksum: mathScenario.expectedChecksum,
      mathActualChecksum: runMathOperationWorkload(mathScenario.iterations),
      mathRepeated: repeatedAndroidBenchmarkScenarios.includes("math-operations"),
      numberParsingIterations: numberParsingScenario.iterations,
      numberParsingExpectedChecksum: numberParsingScenario.expectedChecksum,
      numberParsingActualChecksum: runNumberParsingWorkload(numberParsingScenario.iterations),
      numberParsingRepeated: repeatedAndroidBenchmarkScenarios.includes("number-parsing"),
      directApplicationId: directJvmBenchmarkApplication.applicationId,
      directActivityBinaryName: directJvmBenchmarkApplication.activityBinaryName,
      nativeApplicationId: nativeTypescriptBenchmarkProject.android.applicationId,
      kotlinApplicationId: kotlinBenchmarkApplication.applicationId,
    }));
  `;
  return JSON.parse(execFileSync(process.execPath, [
    "--experimental-strip-types",
    "--no-warnings",
    "--input-type=module",
    "--eval",
    program,
  ], { encoding: "utf8" })) as AndroidLanguageContract;
}

test("the Android language benchmarks are one matched four-application contract", () => {
  const contract = readAndroidLanguageContract();
  assert.equal(contract.version, 12);
  assert.equal(contract.scenarioCount, 23);
  assert.equal(contract.uniqueScenarioCount, contract.scenarioCount);
  assert.equal(contract.iterations, 50_000);
  assert.equal(contract.expectedChecksum, 83_989_039);
  assert.equal(contract.actualChecksum, contract.expectedChecksum);
  assert.equal(contract.repeated, true);
  assert.equal(contract.setIterations, 50_000);
  assert.equal(contract.setExpectedChecksum, 825_665);
  assert.equal(contract.setActualChecksum, contract.setExpectedChecksum);
  assert.equal(contract.setRepeated, true);
  assert.equal(contract.mathIterations, 100_000);
  assert.equal(contract.mathExpectedChecksum, 3_075_216);
  assert.equal(contract.mathActualChecksum, contract.mathExpectedChecksum);
  assert.equal(contract.mathRepeated, true);
  assert.equal(contract.numberParsingIterations, 50_000);
  assert.equal(contract.numberParsingExpectedChecksum, -62_856_250);
  assert.equal(
    contract.numberParsingActualChecksum,
    contract.numberParsingExpectedChecksum,
  );
  assert.equal(contract.numberParsingRepeated, true);
  assert.ok(
    contract.directActivityBinaryName.replaceAll("/", ".")
      .startsWith(`${contract.directApplicationId}.`),
    "the compiler-emitted Direct Activity must be owned by its application id",
  );
  assert.equal(new Set([
    contract.directApplicationId,
    contract.nativeApplicationId,
    contract.kotlinApplicationId,
  ]).size, 3, "benchmark application ids must remain independently installable");

  const runner = readFileSync(
    join(workspace, "scripts/measure-android-performance.ts"),
    "utf8",
  );
  assert.match(
    runner,
    /\.\.\.input\.tools\.kotlinRuntimeJars/u,
    "Kotlin stdlib jars are not D8 program inputs",
  );
  assert.match(
    runner,
    /kotlinRuntime: tools\.kotlinRuntimeJars\.map/u,
    "Kotlin stdlib identities are absent from benchmark provenance",
  );

  for (const [
    implementation,
    relativePath,
    mapConstant,
    setConstant,
    mathConstant,
    numberParsingConstant,
  ] of [
    [
      "native-typescript",
      "benchmarks/android/native/app.ts",
      /const MAP_OPERATION_ITERATIONS = 50000;/u,
      /const SET_OPERATION_ITERATIONS = 50000;/u,
      /const MATH_OPERATION_ITERATIONS = 100000;/u,
      /const NUMBER_PARSING_ITERATIONS = 50000;/u,
    ],
    [
      "native-typescript-jvm",
      "benchmarks/android/direct/activity.ts",
      /const MAP_OPERATION_ITERATIONS = 50000;/u,
      /const SET_OPERATION_ITERATIONS = 50000;/u,
      /const MATH_OPERATION_ITERATIONS = 100000;/u,
      /const NUMBER_PARSING_ITERATIONS = 50000;/u,
    ],
    [
      "kotlin",
      "benchmarks/android/kotlin/com/example/ntsbenchmark/baseline/MainActivity.kt",
      /private const val MAP_OPERATION_ITERATIONS = 50000/u,
      /private const val SET_OPERATION_ITERATIONS = 50000/u,
      /private const val MATH_OPERATION_ITERATIONS = 100000/u,
      /private const val NUMBER_PARSING_ITERATIONS = 50000/u,
    ],
    [
      "nativescript",
      "benchmarks/android/nativescript/app/app.ts",
      /const MAP_OPERATION_ITERATIONS = 50000;/u,
      /const SET_OPERATION_ITERATIONS = 50000;/u,
      /const MATH_OPERATION_ITERATIONS = 100000;/u,
      /const NUMBER_PARSING_ITERATIONS = 50000;/u,
    ],
  ] as const) {
    const source = readFileSync(join(workspace, relativePath), "utf8");
    assert.match(source, mapConstant, `${implementation} map iteration count drifted`);
    assert.match(source, setConstant, `${implementation} set iteration count drifted`);
    assert.match(source, mathConstant, `${implementation} math iteration count drifted`);
    assert.match(
      source,
      numberParsingConstant,
      `${implementation} number parsing iteration count drifted`,
    );
    assert.match(
      source,
      /map-operations/u,
      `${implementation} does not route the map scenario`,
    );
    assert.match(
      source,
      /set-operations/u,
      `${implementation} does not route the set scenario`,
    );
    assert.match(
      source,
      /math-operations/u,
      `${implementation} does not route the math scenario`,
    );
    assert.match(
      source,
      /number-parsing/u,
      `${implementation} does not route the number parsing scenario`,
    );
  }
});
