import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildJvmApplication, discoverJavaHome } from "@native-typescript/target-jvm";
import { scriptCCompilerDistribution } from "@native-typescript/scriptc";
import { executable } from "./support/artifacts.ts";

/**
 * The Android crossing's first slice: the SAME hosted product the desktop
 * lane proves, cross-compiled for an Android triple through the product's
 * own pipeline — planners, ABI probe against the NDK sysroot's real jni.h,
 * emission, archive, and the .so link. The desktop hosted lane is this
 * lane's control: one program, two triples, and every difference between
 * the two builds is a platform fact this lane pins.
 *
 * Nothing here runs the .so — that is the emulator lane's job, a later
 * slice. What IS asserted is every load-bearing property the link can
 * state: the ELF is x86-64 DYN; JNI_OnLoad is exported for ART to find;
 * LOAD segments align at 16KB, because this machine's only system image
 * has 16K pages and its loader refuses 4K alignment; no ucontext function
 * is imported, because bionic ships none (the fiber machinery a library
 * can never reach must not leak into its imports); no JNI_CreateJavaVM is
 * imported, because bionic resolves eagerly at load and Android is
 * adoption-only; and no libjvm is NEEDED, because none exists there.
 */
const NDK_API = 35;

function findNdk(): {
  readonly clang: string;
  readonly ar: string;
  readonly readelf: string;
} | null {
  const explicit = process.env["ANDROID_NDK_ROOT"];
  const ndkRoots: string[] = [];
  if (explicit !== undefined && explicit.length > 0) ndkRoots.push(explicit);
  for (const sdkRoot of [
    process.env["ANDROID_SDK_ROOT"],
    process.env["ANDROID_HOME"],
    join(homedir(), "Android/Sdk"),
  ]) {
    if (sdkRoot === undefined || sdkRoot.length === 0) continue;
    const ndkDir = join(sdkRoot, "ndk");
    if (!existsSync(ndkDir)) continue;
    const versions = readdirSync(ndkDir)
      .filter((name) => /^\d+\.\d+\.\d+$/u.test(name))
      .sort((left, right) => {
        const parse = (version: string) => version.split(".").map(Number);
        const [leftParts, rightParts] = [parse(left), parse(right)];
        return (
          rightParts[0]! - leftParts[0]! ||
          rightParts[1]! - leftParts[1]! ||
          rightParts[2]! - leftParts[2]!
        );
      });
    for (const version of versions) ndkRoots.push(join(ndkDir, version));
  }
  for (const root of ndkRoots) {
    const bin = join(root, "toolchains/llvm/prebuilt/linux-x86_64/bin");
    const clang = join(bin, `x86_64-linux-android${NDK_API}-clang`);
    const ar = join(bin, "llvm-ar");
    const readelf = join(bin, "llvm-readelf");
    if (existsSync(clang) && existsSync(ar) && existsSync(readelf)) {
      return { clang, ar, readelf };
    }
  }
  return null;
}

const workspace = join(import.meta.dirname, "..");
const scriptcRoot = join(workspace, "third_party/scriptc");
const fixtureRoot = join(workspace, "fixtures/jvm-app");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const javaHome = discoverJavaHome();
const ndk = findNdk();
const hasBubblewrap = spawnSync("bwrap", ["--version"]).status === 0;

const skip =
  process.platform !== "linux" || process.arch !== "x64"
    ? "the Android build lane cross-compiles from x86_64 Linux"
    : javaHome === null
      ? "no JDK with include/jni.h on this host (javac still comes from it)"
      : ndk === null
        ? `no Android NDK with an x86_64 android${NDK_API} toolchain`
        : !hasBubblewrap
          ? "bwrap is unavailable"
          : false;

/* The desktop hosted project, retargeted: the ONLY differences are the
 * triple, the clang (the NDK wrapper carries the sysroot), the archiver
 * (the NDK's llvm-ar), and the sdk record. Everything else is identical
 * by construction, which is what makes the desktop lane this lane's
 * control. */
