/**
 * The Native TypeScript half of the Android performance comparison.
 *
 * This is deliberately separate from the acceptance application. The
 * acceptance app answers whether the platform contract works; this package
 * supplies repeatable work whose duration may be recorded without turning a
 * noisy device number into a test verdict.
 */

export const ANDROID_BENCHMARK_API = 35;

export const androidBenchmarkWorkload = Object.freeze({
  version: 12,
  warmupSamples: 3,
  measuredSamples: 7,
  lightObjectIterations: 50_000,
  managedClassIterations: 100_000,
  constructorIterations: 2_000,
  setterIterations: 50_000,
  callbackIterations: 50_000,
  stringArgumentIterations: 20_000,
  stringResultIterations: 10_000,
  stringOperationIterations: 10_000,
  arrayOperationIterations: 20_000,
  arrayPipelineIterations: 20_000,
  recordObjectIterations: 50_000,
  optionalValueIterations: 50_000,
  mapOperationIterations: 50_000,
  setOperationIterations: 50_000,
  mathOperationIterations: 100_000,
  numberParsingIterations: 50_000,
  byteArrayIterations: 2_000,
  byteArrayLength: 256,
  handleResultIterations: 32_000,
  handleResultChildren: 16,
  callbackPayloadIterations: 20_000,
  callbackCaptureIterations: 20_000,
  textUpdateIterations: 10_000,
  screenBuildRows: 32,
  treeChildren: 128,
});

function alternatingBitChecksum(iterations: number): number {
  return Math.floor(iterations / 2);
}

function oneBasedCycleChecksum(iterations: number, width: number): number {
  const completeCycles = Math.floor(iterations / width);
  const remainder = iterations % width;
  return completeCycles * ((width * (width + 1)) / 2) +
    ((remainder * (remainder + 1)) / 2);
}

function managedClassChecksum(iterations: number): number {
  let value = 7;
  let checksum = 0;
  for (let index = 0; index < iterations; index++) {
    value = ((value << 5) ^ (value >>> 2) ^ 17) & 1023;
    checksum += value + 1;
  }
  return checksum;
}

function maskedCycleChecksum(iterations: number, mask: number): number {
  const width = mask + 1;
  const completeCycles = Math.floor(iterations / width);
  const remainder = iterations % width;
  return completeCycles * ((mask * width) / 2) +
    ((remainder * (remainder - 1)) / 2);
}

function arrayPipelineChecksum(iterations: number): number {
  let checksum = 0;
  for (let index = 0; index < iterations; index++) {
    const delta = index & 7;
    const mapped = [
      (index & 255) * 2 + delta,
      5 + delta,
      8 + delta,
      11 + delta,
    ];
    for (const value of mapped) {
      if (value > 7) checksum += value;
    }
  }
  return checksum;
}

function recordObjectChecksum(iterations: number): number {
  let checksum = 0;
  for (let index = 0; index < iterations; index++) {
    checksum += (index & 255) + (index & 1 ? 5 : 8);
    if ((index & 3) === 0) checksum += 3;
  }
  return checksum;
}

function optionalValueChecksum(iterations: number): number {
  let checksum = 0;
  for (let index = 0; index < iterations; index++) {
    const numeric = (index & 3) === 0 ? undefined : index & 255;
    checksum += numeric === undefined ? 11 : numeric + 3;
    const label = index & 1 ? "alpha" : undefined;
    checksum += label === undefined ? 7 : label.length;
  }
  return checksum;
}

function mapOperationChecksum(iterations: number): number {
  const keys = [
    "alpha", "beta", "gamma", "delta",
    "epsilon", "zeta", "eta", "theta",
    "iota", "kappa", "lambda", "mu",
    "nu", "xi", "omicron", "pi",
  ];
  const counts = new Map<string, number>();
  let checksum = 0;
  for (let index = 0; index < iterations; index++) {
    const key = keys[index & 15]!;
    const previous = counts.get(key);
    const next = previous === undefined ? (index & 7) + 1 : previous + 1;
    counts.set(key, next);
    if ((index & 31) === 0) {
      const evictionKey = keys[(index >>> 5) & 15]!;
      if (counts.has(evictionKey)) checksum += 3;
      if (counts.delete(evictionKey)) checksum += 5;
      counts.set(evictionKey, next + 2);
    }
    checksum += next + counts.size;
  }
  return checksum;
}

