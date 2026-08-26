import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { assertScabiManifest } from "@native-typescript/scabi";
import {
  defineChromiumPerformanceInput,
  evaluateChromiumPerformance,
  type ChromiumBenchmarkCategory,
  type ChromiumBenchmarkLane,
  type ChromiumBenchmarkObservation,
  type ChromiumProductShapeObservation,
} from "@native-typescript/target-chromium";
import {
  loadScriptCLibraryPlanners,
  scriptCCompilerDistribution,
  translateScabiNativeProgram,
  type ScriptCLibraryCompilationPlan,
} from "@native-typescript/scriptc";

interface ScriptCLibraryEmitter {
  readonly emitLibraryCompilationPlan: (plan: ScriptCLibraryCompilationPlan) => string;
}

const lanes = ["cpp", "scriptc-c", "scriptc-llvm", "v8"] as const;
const chromiumPackageRoot = resolve(
  import.meta.dirname,
  "../packages/target-chromium",
);

function collectRecords(
  value: unknown,
  predicate: (record: Readonly<Record<string, unknown>>) => boolean,
  output: Readonly<Record<string, unknown>>[] = [],
): Readonly<Record<string, unknown>>[] {
  if (value === null || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) collectRecords(item, predicate, output);
    return output;
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (predicate(record)) output.push(record);
  for (const child of Object.values(record)) {
    collectRecords(child, predicate, output);
  }
  return output;
}

function samples(value: number): readonly number[] {
  return Object.freeze(Array.from({ length: 20 }, () => value));
}

function benchmarkBudget(
  perCallIterations: number,
  perCallWarmupIterations: number,
  compiledLoopIterations = perCallIterations,
  compiledLoopWarmupIterations = perCallWarmupIterations,
): Readonly<{
  perCallIterations: number;
  perCallWarmupIterations: number;
  compiledLoopIterations: number;
  compiledLoopWarmupIterations: number;
}> {
  return Object.freeze({
    perCallIterations,
    perCallWarmupIterations,
    compiledLoopIterations,
    compiledLoopWarmupIterations,
  });
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

function productShape(
  lane: ChromiumBenchmarkLane,
  workloadName: string,
  managedSubscriptions = 0,
): ChromiumProductShapeObservation {
  const compiled = lane === "scriptc-c" || lane === "scriptc-llvm";
  const snapshot = Object.freeze({
    rssBytes: 100_000_000,
    pssBytes: 90_000_000,
    documents: 1,
    nodes: 8,
    jsEventListeners: 0,
  });
  return Object.freeze({
    lane,
    workload: workloadName,
    startupMilliseconds: 50,
    workloadMilliseconds: 400,
    shutdownMilliseconds: 25,
    wallClockMilliseconds: 500,
    rendererPeakRssBytes: 120_000_000,
    baseline: snapshot,
    postWorkload: snapshot,
    postTeardown: snapshot,
    finalInterop: compiled
      ? Object.freeze({
        managedNodePeers: 1,
        managedNodeClaims: 1,
        managedSubscriptions,
      })
      : null,
  });
}

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

  const controlled = defineChromiumPerformanceInput({
    ...input,
    provenance: {
      ...provenance,
      schemaVersion: 2,
      benchmarkEnvironment: {
        iterationsPerSample: 100_000,
        samplesPerRepetition: 30,
        warmupIterations: 20_000,
        repetitions: 3,
        laneIsolation: "fresh-renderer",
        rendererCpuSet: "0-3",
      },
    },
  });
  assert.equal(controlled.provenance.schemaVersion, 2);
  assert.equal(
    controlled.provenance.schemaVersion === 2
      ? controlled.provenance.benchmarkEnvironment.rendererCpuSet
      : undefined,
    "0-3",
  );
});

