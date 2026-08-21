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
import { androidProject } from "./support/android-project.ts";

/**
 * The last question the crossing can ask: does it RUN.
 *
 * Everything before this proves the artifact — that a package exists,
 * says the right things, and carries the right bytes. None of it can say
 * whether ART loads the library, whether JNI_OnLoad adopts the thread the
 * platform dispatches on, or whether a class-anchored registration
 * answers for an instance TypeScript never named. Only a device can, and
 * the verdict comes back through android.util.Log because that is the
 * channel an Android process actually has.
 *
 * BOTH PAYLOAD ARMS ARE TAKEN, deliberately. A cold start hands onCreate
 * a null savedInstanceState; a configuration change recreates the
 * Activity and hands it the state the framework saved. A run that only
 * ever cold-started would leave the present arm untaken on the device
 * even though the desktop covers it, and "covered somewhere else" is not
 * covered here.
 *
 * The lane uses a device that is ALREADY attached and authorized rather
 * than booting one: an emulator image that enforces `ro.adb.secure`
 * requires its debugging dialog to be accepted once, which is a person's
 * decision about their machine and not something a test may fake. It
 * skips by name when no such device is there, like every other lane here
 * whose capability the host may not have.
 */
const LOG_TAG = "native-typescript";

function adbPath(): string | null {
  for (const sdkRoot of [
    process.env["ANDROID_SDK_ROOT"],
    process.env["ANDROID_HOME"],
    join(homedir(), "Android/Sdk"),
  ]) {
    if (sdkRoot === undefined || sdkRoot.length === 0) continue;
    const adb = join(sdkRoot, "platform-tools/adb");
    if (existsSync(adb)) return adb;
  }
  return null;
}

const adb = adbPath();

/** An attached device that will accept commands, or the reason none is. */
function readyDevice(): { serial: string } | string {
  if (adb === null) return "no adb in any Android SDK root";
  const listed = spawnSync(adb, ["devices"], { encoding: "utf8" });
  if (listed.status !== 0) return "adb devices failed";
  const rows = listed.stdout.split("\n").slice(1).map((row) => row.trim());
  const ready = rows.find((row) => row.endsWith("\tdevice"));
  if (ready !== undefined) return { serial: ready.split("\t")[0]! };
  const unauthorized = rows.find((row) => row.endsWith("\tunauthorized"));
  if (unauthorized !== undefined) {
    return "an attached device is unauthorized: accept its USB-debugging " +
      "dialog once (a Play Store image enforces it, and a headless boot " +
      "cannot present it)";
  }
  return "no attached Android device";
}

function findNdk(): { clang: string; ar: string } | null {
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
      const clang = join(bin, "x86_64-linux-android35-clang");
      if (existsSync(clang)) return { clang, ar: join(bin, "llvm-ar") };
    }
  }
  return null;
}

function findBuildTools(): {
  aapt2: string;
  d8: string;
  zipalign: string;
  apksigner: string;
  androidJar: string;
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
const device = readyDevice();

const skip =
  process.platform !== "linux" || process.arch !== "x64"
    ? "the Android device lane builds from x86_64 Linux"
    : javaHome === null
      ? "no JDK with include/jni.h on this host"
      : ndk === null
        ? "no Android NDK toolchain"
        : sdk === null
          ? "no Android SDK build-tools with a platform jar"
          : typeof device === "string"
            ? device
            : false;

test(
  "the application runs on a device and reports through the platform's log",
  { skip, timeout: 900_000 },
  async () => {
    const serial = (device as { serial: string }).serial;
    const run = (...args: readonly string[]): string =>
      execFileSync(adb!, ["-s", serial, ...args], {
        encoding: "utf8",
        timeout: 120_000,
      });

    execFileSync(pnpm, [
      "--dir",
      scriptcRoot,
      "--filter",
      "@scriptc/compiler",
      "build",
    ]);
    assert.equal(existsSync(scriptCCompilerDistribution()), true);

    const scratch = mkdtempSync(join(tmpdir(), "nts-android-device-"));
    try {
      const keystore = join(scratch, "debug.jks");
      execFileSync(join(javaHome!, "bin/keytool"), [
        "-genkeypair", "-keystore", keystore,
        "-storepass", "android", "-keypass", "android",
        "-alias", "nts", "-keyalg", "RSA", "-keysize", "2048",
        "-validity", "10000", "-dname", "CN=native-typescript debug",
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

      const applicationId = androidProject.android.applicationId;
      const activity = androidProject.android.activityBinaryName
        .replace(/\//gu, ".");
      /* Uninstall first: a stale install from an earlier run would make a
       * passing log line say nothing about this build. */
      try {
        run("uninstall", applicationId);
      } catch {
        /* Not installed, which is the ordinary case. */
      }
      run("install", "-r", built.apkPath);
      run("logcat", "-c");

      /* COLD START: the framework has nothing saved, so onCreate is
       * handed the withheld arm. */
      run("shell", "am", "start", "-W", "-n", `${applicationId}/${activity}`);
      const cold = awaitLogLine(run, /onCreate ran (fresh|restored)/u);
      assert.match(
        cold,
        /onCreate ran fresh in MainActivity/u,
        "a cold start delivers no saved state",
      );

      /* RESTORE: a configuration change recreates the Activity, and the
       * framework hands back the state it saved — the present arm, which
       * a cold start alone would never take. */
      run("logcat", "-c");
      run("shell", "settings", "put", "system", "accelerometer_rotation", "0");
      run("shell", "settings", "put", "system", "user_rotation", "1");
      const restored = awaitLogLine(run, /onCreate ran (fresh|restored)/u);
      assert.match(
        restored,
        /onCreate ran restored in MainActivity/u,
        "a recreated Activity is handed the state the framework saved",
      );
    } finally {
      try {
        run("shell", "settings", "put", "system", "user_rotation", "0");
        run("uninstall", androidProject.android.applicationId);
      } catch {
        /* Teardown is best-effort: the assertions above are the verdict. */
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

/** Polls logcat for the tag's next line, so the test waits on the DEVICE
 * rather than on a sleep long enough to hide a slow dispatch. */
function awaitLogLine(
  run: (...args: readonly string[]) => string,
  pattern: RegExp,
): string {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const dumped = run("logcat", "-d", "-s", LOG_TAG);
    const line = dumped.split("\n").find((candidate) => pattern.test(candidate));
    if (line !== undefined) return line;
    execFileSync("sleep", ["1"]);
  }
  throw new Error(`no ${LOG_TAG} line matching ${pattern} within 60s`);
}
