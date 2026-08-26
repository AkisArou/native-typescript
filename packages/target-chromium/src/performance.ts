export type ChromiumBenchmarkLane =
  | "cpp"
  | "scriptc-c"
  | "scriptc-llvm"
  | "v8";

import type { ChromiumBenchmarkCategory } from "./benchmark-contract.ts";

export type { ChromiumBenchmarkCategory } from "./benchmark-contract.ts";

export interface ChromiumBenchmarkObservation {
  readonly workload: string;
  readonly category: ChromiumBenchmarkCategory;
  readonly lane: ChromiumBenchmarkLane;
  readonly samplesNanoseconds: readonly number[];
}

export interface ChromiumCapsuleStructure {
  readonly genericDispatch: boolean;
  readonly v8Values: boolean;
  readonly avoidableBoxing: boolean;
  readonly perCallHeapAllocation: boolean;
}

export interface ChromiumInteropDiagnostics {
  readonly managedNodePeers: number;
  readonly managedNodeClaims: number;
  readonly managedSubscriptions: number;
}

export interface ChromiumRendererSnapshot {
  readonly rssBytes: number;
  readonly pssBytes: number;
  readonly documents: number;
  readonly nodes: number;
  readonly jsEventListeners: number;
}

export interface ChromiumProductShapeObservation {
  readonly lane: ChromiumBenchmarkLane;
  readonly workload: string;
  readonly startupMilliseconds: number;
  readonly workloadMilliseconds: number;
  readonly shutdownMilliseconds?: number;
  readonly wallClockMilliseconds: number;
  readonly rendererPeakRssBytes: number;
  readonly baseline: ChromiumRendererSnapshot;
  readonly postWorkload: ChromiumRendererSnapshot;
  readonly postTeardown: ChromiumRendererSnapshot;
  readonly finalInterop: ChromiumInteropDiagnostics | null;
}

export interface ChromiumArtifactShape {
  readonly sharedContentShellBytes: number;
  readonly scriptcCArchiveBytes: number;
  readonly scriptcLlvmArchiveBytes: number;
}

interface ChromiumBenchmarkProvenanceCommon {
  readonly chromiumRevision: string;
  readonly nativeTypescriptRevision: string;
  readonly scriptCRevision: string;
  readonly chromiumClangVersion: string;
  readonly contentShellDigest: string;
  readonly scriptcCArchiveDigest: string;
  readonly scriptcLlvmArchiveDigest: string;
  readonly fixtureDigest: string;
  readonly buildArguments: readonly string[];
  readonly recordedAt: string;
}

export interface ChromiumBenchmarkProvenanceV1
  extends ChromiumBenchmarkProvenanceCommon {
  readonly schemaVersion: 1;
}

export interface ChromiumBenchmarkEnvironment {
  readonly iterationsPerSample: number;
  readonly samplesPerRepetition: number;
  readonly warmupIterations: number;
  readonly repetitions: number;
  readonly laneIsolation: "fresh-renderer";
  readonly rendererCpuSet: string | null;
}

export interface ChromiumBenchmarkShapeBudget {
  readonly perCallIterations: number;
  readonly perCallWarmupIterations: number;
  readonly compiledLoopIterations: number;
  readonly compiledLoopWarmupIterations: number;
}

export interface ChromiumBenchmarkWorkloadEnvironment {
  readonly id: string;
  readonly budgets: Readonly<
    Record<ChromiumBenchmarkLane, ChromiumBenchmarkShapeBudget>
  >;
}

export interface ChromiumBenchmarkEnvironmentV3 {
  readonly workloads: readonly ChromiumBenchmarkWorkloadEnvironment[];
  readonly samplesPerRepetition: number;
  readonly repetitions: number;
  readonly laneIsolation: "fresh-renderer";
  readonly rendererCpuSet: string | null;
}

export interface ChromiumBenchmarkEnvironmentV4
  extends ChromiumBenchmarkEnvironmentV3 {
  readonly laneScheduling: "workload-repetition-rotation";
}