function setOperationChecksum(iterations: number): number {
  const keys = [
    "alpha", "beta", "gamma", "delta",
    "epsilon", "zeta", "eta", "theta",
    "iota", "kappa", "lambda", "mu",
    "nu", "xi", "omicron", "pi",
  ];
  const active = new Set<string>();
  let checksum = 0;
  for (let index = 0; index < iterations; index++) {
    const key = keys[index & 15]!;
    if (!active.has(key)) {
      active.add(key);
      checksum += 1;
    }
    if ((index & 31) === 0) {
      const evictionKey = keys[(index >>> 5) & 15]!;
      if (active.has(evictionKey)) checksum += 3;
      if (active.delete(evictionKey)) checksum += 5;
      active.add(evictionKey);
    }
    if ((index & 255) === 0) {
      for (const member of active) checksum += member.length;
    }
    checksum += active.size;
  }
  return checksum;
}

function mathOperationChecksum(iterations: number): number {
  let checksum = 0;
  for (let index = 0; index < iterations; index++) {
    const value = ((index & 1_023) - 512) / 8 +
      (index & 1 ? 0.25 : -0.25);
    const minimum = Math.min(value, -value);
    const maximum = Math.max(value, -value);
    checksum += Math.floor(value);
    checksum += Math.ceil(value);
    checksum += Math.trunc(value);
    checksum += Math.round(value);
    checksum += Math.trunc(Math.abs(value));
    checksum += Math.trunc(minimum);
    checksum += Math.trunc(maximum);
  }
  return checksum;
}

function numberParsingChecksum(iterations: number): number {
  const integerInputs = [
    "0", "7", "42", "-17", "255", "1024", "6553", "-3276",
    "12345", "-7654", "2147", "-9999", "73", "8080", "-4096", "3141",
  ];
  const floatInputs = [
    "0.5", "-2.25", "3.125", "1e3", "-0.03125", "42.75", "512.5", "-128.125",
    "0.125", "64.875", "-16.5", "2048.25", "-4096.75", "7.5", "0e0", "123.375",
  ];
  const numberInputs = [
    "1.25", "-3.5", "6.125", "2.5e2", "-0.0625", "18.75", "256.25", "-64.5",
    "0.375", "32.625", "-8.25", "1024.5", "-2048.125", "15.875", "0.0", "61.25",
  ];
  let checksum = 0;
  for (let index = 0; index < iterations; index++) {
    const slot = index & 15;
    checksum += parseInt(integerInputs[slot]!, 10);
    checksum += parseFloat(floatInputs[slot]!) * 32;
    checksum += Number(numberInputs[slot]!) * 32;
  }
  return checksum;
}

function numberedTextChecksum(
  iterations: number,
  mask: number | null,
  prefixes: readonly string[],
): number {
  let checksum = 0;
  for (let index = 0; index < iterations; index++) {
    const value = mask === null ? index : index & mask;
    for (const prefix of prefixes) checksum += `${prefix}${value}`.length;
  }
  return checksum;
}

const workload = androidBenchmarkWorkload;

/**
 * The declared hotspot matrix is serialized into every report. Microcases
 * isolate one boundary cost; Android and composite cases retain enough real
 * framework work to say whether that cost matters to an application.
 */