test("schema 3 records product shape per workload and lane", () => {
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
  ];
  const schema3Provenance = {
    ...provenance,
    schemaVersion: 3 as const,
    benchmarkEnvironment: {
      workloads: [
        {
          id: "set-text",
          budgets: {
            cpp: benchmarkBudget(100, 20),
            "scriptc-c": benchmarkBudget(100, 20),
            "scriptc-llvm": benchmarkBudget(100, 20),
            v8: benchmarkBudget(100, 20),
          },
        },
        {
          id: "dom-batch",
          budgets: {
            cpp: benchmarkBudget(10, 2, 20, 4),
            "scriptc-c": benchmarkBudget(1, 1, 5, 1),
            "scriptc-llvm": benchmarkBudget(1, 1, 5, 1),
            v8: benchmarkBudget(10, 2, 20, 4),
          },
        },
      ],
      samplesPerRepetition: 20,
      repetitions: 1,
      laneIsolation: "fresh-renderer" as const,
      rendererCpuSet: null,
    },
  };
  const productShapeSamples = ["set-text", "dom-batch"].flatMap(
    (workloadName) => lanes.map((lane) => productShape(lane, workloadName)),
  );
  const report = evaluateChromiumPerformance({
    observations,
    capsuleStructure: cleanCapsule,
    provenance: schema3Provenance,
    productShape: productShapeSamples,
    artifactShape: {
      sharedContentShellBytes: 1_000_000,
      scriptcCArchiveBytes: 10_000,
      scriptcLlvmArchiveBytes: 12_000,
    },
  });

  assert.equal(report.passed, true);
  assert.equal(report.productShape.length, 8);
  assert.equal(Object.isFrozen(report.productShape), true);

  const schema4 = defineChromiumPerformanceInput({
    observations,
    capsuleStructure: cleanCapsule,
    provenance: {
      ...schema3Provenance,
      schemaVersion: 4,
      benchmarkEnvironment: {
        ...schema3Provenance.benchmarkEnvironment,
        laneScheduling: "workload-repetition-rotation",
      },
    },
    productShape: productShapeSamples,
    artifactShape: {
      sharedContentShellBytes: 1_000_000,
      scriptcCArchiveBytes: 10_000,
      scriptcLlvmArchiveBytes: 12_000,
    },
  });
  assert.equal(schema4.provenance.schemaVersion, 4);
  if (schema4.provenance.schemaVersion !== 4) {
    assert.fail("schema 4 provenance was not preserved");
  }
  const schema4Provenance = schema4.provenance;
  assert.equal(
    schema4Provenance.benchmarkEnvironment.laneScheduling,
    "workload-repetition-rotation",
  );
  assert.throws(
    () => defineChromiumPerformanceInput({
      ...schema4,
      provenance: {
        ...schema4Provenance,
        benchmarkEnvironment: {
          ...schema4Provenance.benchmarkEnvironment,
          laneScheduling: "fixed",
        },
      },
    }),
    /laneScheduling must be workload-repetition-rotation/u,
  );
  assert.throws(
    () => defineChromiumPerformanceInput({
      observations,
      capsuleStructure: cleanCapsule,
      provenance: schema3Provenance,
      productShape: productShapeSamples.slice(1),
      artifactShape: {
        sharedContentShellBytes: 1_000_000,
        scriptcCArchiveBytes: 10_000,
        scriptcLlvmArchiveBytes: 12_000,
      },
    }),
    /must contain 8 observations/u,
  );

  const leaking = evaluateChromiumPerformance({
    observations,
    capsuleStructure: cleanCapsule,
    provenance: schema3Provenance,
    productShape: productShapeSamples.map((observation) =>
      observation.lane === "scriptc-c"
        ? productShape("scriptc-c", observation.workload, 1)
        : observation
    ),
    artifactShape: {
      sharedContentShellBytes: 1_000_000,
      scriptcCArchiveBytes: 10_000,
      scriptcLlvmArchiveBytes: 12_000,
    },
  });
  assert.equal(leaking.passed, false);
  assert.ok(leaking.violations.some((violation) =>
    violation.includes("retained 1 managed event subscriptions")
  ));
});