export interface ChromiumBenchmarkProvenanceV2
  extends ChromiumBenchmarkProvenanceCommon {
  readonly schemaVersion: 2;
  readonly benchmarkEnvironment: ChromiumBenchmarkEnvironment;
}

export interface ChromiumBenchmarkProvenanceV3
  extends ChromiumBenchmarkProvenanceCommon {
  readonly schemaVersion: 3;
  readonly benchmarkEnvironment: ChromiumBenchmarkEnvironmentV3;
}

export interface ChromiumBenchmarkProvenanceV4
  extends ChromiumBenchmarkProvenanceCommon {
  readonly schemaVersion: 4;
  readonly benchmarkEnvironment: ChromiumBenchmarkEnvironmentV4;
}

export type ChromiumBenchmarkProvenance =
  | ChromiumBenchmarkProvenanceV1
  | ChromiumBenchmarkProvenanceV2
  | ChromiumBenchmarkProvenanceV3
  | ChromiumBenchmarkProvenanceV4;

export interface ChromiumPerformanceInput {
  readonly observations: readonly ChromiumBenchmarkObservation[];
  readonly capsuleStructure: ChromiumCapsuleStructure;
  readonly provenance: ChromiumBenchmarkProvenance;
  readonly productShape?: readonly ChromiumProductShapeObservation[];
  readonly artifactShape?: ChromiumArtifactShape;
}

export interface ChromiumBenchmarkMetrics {
  readonly workload: string;
  readonly category: ChromiumBenchmarkCategory;
  readonly lane: ChromiumBenchmarkLane;
  readonly medianNanoseconds: number;
  readonly p95Nanoseconds: number;
  readonly sampleCount: number;
}

export interface ChromiumPerformanceReport {
  readonly passed: boolean;
  readonly metrics: readonly ChromiumBenchmarkMetrics[];
  readonly violations: readonly string[];
  readonly provenance: ChromiumBenchmarkProvenance;
  readonly productShape: readonly ChromiumProductShapeObservation[];
  readonly artifactShape: ChromiumArtifactShape | null;
}

const lanes = Object.freeze([
  "cpp",
  "scriptc-c",
  "scriptc-llvm",
  "v8",
] as const);
const compiledLanes = Object.freeze(["scriptc-c", "scriptc-llvm"] as const);
const minimumSampleCount = 20;
const cppMaximumRatio = 1.25;
const v8IndividualMaximumRatio = 1.1;
const v8BoundaryHeavyMaximumRatio = 0.85;

function assertRecord(
  value: unknown,
  path: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${path} fields must be exactly: ${expected.join(", ")}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertRendererSnapshot(value: unknown, path: string): void {
  assertRecord(value, path);
  assertExactKeys(
    value,
    ["documents", "jsEventListeners", "nodes", "pssBytes", "rssBytes"],
    path,
  );
  for (const [name, field] of Object.entries(value)) {
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
      throw new TypeError(`${path}/${name} must be a non-negative integer`);
    }
  }
}

