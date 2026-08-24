import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { readZipEntries } from "@native-typescript/bindgen-jvm";
import type {
  JvmDirectBinding,
  JvmDirectBindingManifest,
} from "@native-typescript/bindgen-jvm";
import { parseScabiManifest } from "@native-typescript/scabi";
import {
  buildAndroidApk,
  discoverJavaHome,
  generateAndroidManifest,
} from "@native-typescript/target-jvm";
import {
  loadScriptCExecutablePlanners,
  loadScriptCJvmEmitter,
  scriptCCompilerDistribution,
  translateScabiNativeProgram,
} from "@native-typescript/scriptc";
import {
  ANDROID_BENCHMARK_API,
  type AndroidBenchmarkScenario,
  androidBenchmarkScenarios,
  androidBenchmarkWorkload,
  directJvmBenchmarkApplication,
  kotlinBenchmarkApplication,
  nativeTypescriptBenchmarkProject,
  repeatedAndroidBenchmarkScenarios,
} from "../benchmarks/android/native-project.ts";

const workspace = join(import.meta.dirname, "..");
const benchmarkRoot = join(workspace, "benchmarks/android");
const nativeRoot = join(benchmarkRoot, "native");
const nativeSource = join(nativeRoot, "app.ts");
const kotlinSource = join(
  benchmarkRoot,
  "kotlin/com/example/ntsbenchmark/baseline/MainActivity.kt",
);
const nativeScriptRoot = join(benchmarkRoot, "nativescript");
const nativeScriptSource = join(nativeScriptRoot, "app/app.ts");
const directRoot = join(benchmarkRoot, "direct");
const directTypescriptActivitySource = join(directRoot, "activity.ts");
const directArrayOperationSource = join(directRoot, "array-operations.ts");
const directArrayPipelineSource = join(directRoot, "array-pipeline.ts");
const directByteArraySource = join(directRoot, "byte-array.ts");
const directConstructorSource = join(directRoot, "constructor.ts");
const directHandleResultSource = join(directRoot, "handle-result.ts");
const directLightObjectSource = join(directRoot, "light-object.ts");
const directManagedClassSource = join(directRoot, "managed-class.ts");
const directMapOperationSource = join(directRoot, "map-operations.ts");
const directMathOperationSource = join(directRoot, "math-operations.ts");
const directNumberParsingSource = join(directRoot, "number-parsing.ts");
const directOptionalValueSource = join(directRoot, "optional-values.ts");
const directRecordObjectSource = join(directRoot, "record-objects.ts");
const directScreenBuildSource = join(directRoot, "screen-build.ts");
const directSetOperationSource = join(directRoot, "set-operations.ts");
const directSetterSource = join(directRoot, "setter.ts");
const directStringArgumentSource = join(directRoot, "string-argument.ts");
const directStringOperationSource = join(directRoot, "string-operations.ts");
const directStringResultSource = join(directRoot, "string-result.ts");
const directTextUpdateSource = join(directRoot, "text-update.ts");
const scriptcRoot = join(workspace, "third_party/scriptc");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const DEVICE_LOCK = "/tmp/native-typescript-android-device.lock";
const LOG_TAG = "nts-benchmark";

const IMPLEMENTATIONS = [
  "native-typescript",
  "native-typescript-jvm",
  "kotlin",
  "nativescript",
] as const;
type Implementation = typeof IMPLEMENTATIONS[number];
const FULL_APPLICATION_IMPLEMENTATIONS = [
  "native-typescript",
  "native-typescript-jvm",
  "kotlin",
  "nativescript",
] as const;
const DIRECT_JVM_SCENARIOS = [
  "light-object",
  "managed-class",
  "constructor",
  "setter",
  "callback",
  "callback-payload",
  "callback-capture",
  "string-argument",
  "string-result",
  "string-operations",
  "string-normalize",
  "string-slice",
  "string-pad",
  "string-search",
  "array-operations",
  "array-pipeline",
  "record-objects",
  "optional-values",
  "map-operations",
  "set-operations",
  "math-operations",
  "number-parsing",
  "byte-array",
  "handle-result",
  "text-update",
  "screen-build",
  "view-tree",
] as const satisfies readonly AndroidBenchmarkScenario[];
const TYPESCRIPT_OWNED_DIRECT_JVM_SCENARIOS = [
  "light-object",
  "managed-class",
  "constructor",
  "setter",
  "callback",
  "callback-payload",
  "callback-capture",
  "string-argument",
  "string-result",
  "string-operations",
  "string-normalize",
  "string-slice",
  "string-pad",
  "string-search",
  "array-operations",
  "array-pipeline",
  "record-objects",
  "optional-values",
  "map-operations",
  "set-operations",
  "math-operations",
  "number-parsing",
  "byte-array",
  "handle-result",
  "text-update",
  "screen-build",
  "view-tree",
] as const satisfies readonly AndroidBenchmarkScenario[];

function directJvmSupportsScenario(
  scenario: AndroidBenchmarkScenario,
): boolean {
  return DIRECT_JVM_SCENARIOS.some((candidate) => candidate === scenario);
}

interface Options {
  readonly avd: string | null;
  readonly buildOnly: boolean;
  readonly rounds: number;
  readonly scenarios: readonly AndroidBenchmarkScenario[] | null;
  readonly serial: string | null;
  readonly output: string;
}

interface AndroidTools {
  readonly sdkRoot: string;
  readonly platform: string;
  readonly buildToolsVersion: string;
  readonly androidJar: string;
  readonly adb: string;
  readonly aapt2: string;
  readonly d8: string;
  readonly zipalign: string;
  readonly apksigner: string;
  readonly emulator: string;
  readonly clang: string;
  readonly ar: string;
  readonly kotlin: string;
  readonly kotlinRuntimeJars: readonly string[];
}

interface BuiltApplication {
  readonly implementation: Implementation;
  readonly applicationId: string;
  readonly activity: string;
  readonly apkPath: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface DirectJvmBuiltApplication extends BuiltApplication {
  readonly evidence: {
    readonly bindings: readonly {
      readonly bindingId: string;
      readonly ownerBinaryName: string;
      readonly name: string;
      readonly descriptor: string;
      readonly nativeEntrySymbol: string;
    }[];
    readonly bytecodePath: string;
    readonly typescriptActivity: string;
    readonly typescriptActivityBytecodePath: string;
  };
}

interface LaunchMeasurement {
  readonly implementation: Implementation;
  readonly round: number;
  readonly kind: "process-start" | "warm-foreground";
  readonly status: string | null;
  readonly launchState: string | null;
  readonly thisTimeMs: number | null;
  readonly totalTimeMs: number | null;
  readonly waitTimeMs: number | null;
  readonly raw: string;
}

interface WorkloadMeasurement {
  readonly implementation: Implementation;
  readonly scenario: AndroidBenchmarkScenario;
  readonly processRound: number;
  readonly sample: number;
  readonly iterations: number;
  readonly elapsedNs: number;
  readonly nanosecondsPerOperation: number;
  readonly checksum: number;
}

interface MemoryMeasurement {
  readonly implementation: Implementation;
  readonly round: number;
  readonly totalPssKb: number;
  readonly totalRssKb: number;
  readonly rawPath: string;
}

function parseOptions(argv: readonly string[]): Options {
  let buildOnly = false;
  let avd: string | null = null;
  let rounds = 3;
  const scenarios: AndroidBenchmarkScenario[] = [];
  let serial: string | null = null;
  let output: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    /* pnpm preserves the conventional separator for this workspace's Bun-
     * compatible script runner. It carries no option of its own. */
    if (argument === "--") continue;
    if (argument === "--build-only") {
      buildOnly = true;
      continue;
    }
    if (
      argument === "--avd" || argument === "--rounds" ||
      argument === "--scenario" || argument === "--serial" || argument === "--output"
    ) {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${argument} needs a value`);
      if (argument === "--rounds") {
        rounds = Number(value);
        if (!Number.isInteger(rounds) || rounds < 1) {
          throw new Error(`--rounds must be a positive integer, got '${value}'`);
        }
      } else if (argument === "--avd") {
        avd = value;
      } else if (argument === "--serial") {
        serial = value;
      } else if (argument === "--scenario") {
        const definition = androidBenchmarkScenarios.find(
          (candidate) => candidate.name === value,
        );
        if (definition === undefined) {
          throw new Error(
            `--scenario must name one of ${
              androidBenchmarkScenarios.map(({ name }) => name).join(", ")
            }, got '${value}'`,
          );
        }
        if (scenarios.includes(definition.name)) {
          throw new Error(`--scenario '${value}' was selected twice`);
        }
        scenarios.push(definition.name);
      } else {
        output = resolve(value);
      }
      continue;
    }
    if (argument === "--help") {
      console.log(
        "Usage: pnpm benchmark:android -- [--build-only] [--rounds N] " +
          "[--scenario NAME]... [--serial SERIAL | --avd NAME] " +
          "[--output DIRECTORY]",
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument '${argument}'`);
  }
  if (avd !== null && serial !== null) {
    throw new Error("--avd and --serial are mutually exclusive");
  }
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return {
    avd,
    buildOnly,
    rounds,
    scenarios: scenarios.length === 0 ? null : Object.freeze(scenarios),
    serial,
    output: output ?? join(workspace, ".native-typescript/benchmarks/android", stamp),
  };
}

