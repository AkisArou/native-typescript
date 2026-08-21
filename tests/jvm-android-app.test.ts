import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildAndroidApk,
  discoverJavaHome,
} from "@native-typescript/target-jvm";
import { scriptCCompilerDistribution } from "@native-typescript/scriptc";
import { executable } from "./support/artifacts.ts";

/**
 * The acceptance program the whole crossing exists for: a TypeScript
 * Android application, built into a signed APK by the product's own
 * pipeline, whose only code is a lifecycle handler.
 *
 * Every stage is the product's own: ingestion of the real android.jar,
 * a generated Activity, javac against the platform jar, the cross-compiled
 * hosted library, dex, manifest, assembly, alignment and signature. What
 * this lane asserts is the APK's own testimony — that the package ART
 * would read names the generated Activity as its launcher, and that the
 * library inside it is the one this build produced.
 *
 * Running it is the next slice: install on the emulator, launch, and read
 * the verdict out of logcat, which is where an Android process's only
 * honest channel goes.
 */
const NDK_API = 35;

function findNdk(): {
  readonly clang: string;
  readonly ar: string;
} | null {
  for (const sdkRoot of [
    process.env["ANDROID_SDK_ROOT"],
    process.env["ANDROID_HOME"],
    join(homedir(), "Android/Sdk"),
  ]) {
    if (sdkRoot === undefined || sdkRoot.length === 0) continue;
    const ndkDir = join(sdkRoot, "ndk");
    if (!existsSync(ndkDir)) continue;
    for (const version of readdirSync(ndkDir).sort().reverse()) {
      const bin = join(ndkDir, version, "toolchains/llvm/prebuilt/linux-x86_64/bin");
      const clang = join(bin, `x86_64-linux-android${NDK_API}-clang`);
      if (existsSync(clang)) return { clang, ar: join(bin, "llvm-ar") };
    }
  }
  return null;
}

function findBuildTools(): {
  readonly aapt2: string;
  readonly d8: string;
  readonly zipalign: string;
  readonly apksigner: string;
  readonly androidJar: string;
} | null {
  for (const sdkRoot of [
    process.env["ANDROID_SDK_ROOT"],
    process.env["ANDROID_HOME"],
    join(homedir(), "Android/Sdk"),
  ]) {
    if (sdkRoot === undefined || sdkRoot.length === 0) continue;
    const toolsDir = join(sdkRoot, "build-tools");
    const platformsDir = join(sdkRoot, "platforms");
    if (!existsSync(toolsDir) || !existsSync(platformsDir)) continue;
    const platform = readdirSync(platformsDir)
      .filter((name) => existsSync(join(platformsDir, name, "android.jar")))
      .sort((left, right) =>
        parseFloat(right.slice("android-".length)) -
        parseFloat(left.slice("android-".length))
      )[0];
    const tools = readdirSync(toolsDir).sort().reverse()[0];
    if (platform === undefined || tools === undefined) continue;
    const at = (name: string) => join(toolsDir, tools, name);
    if (!existsSync(at("aapt2"))) continue;
    return {
      aapt2: at("aapt2"),
      d8: at("d8"),
      zipalign: at("zipalign"),
      apksigner: at("apksigner"),
      androidJar: join(platformsDir, platform, "android.jar"),
    };
  }
  return null;
}

const workspace = join(import.meta.dirname, "..");
const scriptcRoot = join(workspace, "third_party/scriptc");
const fixtureRoot = join(workspace, "fixtures/android-app");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const javaHome = discoverJavaHome();
const ndk = findNdk();
const sdk = findBuildTools();
const hasBubblewrap = spawnSync("bwrap", ["--version"]).status === 0;

const skip =
  process.platform !== "linux" || process.arch !== "x64"
    ? "the Android application lane builds from x86_64 Linux"
    : javaHome === null
      ? "no JDK with include/jni.h on this host"
      : ndk === null
        ? "no Android NDK toolchain"
        : sdk === null
          ? "no Android SDK build-tools with a platform jar"
          : !hasBubblewrap
            ? "bwrap is unavailable"
            : false;

/* The Activity's ancestry, which ingestion requires to be selected rather
 * than inferred: a class whose superclass is present among the sources but
 * absent from the selection is a silent-ancestry error by design. */
const activityChain = [
  { binaryName: "java/lang/Object" },
  { binaryName: "android/content/Context" },
  { binaryName: "android/content/ContextWrapper" },
  { binaryName: "android/view/ContextThemeWrapper" },
];

