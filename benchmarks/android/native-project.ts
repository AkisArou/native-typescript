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
  version: 2,
  warmupSamples: 3,
  measuredSamples: 7,
  lightObjectIterations: 50_000,
  constructorIterations: 2_000,
  setterIterations: 50_000,
  callbackIterations: 50_000,
  stringArgumentIterations: 20_000,
  stringResultIterations: 10_000,
  byteArrayIterations: 2_000,
  byteArrayLength: 256,
  handleResultIterations: 32_000,
  handleResultChildren: 16,
  callbackPayloadIterations: 20_000,
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