export const androidBenchmarkScenarios = Object.freeze([
  {
    name: "view-tree",
    layer: "android-operation",
    hotspot: "widget construction plus hierarchy insertion",
    operationUnit: "child",
    iterations: workload.treeChildren,
    warmupSamples: 0,
    measuredSamples: 1,
    expectedChecksum: workload.treeChildren,
  },
  {
    name: "light-object",
    layer: "boundary-micro",
    hotspot: "non-escaping object construction and scalar result",
    operationUnit: "rectangle",
    iterations: workload.lightObjectIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: workload.lightObjectIterations,
  },
  {
    name: "managed-class",
    layer: "language-runtime",
    hotspot: "managed field access, inheritance, super call, and virtual dispatch",
    operationUnit: "method dispatch",
    iterations: workload.managedClassIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: managedClassChecksum(workload.managedClassIterations),
  },
  {
    name: "constructor",
    layer: "android-operation",
    hotspot: "real widget construction and scalar argument",
    operationUnit: "widget",
    iterations: workload.constructorIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: alternatingBitChecksum(workload.constructorIterations),
  },
  {
    name: "setter",
    layer: "boundary-micro",
    hotspot: "primitive argument on a stable receiver",
    operationUnit: "call",
    iterations: workload.setterIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: alternatingBitChecksum(workload.setterIterations),
  },
  {
    name: "callback",
    layer: "boundary-micro",
    hotspot: "same-thread callback dispatch without payload use",
    operationUnit: "delivery",
    iterations: workload.callbackIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: workload.callbackIterations,
  },
  {
    name: "string-argument",
    layer: "boundary-micro",
    hotspot: "ASCII and UTF-16 string arguments into Android",
    operationUnit: "comparison",
    iterations: workload.stringArgumentIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: workload.stringArgumentIterations,
  },
  {
    name: "string-result",
    layer: "boundary-micro",
    hotspot: "fresh Java String result copied into the language runtime",
    operationUnit: "result",
    iterations: workload.stringResultIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: workload.stringResultIterations * "1 2 11 22".length,
  },
  {
    name: "string-operations",
    layer: "language-runtime",
    hotspot:
      "UTF-16 trim, case conversion, search, slicing, and padding",
    operationUnit: "string transform",
    iterations: workload.stringOperationIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: workload.stringOperationIterations * 960,
  },
  {
    name: "array-operations",
    layer: "language-runtime",
    hotspot:
      "dynamic numeric array allocation, growth, indexed access, search, and pop",
    operationUnit: "array lifecycle",
    iterations: workload.arrayOperationIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: workload.arrayOperationIterations * 54 +
      maskedCycleChecksum(workload.arrayOperationIterations, 255),
  },
  {
    name: "array-pipeline",
    layer: "language-runtime",
    hotspot:
      "captured and indexed map callback, filter callback, intermediate arrays, and reduce",
    operationUnit: "map-filter-reduce pipeline",
    iterations: workload.arrayPipelineIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: arrayPipelineChecksum(workload.arrayPipelineIterations),
  },
  {
    name: "record-objects",
    layer: "language-runtime",
    hotspot:
      "fixed-shape object allocation, primitive/reference fields, mutation, and reads",
    operationUnit: "record lifecycle",
    iterations: workload.recordObjectIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: recordObjectChecksum(workload.recordObjectIterations),
  },
  {
    name: "optional-values",
    layer: "language-runtime",
    hotspot:
      "scalar/reference optional results, tag tests, narrowing, and short-lived payloads",
    operationUnit: "two optional lookups",
    iterations: workload.optionalValueIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: optionalValueChecksum(workload.optionalValueIterations),
  },
  {
    name: "map-operations",
    layer: "language-runtime",
    hotspot:
      "bounded string-key map get, set, has, delete, reinsertion, and optional numeric results",
    operationUnit: "map update",
    iterations: workload.mapOperationIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: mapOperationChecksum(workload.mapOperationIterations),
  },
  {
    name: "set-operations",
    layer: "language-runtime",
    hotspot:
      "bounded string set add, has, delete, reinsertion, size, and insertion-order iteration",
    operationUnit: "set membership update",
    iterations: workload.setOperationIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: setOperationChecksum(workload.setOperationIterations),
  },
  {
    name: "math-operations",
    layer: "language-runtime",
    hotspot:
      "floor, ceil, truncation, JavaScript rounding, absolute value, minimum, and maximum",
    operationUnit: "numeric transform",
    iterations: workload.mathOperationIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: mathOperationChecksum(workload.mathOperationIterations),
  },
  {
    name: "number-parsing",
    layer: "language-runtime",
    hotspot:
      "base-10 integer, fractional, signed, and exponent string parsing",
    operationUnit: "three numeric parses",
    iterations: workload.numberParsingIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: numberParsingChecksum(workload.numberParsingIterations),
  },
  {
    name: "byte-array",
    layer: "boundary-micro",
    hotspot:
      "primitive array input, Android processing, and owned array result",
    operationUnit: "256-byte encoding",
    iterations: workload.byteArrayIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: workload.byteArrayIterations *
      (4 * Math.ceil(workload.byteArrayLength / 3)),
  },
  {
    name: "handle-result",
    layer: "boundary-micro",
    hotspot: "nullable Java object result and immediate receiver reuse",
    operationUnit: "lookup",
    iterations: workload.handleResultIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: oneBasedCycleChecksum(
      workload.handleResultIterations,
      workload.handleResultChildren,
    ),
  },
  {
    name: "callback-payload",
    layer: "boundary-micro",
    hotspot: "callback object payload projection and immediate receiver reuse",
    operationUnit: "delivery",
    iterations: workload.callbackPayloadIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: workload.callbackPayloadIterations * 7,
  },
  {
    name: "callback-capture",
    layer: "boundary-micro",
    hotspot: "retained callback state and captured Android receiver reuse",
    operationUnit: "delivery",
    iterations: workload.callbackCaptureIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: workload.callbackCaptureIterations * (7 + 11),
  },
  {
    name: "text-update",
    layer: "android-operation",
    hotspot: "dynamic string formatting and TextView mutation",
    operationUnit: "update",
    iterations: workload.textUpdateIterations,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: numberedTextChecksum(
      workload.textUpdateIterations,
      1_023,
      ["Count: "],
    ),
  },
  {
    name: "screen-build",
    layer: "app-composite",
    hotspot:
      "nested layouts, widgets, dynamic text, setters, and hierarchy edges",
    operationUnit: "row",
    iterations: workload.screenBuildRows,
    warmupSamples: workload.warmupSamples,
    measuredSamples: workload.measuredSamples,
    expectedChecksum: numberedTextChecksum(
      workload.screenBuildRows,
      null,
      ["Item ", "Open "],
    ),
  },
] as const);