function pathExecutable(name: string): string | null {
  for (const directory of (process.env["PATH"] ?? "").split(":")) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sdkRoots(): string[] {
  return [
    process.env["ANDROID_SDK_ROOT"],
    process.env["ANDROID_HOME"],
    join(homedir(), "Android/Sdk"),
  ].filter((value): value is string => value !== undefined && value.length > 0);
}

function versionDescending(left: string, right: string): number {
  const l = left.split(/[.-]/u).map(Number);
  const r = right.split(/[.-]/u).map(Number);
  for (let index = 0; index < Math.max(l.length, r.length); index++) {
    const difference = (r[index] ?? 0) - (l[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function discoverKotlin(): string | null {
  const configured = process.env["KOTLIN_HOME"];
  const candidates = [
    ...(configured === undefined
      ? []
      : [join(configured, "bin/kotlinc-jvm"), join(configured, "bin/kotlinc")]),
    "/opt/android-studio/plugins/Kotlin/kotlinc/bin/kotlinc-jvm",
    "/opt/android-studio/plugins/Kotlin/kotlinc/bin/kotlinc",
    pathExecutable("kotlinc-jvm"),
    pathExecutable("kotlinc"),
  ];
  return candidates.find((candidate): candidate is string =>
    candidate !== null && existsSync(candidate)
  ) ?? null;
}

function discoverKotlinRuntimeJars(compiler: string): readonly string[] {
  /* The command is distributed as KOTLIN_HOME/bin/kotlinc[-jvm]. Keep the
   * benchmark on that same distribution instead of finding an unrelated
   * stdlib elsewhere on the host. jdk7/jdk8 are optional compatibility
   * overlays in newer distributions; the core stdlib is not optional. */
  const library = join(dirname(dirname(realpathSync(resolve(compiler)))), "lib");
  const core = join(library, "kotlin-stdlib.jar");
  if (!existsSync(core)) {
    throw new Error(
      `Kotlin compiler '${compiler}' has no sibling lib/kotlin-stdlib.jar`,
    );
  }
  return Object.freeze([
    core,
    ...["kotlin-stdlib-jdk7.jar", "kotlin-stdlib-jdk8.jar"]
      .map((name) => join(library, name))
      .filter(existsSync),
  ]);
}

function discoverAndroidTools(): AndroidTools {
  const kotlin = discoverKotlin();
  if (kotlin === null) {
    throw new Error(
      "No Kotlin compiler: set KOTLIN_HOME or install the Android Studio " +
        "Kotlin plugin",
    );
  }
  for (const sdkRoot of sdkRoots()) {
    const platformsRoot = join(sdkRoot, "platforms");
    const buildToolsRoot = join(sdkRoot, "build-tools");
    const ndkRoot = join(sdkRoot, "ndk");
    if (
      !existsSync(platformsRoot) || !existsSync(buildToolsRoot) ||
      !existsSync(ndkRoot)
    ) continue;
    const platform = readdirSync(platformsRoot)
      .filter((name) => existsSync(join(platformsRoot, name, "android.jar")))
      .sort((left, right) =>
        versionDescending(
          left.slice("android-".length),
          right.slice("android-".length),
        )
      )[0];
    const buildToolsVersion = readdirSync(buildToolsRoot)
      .filter((version) =>
        ["aapt2", "d8", "zipalign", "apksigner"].every((name) =>
          existsSync(join(buildToolsRoot, version, name))
        )
      )
      .sort(versionDescending)[0];
    const ndkVersion = readdirSync(ndkRoot).sort(versionDescending)[0];
    if (
      platform === undefined || buildToolsVersion === undefined ||
      ndkVersion === undefined
    ) continue;
    const ndkBin = join(
      ndkRoot,
      ndkVersion,
      "toolchains/llvm/prebuilt/linux-x86_64/bin",
    );
    const clang = join(ndkBin, `x86_64-linux-android${ANDROID_BENCHMARK_API}-clang`);
    const ar = join(ndkBin, "llvm-ar");
    const adb = join(sdkRoot, "platform-tools/adb");
    const emulator = join(sdkRoot, "emulator/emulator");
    if (
      !existsSync(clang) || !existsSync(ar) || !existsSync(adb) ||
      !existsSync(emulator)
    ) continue;
    const at = (name: string): string => join(buildToolsRoot, buildToolsVersion, name);
    return {
      sdkRoot,
      platform,
      buildToolsVersion,
      androidJar: join(platformsRoot, platform, "android.jar"),
      adb,
      aapt2: at("aapt2"),
      d8: at("d8"),
      zipalign: at("zipalign"),
      apksigner: at("apksigner"),
      emulator,
      clang,
      ar,
      kotlin,
      kotlinRuntimeJars: discoverKotlinRuntimeJars(kotlin),
    };
  }
  throw new Error(
    "No complete Android SDK/NDK toolchain with adb, platform jar, build " +
      `tools, and x86_64 API ${ANDROID_BENCHMARK_API} clang`,
  );
}

function run(
  file: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly cwd?: string } = {},
): string {
  return execFileSync(file, args, {
    encoding: "utf8",
    timeout: 1_200_000,
    maxBuffer: 64 * 1024 * 1024,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

function commandVersion(file: string, args: readonly string[]): string {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) return result.error.message;
  return `${result.stdout}${result.stderr}`.trim();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function classFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".class")) found.push(path);
    }
  };
  visit(root);
  return found.sort();
}

function stageZipEntries(
  archive: string,
  staging: string,
  wanted: readonly string[],
): void {
  const entries = readZipEntries(readFileSync(archive), archive);
  for (const name of wanted) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (entry === undefined) throw new Error(`${archive} carries no ${name}`);
    const destination = join(staging, name);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, entry.bytes);
  }
}

