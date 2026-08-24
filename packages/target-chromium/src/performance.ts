export type ChromiumBenchmarkLane =
  | "cpp"
  | "scriptc-c"
  | "scriptc-llvm"
  | "v8";

export type ChromiumBenchmarkCategory =
  | "primitive"
  | "boundary-heavy"
  | "mixed";

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

export interface ChromiumBenchmarkProvenance {
  readonly schemaVersion: 1;
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

export interface ChromiumPerformanceInput {
  readonly observations: readonly ChromiumBenchmarkObservation[];
  readonly capsuleStructure: ChromiumCapsuleStructure;
  readonly provenance: ChromiumBenchmarkProvenance;
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

export function defineChromiumPerformanceInput(
  value: unknown,
): ChromiumPerformanceInput {
  assertRecord(value, "Chromium performance input");
  assertExactKeys(
    value,
    ["capsuleStructure", "observations", "provenance"],
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
  const provenancePath = "Chromium performance input/provenance";
  assertRecord(value.provenance, provenancePath);
  assertExactKeys(
    value.provenance,
    [
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
  if (value.provenance.schemaVersion !== 1) {
    throw new TypeError(`${provenancePath}/schemaVersion must be 1`);
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

  if (![...categories.values()].includes("primitive")) {
    throw new Error("Chromium performance input requires a primitive workload");
  }
  if (![...categories.values()].includes("boundary-heavy")) {
    throw new Error(
      "Chromium performance input requires a boundary-heavy workload",
    );
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
    for (const workload of byWorkload.values()) {
      const compiled = workload.get(lane)!;
      if (compiled.category !== "boundary-heavy") continue;
      compiledAggregate += compiled.medianNanoseconds;
      v8Aggregate += workload.get("v8")!.medianNanoseconds;
    }
    if (compiledAggregate > v8Aggregate * v8BoundaryHeavyMaximumRatio) {
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

  return Object.freeze({
    passed: violations.length === 0,
    metrics: Object.freeze(metrics),
    violations: Object.freeze(violations),
    provenance: defined.provenance,
  });
}