export type AndroidBenchmarkScenario =
  typeof androidBenchmarkScenarios[number]["name"];

export const repeatedAndroidBenchmarkScenarios = Object.freeze(
  androidBenchmarkScenarios
    .filter(({ warmupSamples }) => warmupSamples > 0)
    .map(({ name }) => name),
);

export const nativeTypescriptBenchmarkProject = {
  name: "android-performance",
  entry: "app.ts",
  output: "ntsbenchmark",
  packageSlug: "android_benchmark",
  classes: [
    { binaryName: "android/os/Bundle" },
    {
      binaryName: "android/os/SystemClock",
      methods: [{ name: "elapsedRealtimeNanos", descriptor: "()J" }],
    },
    {
      binaryName: "android/text/TextUtils",
      methods: [
        {
          name: "equals",
          descriptor: "(Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Z",
        },
      ],
    },
    {
      binaryName: "android/util/Base64",
      methods: [{ name: "encode", descriptor: "([BI)[B" }],
    },
    {
      binaryName: "android/content/Intent",
      methods: [
        {
          name: "getStringExtra",
          descriptor: "(Ljava/lang/String;)Ljava/lang/String;",
        },
      ],
    },
    {
      binaryName: "android/graphics/Rect",
      constructors: ["(IIII)V"],
      methods: [
        { name: "flattenToString", descriptor: "()Ljava/lang/String;" },
        { name: "width", descriptor: "()I" },
      ],
    },
    {
      binaryName: "android/view/View",
      methods: [
        { name: "callOnClick", descriptor: "()Z" },
        { name: "getId", descriptor: "()I" },
        { name: "setId", descriptor: "(I)V" },
        { name: "setMinimumHeight", descriptor: "(I)V" },
        { name: "setPadding", descriptor: "(IIII)V" },
        {
          name: "setOnClickListener",
          descriptor: "(Landroid/view/View$OnClickListener;)V",
        },
      ],
    },
    { binaryName: "android/view/View$OnClickListener" },
    {
      binaryName: "android/widget/Button",
      constructors: ["(Landroid/content/Context;)V"],
    },
    {
      binaryName: "android/view/ViewGroup",
      methods: [
        { name: "addView", descriptor: "(Landroid/view/View;)V" },
        { name: "getChildAt", descriptor: "(I)Landroid/view/View;" },
      ],
    },
    {
      binaryName: "android/widget/LinearLayout",
      constructors: ["(Landroid/content/Context;)V"],
      methods: [{ name: "setOrientation", descriptor: "(I)V" }],
    },
    {
      binaryName: "android/widget/TextView",
      constructors: ["(Landroid/content/Context;)V"],
      methods: [
        { name: "setText", descriptor: "(Ljava/lang/CharSequence;)V" },
        { name: "setTextColor", descriptor: "(I)V" },
        { name: "setTextSize", descriptor: "(F)V" },
      ],
    },
    {
      binaryName: "android/util/Log",
      methods: [
        { name: "i", descriptor: "(Ljava/lang/String;Ljava/lang/String;)I" },
      ],
    },
    {
      binaryName: "android/app/Activity",
      constructors: ["()V"],
      methods: [
        { name: "onCreate", descriptor: "(Landroid/os/Bundle;)V" },
        { name: "onDestroy", descriptor: "()V" },
        {
          name: "getIntent",
          descriptor: "()Landroid/content/Intent;",
        },
        { name: "setContentView", descriptor: "(Landroid/view/View;)V" },
      ],
    },
  ],
  subclasses: [
    {
      baseBinaryName: "android/view/View$OnClickListener",
      overrides: [{ name: "onClick", descriptor: "(Landroid/view/View;)V" }],
      subclassBinaryName:
        "com/example/ntsbenchmark/compiled/ClickBridge",
    },
    {
      baseBinaryName: "android/app/Activity",
      overrides: [
        { name: "onCreate", descriptor: "(Landroid/os/Bundle;)V" },
      ],
      subclassBinaryName:
        "com/example/ntsbenchmark/compiled/MainActivity",
      anchor: "class" as const,
      loadLibrary: "ntsbenchmark",
      terminal: { name: "onDestroy", descriptor: "()V" },
    },
  ],
  android: {
    applicationId: "com.example.ntsbenchmark.compiled",
    activityBinaryName:
      "com/example/ntsbenchmark/compiled/MainActivity",
    label: "NTS Benchmark",
    minSdk: ANDROID_BENCHMARK_API,
    targetSdk: 36,
    abi: "x86_64",
  },
  target: {
    triple: `x86_64-linux-android${ANDROID_BENCHMARK_API}`,
    executionPlatform: "x86_64-linux",
  },
  sdk: {
    vendor: "google",
    name: "android",
    version: `${ANDROID_BENCHMARK_API}`,
    deploymentTarget: `${ANDROID_BENCHMARK_API}`,
  },
} as const;

export const kotlinBenchmarkApplication = Object.freeze({
  applicationId: "com.example.ntsbenchmark.baseline",
  activityBinaryName:
    "com/example/ntsbenchmark/baseline/MainActivity",
  label: "Kotlin Benchmark",
  minSdk: ANDROID_BENCHMARK_API,
  targetSdk: 36,
});

/** The direct-ART Native TypeScript benchmark. Its launcher, lifecycle, and
 * measured workloads are all compiled from direct/activity.ts. */
export const directJvmBenchmarkApplication = Object.freeze({
  /* The Direct route deliberately consumes the exact generated subclass
   * coordinates carried by the same SCABI package as the native route.
   * Give it a distinct owning application id above that class package;
   * Android application ids need not equal a Java package, but our
   * manifest contract requires generated code to remain beneath one. */
  applicationId: "com.example.ntsbenchmark",
  activityBinaryName:
    "com/example/ntsbenchmark/compiled/MainActivity",
  label: "NTS Direct JVM Benchmark",
  minSdk: ANDROID_BENCHMARK_API,
  targetSdk: 36,
});
