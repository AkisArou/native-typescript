import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  chromiumBenchmarkNativeDeclarations,
  createChromiumBenchmarkNativeManifest,
  defineChromiumPerformanceInput,
  evaluateChromiumPerformance,
  type ChromiumBenchmarkCategory,
  type ChromiumBenchmarkLane,
  type ChromiumBenchmarkObservation,
} from "@native-typescript/target-chromium";
import {
  loadScriptCLibraryPlanners,
  translateScabiNativeProgram,
} from "@native-typescript/scriptc";

const lanes = ["cpp", "scriptc-c", "scriptc-llvm", "v8"] as const;
const chromiumPackageRoot = resolve(
  import.meta.dirname,
  "../packages/target-chromium",
);

function samples(value: number): readonly number[] {
  return Object.freeze(Array.from({ length: 20 }, () => value));
}

function workload(
  name: string,
  category: ChromiumBenchmarkCategory,
  values: Readonly<Record<ChromiumBenchmarkLane, number>>,
): readonly ChromiumBenchmarkObservation[] {
  return lanes.map((lane) =>
    Object.freeze({
      workload: name,
      category,
      lane,
      samplesNanoseconds: samples(values[lane]),
    })
  );
}

const cleanCapsule = Object.freeze({
  genericDispatch: false,
  v8Values: false,
  avoidableBoxing: false,
  perCallHeapAllocation: false,
});

const provenance = Object.freeze({
  schemaVersion: 1 as const,
  chromiumRevision: "96324a4012fe62f48b9463a67486eeb645bc5c78",
  nativeTypescriptRevision: "1111111111111111111111111111111111111111",
  scriptCRevision: "573b218c0f1e9e5cad10a6153859f78ad067d250",
  chromiumClangVersion: "clang version 24.0.0git",
  contentShellDigest:
    "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  scriptcCArchiveDigest:
    "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  scriptcLlvmArchiveDigest:
    "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  fixtureDigest:
    "sha256:4444444444444444444444444444444444444444444444444444444444444444",
  buildArguments: Object.freeze(["is_debug=false"]),
  recordedAt: "2026-08-24T00:00:00.000Z",
});

test("Chromium performance input is exact and deeply frozen", () => {
  const input = defineChromiumPerformanceInput({
    observations: [
      ...workload("set-text", "primitive", {
        cpp: 100,
        "scriptc-c": 100,
        "scriptc-llvm": 100,
        v8: 100,
      }),
      ...workload("dom-batch", "boundary-heavy", {
        cpp: 100,
        "scriptc-c": 80,
        "scriptc-llvm": 80,
        v8: 100,
      }),
    ],
    capsuleStructure: cleanCapsule,
    provenance,
  });
  assert.equal(Object.isFrozen(input), true);
  assert.equal(Object.isFrozen(input.observations), true);
  assert.equal(Object.isFrozen(input.observations[0]?.samplesNanoseconds), true);
  assert.throws(
    () => defineChromiumPerformanceInput({ ...input, ambientPath: "/tmp/run" }),
    /fields must be exactly/u,
  );
});

test("both ScriptC benchmark lanes plan the same native-call kernel", async () => {
  const manifest = createChromiumBenchmarkNativeManifest({
    chromiumRevision: "96324a4012fe62f48b9463a67486eeb645bc5c78",
    clangVersion: "24.0.0git",
    metadataDigest:
      "sha256:c8c043174eb0aae7e6e81ba91af23a5a45d944f1fdf01bf4b3ba0271a490161a",
    target: {
      triple: "x86_64-unknown-linux-gnu",
      architecture: "x86_64",
      pointerWidth: 64,
      endianness: "little",
      objectFormat: "elf",
      minimumPlatformVersion: "0",
      abi: "gnu",
      features: [],
    },
  });
  const translated = translateScabiNativeProgram(manifest, {
    imports: ["create_element_once"],
    exports: [],
  });
  assert.equal(
    translated.ok,
    true,
    translated.ok
      ? undefined
      : translated.diagnostics.map(({ message }) => message).join("\n"),
  );
  if (!translated.ok) return;

  const benchmarkRoot = resolve(chromiumPackageRoot, "benchmark/scriptc");
  assert.equal(
    readFileSync(resolve(benchmarkRoot, "native.d.ts"), "utf8"),
    chromiumBenchmarkNativeDeclarations,
  );
  const { planLibraryCompilation, planLibraryExternalCBuild } =
    await loadScriptCLibraryPlanners();
  for (const backend of ["c", "llvm"] as const) {
    const planned = await planLibraryCompilation({
      profilePath: resolve(benchmarkRoot, `profile-${backend}.json`),
      externalTypes: {
        [manifest.package.name]: resolve(benchmarkRoot, "native.d.ts"),
      },
      native: translated.input,
    });
    assert.equal(
      planned.ok,
      true,
      planned.ok
        ? undefined
        : planned.diagnostics.map(({ message }) => message).join("\n"),
    );
    if (!planned.ok) continue;
    assert.equal(planned.plan.emission, backend);
    assert.match(planned.plan.ir, /"kind": "nativeCall"/u);
    assert.match(
      planned.plan.ir,
      /96324a4012fe62f48b9463a67486eeb645bc5c78#create_element_once/u,
    );
    assert.deepEqual(planned.plan.nativeBuild.localizeSymbols, [
      `nts_chromium_scriptc_${backend}_init`,
      `nts_chromium_scriptc_${backend}_set_panic_sink`,
      `nts_chromium_scriptc_${backend}_create_elements`,
    ]);
    const { localizeSymbols: _, ...unlocalizedNativeBuild } =
      planned.plan.nativeBuild;
    const external = await planLibraryExternalCBuild({
      ...planned.plan,
      nativeBuild: unlocalizedNativeBuild,
    }, {
      program: `generated/scriptc/${backend}/program`,
      runtime: "runtime/scriptc",
      output: `archive/scriptc/${backend}`,
      objectIdPrefix: `object/scriptc/${backend}/`,
    });
    assert.ok(external.objects.length > 0);
    assert.equal(external.plans.length, external.objects.length + 1);
    assert.equal(
      external.plans.at(-1)?.output,
      `archive/scriptc/${backend}`,
    );
  }
});

