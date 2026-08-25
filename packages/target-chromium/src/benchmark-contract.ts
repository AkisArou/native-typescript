export type ChromiumBenchmarkCategory =
  | "primitive"
  | "boundary-heavy"
  | "mixed";

export interface ChromiumBenchmarkWorkload {
  readonly id: string;
  readonly typescriptExport: string;
  readonly symbolStem: string;
  readonly cppFunction: string;
  readonly perCallIterations: number;
  readonly perCallWarmupIterations: number;
  readonly compiledLoopIterations: number;
  readonly compiledLoopWarmupIterations: number;
  readonly perCallCategory: ChromiumBenchmarkCategory;
  readonly compiledLoopCategory: ChromiumBenchmarkCategory;
}

export interface ChromiumBenchmarkContract {
  readonly schemaVersion: 2;
  readonly sampleCount: number;
  readonly workloads: readonly ChromiumBenchmarkWorkload[];
}

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const kebab = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const categories = Object.freeze([
  "primitive",
  "boundary-heavy",
  "mixed",
] as const);

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
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
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

export function defineChromiumBenchmarkContract(
  value: unknown,
): ChromiumBenchmarkContract {
  assertRecord(value, "Chromium benchmark contract");
  assertExactKeys(
    value,
    ["sampleCount", "schemaVersion", "workloads"],
    "Chromium benchmark contract",
  );
  if (value.schemaVersion !== 2) {
    throw new TypeError("Chromium benchmark contract/schemaVersion must be 2");
  }
  if (!Number.isSafeInteger(value.sampleCount) ||
      (value.sampleCount as number) < 20) {
    throw new TypeError("Chromium benchmark contract/sampleCount must be at least 20");
  }
  if (!Array.isArray(value.workloads) || value.workloads.length === 0) {
    throw new TypeError("Chromium benchmark contract/workloads must be non-empty");
  }
  const ids = new Set<string>();
  for (const [index, workload] of value.workloads.entries()) {
    const path = `Chromium benchmark contract/workloads/${index}`;
    assertRecord(workload, path);
    assertExactKeys(
      workload,
      [
        "compiledLoopCategory",
        "compiledLoopIterations",
        "compiledLoopWarmupIterations",
        "cppFunction",
        "id",
        "perCallCategory",
        "perCallIterations",
        "perCallWarmupIterations",
        "symbolStem",
        "typescriptExport",
      ],
      path,
    );
    if (typeof workload.id !== "string" || !kebab.test(workload.id) ||
        ids.has(workload.id)) {
      throw new TypeError(`${path}/id must be a unique kebab-case identifier`);
    }
    ids.add(workload.id);
    for (const name of [
      "cppFunction",
      "symbolStem",
      "typescriptExport",
    ] as const) {
      if (typeof workload[name] !== "string" ||
          !identifier.test(workload[name] as string)) {
        throw new TypeError(`${path}/${name} must be an identifier`);
      }
    }
    for (const name of [
      "compiledLoopIterations",
      "compiledLoopWarmupIterations",
      "perCallIterations",
      "perCallWarmupIterations",
    ] as const) {
      if (!Number.isSafeInteger(workload[name]) ||
          (workload[name] as number) <= 0) {
        throw new TypeError(`${path}/${name} must be a positive integer`);
      }
    }
    for (const name of ["perCallCategory", "compiledLoopCategory"] as const) {
      if (!categories.includes(workload[name] as ChromiumBenchmarkCategory)) {
        throw new TypeError(`${path}/${name} is unsupported`);
      }
    }
  }
  return deepFreeze(
    structuredClone(value) as unknown as ChromiumBenchmarkContract,
  );
}