test("both ScriptC benchmark lanes plan the generated DOM kernels", async () => {
  const webIdlRoot = resolve(chromiumPackageRoot, "chromium/webidl");
  const manifest = assertScabiManifest(JSON.parse(readFileSync(
    resolve(webIdlRoot, "package.scabi.json"),
    "utf8",
  )));
  const translated = translateScabiNativeProgram(manifest, {
    imports: [
      "web_current_document",
      "web_document_body",
      "web_document_create_element",
      "web_document_create_text_node",
      "web_node_append_child",
      "web_node_remove_child",
      "web_element_set_attribute",
      "web_element_query_selector",
      "web_html_element_click",
      "web_character_data_set_data",
      "web_event_target_listen",
      "web_subscription_release",
    ],
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

  const benchmarkRoot = resolve(chromiumPackageRoot, "../../benchmarks/chromium/scriptc");
  const { planLibraryCompilation, planLibraryExternalCBuild } =
    await loadScriptCLibraryPlanners();
  const compiler = await import(
    pathToFileURL(resolve(scriptCCompilerDistribution(), "index.js")).href
  ) as Partial<ScriptCLibraryEmitter>;
  assert.equal(typeof compiler.emitLibraryCompilationPlan, "function");
  for (const backend of ["c", "llvm"] as const) {
    const planned = await planLibraryCompilation({
      profilePath: resolve(benchmarkRoot, `profile-${backend}.json`),
      externalTypes: {
        [manifest.package.name]: resolve(webIdlRoot, "reached.d.ts"),
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
      /96324a4012fe62f48b9463a67486eeb645bc5c78#web_document_create_element/u,
    );
    const plannedIr = JSON.parse(planned.plan.ir) as unknown;
    const createTextCalls = collectRecords(
      plannedIr,
      (record) =>
        record.kind === "nativeCall" &&
        typeof record.binding === "string" &&
        record.binding.endsWith("#web_document_create_text_node"),
    );
    assert.equal(createTextCalls.length, 5);
    assert.equal(
      createTextCalls.filter((call) => call.resultMode === "frameBounded").length,
      4,
      "nested borrowed text nodes must not allocate managed ScriptC/Oilpan peers",
    );
    const listenerCalls = collectRecords(
      plannedIr,
      (record) =>
        record.kind === "nativeCall" &&
        typeof record.binding === "string" &&
        record.binding.endsWith("#web_event_target_listen"),
    );
    assert.equal(listenerCalls.length, 1);
    assert.equal(
      listenerCalls[0]?.resultMode,
      "frameBounded",
      "a synchronous local listener with terminal dispose must transfer its callback context directly to Blink",
    );
    const frameResources = collectRecords(
      plannedIr,
      (record) =>
        typeof record.nativeFrame === "object" &&
        record.nativeFrame !== null &&
        (record.nativeFrame as Record<string, unknown>).release ===
          "nts_web_subscription_release_frame",
    );
    assert.equal(frameResources.length, 1);
    const frameContexts = collectRecords(
      plannedIr,
      (record) => record.kind === "closure" && record.nativeFrameContext === true,
    );
    assert.equal(
      frameContexts.length,
      1,
      "the scoped listener closure itself must use the proven stack context",
    );
    const frameCaptures = collectRecords(
      plannedIr,
      (record) => record.nativeFrameCapture === true,
    );
    assert.equal(
      frameCaptures.length,
      1,
      "the listener checksum must use a stack capture box rather than a heap box",
    );
    const generated = compiler.emitLibraryCompilationPlan!(planned.plan);
    assert.match(generated, /sc_native_cb_[0-9]+_frame/u);
    assert.match(generated, /scr_closure_retain(?:_v)?/u);
    assert.match(generated, /nts_web_event_target_listen_frame/u);
    assert.match(generated, /scr_closure_release_v/u);
    assert.match(generated, /scr_box_init_frame/u);
    assert.match(generated, /scr_closure_init_frame/u);
    if (backend === "c") {
      assert.match(
        generated,
        /void \*sc_frame_closure_storage_0 = SCR_STACK_ALLOC\(SCR_CLOSURE_FRAME_BYTES\(1\)\);/u,
        "C must reserve one callback slot in the function prologue",
      );
      assert.match(
        generated,
        /scr_closure_init_frame\(sc_frame_closure_storage_0,/u,
        "each evaluation must reinitialize its function-entry slot",
      );
      assert.doesNotMatch(
        generated,
        /scr_closure_init_frame\(SCR_STACK_ALLOC/u,
        "loop evaluation must not grow the native stack",
      );
    } else {
      assert.match(
        generated,
        /alloca \[5 x ptr\]/u,
        "LLVM must reserve its closure header and one capture at function entry",
      );
    }
    assert.match(generated, /nts_web_subscription_release_frame/u);
    assert.doesNotMatch(
      generated,
      backend === "c"
        ? /nts_web_character_data_set_data_managed\([^;\n]+, \(size_t\)0\)/u
        : /call void @nts_web_character_data_set_data_managed\([^\n]+, i64 0\)/u,
      "a finite literal choice in retained text mutation must preserve the selected static identity",
    );
    assert.doesNotMatch(
      generated,
      backend === "c"
        ? /nts_web_element_set_attribute\([^;\n]+, \(size_t\)0, &/u
        : /call void @nts_web_element_set_attribute\([^\n]+, i64 0, ptr/u,
      "a finite literal choice in attribute mutation must preserve the selected static identity",
    );
    assert.doesNotMatch(
      generated,
      /scr_direct_callback_create_owned/u,
      "the scoped event registration must transfer its closure without allocating a callback wrapper",
    );
    assert.doesNotMatch(
      generated,
      /scr_native_handle_prepare_direct_callback(?:_fused)?/u,
      "the scoped event registration must not construct a stable callback lifecycle cell",
    );
    const profile = JSON.parse(readFileSync(
      resolve(benchmarkRoot, `profile-${backend}.json`),
      "utf8",
    )) as {
      readonly abi: {
        readonly init_symbol: string;
        readonly sink_register_symbol: string;
        readonly hosted_scheduler_configure_symbol: string;
        readonly hosted_scheduler_stop_symbol: string;
      };
      readonly exports: readonly { readonly symbol: string }[];
    };
    assert.deepEqual(planned.plan.nativeBuild.localizeSymbols, [
      profile.abi.init_symbol,
      profile.abi.sink_register_symbol,
      profile.abi.hosted_scheduler_configure_symbol,
      profile.abi.hosted_scheduler_stop_symbol,
      ...profile.exports.map(({ symbol }) => symbol),
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

test("the scoped Blink event result reuses its Oilpan listener", () => {
  const registry = readFileSync(
    resolve(
      chromiumPackageRoot,
      "chromium/overlay/nts_blink_managed_registry.cc",
    ),
    "utf8",
  );
  const scabi = readFileSync(
    resolve(chromiumPackageRoot, "chromium/overlay/nts_blink_scabi.cc"),
    "utf8",
  );
  const frameListen = /NtsWebManagedSubscription \*BlinkManagedRegistry::ListenFrame\([\s\S]*?\n\}\n\nvoid BlinkManagedRegistry::RemoveSubscription/u.exec(
    registry,
  )?.[0];
  assert.ok(frameListen, "the frame-only listener implementation must exist");
  assert.match(
    frameListen,
    /MakeGarbageCollected<BlinkFrameEventListener>/u,
  );
  assert.match(
    frameListen,
    /reinterpret_cast<NtsWebManagedSubscription \*>\(listener\)/u,
  );
  assert.doesNotMatch(frameListen, /new \(std::nothrow\)|Persistent</u);
  assert.match(
    scabi,
    /nts_web_subscription_release_frame\([\s\S]*?ReleaseFrameSubscription\(subscription\)/u,
  );
  assert.match(
    scabi,
    /nts_web_subscription_release\([\s\S]*?ReleaseManagedSubscription\(subscription\)/u,
  );

  const frameListener = /class BlinkFrameEventListener[\s\S]*?\n\};/u.exec(
    registry,
  )?.[0];
  assert.ok(frameListener, "the frame-only listener class must exist");
  assert.match(
    frameListener,
    /CurrentWebRealm\(\) != realm_/u,
    "the frame listener must fail closed outside its proven enclosing realm",
  );
  assert.doesNotMatch(
    frameListener,
    /ScopedCurrentWebRealm active_realm/u,
    "the frame listener must reuse rather than reinstall its enclosing realm",
  );
  assert.match(
    frameListener,
    /DCHECK_EQ\(realm_->Document\(\)->GetExecutionContext\(\), context\)/u,
    "debug builds must retain the execution-context invariant",
  );

  const stableListener = /class BlinkManagedEventListener[\s\S]*?\n\};/u.exec(
    registry,
  )?.[0];
  assert.ok(stableListener, "the stable listener class must exist");
  assert.match(
    stableListener,
    /ScopedCurrentWebRealm active_realm/u,
    "escaping listeners must still install their realm defensively",
  );
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

test("Chromium performance contract accepts a focused mixed workload", () => {
  const report = evaluateChromiumPerformance({
    observations: workload("event-round-trip", "mixed", {
      cpp: 100,
      "scriptc-c": 105,
      "scriptc-llvm": 108,
      v8: 160,
    }),
    capsuleStructure: cleanCapsule,
    provenance,
  });

  assert.equal(report.passed, true);
  assert.equal(report.metrics.length, lanes.length);
  assert.deepEqual(report.violations, []);
});

test("Chromium performance contract accepts a focused primitive workload", () => {
  const report = evaluateChromiumPerformance({
    observations: workload("set-text", "primitive", {
      cpp: 100,
      "scriptc-c": 120,
      "scriptc-llvm": 115,
      v8: 125,
    }),
    capsuleStructure: cleanCapsule,
    provenance,
  });

  assert.equal(report.passed, true);
  assert.deepEqual(report.violations, []);
});

test("Chromium performance contract rejects an empty workload set", () => {
  assert.throws(
    () => evaluateChromiumPerformance({
      observations: [],
      capsuleStructure: cleanCapsule,
      provenance,
    }),
    /requires a workload/u,
  );
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