const androidProject = {
  name: "jvm-android",
  entry: "hosted.ts",
  output: "jvmandroid",
  packageSlug: "fixture",
  javaSources: {
    root: join(workspace, "fixtures/jvm/src"),
    logicalPath: "fixtures/jvm/src",
    files: ["fixture/Widget.java", "fixture/Host.java"],
  },
  classes: [
    {
      binaryName: "fixture/Widget",
      constructors: ["(I)V"],
      methods: ["depth", "greet"],
    },
    {
      binaryName: "fixture/Host",
      constructors: ["()V"],
      methods: ["run"],
    },
  ],
  subclasses: [{ baseBinaryName: "fixture/Host", overrides: ["onEvent"] }],
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

function readelf(args: readonly string[], path: string): string {
  return execFileSync(ndk!.readelf, [...args, path], { encoding: "utf8" });
}

test(
  "the hosted product cross-compiles for Android through its own pipeline",
  { skip, timeout: 600_000 },
  async (t) => {
    execFileSync(pnpm, ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"]);
    assert.equal(existsSync(scriptCCompilerDistribution()), true);

    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const scratch = mkdtempSync(join(tmpdir(), "nts-jvm-android-"));
    try {
      for (const backend of ["c", "llvm"] as const) {
        const built = await buildJvmApplication({
          projectRoot: fixtureRoot,
          project: androidProject,
          scratch: join(scratch, backend),
          backend,
          product: "hosted-library",
          javaHome: javaHome!,
          tools: {
            clang: ndk!.clang,
            node: process.execPath,
            sandbox: executable("bwrap"),
            ar: ndk!.ar,
          },
        });
        assert.ok(built.productPath.endsWith("libjvmandroid.so"));
        assert.equal(built.jvmLibraryPath, null);

        const header = readelf(["-h"], built.productPath);
        assert.match(header, /Machine:\s+Advanced Micro Devices X86-64/u);
        assert.match(header, /Type:\s+DYN/u);

        /* ART finds the adoption entry by name. */
        const dynamicSymbols = readelf(["--dyn-syms"], built.productPath);
        assert.match(dynamicSymbols, /\bJNI_OnLoad\b/u);
        /* bionic ships no ucontext functions and resolves imports eagerly
         * at load: any of these in the import set means the .so cannot
         * load on the platform it was built for. The first three observe
         * the fiberless library runtime; the last observes the runtime's
         * adoption-only refusal replacing the create path. */
        for (const forbidden of ["getcontext", "makecontext", "swapcontext", "JNI_CreateJavaVM"]) {
          assert.ok(
            !new RegExp(`UND ${forbidden}\\b`, "u").test(dynamicSymbols),
            `backend ${backend}: the Android .so imports ${forbidden}`,
          );
        }

        /* This machine's only system image has 16K pages; a 4K-aligned
         * LOAD segment is refused by its loader, so the alignment is a
         * load-bearing link fact, asserted rather than trusted. */
        const programHeaders = readelf(["-l"], built.productPath);
        const loadAlignments = [
          ...programHeaders.matchAll(/^\s*LOAD\S*\s+.*?(0x[0-9a-f]+)\s*$/gmu),
        ].map(([, align]) => parseInt(align!, 16));
        assert.ok(loadAlignments.length > 0, "no LOAD segments parsed");
        for (const alignment of loadAlignments) {
          assert.ok(
            alignment >= 0x4000,
            `backend ${backend}: LOAD aligned at ${alignment}, below 16KB`,
          );
        }

        /* Math lives in libm on bionic, and a shared link does not pull
         * it in on its own. Every artifact assertion here passed on a
         * build whose .so could not load for want of it — the device is
         * what noticed, and this is the observer that would have. */
        const needed = readelf(["-d"], built.productPath);
        assert.match(needed, /NEEDED.*\[libm\.so\]/u);

        /* No libjvm exists on Android to be NEEDED. */
        assert.ok(!/NEEDED.*libjvm/u.test(needed));
        t.diagnostic(`backend ${backend}: ${built.productPath}`);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test("an Android target refuses the executable product by name", { skip }, async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const scratch = mkdtempSync(join(tmpdir(), "nts-jvm-android-refuse-"));
  try {
    await assert.rejects(
      buildJvmApplication({
        projectRoot: fixtureRoot,
        project: androidProject,
        scratch,
        backend: "c",
        javaHome: javaHome!,
        tools: {
          clang: ndk!.clang,
          node: process.execPath,
          sandbox: executable("bwrap"),
          ar: ndk!.ar,
        },
      }),
      /has no executable product: Android has no libjvm to create/u,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
