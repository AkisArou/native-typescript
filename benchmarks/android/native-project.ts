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
  version: 1,
  warmupSamples: 3,
  measuredSamples: 7,
  lightObjectIterations: 50_000,
  constructorIterations: 2_000,
  setterIterations: 50_000,
  callbackIterations: 50_000,
  treeChildren: 128,
});

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
      methods: [{ name: "width", descriptor: "()I" }],
    },
    {
      binaryName: "android/view/View",
      methods: [
        { name: "callOnClick", descriptor: "()Z" },
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
      methods: [{ name: "addView", descriptor: "(Landroid/view/View;)V" }],
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