const androidProject = {
  name: "android-app",
  entry: "app.ts",
  output: "ntsdemo",
  packageSlug: "android",
  classes: [
    ...activityChain,
    /* Bundle is the payload onCreate is handed, so the selection must
     * project it — and BaseBundle with it, because ingestion refuses a
     * class whose superclass is present among the sources but absent
     * from the selection rather than inventing an ancestry. */
    { binaryName: "android/os/BaseBundle" },
    { binaryName: "android/os/Bundle" },
    {
      binaryName: "android/util/Log",
      methods: [{ name: "i", descriptor: "(Ljava/lang/String;Ljava/lang/String;)I" }],
    },
    {
      binaryName: "android/app/Activity",
      constructors: ["()V"],
      methods: [
        { name: "onCreate", descriptor: "(Landroid/os/Bundle;)V" },
        { name: "getLocalClassName", descriptor: "()Ljava/lang/String;" },
      ],
    },
  ],
  subclasses: [
    {
      baseBinaryName: "android/app/Activity",
      overrides: [{ name: "onCreate", descriptor: "(Landroid/os/Bundle;)V" }],
      /* NOT the base's package: Android refuses to load application
       * classes defined in android.*, so the Activity is generated into
       * a package the application owns. */
      subclassBinaryName: "com/example/ntsdemo/MainActivity",
      /* ART constructs this Activity, so its lifecycle registrations
       * answer for the class rather than for an instance nobody holds. */
      anchor: "class" as const,
      /* The platform constructs this class, so its own initializer is
       * the only place the native half can be loaded in time. */
      loadLibrary: "ntsdemo",
    },
  ],
  android: {
    applicationId: "com.example.ntsdemo",
    activityBinaryName: "com/example/ntsdemo/MainActivity",
    label: "NTS Demo",
    minSdk: NDK_API,
    targetSdk: 36,
    abi: "x86_64",
  },
  target: {
    triple: `x86_64-linux-android${NDK_API}`,
    executionPlatform: "x86_64-linux",
  },
  sdk: {
    vendor: "google",
    name: "android",
    version: `${NDK_API}`,
    deploymentTarget: `${NDK_API}`,
  },
} as const;

test(
  "a TypeScript Android application packages into an installable APK",
  { skip, timeout: 600_000 },
  async () => {
    execFileSync(pnpm, [
      "--dir",
      scriptcRoot,
      "--filter",
      "@scriptc/compiler",
      "build",
    ]);
    assert.equal(existsSync(scriptCCompilerDistribution()), true);

    const scratch = mkdtempSync(join(tmpdir(), "nts-android-app-"));
    try {
      const keystore = join(scratch, "debug.jks");
      execFileSync(join(javaHome!, "bin/keytool"), [
        "-genkeypair",
        "-keystore", keystore,
        "-storepass", "android",
        "-keypass", "android",
        "-alias", "nts",
        "-keyalg", "RSA",
        "-keysize", "2048",
        "-validity", "10000",
        "-dname", "CN=native-typescript debug",
      ], { stdio: ["ignore", "pipe", "pipe"] });

      const built = await buildAndroidApk({
        projectRoot: fixtureRoot,
        project: androidProject,
        scratch: join(scratch, "build"),
        backend: "c",
        javaHome: javaHome!,
        androidJarPath: sdk!.androidJar,
        keystore: { path: keystore, alias: "nts", password: "android" },
        tools: {
          clang: ndk!.clang,
          node: process.execPath,
          sandbox: executable("bwrap"),
          ar: ndk!.ar,
          aapt2: sdk!.aapt2,
          d8: sdk!.d8,
          zipalign: sdk!.zipalign,
          apksigner: sdk!.apksigner,
        },
      });
      assert.ok(existsSync(built.apkPath));

      /* The package's own account of itself, read back with the platform's
       * tool rather than from what the build believed it wrote. */
      const badging = execFileSync(sdk!.aapt2, ["dump", "badging", built.apkPath], {
        encoding: "utf8",
      });
      assert.match(badging, /package: name='com\.example\.ntsdemo'/u);
      assert.match(
        badging,
        /launchable-activity: name='com\.example\.ntsdemo\.MainActivity'/u,
      );
      assert.match(badging, /native-code: 'x86_64'/u);

      /* Signed, and aligned the way a mapped library requires. */
      execFileSync(sdk!.apksigner, ["verify", built.apkPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      execFileSync(sdk!.zipalign, ["-c", "-P", "16", "4", built.apkPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      /* The dex carries the generated Activity, and the library entry is
       * the one this build produced. */
      /* The library inside the package is the one this build produced,
       * and it is STORED so the loader can map it — the other half of the
       * manifest's extractNativeLibs declaration. */
      assert.match(badging, /native-code: 'x86_64'/u);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