export function defineChromiumPerformanceInput(
  value: unknown,
): ChromiumPerformanceInput {
  assertRecord(value, "Chromium performance input");
  assertExactKeys(
    value,
    [
      "capsuleStructure",
      "observations",
      "provenance",
      ...(Object.hasOwn(value, "artifactShape") ? ["artifactShape"] : []),
      ...(Object.hasOwn(value, "productShape") ? ["productShape"] : []),
    ],
    "Chromium performance input",
  );
  if (!Array.isArray(value.observations)) {
    throw new TypeError("Chromium performance input/observations must be an array");
  }
  for (const [index, observation] of value.observations.entries()) {
    const path = `Chromium performance input/observations/${index}`;
    assertRecord(observation, path);
    assertExactKeys(
      observation,
      ["category", "lane", "samplesNanoseconds", "workload"],
      path,
    );
    if (typeof observation.workload !== "string") {
      throw new TypeError(`${path}/workload must be a string`);
    }
    if (
      observation.category !== "primitive" &&
      observation.category !== "boundary-heavy" &&
      observation.category !== "mixed"
    ) {
      throw new TypeError(`${path}/category is unsupported`);
    }
    if (!lanes.includes(observation.lane as ChromiumBenchmarkLane)) {
      throw new TypeError(`${path}/lane is unsupported`);
    }
    if (
      !Array.isArray(observation.samplesNanoseconds) ||
      observation.samplesNanoseconds.some((sample) => typeof sample !== "number")
    ) {
      throw new TypeError(`${path}/samplesNanoseconds must be a number array`);
    }
  }
  assertRecord(
    value.capsuleStructure,
    "Chromium performance input/capsuleStructure",
  );
  assertExactKeys(
    value.capsuleStructure,
    [
      "avoidableBoxing",
      "genericDispatch",
      "perCallHeapAllocation",
      "v8Values",
    ],
    "Chromium performance input/capsuleStructure",
  );
  for (const [name, present] of Object.entries(value.capsuleStructure)) {
    if (typeof present !== "boolean") {
      throw new TypeError(
        `Chromium performance input/capsuleStructure/${name} must be boolean`,
      );
    }
  }
  if (Object.hasOwn(value, "artifactShape")) {
    const path = "Chromium performance input/artifactShape";
    assertRecord(value.artifactShape, path);
    assertExactKeys(
      value.artifactShape,
      [
        "scriptcCArchiveBytes",
        "scriptcLlvmArchiveBytes",
        "sharedContentShellBytes",
      ],
      path,
    );
    for (const [name, size] of Object.entries(value.artifactShape)) {
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
        throw new TypeError(`${path}/${name} must be a positive integer`);
      }
    }
  }
  if (Object.hasOwn(value, "productShape")) {
    if (!Array.isArray(value.productShape)) {
      throw new TypeError("Chromium performance input/productShape must be an array");
    }
    for (const [index, observation] of value.productShape.entries()) {
      const path = `Chromium performance input/productShape/${index}`;
      assertRecord(observation, path);
      assertExactKeys(
        observation,
        [
          "baseline",
          "finalInterop",
          "lane",
          "postTeardown",
          "postWorkload",
          "rendererPeakRssBytes",
          ...(Object.hasOwn(observation, "shutdownMilliseconds")
            ? ["shutdownMilliseconds"]
            : []),
          "startupMilliseconds",
          "wallClockMilliseconds",
          "workload",
          "workloadMilliseconds",
        ],
        path,
      );
      if (!lanes.includes(observation.lane as ChromiumBenchmarkLane)) {
        throw new TypeError(`${path}/lane is unsupported`);
      }
      if (typeof observation.workload !== "string" ||
          observation.workload.length === 0) {
        throw new TypeError(`${path}/workload must be non-empty`);
      }
      const startupMilliseconds = observation.startupMilliseconds;
      const workloadMilliseconds = observation.workloadMilliseconds;
      const shutdownMilliseconds = observation.shutdownMilliseconds;
      const wallClockMilliseconds = observation.wallClockMilliseconds;
      if (typeof startupMilliseconds !== "number" ||
          !Number.isFinite(startupMilliseconds) || startupMilliseconds <= 0) {
        throw new TypeError(`${path}/startupMilliseconds must be positive`);
      }
      if (typeof wallClockMilliseconds !== "number" ||
          !Number.isFinite(wallClockMilliseconds) || wallClockMilliseconds <= 0) {
        throw new TypeError(`${path}/wallClockMilliseconds must be positive`);
      }
      if (typeof workloadMilliseconds !== "number" ||
          !Number.isFinite(workloadMilliseconds) || workloadMilliseconds <= 0) {
        throw new TypeError(`${path}/workloadMilliseconds must be positive`);
      }
      if (shutdownMilliseconds !== undefined &&
          (typeof shutdownMilliseconds !== "number" ||
            !Number.isFinite(shutdownMilliseconds) || shutdownMilliseconds <= 0)) {
        throw new TypeError(`${path}/shutdownMilliseconds must be positive`);
      }
      if (wallClockMilliseconds < startupMilliseconds + workloadMilliseconds +
          (shutdownMilliseconds ?? 0)) {
        throw new TypeError(
          `${path}/wallClockMilliseconds must include startup, workload, and shutdown time`,
        );
      }
      if (typeof observation.rendererPeakRssBytes !== "number" ||
          !Number.isSafeInteger(observation.rendererPeakRssBytes) ||
          observation.rendererPeakRssBytes < 0) {
        throw new TypeError(
          `${path}/rendererPeakRssBytes must be a non-negative integer`,
        );
      }
      assertRendererSnapshot(observation.baseline, `${path}/baseline`);
      assertRendererSnapshot(observation.postWorkload, `${path}/postWorkload`);
      assertRendererSnapshot(observation.postTeardown, `${path}/postTeardown`);
      if (observation.finalInterop !== null) {
        assertRecord(observation.finalInterop, `${path}/finalInterop`);
        assertExactKeys(
          observation.finalInterop,
          ["managedNodeClaims", "managedNodePeers", "managedSubscriptions"],
          `${path}/finalInterop`,
        );
        for (const [name, field] of Object.entries(observation.finalInterop)) {
          if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
            throw new TypeError(`${path}/finalInterop/${name} must be non-negative`);
          }
        }
        if ((observation.finalInterop.managedNodeClaims as number) <
            (observation.finalInterop.managedNodePeers as number)) {
          throw new TypeError(
            `${path}/finalInterop has fewer claims than managed peers`,
          );
        }
      }
      const isCompiled = observation.lane === "scriptc-c" ||
        observation.lane === "scriptc-llvm";
      if (isCompiled !== (observation.finalInterop !== null)) {
        throw new TypeError(
          `${path}/finalInterop must be present only for ScriptC lanes`,
        );
      }
    }
  }
  const provenancePath = "Chromium performance input/provenance";
  assertRecord(value.provenance, provenancePath);
  if (
    value.provenance.schemaVersion !== 1 &&
    value.provenance.schemaVersion !== 2 &&
    value.provenance.schemaVersion !== 3 &&
    value.provenance.schemaVersion !== 4
  ) {
    throw new TypeError(`${provenancePath}/schemaVersion must be 1, 2, 3, or 4`);
  }
  assertExactKeys(
    value.provenance,
    [
      ...(value.provenance.schemaVersion === 2 ||
          value.provenance.schemaVersion === 3 ||
          value.provenance.schemaVersion === 4
        ? ["benchmarkEnvironment"]
        : []),
      "buildArguments",
      "chromiumClangVersion",
      "chromiumRevision",
      "contentShellDigest",
      "fixtureDigest",
      "nativeTypescriptRevision",
      "recordedAt",
      "schemaVersion",
      "scriptCRevision",
      "scriptcCArchiveDigest",
      "scriptcLlvmArchiveDigest",
    ],
    provenancePath,
  );
  if (value.provenance.schemaVersion === 2) {
    const environmentPath = `${provenancePath}/benchmarkEnvironment`;
    assertRecord(value.provenance.benchmarkEnvironment, environmentPath);
    assertExactKeys(
      value.provenance.benchmarkEnvironment,
      [
        "iterationsPerSample",
        "laneIsolation",
        "rendererCpuSet",
        "repetitions",
        "samplesPerRepetition",
        "warmupIterations",
      ],
      environmentPath,
    );
    for (const name of [
      "iterationsPerSample",
      "repetitions",
      "samplesPerRepetition",
      "warmupIterations",
    ] as const) {
      const field = value.provenance.benchmarkEnvironment[name];
      if (
        typeof field !== "number" ||
        !Number.isSafeInteger(field) ||
        field <= 0
      ) {
        throw new TypeError(`${environmentPath}/${name} must be positive`);
      }
    }
    if (value.provenance.benchmarkEnvironment.laneIsolation !== "fresh-renderer") {
      throw new TypeError(
        `${environmentPath}/laneIsolation must be fresh-renderer`,
      );
    }
    const cpuSet = value.provenance.benchmarkEnvironment.rendererCpuSet;
    if (
      cpuSet !== null &&
      (typeof cpuSet !== "string" ||
        !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u.test(cpuSet))
    ) {
      throw new TypeError(`${environmentPath}/rendererCpuSet is invalid`);
    }
  }
  if (value.provenance.schemaVersion === 3 ||
      value.provenance.schemaVersion === 4) {
    const environmentPath = `${provenancePath}/benchmarkEnvironment`;
    assertRecord(value.provenance.benchmarkEnvironment, environmentPath);
    assertExactKeys(
      value.provenance.benchmarkEnvironment,
      [
        "laneIsolation",
        ...(value.provenance.schemaVersion === 4 ? ["laneScheduling"] : []),
        "rendererCpuSet",
        "repetitions",
        "samplesPerRepetition",
        "workloads",
      ],
      environmentPath,
    );
    for (const name of ["repetitions", "samplesPerRepetition"] as const) {
      const field = value.provenance.benchmarkEnvironment[name];
      if (typeof field !== "number" || !Number.isSafeInteger(field) || field <= 0) {
        throw new TypeError(`${environmentPath}/${name} must be positive`);
      }
    }
    if (value.provenance.benchmarkEnvironment.laneIsolation !== "fresh-renderer") {
      throw new TypeError(
        `${environmentPath}/laneIsolation must be fresh-renderer`,
      );
    }
    if (value.provenance.schemaVersion === 4 &&
        value.provenance.benchmarkEnvironment.laneScheduling !==
          "workload-repetition-rotation") {
      throw new TypeError(
        `${environmentPath}/laneScheduling must be workload-repetition-rotation`,
      );
    }
    const cpuSet = value.provenance.benchmarkEnvironment.rendererCpuSet;
    if (cpuSet !== null &&
        (typeof cpuSet !== "string" ||
         !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u.test(cpuSet))) {
      throw new TypeError(`${environmentPath}/rendererCpuSet is invalid`);
    }
    const workloads = value.provenance.benchmarkEnvironment.workloads;
    if (!Array.isArray(workloads) || workloads.length === 0) {
      throw new TypeError(`${environmentPath}/workloads must be non-empty`);
    }
    const workloadIds = new Set<string>();
    for (const [index, workload] of workloads.entries()) {
      const workloadPath = `${environmentPath}/workloads/${index}`;
      assertRecord(workload, workloadPath);
      assertExactKeys(workload, ["budgets", "id"], workloadPath);
      if (typeof workload.id !== "string" || workload.id.length === 0 ||
          workloadIds.has(workload.id)) {
        throw new TypeError(`${workloadPath}/id must be unique and non-empty`);
      }
      workloadIds.add(workload.id);
      const budgetsPath = `${workloadPath}/budgets`;
      assertRecord(workload.budgets, budgetsPath);
      assertExactKeys(workload.budgets, lanes, budgetsPath);
      for (const lane of lanes) {
        const budgetPath = `${budgetsPath}/${lane}`;
        const budget = workload.budgets[lane];
        assertRecord(budget, budgetPath);
        assertExactKeys(
          budget,
          [
            "compiledLoopIterations",
            "compiledLoopWarmupIterations",
            "perCallIterations",
            "perCallWarmupIterations",
          ],
          budgetPath,
        );
        for (const name of [
          "compiledLoopIterations",
          "compiledLoopWarmupIterations",
          "perCallIterations",
          "perCallWarmupIterations",
        ] as const) {
          const field = budget[name];
          if (typeof field !== "number" || !Number.isSafeInteger(field) ||
              field <= 0) {
            throw new TypeError(`${budgetPath}/${name} must be positive`);
          }
        }
      }
    }
    if (!Array.isArray(value.productShape) || value.productShape.length === 0) {
      throw new TypeError(
        "Chromium performance input/productShape is required for schema 3 or 4",
      );
    }
    if (value.artifactShape === undefined) {
      throw new TypeError(
        "Chromium performance input/artifactShape is required for schema 3 or 4",
      );
    }
    const repetitions =
      value.provenance.benchmarkEnvironment.repetitions as number;
    const expectedProductShapeCount =
      repetitions * lanes.length * workloadIds.size;
    if (value.productShape.length !== expectedProductShapeCount) {
      throw new TypeError(
        `Chromium performance input/productShape must contain ${expectedProductShapeCount} observations`,
      );
    }
    for (const workload of workloadIds) {
      for (const lane of lanes) {
        const count = value.productShape.filter(
          (observation) => observation.lane === lane &&
            observation.workload === workload,
        ).length;
        if (count !== repetitions) {
          throw new TypeError(
            `Chromium performance input/productShape must contain one ${workload}/${lane} observation per repetition`,
          );
        }
      }
    }
  }
  for (const revision of [
    "chromiumRevision",
    "nativeTypescriptRevision",
    "scriptCRevision",
  ] as const) {
    if (!/^[0-9a-f]{40}$/u.test(value.provenance[revision] as string)) {
      throw new TypeError(`${provenancePath}/${revision} must be a Git revision`);
    }
  }
  for (const digest of [
    "contentShellDigest",
    "scriptcCArchiveDigest",
    "scriptcLlvmArchiveDigest",
    "fixtureDigest",
  ] as const) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(value.provenance[digest] as string)) {
      throw new TypeError(`${provenancePath}/${digest} must be a SHA-256 digest`);
    }
  }
  if (
    typeof value.provenance.chromiumClangVersion !== "string" ||
    value.provenance.chromiumClangVersion.length === 0
  ) {
    throw new TypeError(`${provenancePath}/chromiumClangVersion must be non-empty`);
  }
  if (
    typeof value.provenance.recordedAt !== "string" ||
    Number.isNaN(Date.parse(value.provenance.recordedAt))
  ) {
    throw new TypeError(`${provenancePath}/recordedAt must be an ISO timestamp`);
  }
  if (
    !Array.isArray(value.provenance.buildArguments) ||
    value.provenance.buildArguments.some(
      (argument) => typeof argument !== "string" || argument.length === 0,
    )
  ) {
    throw new TypeError(`${provenancePath}/buildArguments must be a string array`);
  }
  return deepFreeze(
    structuredClone(value) as unknown as ChromiumPerformanceInput,
  );
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.ceil(sorted.length * fraction) - 1;
  return sorted[Math.max(0, index)]!;
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function metricsFor(
  observation: ChromiumBenchmarkObservation,
): ChromiumBenchmarkMetrics {
  if (observation.workload.length === 0) {
    throw new Error("Chromium benchmark workload must be non-empty");
  }
  if (observation.samplesNanoseconds.length < minimumSampleCount) {
    throw new Error(
      `${observation.workload}/${observation.lane} requires at least ${minimumSampleCount} samples`,
    );
  }
  if (
    observation.samplesNanoseconds.some(
      (sample) => !Number.isFinite(sample) || sample <= 0,
    )
  ) {
    throw new Error(
      `${observation.workload}/${observation.lane} has an invalid latency sample`,
    );
  }

  const sorted = [...observation.samplesNanoseconds].sort(
    (left, right) => left - right,
  );
  return Object.freeze({
    workload: observation.workload,
    category: observation.category,
    lane: observation.lane,
    medianNanoseconds: median(sorted),
    p95Nanoseconds: percentile(sorted, 0.95),
    sampleCount: sorted.length,
  });
}

