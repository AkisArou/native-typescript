import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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

/**
 * One attached emulator, and two gates that both want it.
 *
 * This lane installs, launches, rotates and uninstalls ONE package, and
 * it writes global device state — `logcat -c` clears the buffer, and
 * `user_rotation` is a system setting. Two runs overlapping do not fail
 * gracefully: one uninstalls the package the other has launched, and the
 * loser reads as a code defect in whatever it was about to commit. That
 * is the expensive failure, because it points away from the collision.
 *
 * A unique applicationId per run would serialise nothing, but it would
 * move a value that appears in the generated manifest, the generated Java
 * package, the dex, and the log tag asserted on below — so the lane's own
 * evidence would become per-run and a failure could not be reproduced by
 * hand. One canonical package and an exclusive lock keeps the artifact a
 * person can install and poke at.
 *
 * `flock` rather than a lock FILE this test manages: the kernel releases
 * on process death, so there is no stale-lock path to get subtly wrong
 * and no pid-reuse race to reason about. The holder is a subprocess
 * parked on stdin; closing that pipe — deliberately, or by this process
 * dying — ends it and drops the lock.
 */
const DEVICE_LOCK = "/tmp/native-typescript-android-device.lock";

/** Seconds to wait for the other run's device section, which takes about
 * two minutes. Generous enough that skipping is rare, bounded enough that
 * the test's own timeout is never what fails. */
const DEVICE_LOCK_WAIT = 420;

interface DeviceClaim {
  readonly release: () => void;
}

/** The lock, or null when another run still holds it. */
async function claimDevice(): Promise<DeviceClaim | null> {
  const holder = spawn(
    "flock",
    [
      "-w",
      String(DEVICE_LOCK_WAIT),
      DEVICE_LOCK,
      "-c",
      /* Announce the acquisition, then hold it by blocking on stdin.
       * `exec` replaces the shell so nothing is left between this
       * process's pipe and the lock. */
      "echo held; exec cat",
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  return await new Promise<DeviceClaim | null>((resolve, reject) => {
    let announced = "";
    holder.stdout.on("data", (chunk: Buffer) => {
      announced += chunk.toString("utf8");
      if (!announced.includes("held")) return;
      resolve({
        release: () => {
          holder.stdin.end();
          holder.kill();
        },
      });
    });
    /* flock exits non-zero when the wait expires; any other exit before
     * the announcement means it never ran, which is a host problem rather
     * than contention and must not read as "busy". */
    holder.on("exit", (code) => {
      if (announced.includes("held")) return;
      if (code === 1) resolve(null);
      else reject(new Error(`flock exited ${String(code)} without the lock`));
    });
    holder.on("error", reject);
  });
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
  { skip, timeout: 1_200_000 },
  async (t) => {
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
    let claim: DeviceClaim | null = null;
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

      /* Claimed HERE rather than at the top: everything above builds the
       * compiler and the APK and touches no device, so holding the lock
       * through it would block a sibling run for two minutes of work it
       * could have been doing. Everything below mutates the device. */
      claim = await claimDevice();
      if (claim === null) {
        /* A different sentence from "no attached Android device" on
         * purpose. Both are legitimate reasons not to run, and a skip
         * that names which input was missing is the only kind worth
         * reading. */
        t.skip(
          "another run holds the emulator: this lane takes an exclusive " +
            `lock on ${DEVICE_LOCK} and waited ${DEVICE_LOCK_WAIT}s for it`,
        );
        return;
      }

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

      /* What the platform BUILT, not what the program said it built. The
       * log line proves the handler ran; the view hierarchy proves the
       * handler's work reached the screen — a TextView the program
       * constructed with the receiver as its Context, carrying text that
       * crossed as a string into a CharSequence position. */
      run("shell", "uiautomator", "dump", "/sdcard/nts-ui.xml");
      const hierarchy = run("shell", "cat", "/sdcard/nts-ui.xml");
      assert.match(
        hierarchy,
        /class="android\.widget\.TextView"[^>]*package="com\.example\.ntsdemo"/u,
        "the application's own TextView is in the hierarchy",
      );
      assert.match(
        hierarchy,
        /text="Compiled TypeScript, fresh on Android"/u,
        "the text the program set is the text the platform holds",
      );

      /* INTERACTION: the platform calls a TypeScript handler through a
       * generated class implementing its listener INTERFACE, and the
       * handler's effect comes back through the platform. The tap count
       * lives in an ordinary closure, so a label reading "Tapped 1 time"
       * is TypeScript state surviving a platform callback — which no
       * amount of inspecting the package could have shown.
       *
       * The button is located from the hierarchy rather than by a
       * remembered coordinate, because its position moves when the label
       * above it changes size — which is how the first run of this lane
       * lost three taps out of four. */
      const button = /class="android\.widget\.Button"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/u
        .exec(hierarchy);
      assert.ok(button !== null, "the application's Button is in the hierarchy");
      const [left, top, right, bottom] = button!.slice(1).map(Number) as
        [number, number, number, number];
      run(
        "shell",
        "input",
        "tap",
        `${Math.round((left + right) / 2)}`,
        `${Math.round((top + bottom) / 2)}`,
      );
      const tapped = awaitLogLine(run, /tap 1/u);
      assert.match(tapped, /tap 1/u, "the click reached the TypeScript handler");
      run("shell", "uiautomator", "dump", "/sdcard/nts-ui.xml");
      assert.match(
        run("shell", "cat", "/sdcard/nts-ui.xml"),
        /text="Tapped 1 time"/u,
        "the handler's closure state reached the platform",
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
        run("shell", "rm", "-f", "/sdcard/nts-ui.xml");
        run("shell", "settings", "put", "system", "user_rotation", "0");
        run("uninstall", androidProject.android.applicationId);
      } catch {
        /* Teardown is best-effort: the assertions above are the verdict. */
      }
      /* After the device teardown, so the next run never observes the
       * rotation or the install this one was still undoing. */
      claim?.release();
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
  /* A timeout on this lane used to say only that no line arrived, which
   * names the symptom and nothing else — the interesting cases (a Java
   * exception before the handler, a link failure at load, a refused
   * registration) all report through channels this filter excludes. So
   * the failure carries what the DEVICE said: the crash buffer, plus the
   * process's own lines. Without this a runtime failure and a
   * never-registered handler are the same message. */
  let context = "";
  try {
    const crash = run("logcat", "-d", "-b", "crash", "-t", "40");
    const own = run("logcat", "-d", "-t", "200").split("\n")
      .filter((entry) => /ntsdemo|native-typescript|AndroidRuntime|DEBUG/u.test(entry))
      .slice(-40)
      .join("\n");
    context = `\n--- crash buffer ---\n${crash}\n--- process lines ---\n${own}`;
  } catch {
    /* Best effort: the assertion below is the verdict either way. */
  }
  throw new Error(
    `no ${LOG_TAG} line matching ${pattern} within 60s${context}`,
  );
}