test("Chromium performance contract accepts near-C++ compiled lanes", () => {
  const report = evaluateChromiumPerformance({
    observations: [
      ...workload("set-text", "primitive", {
        cpp: 100,
        "scriptc-c": 120,
        "scriptc-llvm": 115,
        v8: 125,
      }),
      ...workload("dom-batch", "boundary-heavy", {
        cpp: 1_000,
        "scriptc-c": 1_050,
        "scriptc-llvm": 1_020,
        v8: 1_300,
      }),
    ],
    capsuleStructure: cleanCapsule,
    provenance,
  });

  assert.equal(report.passed, true);
  assert.deepEqual(report.violations, []);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.metrics), true);
});

test("Chromium performance contract reports latency and structure failures", () => {
  const report = evaluateChromiumPerformance({
    observations: [
      ...workload("set-text", "primitive", {
        cpp: 100,
        "scriptc-c": 130,
        "scriptc-llvm": 100,
        v8: 105,
      }),
      ...workload("dom-batch", "boundary-heavy", {
        cpp: 1_000,
        "scriptc-c": 1_100,
        "scriptc-llvm": 1_000,
        v8: 1_200,
      }),
    ],
    capsuleStructure: { ...cleanCapsule, genericDispatch: true },
    provenance,
  });

  assert.equal(report.passed, false);
  assert.ok(
    report.violations.includes(
      "set-text/scriptc-c median is 1.300x handwritten C++ (maximum 1.250x)",
    ),
  );
  assert.ok(
    report.violations.includes(
      "scriptc-c boundary-heavy aggregate median is 0.917x V8 (maximum 0.850x)",
    ),
  );
  assert.ok(
    report.violations.includes("generated scalar capsule uses genericDispatch"),
  );
});

test("Chromium performance contract aggregates boundary-heavy workloads", () => {
  const report = evaluateChromiumPerformance({
    observations: [
      ...workload("set-text", "primitive", {
        cpp: 100,
        "scriptc-c": 100,
        "scriptc-llvm": 100,
        v8: 100,
      }),
      ...workload("dom-batch-a", "boundary-heavy", {
        cpp: 100,
        "scriptc-c": 90,
        "scriptc-llvm": 90,
        v8: 100,
      }),
      ...workload("dom-batch-b", "boundary-heavy", {
        cpp: 100,
        "scriptc-c": 80,
        "scriptc-llvm": 80,
        v8: 100,
      }),
    ],
    capsuleStructure: cleanCapsule,
    provenance,
  });

  assert.equal(report.passed, true);
});

test("Chromium performance contract rejects incomplete lane matrices", () => {
  assert.throws(
    () => evaluateChromiumPerformance({
      observations: [
        ...workload("set-text", "primitive", {
          cpp: 100,
          "scriptc-c": 100,
          "scriptc-llvm": 100,
          v8: 100,
        }),
        ...workload("dom-batch", "boundary-heavy", {
          cpp: 100,
          "scriptc-c": 100,
          "scriptc-llvm": 100,
          v8: 100,
        }).filter((observation) => observation.lane !== "v8"),
      ],
      capsuleStructure: cleanCapsule,
      provenance,
    }),
    /Missing Chromium benchmark lane: dom-batch\/v8/u,
  );
});

test("Chromium performance contract requires matched sample counts", () => {
  const observations = [
    ...workload("set-text", "primitive", {
      cpp: 100,
      "scriptc-c": 100,
      "scriptc-llvm": 100,
      v8: 100,
    }),
    ...workload("dom-batch", "boundary-heavy", {
      cpp: 100,
      "scriptc-c": 80,
      "scriptc-llvm": 80,
      v8: 100,
    }),
  ].map((observation) =>
    observation.workload === "dom-batch" && observation.lane === "v8"
      ? { ...observation, samplesNanoseconds: [...samples(100), 100] }
      : observation
  );

  assert.throws(
    () => evaluateChromiumPerformance({
      observations,
      capsuleStructure: cleanCapsule,
      provenance,
    }),
    /lanes use different sample counts/u,
  );
});