function buildKotlinApk(input: {
  readonly root: string;
  readonly tools: AndroidTools;
  readonly javaHome: string;
  readonly keystore: string;
}): BuiltApplication {
  const classes = join(input.root, "classes");
  const staging = join(input.root, "staging");
  mkdirSync(classes, { recursive: true });
  mkdirSync(staging, { recursive: true });
  const buildEnvironment = {
    ...process.env,
    JAVA_HOME: input.javaHome,
    PATH: `${join(input.javaHome, "bin")}:${process.env["PATH"] ?? ""}`,
  };
  run(
    input.tools.kotlin,
    [
      "-jvm-target",
      "1.8",
      "-classpath",
      input.tools.androidJar,
      "-d",
      classes,
      kotlinSource,
    ],
    { env: buildEnvironment },
  );
  const compiledClasses = classFiles(classes);
  if (compiledClasses.length === 0) throw new Error("Kotlin produced no classes");

  const manifest = join(input.root, "AndroidManifest.xml");
  writeFileSync(manifest, generateAndroidManifest(kotlinBenchmarkApplication));
  const linked = join(input.root, "base.apk");
  run(input.tools.aapt2, [
    "link",
    "--manifest",
    manifest,
    "-I",
    input.tools.androidJar,
    "-o",
    linked,
  ]);
  const dex = join(input.root, "classes.zip");
  run(input.tools.d8, [
    "--min-api",
    String(kotlinBenchmarkApplication.minSdk),
    "--lib",
    input.tools.androidJar,
    "--output",
    dex,
    ...compiledClasses,
    ...input.tools.kotlinRuntimeJars,
  ], { env: buildEnvironment });
  stageZipEntries(linked, staging, ["AndroidManifest.xml", "resources.arsc"]);
  stageZipEntries(dex, staging, ["classes.dex"]);

  const unaligned = join(input.root, "app-unaligned.apk");
  run(join(input.javaHome, "bin/jar"), [
    "--create",
    "--file",
    unaligned,
    "--no-manifest",
    "--no-compress",
    "--date",
    "2000-01-01T00:00:00Z",
    "-C",
    staging,
    "AndroidManifest.xml",
    "-C",
    staging,
    "resources.arsc",
    "-C",
    staging,
    "classes.dex",
  ]);
  const aligned = join(input.root, "app-aligned.apk");
  run(input.tools.zipalign, ["-f", "-P", "16", "4", unaligned, aligned]);
  const apkPath = join(input.root, "kotlin-benchmark.apk");
  run(input.tools.apksigner, [
    "sign",
    "--ks",
    input.keystore,
    "--ks-pass",
    "pass:android",
    "--key-pass",
    "pass:android",
    "--ks-key-alias",
    "nts",
    "--v1-signing-enabled",
    "false",
    "--v2-signing-enabled",
    "true",
    "--v4-signing-enabled",
    "false",
    "--out",
    apkPath,
    aligned,
  ], { env: buildEnvironment });
  return {
    implementation: "kotlin",
    applicationId: kotlinBenchmarkApplication.applicationId,
    activity: kotlinBenchmarkApplication.activityBinaryName.replace(/\//gu, "."),
    apkPath,
    sha256: sha256(apkPath),
    bytes: statSync(apkPath).size,
  };
}

async function buildNativeTypescriptApk(input: {
  readonly root: string;
  readonly tools: AndroidTools;
  readonly javaHome: string;
  readonly keystore: string;
}): Promise<BuiltApplication> {
  run(pnpm, ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"]);
  if (!existsSync(scriptCCompilerDistribution())) {
    throw new Error("The ScriptC compiler distribution was not built");
  }
  const built = await buildAndroidApk({
    projectRoot: nativeRoot,
    project: nativeTypescriptBenchmarkProject,
    scratch: join(input.root, "build"),
    backend: "c",
    javaHome: input.javaHome,
    androidJarPath: input.tools.androidJar,
    keystore: { path: input.keystore, alias: "nts", password: "android" },
    tools: {
      clang: input.tools.clang,
      node: process.execPath,
      sandbox: pathExecutable("bwrap") ?? "/usr/bin/bwrap",
      ar: input.tools.ar,
      aapt2: input.tools.aapt2,
      d8: input.tools.d8,
      zipalign: input.tools.zipalign,
      apksigner: input.tools.apksigner,
    },
    cachePath: join(workspace, ".native-typescript/cache"),
  });
  const apkPath = join(input.root, "native-typescript-benchmark.apk");
  copyFileSync(built.apkPath, apkPath);
  return {
    implementation: "native-typescript",
    applicationId: nativeTypescriptBenchmarkProject.android.applicationId,
    activity: nativeTypescriptBenchmarkProject.android.activityBinaryName
      .replace(/\//gu, "."),
    apkPath,
    sha256: sha256(apkPath),
    bytes: statSync(apkPath).size,
  };
}

async function buildDirectJvmApk(input: {
  readonly root: string;
  readonly bindingPackageRoot: string;
  readonly tools: AndroidTools;
  readonly javaHome: string;
  readonly keystore: string;
}): Promise<DirectJvmBuiltApplication> {
  const packageManifestPath = join(input.bindingPackageRoot, "package.scabi.json");
  const packageDeclarationsPath = join(input.bindingPackageRoot, "package.d.ts");
  const directBindingsPath = join(
    input.bindingPackageRoot,
    "jvm-direct-bindings.json",
  );
  for (const path of [
    packageManifestPath,
    packageDeclarationsPath,
    directBindingsPath,
  ]) {
    if (!existsSync(path)) {
      throw new Error(
        `The Native TypeScript build produced no direct-JVM input at ${path}`,
      );
    }
  }
  const manifest = parseScabiManifest(
    readFileSync(packageManifestPath, "utf8"),
  );
  const directBindings = JSON.parse(
    readFileSync(directBindingsPath, "utf8"),
  ) as JvmDirectBindingManifest;
  if (
    directBindings.schema !== "native-typescript.jvm-direct-bindings" ||
    directBindings.schemaVersion !== 3
  ) {
    throw new Error(`Unsupported direct-JVM binding manifest at ${directBindingsPath}`);
  }
  const findDirectBinding = (
    kind: JvmDirectBinding["kind"],
    ownerBinaryName: string,
    name: string,
    descriptor: string,
  ): JvmDirectBinding => {
    const binding = directBindings.bindings.find((candidate) =>
      candidate.kind === kind &&
      candidate.ownerBinaryName === ownerBinaryName &&
      candidate.name === name &&
      candidate.descriptor === descriptor
    );
    if (binding === undefined) {
      throw new Error(
        `The generated JVM binding sidecar carries no exact ${kind} ` +
          `'${ownerBinaryName}.${name}${descriptor}'`,
      );
    }
    return binding;
  };
  const rectConstructorBinding = findDirectBinding(
    "constructor",
    "android/graphics/Rect",
    "<init>",
    "(IIII)V",
  );
  const rectWidthBinding = findDirectBinding(
    "instance-method",
    "android/graphics/Rect",
    "width",
    "()I",
  );
  const rectFlattenToStringBinding = findDirectBinding(
    "instance-method",
    "android/graphics/Rect",
    "flattenToString",
    "()Ljava/lang/String;",
  );
  const textViewConstructorBinding = findDirectBinding(
    "constructor",
    "android/widget/TextView",
    "<init>",
    "(Landroid/content/Context;)V",
  );
  const textViewSetTextSizeBinding = findDirectBinding(
    "instance-method",
    "android/widget/TextView",
    "setTextSize",
    "(F)V",
  );
  const textViewSetTextBinding = findDirectBinding(
    "instance-method",
    "android/widget/TextView",
    "setText",
    "(Ljava/lang/CharSequence;)V",
  );
  const linearLayoutConstructorBinding = findDirectBinding(
    "constructor",
    "android/widget/LinearLayout",
    "<init>",
    "(Landroid/content/Context;)V",
  );
  const viewGroupAddViewBinding = findDirectBinding(
    "instance-method",
    "android/view/ViewGroup",
    "addView",
    "(Landroid/view/View;)V",
  );
  const buttonConstructorBinding = findDirectBinding(
    "constructor",
    "android/widget/Button",
    "<init>",
    "(Landroid/content/Context;)V",
  );
  const clickBridgeConstructorBinding = findDirectBinding(
    "constructor",
    "com/example/ntsbenchmark/compiled/ClickBridge",
    "<init>",
    "()V",
  );
  const clickBridgeCallbackBinding = findDirectBinding(
    "instance-callback",
    "com/example/ntsbenchmark/compiled/ClickBridge",
    "onClick",
    "(Landroid/view/View;)V",
  );
  const viewSetOnClickListenerBinding = findDirectBinding(
    "instance-method",
    "android/view/View",
    "setOnClickListener",
    "(Landroid/view/View$OnClickListener;)V",
  );
  const viewCallOnClickBinding = findDirectBinding(
    "instance-method",
    "android/view/View",
    "callOnClick",
    "()Z",
  );
  const equalsBinding = findDirectBinding(
    "static-method",
    "android/text/TextUtils",
    "equals",
    "(Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Z",
  );
  const base64EncodeBinding = findDirectBinding(
    "static-method",
    "android/util/Base64",
    "encode",
    "([BI)[B",
  );
  const viewGetIdBinding = findDirectBinding(
    "instance-method",
    "android/view/View",
    "getId",
    "()I",
  );
  const viewSetIdBinding = findDirectBinding(
    "instance-method",
    "android/view/View",
    "setId",
    "(I)V",
  );
  const viewSetMinimumHeightBinding = findDirectBinding(
    "instance-method",
    "android/view/View",
    "setMinimumHeight",
    "(I)V",
  );
  const viewGroupGetChildAtBinding = findDirectBinding(
    "instance-method",
    "android/view/ViewGroup",
    "getChildAt",
    "(I)Landroid/view/View;",
  );
  const linearLayoutSetOrientationBinding = findDirectBinding(
    "instance-method",
    "android/widget/LinearLayout",
    "setOrientation",
    "(I)V",
  );
  const systemClockElapsedBinding = findDirectBinding(
    "static-method",
    "android/os/SystemClock",
    "elapsedRealtimeNanos",
    "()J",
  );
  const activityConstructorBinding = findDirectBinding(
    "constructor",
    "android/app/Activity",
    "<init>",
    "()V",
  );
  const activityGetIntentBinding = findDirectBinding(
    "instance-method",
    "android/app/Activity",
    "getIntent",
    "()Landroid/content/Intent;",
  );
  const activitySetContentViewBinding = findDirectBinding(
    "instance-method",
    "android/app/Activity",
    "setContentView",
    "(Landroid/view/View;)V",
  );
  const intentGetStringExtraBinding = findDirectBinding(
    "instance-method",
    "android/content/Intent",
    "getStringExtra",
    "(Ljava/lang/String;)Ljava/lang/String;",
  );
  const logInfoBinding = findDirectBinding(
    "static-method",
    "android/util/Log",
    "i",
    "(Ljava/lang/String;Ljava/lang/String;)I",
  );
  const generatedActivityOwner =
    nativeTypescriptBenchmarkProject.android.activityBinaryName;
  const activityOnCreateBinding = findDirectBinding(
    "class-callback",
    generatedActivityOwner,
    "onCreate",
    "(Landroid/os/Bundle;)V",
  );
  const activityOnDestroyBinding = findDirectBinding(
    "class-callback",
    generatedActivityOwner,
    "onDestroy",
    "()V",
  );
  const packageInstanceSeparator = rectConstructorBinding.id.indexOf("#");
  if (packageInstanceSeparator < 1) {
    throw new Error(
      `Direct binding '${rectConstructorBinding.id}' has no package instance`,
    );
  }
  const representativeLocalBindingId = rectConstructorBinding.id.slice(
    packageInstanceSeparator + 1,
  );
  const packageSlugSeparator = representativeLocalBindingId.indexOf(".");
  if (packageSlugSeparator < 1) {
    throw new Error(
      `Direct binding '${representativeLocalBindingId}' has no package slug`,
    );
  }
  const packageSlug = representativeLocalBindingId.slice(0, packageSlugSeparator);

  const activityBindings = [
    rectConstructorBinding,
    rectWidthBinding,
    rectFlattenToStringBinding,
    activityConstructorBinding,
    activityGetIntentBinding,
    activitySetContentViewBinding,
    intentGetStringExtraBinding,
    equalsBinding,
    base64EncodeBinding,
    textViewConstructorBinding,
    textViewSetTextBinding,
    textViewSetTextSizeBinding,
    buttonConstructorBinding,
    clickBridgeConstructorBinding,
    clickBridgeCallbackBinding,
    viewSetOnClickListenerBinding,
    viewCallOnClickBinding,
    linearLayoutConstructorBinding,
    viewGroupAddViewBinding,
    viewGroupGetChildAtBinding,
    viewGetIdBinding,
    viewSetIdBinding,
    viewSetMinimumHeightBinding,
    linearLayoutSetOrientationBinding,
    systemClockElapsedBinding,
    logInfoBinding,
    activityOnCreateBinding,
    activityOnDestroyBinding,
  ] as const;
  const activityLocalBindingIds = activityBindings.map((binding) => {
    const separator = binding.id.indexOf("#");
    if (separator < 1) {
      throw new Error(`Direct binding '${binding.id}' has no package instance`);
    }
    return binding.id.slice(separator + 1);
  });
  const activityConstantBindingIds = [
    `${packageSlug}.android.widget.linearlayout.horizontal`,
    `${packageSlug}.android.widget.linearlayout.vertical`,
  ] as const;
  const translatedActivity = translateScabiNativeProgram(manifest, {
    types: [
      "jvm.android.app.activity",
      "jvm.android.content.intent",
      "jvm.android.widget.textview",
      "jvm.android.widget.linearlayout",
    ],
    imports: [
      `${packageSlug}.object.release`,
      ...activityLocalBindingIds,
      ...activityConstantBindingIds,
    ],
    exports: [],
  });
  if (!translatedActivity.ok) {
    throw new Error(
      "Direct-JVM TypeScript Activity translation failed:\n" +
        translatedActivity.diagnostics
          .map(({ code, path, message }) => `  ${code} ${path}: ${message}`)
          .join("\n"),
    );
  }

  const planners = await loadScriptCExecutablePlanners();
  const plannedActivity = planners.planExecutableCompilation(
    directTypescriptActivitySource,
    {
      backend: "c",
      sourceRoot: directRoot,
      externalTypes: {
        [manifest.package.name]: packageDeclarationsPath,
      },
      native: translatedActivity.input,
    },
  );
  if (!plannedActivity.ok) {
    throw new Error(
      "Compiling the direct-JVM TypeScript Activity failed:\n" +
        plannedActivity.diagnostics.map((diagnostic) =>
          `  ${diagnostic.code} ${diagnostic.loc.file}:` +
          `${diagnostic.loc.start}-${diagnostic.loc.end} ${diagnostic.message}`
        ).join("\n"),
    );
  }
  const emitter = await loadScriptCJvmEmitter();
  const generatedActivityPackage = generatedActivityOwner
    .slice(0, generatedActivityOwner.lastIndexOf("/"))
    .replaceAll("/", ".");
  const generatedActivityClass = generatedActivityOwner
    .slice(generatedActivityOwner.lastIndexOf("/") + 1);
  const generatedActivitySource = emitter.emitJvmSerializedModule(
    plannedActivity.plan.ir,
    {
      packageName: generatedActivityPackage,
      className: generatedActivityClass,
      nativeBindings: directBindings.bindings,
    },
  );

  const generatedRoot = join(input.root, "generated");
  const generatedActivityPath = join(
    generatedRoot,
    ...generatedActivityPackage.split("."),
    `${generatedActivityClass}.java`,
  );
  const classes = join(input.root, "classes");
  const staging = join(input.root, "staging");
  mkdirSync(dirname(generatedActivityPath), { recursive: true });
  mkdirSync(classes, { recursive: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(generatedActivityPath, generatedActivitySource);
  const buildEnvironment = {
    ...process.env,
    JAVA_HOME: input.javaHome,
    PATH: `${join(input.javaHome, "bin")}:${process.env["PATH"] ?? ""}`,
  };
  run(
    join(input.javaHome, "bin/javac"),
    [
      "--release",
      "17",
      "-classpath",
      input.tools.androidJar,
      "-d",
      classes,
      generatedActivityPath,
    ],
    { env: buildEnvironment },
  );
  const typescriptActivityClassName = generatedActivityOwner.replaceAll("/", ".");
  const typescriptActivityBytecode = run(
    join(input.javaHome, "bin/javap"),
    ["-classpath", classes, "-c", "-p", typescriptActivityClassName],
    { env: buildEnvironment },
  );
  const mapClassEntry = readdirSync(
    join(classes, ...generatedActivityPackage.split(".")),
  ).find((entry) =>
    entry.startsWith(`${generatedActivityClass}$NtsMap`) && entry.endsWith(".class")
  );
  if (mapClassEntry === undefined) {
    throw new Error("Compiler-emitted TypeScript Activity has no specialized Map class");
  }
  const typescriptMapClassName =
    `${generatedActivityPackage}.${mapClassEntry.slice(0, -".class".length)}`;
  const typescriptMapBytecode = run(
    join(input.javaHome, "bin/javap"),
    ["-classpath", classes, "-p", typescriptMapClassName],
    { env: buildEnvironment },
  );
  for (const mapEvidence of [
    "java.lang.String[] keys;",
    "double[] values;",
    "int[] table;",
    "double size();",
    "boolean delete(java.lang.String);",
  ]) {
    if (!typescriptMapBytecode.includes(mapEvidence)) {
      throw new Error(
        `Compiler-emitted TypeScript Map lacks '${mapEvidence}':\n${typescriptMapBytecode}`,
      );
    }
  }
  if (
    /java\.lang\.Object|java\.util\.(?:HashMap|LinkedHashMap)|java\.lang\.Double/u
      .test(typescriptMapBytecode)
  ) {
    throw new Error(
      `Compiler-emitted TypeScript Map erased its exact storage:\n${typescriptMapBytecode}`,
    );
  }
  const setClassEntry = readdirSync(
    join(classes, ...generatedActivityPackage.split(".")),
  ).find((entry) =>
    entry.startsWith(`${generatedActivityClass}$NtsSet`) && entry.endsWith(".class")
  );
  if (setClassEntry === undefined) {
    throw new Error("Compiler-emitted TypeScript Activity has no specialized Set class");
  }
  const typescriptSetClassName =
    `${generatedActivityPackage}.${setClassEntry.slice(0, -".class".length)}`;
  const typescriptSetBytecode = run(
    join(input.javaHome, "bin/javap"),
    ["-classpath", classes, "-p", typescriptSetClassName],
    { env: buildEnvironment },
  );
  for (const setEvidence of [
    "java.lang.String[] elements;",
    "boolean[] live;",
    "int[] table;",
    "double size();",
    "boolean delete(java.lang.String);",
    "java.lang.String iterKey(double);",
  ]) {
    if (!typescriptSetBytecode.includes(setEvidence)) {
      throw new Error(
        `Compiler-emitted TypeScript Set lacks '${setEvidence}':\n${typescriptSetBytecode}`,
      );
    }
  }
  if (
    /java\.lang\.Object|java\.util\.(?:HashSet|LinkedHashSet)|java\.lang\.Double/u
      .test(typescriptSetBytecode)
  ) {
    throw new Error(
      `Compiler-emitted TypeScript Set erased its exact storage:\n${typescriptSetBytecode}`,
    );
  }
  for (const activityEvidence of [
    "extends android.app.Activity",
    "android/app/Activity.onCreate:(Landroid/os/Bundle;)V",
    "android/app/Activity.getIntent:()Landroid/content/Intent;",
    "android/app/Activity.setContentView:(Landroid/view/View;)V",
    "android/content/Intent.getStringExtra:(Ljava/lang/String;)Ljava/lang/String;",
    "android/text/TextUtils.equals:(Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Z",
    "android/os/SystemClock.elapsedRealtimeNanos:()J",
    "android/graphics/Rect.width:()I",
    "android/graphics/Rect.flattenToString:()Ljava/lang/String;",
    "android/util/Base64.encode:([BI)[B",
    'android/widget/TextView."<init>":(Landroid/content/Context;)V',
    "android/widget/TextView.setText:(Ljava/lang/CharSequence;)V",
    "android/widget/TextView.setTextSize:(F)V",
    "android/widget/TextView.setMinimumHeight:(I)V",
    'android/widget/Button."<init>":(Landroid/content/Context;)V',
    "android/widget/Button.setOnClickListener:(Landroid/view/View$OnClickListener;)V",
    "android/widget/Button.callOnClick:()Z",
    'android/widget/LinearLayout."<init>":(Landroid/content/Context;)V',
    "android/widget/LinearLayout.addView:(Landroid/view/View;)V",
    "android/widget/LinearLayout.getChildAt:(I)Landroid/view/View;",
    "android/widget/LinearLayout.setOrientation:(I)V",
    "android/view/View.getId:()I",
    "android/widget/TextView.setId:(I)V",
    "android/util/Log.i:(Ljava/lang/String;Ljava/lang/String;)I",
    "java/lang/String.toLowerCase:(Ljava/util/Locale;)Ljava/lang/String;",
    "java/lang/String.indexOf:(Ljava/lang/String;I)I",
    "java/lang/String.substring:(II)Ljava/lang/String;",
    "java/lang/Math.floor:(D)D",
    "java/lang/Math.ceil:(D)D",
    "java/lang/Math.abs:(D)D",
    "java/lang/Math.min:(DD)D",
    "java/lang/Math.max:(DD)D",
    "ntsMathRound:(D)D",
    "ntsStringTrim",
    "ntsStringPad",
    "ntsI64ToNumber:(J)D",
    "lsub",
    "newarray       byte",
    "bastore",
  ]) {
    if (!typescriptActivityBytecode.includes(activityEvidence)) {
      throw new Error(
        `Compiler-emitted TypeScript Activity lacks '${activityEvidence}':\n` +
          typescriptActivityBytecode,
      );
    }
  }
  if (!/invokevirtual .*\.m_[0-9a-f]+:\(\)I/u.test(typescriptActivityBytecode)) {
    throw new Error(
      "Compiler-emitted TypeScript Activity did not run the managed-class " +
        `workload through ART virtual dispatch:\n${typescriptActivityBytecode}`,
    );
  }
  const typescriptCallbackAdapterClassName =
    `${typescriptActivityClassName}$NtsCallbackAdapter0`;
  const typescriptCallbackBytecode = run(
    join(input.javaHome, "bin/javap"),
    ["-classpath", classes, "-c", "-p", typescriptCallbackAdapterClassName],
    { env: buildEnvironment },
  );
  for (const callbackEvidence of [
    "implements android.view.View$OnClickListener",
    "public void onClick(android.view.View)",
    "tableswitch",
  ]) {
    if (!typescriptCallbackBytecode.includes(callbackEvidence)) {
      throw new Error(
        `Compiler-emitted TypeScript callback lacks '${callbackEvidence}':\n` +
          typescriptCallbackBytecode,
      );
    }
  }
  if (
    !/getfield .*d_[0-9a-f]+:[ID]/u.test(typescriptActivityBytecode) ||
    !/putfield .*d_[0-9a-f]+:[ID]/u.test(typescriptActivityBytecode)
  ) {
    throw new Error(
      "Compiler-emitted TypeScript Activity did not keep its instance field " +
        `on the ART receiver:\n${typescriptActivityBytecode}`,
    );
  }
  if (
    typescriptActivityBytecode.includes("nts_jvm_") ||
    /^\s+.*\bnative\b.*\);$/mu.test(typescriptActivityBytecode)
  ) {
    throw new Error(
      `Compiler-emitted TypeScript Activity unexpectedly crosses JNI:\n${typescriptActivityBytecode}`,
    );
  }
  writeFileSync(
    join(input.root, "bytecode-evidence.txt"),
    `=== ${typescriptActivityClassName} ===\n${typescriptActivityBytecode}\n` +
      `=== ${typescriptCallbackAdapterClassName} ===\n${typescriptCallbackBytecode}\n` +
      `=== ${typescriptMapClassName} ===\n${typescriptMapBytecode}\n` +
      `=== ${typescriptSetClassName} ===\n${typescriptSetBytecode}`,
  );

  const compiledClasses = classFiles(classes);
  if (compiledClasses.length === 0) {
    throw new Error("The direct JVM backend produced no classes");
  }
  const androidManifestPath = join(input.root, "AndroidManifest.xml");
  writeFileSync(
    androidManifestPath,
    generateAndroidManifest(directJvmBenchmarkApplication),
  );
  const linked = join(input.root, "base.apk");
  run(input.tools.aapt2, [
    "link",
    "--manifest",
    androidManifestPath,
    "-I",
    input.tools.androidJar,
    "-o",
    linked,
  ]);
  const dex = join(input.root, "classes.zip");
  run(input.tools.d8, [
    "--min-api",
    String(directJvmBenchmarkApplication.minSdk),
    "--lib",
    input.tools.androidJar,
    "--output",
    dex,
    ...compiledClasses,
  ], { env: buildEnvironment });
  stageZipEntries(linked, staging, ["AndroidManifest.xml", "resources.arsc"]);
  stageZipEntries(dex, staging, ["classes.dex"]);

  const unaligned = join(input.root, "app-unaligned.apk");
  run(join(input.javaHome, "bin/jar"), [
    "--create",
    "--file",
    unaligned,
    "--no-manifest",
    "--no-compress",
    "--date",
    "2000-01-01T00:00:00Z",
    "-C",
    staging,
    "AndroidManifest.xml",
    "-C",
    staging,
    "resources.arsc",
    "-C",
    staging,
    "classes.dex",
  ]);
  const aligned = join(input.root, "app-aligned.apk");
  run(input.tools.zipalign, ["-f", "-P", "16", "4", unaligned, aligned]);
  const apkPath = join(input.root, "native-typescript-jvm-benchmark.apk");
  run(input.tools.apksigner, [
    "sign",
    "--ks",
    input.keystore,
    "--ks-pass",
    "pass:android",
    "--key-pass",
    "pass:android",
    "--ks-key-alias",
    "nts",
    "--v1-signing-enabled",
    "false",
    "--v2-signing-enabled",
    "true",
    "--v4-signing-enabled",
    "false",
    "--out",
    apkPath,
    aligned,
  ], { env: buildEnvironment });
  return {
    implementation: "native-typescript-jvm",
    applicationId: directJvmBenchmarkApplication.applicationId,
    activity: directJvmBenchmarkApplication.activityBinaryName.replace(/\//gu, "."),
    apkPath,
    sha256: sha256(apkPath),
    bytes: statSync(apkPath).size,
    evidence: {
      bindings: activityBindings.map((binding) => ({
        bindingId: binding.id,
        ownerBinaryName: binding.ownerBinaryName,
        name: binding.name,
        descriptor: binding.descriptor,
        nativeEntrySymbol: binding.nativeEntrySymbol,
      })),
      bytecodePath: relative(
        input.root,
        join(input.root, "bytecode-evidence.txt"),
      ),
      typescriptActivity: generatedActivityOwner.replaceAll("/", "."),
      typescriptActivityBytecodePath: relative(
        input.root,
        join(input.root, "bytecode-evidence.txt"),
      ),
    },
  };
}

function buildNativeScriptApk(input: {
  readonly root: string;
  readonly tools: AndroidTools;
  readonly javaHome: string;
  readonly keystore: string;
}): BuiltApplication {
  mkdirSync(input.root, { recursive: true });
  const project = join(input.root, "project");
  mkdirSync(project, { recursive: true });
  for (const entry of [
    "app",
    "App_Resources",
    "nativescript.config.ts",
    "references.d.ts",
    "tsconfig.json",
    "webpack.config.js",
  ]) {
    cpSync(join(nativeScriptRoot, entry), join(project, entry), { recursive: true });
  }
  const sourcePackage = JSON.parse(
    readFileSync(join(nativeScriptRoot, "package.json"), "utf8"),
  ) as {
    readonly name: string;
    readonly version: string;
    readonly private: boolean;
    readonly main: string;
    readonly dependencies: Readonly<Record<string, string>>;
    readonly devDependencies: Readonly<Record<string, string>>;
  };
  const materialize = (
    dependencies: Readonly<Record<string, string>>,
  ): Record<string, string> => Object.fromEntries(
    Object.entries(dependencies).map(([name, requested]) => {
      if (requested !== "catalog:nativescript") return [name, requested];
      const installed = JSON.parse(
        readFileSync(join(nativeScriptRoot, `node_modules/${name}/package.json`), "utf8"),
      ) as { readonly version: string };
      return [name, installed.version];
    }),
  );
  writeFileSync(join(project, "package.json"), JSON.stringify({
    name: sourcePackage.name,
    version: sourcePackage.version,
    private: sourcePackage.private,
    main: sourcePackage.main,
    dependencies: materialize(sourcePackage.dependencies),
    devDependencies: materialize(sourcePackage.devDependencies),
  }, null, 2) + "\n");
  symlinkSync(join(nativeScriptRoot, "node_modules"), join(project, "node_modules"), "dir");
  const apkPath = join(input.root, "nativescript-benchmark.apk");
  const buildEnvironment = {
    ...process.env,
    ANDROID_HOME: input.tools.sdkRoot,
    ANDROID_SDK_ROOT: input.tools.sdkRoot,
    JAVA_HOME: input.javaHome,
    PATH: `${join(input.javaHome, "bin")}:${process.env["PATH"] ?? ""}`,
  };
  run(
    join(nativeScriptRoot, "node_modules/.bin/ns"),
    [
      "build",
      "android",
      "--release",
      "--no-hmr",
      "--clean",
      "--compileSdk",
      String(ANDROID_BENCHMARK_API),
      "--key-store-path",
      input.keystore,
      "--key-store-password",
      "android",
      "--key-store-alias",
      "nts",
      "--key-store-alias-password",
      "android",
      "--copy-to",
      apkPath,
    ],
    { cwd: project, env: buildEnvironment },
  );
  if (!existsSync(apkPath)) {
    throw new Error(`NativeScript produced no APK at ${apkPath}`);
  }
  return {
    implementation: "nativescript",
    applicationId: "com.example.ntsbenchmark.nativescript",
    activity: "com.tns.NativeScriptActivity",
    apkPath,
    sha256: sha256(apkPath),
    bytes: statSync(apkPath).size,
  };
}

function sourceConstant(source: string, language: Implementation, name: string): number {
  const expression = language === "kotlin"
    ? new RegExp(`private const val ${name} = ([0-9_]+)`, "u")
    : new RegExp(`const ${name} = ([0-9_]+);`, "u");
  const found = expression.exec(source)?.[1];
  if (found === undefined) throw new Error(`${language} source has no ${name}`);
  return Number(found.replace(/_/gu, ""));
}

function verifyWorkloadAgreement(): void {
  const nts = readFileSync(nativeSource, "utf8");
  const kotlin = readFileSync(kotlinSource, "utf8");
  const nativeScript = readFileSync(nativeScriptSource, "utf8");
  const direct = readFileSync(directTypescriptActivitySource, "utf8");
  const expected = {
    WARMUP_SAMPLES: androidBenchmarkWorkload.warmupSamples,
    MEASURED_SAMPLES: androidBenchmarkWorkload.measuredSamples,
    LIGHT_OBJECT_ITERATIONS: androidBenchmarkWorkload.lightObjectIterations,
    MANAGED_CLASS_ITERATIONS: androidBenchmarkWorkload.managedClassIterations,
    CONSTRUCTOR_ITERATIONS: androidBenchmarkWorkload.constructorIterations,
    SETTER_ITERATIONS: androidBenchmarkWorkload.setterIterations,
    CALLBACK_ITERATIONS: androidBenchmarkWorkload.callbackIterations,
    STRING_ARGUMENT_ITERATIONS:
      androidBenchmarkWorkload.stringArgumentIterations,
    STRING_RESULT_ITERATIONS: androidBenchmarkWorkload.stringResultIterations,
    STRING_OPERATION_ITERATIONS:
      androidBenchmarkWorkload.stringOperationIterations,
    ARRAY_OPERATION_ITERATIONS:
      androidBenchmarkWorkload.arrayOperationIterations,
    ARRAY_PIPELINE_ITERATIONS:
      androidBenchmarkWorkload.arrayPipelineIterations,
    RECORD_OBJECT_ITERATIONS:
      androidBenchmarkWorkload.recordObjectIterations,
    OPTIONAL_VALUE_ITERATIONS:
      androidBenchmarkWorkload.optionalValueIterations,
    MAP_OPERATION_ITERATIONS:
      androidBenchmarkWorkload.mapOperationIterations,
    SET_OPERATION_ITERATIONS:
      androidBenchmarkWorkload.setOperationIterations,
    MATH_OPERATION_ITERATIONS:
      androidBenchmarkWorkload.mathOperationIterations,
    NUMBER_PARSING_ITERATIONS:
      androidBenchmarkWorkload.numberParsingIterations,
    BYTE_ARRAY_ITERATIONS: androidBenchmarkWorkload.byteArrayIterations,
    BYTE_ARRAY_LENGTH: androidBenchmarkWorkload.byteArrayLength,
    HANDLE_RESULT_ITERATIONS: androidBenchmarkWorkload.handleResultIterations,
    HANDLE_RESULT_CHILDREN: androidBenchmarkWorkload.handleResultChildren,
    CALLBACK_PAYLOAD_ITERATIONS:
      androidBenchmarkWorkload.callbackPayloadIterations,
    CALLBACK_CAPTURE_ITERATIONS:
      androidBenchmarkWorkload.callbackCaptureIterations,
    TEXT_UPDATE_ITERATIONS: androidBenchmarkWorkload.textUpdateIterations,
    SCREEN_BUILD_ROWS: androidBenchmarkWorkload.screenBuildRows,
    TREE_CHILDREN: androidBenchmarkWorkload.treeChildren,
  };
  for (const [name, value] of Object.entries(expected)) {
    const ntsValue = sourceConstant(nts, "native-typescript", name);
    const kotlinValue = sourceConstant(kotlin, "kotlin", name);
    const nativeScriptValue = sourceConstant(nativeScript, "nativescript", name);
    if (
      ntsValue !== value || kotlinValue !== value || nativeScriptValue !== value
    ) {
      throw new Error(
        `${name} drifted: project=${value}, native-typescript=${ntsValue}, ` +
          `kotlin=${kotlinValue}, nativescript=${nativeScriptValue}`,
      );
    }
    const directValue = sourceConstant(direct, "native-typescript-jvm", name);
    if (directValue !== value) {
      throw new Error(
        `${name} drifted: project=${value}, native-typescript-jvm=${directValue}`,
      );
    }
  }
}

function scenarioDefinition(name: AndroidBenchmarkScenario) {
  const definition = androidBenchmarkScenarios.find(
    (candidate) => candidate.name === name,
  );
  if (definition === undefined) {
    throw new Error(`benchmark scenario '${name}' has no declared contract`);
  }
  return definition;
}

interface DeviceClaim {
  readonly release: () => void;
}

async function claimDevice(): Promise<DeviceClaim> {
  const holder = spawn(
    "flock",
    ["-w", "420", DEVICE_LOCK, "-c", "echo held; exec cat"],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  return await new Promise<DeviceClaim>((resolveClaim, reject) => {
    let announced = "";
    holder.stdout.on("data", (chunk: Buffer) => {
      announced += chunk.toString("utf8");
      if (!announced.includes("held")) return;
      resolveClaim({
        release: () => {
          holder.stdin.end();
          holder.kill();
        },
      });
    });
    holder.on("exit", (code) => {
      if (announced.includes("held")) return;
      reject(
        new Error(
          code === 1
            ? `another run held ${DEVICE_LOCK} for more than 420 seconds`
            : `flock exited ${String(code)} before acquiring the device`,
        ),
      );
    });
    holder.on("error", reject);
  });
}

function readyDevices(adb: string): string[] {
  const listed = run(adb, ["devices"]);
  return listed.split("\n").slice(1).map((row) => row.trim())
    .filter((row) => row.endsWith("\tdevice"))
    .map((row) => row.split("\t")[0]!);
}

function readyDevice(adb: string, requested: string | null): string | null {
  const ready = readyDevices(adb);
  if (requested !== null) {
    if (!ready.includes(requested)) {
      throw new Error(`requested device '${requested}' is not attached and ready`);
    }
    return requested;
  }
  if (ready.length > 1) {
    throw new Error(
      `more than one device is ready; choose one with --serial (${ready.join(", ")})`,
    );
  }
  return ready[0] ?? null;
}

async function bootAvd(tools: AndroidTools, avd: string): Promise<{
  readonly serial: string;
  readonly stop: () => void;
}> {
  const configured = run(tools.emulator, ["-list-avds"])
    .split("\n").map((name) => name.trim()).filter((name) => name.length > 0);
  if (!configured.includes(avd)) {
    throw new Error(
      `AVD '${avd}' is not configured; available AVDs: ${configured.join(", ")}`,
    );
  }
  const child = spawn(
    tools.emulator,
    [
      "-avd",
      avd,
      "-no-window",
      "-no-audio",
      "-no-boot-anim",
      "-no-snapshot-save",
    ],
    { stdio: "ignore", detached: false },
  );
  const deadline = Date.now() + 300_000;
  let serial: string | null = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`emulator for AVD '${avd}' exited with ${child.exitCode}`);
    }
    for (const candidate of readyDevices(tools.adb)) {
      if (!candidate.startsWith("emulator-")) continue;
      const name = run(tools.adb, ["-s", candidate, "emu", "avd", "name"]);
      if (name.split("\n")[0]?.trim() === avd) {
        serial = candidate;
        break;
      }
    }
    if (serial !== null) {
      const completed = run(
        tools.adb,
        ["-s", serial, "shell", "getprop", "sys.boot_completed"],
      ).trim();
      if (completed === "1") break;
    }
    execFileSync("sleep", ["1"]);
  }
  if (serial === null || Date.now() >= deadline) {
    child.kill();
    throw new Error(`AVD '${avd}' did not finish booting within 300 seconds`);
  }
  const selected = serial;
  return {
    serial: selected,
    stop: () => {
      try {
        run(tools.adb, ["-s", selected, "emu", "kill"]);
      } catch {
        child.kill();
      }
    },
  };
}

function parseAmStart(
  implementation: Implementation,
  round: number,
  kind: LaunchMeasurement["kind"],
  raw: string,
): LaunchMeasurement {
  const field = (name: string): string | null =>
    new RegExp(`^${name}: (.+)$`, "mu").exec(raw)?.[1]?.trim() ?? null;
  const numberField = (name: string): number | null => {
    const value = field(name);
    return value === null ? null : Number(value);
  };
  return {
    implementation,
    round,
    kind,
    status: field("Status"),
    launchState: field("LaunchState"),
    thisTimeMs: numberField("ThisTime"),
    totalTimeMs: numberField("TotalTime"),
    waitTimeMs: numberField("WaitTime"),
    raw,
  };
}

function awaitBenchmarkLog(
  adbRun: (...args: readonly string[]) => string,
  implementation: Implementation,
  scenario: string,
): string {
  const complete = `complete implementation=${implementation} scenario=${scenario}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const log = adbRun("logcat", "-d", "-s", `${LOG_TAG}:I`, "*:S");
    if (log.includes(complete)) return log;
    execFileSync("sleep", ["0.25"]);
  }
  throw new Error(
    `timed out waiting for ${implementation} ${scenario}; logcat:\n` +
      adbRun("logcat", "-d", "-t", "300"),
  );
}

function assertProcessAlive(
  adbRun: (...args: readonly string[]) => string,
  application: BuiltApplication,
  phase: string,
): void {
  /* A benchmark may emit its completion line and then fail while Android is
   * attaching the returned view. Give that asynchronous failure a chance to
   * surface before accepting the observation. */
  execFileSync("sleep", ["0.5"]);
  const pid = adbRun("shell", "pidof", application.applicationId).trim();
  if (pid.length > 0) return;
  const crash = adbRun("logcat", "-b", "crash", "-d", "-t", "300");
  throw new Error(
    `${application.implementation} process exited after ${phase}:\n${crash}`,
  );
}

function parseWorkloadLog(
  implementation: Implementation,
  scenario: WorkloadMeasurement["scenario"],
  processRound: number,
  log: string,
): WorkloadMeasurement[] {
  const pattern = /sample implementation=(native-typescript|native-typescript-jvm|kotlin|nativescript) scenario=([a-z-]+) sample=(\d+) iterations=(\d+) elapsedNs=(\d+) checksum=(-?\d+)/u;
  const measurements: WorkloadMeasurement[] = [];
  for (const line of log.split("\n")) {
    const match = pattern.exec(line);
    if (match === null || match[1] !== implementation || match[2] !== scenario) {
      continue;
    }
    const sample = Number(match[3]);
    const iterations = Number(match[4]);
    const elapsedNs = Number(match[5]);
    const checksum = Number(match[6]);
    measurements.push({
      implementation,
      scenario,
      processRound,
      sample,
      iterations,
      elapsedNs,
      nanosecondsPerOperation: elapsedNs / iterations,
      checksum,
    });
  }
  const definition = scenarioDefinition(scenario);
  const expected = definition.measuredSamples;
  if (measurements.length !== expected) {
    throw new Error(
      `${implementation} ${scenario} emitted ${measurements.length} samples, ` +
        `expected ${expected}:\n${log}`,
    );
  }
  if (measurements.some(({ iterations }) => iterations !== definition.iterations)) {
    throw new Error(
      `${implementation} ${scenario} reported the wrong iteration count; ` +
        `expected ${definition.iterations}:\n${log}`,
    );
  }
  const sampleNumbers = measurements.map(({ sample }) => sample).sort(
    (left, right) => left - right,
  );
  if (sampleNumbers.some((sample, index) => sample !== index)) {
    throw new Error(
      `${implementation} ${scenario} emitted non-contiguous sample numbers; ` +
        `expected 0 through ${expected - 1}:\n${log}`,
    );
  }
  const expectedChecksum = definition.expectedChecksum;
  if (measurements.some(({ checksum }) => checksum !== expectedChecksum)) {
    throw new Error(
      `${implementation} ${scenario} produced the wrong checksum; expected ` +
        `${expectedChecksum}:\n${log}`,
    );
  }
  return measurements;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function parseMeminfo(
  implementation: Implementation,
  round: number,
  rawPath: string,
  raw: string,
): MemoryMeasurement {
  const totals = /TOTAL PSS:\s+(\d+)\s+TOTAL RSS:\s+(\d+)/u.exec(raw);
  if (totals === null) {
    throw new Error(`${implementation} meminfo carries no TOTAL PSS/RSS:\n${raw}`);
  }
  return {
    implementation,
    round,
    totalPssKb: Number(totals[1]),
    totalRssKb: Number(totals[2]),
    rawPath,
  };
}

function summarize(
  launches: readonly LaunchMeasurement[],
  workloads: readonly WorkloadMeasurement[],
  memory: readonly MemoryMeasurement[],
  scenarios: typeof androidBenchmarkScenarios,
): object {
  const launch = launches.length === 0 ? [] :
    (["process-start", "warm-foreground"] as const).flatMap((kind) =>
      FULL_APPLICATION_IMPLEMENTATIONS.map((implementation) => {
        /* NativeScriptActivity reports LaunchState UNKNOWN on current ART and
         * therefore omits TotalTime. WaitTime is emitted for every implementation;
         * keep the stronger fields in the raw observation, but compare one shared
         * command-completion metric rather than silently dropping NativeScript. */
        const sourceMetric = "WaitTime";
        const values = launches
          .filter((entry) => entry.kind === kind && entry.implementation === implementation)
          .flatMap((entry) => {
            const value = entry.waitTimeMs;
            return value === null ? [] : [value];
          });
        return {
          implementation,
          kind,
          sourceMetric,
          samples: values.length,
          medianMs: median(values),
          minMs: values.length === 0 ? null : Math.min(...values),
          maxMs: values.length === 0 ? null : Math.max(...values),
        };
      })
    );
  const workload = scenarios
    .flatMap((scenario) =>
      IMPLEMENTATIONS
        .filter((implementation) =>
          implementation !== "native-typescript-jvm" ||
          directJvmSupportsScenario(scenario.name)
        )
        .map((implementation) => {
          const values = workloads
            .filter((entry) =>
              entry.scenario === scenario.name &&
              entry.implementation === implementation
            )
            .map(({ nanosecondsPerOperation }) => nanosecondsPerOperation);
          return {
            implementation,
            scenario: scenario.name,
            layer: scenario.layer,
            hotspot: scenario.hotspot,
            operationUnit: scenario.operationUnit,
            samples: values.length,
            medianNanosecondsPerOperation: median(values),
            minNanosecondsPerOperation: values.length === 0 ? null : Math.min(...values),
            maxNanosecondsPerOperation: values.length === 0 ? null : Math.max(...values),
          };
        })
    );
  const ratios = ([
    ["native-typescript", "kotlin"],
    ["native-typescript-jvm", "kotlin"],
    ["native-typescript-jvm", "native-typescript"],
    ["native-typescript-jvm", "nativescript"],
    ["nativescript", "kotlin"],
    ["native-typescript", "nativescript"],
  ] as const).flatMap(([implementation, baseline]) =>
    workload.flatMap((measured) => {
      if (measured.implementation !== implementation) return [];
      const reference = workload.find((entry) =>
        entry.implementation === baseline && entry.scenario === measured.scenario
      );
      if (
        reference === undefined ||
        measured.medianNanosecondsPerOperation === null ||
        reference.medianNanosecondsPerOperation === null ||
        reference.medianNanosecondsPerOperation === 0
      ) return [];
      return [{
        scenario: measured.scenario,
        implementation,
        baseline,
        ratio: measured.medianNanosecondsPerOperation /
          reference.medianNanosecondsPerOperation,
      }];
    })
  );
  const memorySummary = memory.length === 0 ? [] : FULL_APPLICATION_IMPLEMENTATIONS.map(
    (implementation) => {
      const rows = memory.filter((entry) => entry.implementation === implementation);
      return {
        implementation,
        samples: rows.length,
        medianTotalPssKb: median(rows.map(({ totalPssKb }) => totalPssKb)),
        medianTotalRssKb: median(rows.map(({ totalRssKb }) => totalRssKb)),
      };
    },
  );
  return { launch, workload, memory: memorySummary, ratios };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const selectedScenarios = Object.freeze(
    options.scenarios === null
      ? [...androidBenchmarkScenarios]
      : androidBenchmarkScenarios.filter(({ name }) =>
        options.scenarios!.includes(name)
      ),
  );
  const selectedRepeatedScenarios = repeatedAndroidBenchmarkScenarios.filter(
    (scenario) => selectedScenarios.some(({ name }) => name === scenario),
  );
  const measureApplicationShape = selectedScenarios.some(
    ({ name }) => name === "view-tree",
  );
  if (existsSync(options.output)) {
    throw new Error(`output directory already exists: ${options.output}`);
  }
  mkdirSync(options.output, { recursive: true });
  const taskTmp = join(homedir(), ".cache/nts-tmp");
  mkdirSync(taskTmp, { recursive: true });
  process.env["TMPDIR"] = taskTmp;

  verifyWorkloadAgreement();
  const tools = discoverAndroidTools();
  const javaHome = discoverJavaHome();
  if (javaHome === null) throw new Error("No JDK with JNI headers was found");
  const keystore = join(options.output, "debug.jks");
  run(join(javaHome, "bin/keytool"), [
    "-genkeypair",
    "-keystore",
    keystore,
    "-storepass",
    "android",
    "-keypass",
    "android",
    "-alias",
    "nts",
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "10000",
    "-dname",
    "CN=native-typescript benchmark",
  ]);

  console.log("Building the Native TypeScript benchmark APK...");
  const nativeBuildRoot = join(options.output, "native-typescript");
  const nativeApplication = await buildNativeTypescriptApk({
    root: nativeBuildRoot,
    tools,
    javaHome,
    keystore,
  });
  console.log("Building the Native TypeScript direct-JVM benchmark APK...");
  const directApplication = await buildDirectJvmApk({
    root: join(options.output, "native-typescript-jvm"),
    bindingPackageRoot: join(
      nativeBuildRoot,
      "build/library/generated/android_benchmark",
    ),
    tools,
    javaHome,
    keystore,
  });
  console.log("Building the Kotlin benchmark APK...");
  const kotlinApplication = buildKotlinApk({
    root: join(options.output, "kotlin"),
    tools,
    javaHome,
    keystore,
  });
  console.log("Building the NativeScript benchmark APK...");
  const nativeScriptApplication = buildNativeScriptApk({
    root: join(options.output, "nativescript"),
    tools,
    javaHome,
    keystore,
  });
  const applications = [
    nativeApplication,
    directApplication,
    kotlinApplication,
    nativeScriptApplication,
  ] as const;
  const fullApplications = [
    nativeApplication,
    directApplication,
    kotlinApplication,
    nativeScriptApplication,
  ] as const;
  const sourceState = {
    parentCommit: run("git", ["rev-parse", "HEAD"], { cwd: workspace }).trim(),
    scriptcCommit: run("git", ["rev-parse", "HEAD"], { cwd: scriptcRoot }).trim(),
    status: run("git", ["status", "--short"], { cwd: workspace }),
    nativeSourceSha256: sha256(nativeSource),
    directTypescriptActivitySourceSha256: sha256(directTypescriptActivitySource),
    directArrayOperationSourceSha256: sha256(directArrayOperationSource),
    directArrayPipelineSourceSha256: sha256(directArrayPipelineSource),
    directByteArraySourceSha256: sha256(directByteArraySource),
    directConstructorSourceSha256: sha256(directConstructorSource),
    directHandleResultSourceSha256: sha256(directHandleResultSource),
    directLightObjectSourceSha256: sha256(directLightObjectSource),
    directManagedClassSourceSha256: sha256(directManagedClassSource),
    directMapOperationSourceSha256: sha256(directMapOperationSource),
    directMathOperationSourceSha256: sha256(directMathOperationSource),
    directNumberParsingSourceSha256: sha256(directNumberParsingSource),
    directOptionalValueSourceSha256: sha256(directOptionalValueSource),
    directRecordObjectSourceSha256: sha256(directRecordObjectSource),
    directScreenBuildSourceSha256: sha256(directScreenBuildSource),
    directSetOperationSourceSha256: sha256(directSetOperationSource),
    directSetterSourceSha256: sha256(directSetterSource),
    directStringArgumentSourceSha256: sha256(directStringArgumentSource),
    directStringOperationSourceSha256: sha256(directStringOperationSource),
    directStringResultSourceSha256: sha256(directStringResultSource),
    directTextUpdateSourceSha256: sha256(directTextUpdateSource),
    kotlinSourceSha256: sha256(kotlinSource),
    nativeScriptSourceSha256: sha256(nativeScriptSource),
  };
  const toolchains = {
    java: commandVersion(join(javaHome, "bin/java"), ["-version"]),
    kotlin: commandVersion(tools.kotlin, ["-version"]),
    kotlinRuntime: tools.kotlinRuntimeJars.map((path) => ({
      name: basename(path),
      sha256: sha256(path),
    })),
    nativeScript: JSON.parse(
      readFileSync(join(nativeScriptRoot, "node_modules/nativescript/package.json"), "utf8"),
    ).version as string,
    nativeScriptAndroid: JSON.parse(
      readFileSync(join(nativeScriptRoot, "node_modules/@nativescript/android/package.json"), "utf8"),
    ).version as string,
    clang: commandVersion(tools.clang, ["--version"]),
    adb: commandVersion(tools.adb, ["version"]),
    aapt2: commandVersion(tools.aapt2, ["version"]),
    sdkPlatform: tools.platform,
    buildTools: tools.buildToolsVersion,
  };
  const baseReport = {
    schema: "native-typescript.android-performance",
    schemaVersion: 8,
    recordedAt: new Date().toISOString(),
    mode: options.buildOnly ? "build-only" : "device",
    rounds: options.rounds,
    workload: androidBenchmarkWorkload,
    scenarios: selectedScenarios,
    sourceState,
    toolchains,
    artifacts: applications.map(({ implementation, apkPath, sha256, bytes }) => ({
      implementation,
      path: relative(options.output, apkPath),
      sha256,
      bytes,
    })),
    directJvmEvidence: {
      ...directApplication.evidence,
      typescriptOwnedScenarios: TYPESCRIPT_OWNED_DIRECT_JVM_SCENARIOS,
      bytecodePath: join(
        "native-typescript-jvm",
        directApplication.evidence.bytecodePath,
      ),
    },
  };
  if (options.buildOnly) {
    const reportPath = join(options.output, "results.json");
    writeFileSync(reportPath, JSON.stringify(baseReport, null, 2) + "\n");
    console.log(`Built all four APKs; report: ${reportPath}`);
    return;
  }

  const claim = await claimDevice();
  let bootedAvd: { readonly serial: string; readonly stop: () => void } | null = null;
  let serial: string;
  try {
    const attached = readyDevice(tools.adb, options.serial);
    if (attached !== null) serial = attached;
    else if (options.avd !== null) {
      console.log(`Booting Android AVD ${options.avd}...`);
      bootedAvd = await bootAvd(tools, options.avd);
      serial = bootedAvd.serial;
    } else {
      throw new Error(
        "no attached and authorized Android device; pass --avd NAME to boot one",
      );
    }
  } catch (error) {
    claim.release();
    throw error;
  }
  const adbRun = (...args: readonly string[]): string =>
    run(tools.adb, ["-s", serial, ...args]);
  const launches: LaunchMeasurement[] = [];
  const workloads: WorkloadMeasurement[] = [];
  const memory: MemoryMeasurement[] = [];
  const compilation: Record<string, string> = {};
  try {
    for (const application of applications) {
      try {
        adbRun("uninstall", application.applicationId);
      } catch {
        // A clean device normally has neither package.
      }
      adbRun("install", "-r", application.apkPath);
      compilation[application.implementation] = adbRun(
        "shell",
        "cmd",
        "package",
        "compile",
        "-m",
        "speed",
        "-f",
        application.applicationId,
      ).trim();
    }

    const ordered = (
      pool: readonly BuiltApplication[],
      round: number,
    ): readonly BuiltApplication[] =>
      pool.map((_, offset) =>
        pool[(round + offset) % pool.length]!
      );
    if (measureApplicationShape) {
      for (let round = 0; round < options.rounds; round++) {
        for (const application of ordered(fullApplications, round)) {
          adbRun("logcat", "-c");
          adbRun("shell", "am", "force-stop", application.applicationId);
          const cold = adbRun(
            "shell",
            "am",
            "start",
            "-W",
            "-n",
            `${application.applicationId}/${application.activity}`,
          );
          const coldLaunch = parseAmStart(
            application.implementation,
            round,
            "process-start",
            cold,
          );
          if (coldLaunch.status !== "ok") {
            throw new Error(
              `${application.implementation} process launch failed:\n${cold}`,
            );
          }
          launches.push(coldLaunch);
          const log = awaitBenchmarkLog(
            adbRun,
            application.implementation,
            "view-tree",
          );
          assertProcessAlive(adbRun, application, "view-tree completion");
          workloads.push(
            ...parseWorkloadLog(
              application.implementation,
              "view-tree",
              round,
              log,
            ),
          );
          adbRun("shell", "input", "keyevent", "KEYCODE_HOME");
          const warm = adbRun(
            "shell",
            "am",
            "start",
            "-W",
            "-n",
            `${application.applicationId}/${application.activity}`,
          );
          const warmLaunch = parseAmStart(
            application.implementation,
            round,
            "warm-foreground",
            warm,
          );
          if (warmLaunch.status !== "ok") {
            throw new Error(
              `${application.implementation} warm launch failed:\n${warm}`,
            );
          }
          launches.push(warmLaunch);
          assertProcessAlive(adbRun, application, "warm foreground launch");
          const meminfoName = `${application.implementation}-meminfo-${round}.txt`;
          const meminfo = adbRun(
            "shell",
            "dumpsys",
            "meminfo",
            application.applicationId,
          );
          writeFileSync(join(options.output, meminfoName), meminfo);
          memory.push(
            parseMeminfo(
              application.implementation,
              round,
              meminfoName,
              meminfo,
            ),
          );
        }
      }
    }

    for (const scenario of selectedRepeatedScenarios) {
      const scenarioApplications = directJvmSupportsScenario(scenario)
        ? applications
        : fullApplications;
      for (let round = 0; round < options.rounds; round++) {
        for (const application of ordered(scenarioApplications, round)) {
          adbRun("logcat", "-c");
          adbRun("shell", "am", "force-stop", application.applicationId);
          adbRun(
            "shell",
            "am",
            "start",
            "-W",
            "-n",
            `${application.applicationId}/${application.activity}`,
            "--es",
            "scenario",
            scenario,
          );
          const log = awaitBenchmarkLog(
            adbRun,
            application.implementation,
            scenario,
          );
          assertProcessAlive(adbRun, application, `${scenario} completion`);
          workloads.push(
            ...parseWorkloadLog(
              application.implementation,
              scenario,
              round,
              log,
            ),
          );
        }
      }
    }

    const getprop = (name: string): string =>
      adbRun("shell", "getprop", name).trim();
    const device = {
      serial,
      manufacturer: getprop("ro.product.manufacturer"),
      model: getprop("ro.product.model"),
      fingerprint: getprop("ro.build.fingerprint"),
      api: getprop("ro.build.version.sdk"),
      abi: getprop("ro.product.cpu.abilist"),
      hardware: getprop("ro.hardware"),
      kernel: adbRun("shell", "uname", "-a").trim(),
      size: adbRun("shell", "wm", "size").trim(),
      density: adbRun("shell", "wm", "density").trim(),
    };
    const report = {
      ...baseReport,
      device,
      compilation,
      launches,
      workloads,
      memory,
      summary: summarize(launches, workloads, memory, selectedScenarios),
    };
    const reportPath = join(options.output, "results.json");
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report.summary, null, 2));
    console.log(`Raw report: ${reportPath}`);
  } finally {
    for (const application of applications) {
      try {
        adbRun("shell", "am", "force-stop", application.applicationId);
        adbRun("uninstall", application.applicationId);
      } catch {
        // Preserve the benchmark verdict; teardown is best-effort.
      }
    }
    bootedAvd?.stop();
    claim.release();
  }
}

await main();