function ratio(value: number, baseline: number): string {
  return `${(value / baseline).toFixed(3)}x`;
}

export function evaluateChromiumPerformance(
  input: ChromiumPerformanceInput,
): ChromiumPerformanceReport {
  const defined = defineChromiumPerformanceInput(input);
  const metrics = defined.observations.map(metricsFor).sort((left, right) =>
    left.workload.localeCompare(right.workload) ||
    lanes.indexOf(left.lane) - lanes.indexOf(right.lane)
  );
  const byWorkload = new Map<
    string,
    Map<ChromiumBenchmarkLane, ChromiumBenchmarkMetrics>
  >();
  const categories = new Map<string, ChromiumBenchmarkCategory>();

  if (metrics.length === 0) {
    throw new Error("Chromium performance input requires a workload");
  }

  for (const metric of metrics) {
    const category = categories.get(metric.workload);
    if (category !== undefined && category !== metric.category) {
      throw new Error(
        `Chromium benchmark workload has conflicting categories: ${metric.workload}`,
      );
    }
    categories.set(metric.workload, metric.category);
    const workload = byWorkload.get(metric.workload) ?? new Map();
    if (workload.has(metric.lane)) {
      throw new Error(
        `Duplicate Chromium benchmark lane: ${metric.workload}/${metric.lane}`,
      );
    }
    workload.set(metric.lane, metric);
    byWorkload.set(metric.workload, workload);
  }

  const violations: string[] = [];
  for (const [workloadName, workload] of byWorkload) {
    for (const lane of lanes) {
      if (!workload.has(lane)) {
        throw new Error(`Missing Chromium benchmark lane: ${workloadName}/${lane}`);
      }
    }

    const cpp = workload.get("cpp")!;
    const v8 = workload.get("v8")!;
    for (const lane of lanes) {
      const observation = workload.get(lane)!;
      if (observation.sampleCount !== cpp.sampleCount) {
        throw new Error(
          `Chromium benchmark lanes use different sample counts: ${workloadName}`,
        );
      }
    }
    for (const lane of compiledLanes) {
      const compiled = workload.get(lane)!;
      if (
        cpp.category === "primitive" &&
        compiled.medianNanoseconds > cpp.medianNanoseconds * cppMaximumRatio
      ) {
        violations.push(
          `${workloadName}/${lane} median is ${ratio(compiled.medianNanoseconds, cpp.medianNanoseconds)} handwritten C++ (maximum 1.250x)`,
        );
      }
      if (
        cpp.category === "primitive" &&
        compiled.p95Nanoseconds > cpp.p95Nanoseconds * cppMaximumRatio
      ) {
        violations.push(
          `${workloadName}/${lane} p95 is ${ratio(compiled.p95Nanoseconds, cpp.p95Nanoseconds)} handwritten C++ (maximum 1.250x)`,
        );
      }
      if (
        compiled.medianNanoseconds >
        v8.medianNanoseconds * v8IndividualMaximumRatio
      ) {
        violations.push(
          `${workloadName}/${lane} median is ${ratio(compiled.medianNanoseconds, v8.medianNanoseconds)} V8 (maximum 1.100x)`,
        );
      }
    }
  }

  for (const lane of compiledLanes) {
    let compiledAggregate = 0;
    let v8Aggregate = 0;
    let workloadCount = 0;
    for (const workload of byWorkload.values()) {
      const compiled = workload.get(lane)!;
      if (compiled.category !== "boundary-heavy") continue;
      compiledAggregate += compiled.medianNanoseconds;
      v8Aggregate += workload.get("v8")!.medianNanoseconds;
      workloadCount += 1;
    }
    if (
      workloadCount > 0 &&
      compiledAggregate > v8Aggregate * v8BoundaryHeavyMaximumRatio
    ) {
      violations.push(
        `${lane} boundary-heavy aggregate median is ${ratio(compiledAggregate, v8Aggregate)} V8 (maximum 0.850x)`,
      );
    }
  }

  const structuralChecks = Object.entries(defined.capsuleStructure).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  for (const [name, present] of structuralChecks) {
    if (present) violations.push(`generated scalar capsule uses ${name}`);
  }

  for (const observation of defined.productShape ?? []) {
    const retainedSubscriptions =
      observation.finalInterop?.managedSubscriptions;
    if (retainedSubscriptions !== undefined && retainedSubscriptions !== 0) {
      violations.push(
        `${observation.workload}/${observation.lane} retained ${retainedSubscriptions} managed event subscriptions after its workload`,
      );
    }
  }

  return Object.freeze({
    passed: violations.length === 0,
    metrics: Object.freeze(metrics),
    violations: Object.freeze(violations),
    provenance: defined.provenance,
    productShape: Object.freeze([...(defined.productShape ?? [])]),
    artifactShape: defined.artifactShape ?? null,
  });
}
