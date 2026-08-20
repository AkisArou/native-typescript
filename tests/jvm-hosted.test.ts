import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildJvmApplication,
  discoverJavaHome,
} from "@native-typescript/target-jvm";
import { scriptCCompilerDistribution } from "@native-typescript/scriptc";
import { executable } from "./support/artifacts.ts";

const workspace = join(import.meta.dirname, "..");
const scriptcRoot = join(workspace, "third_party/scriptc");
const fixtureRoot = join(workspace, "fixtures/jvm-app");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const javaHome = discoverJavaHome();
const hasClang = spawnSync("clang", ["--version"]).status === 0;
const hasBubblewrap = spawnSync("bwrap", ["--version"]).status === 0;
const hasAr = spawnSync("ar", ["--version"]).status === 0;

const skip =
  process.platform !== "linux" || process.arch !== "x64"
    ? "the JVM hosted lane targets x86_64 Linux"
    : javaHome === null
      ? "no JDK with include/jni.h on this host"
      : !hasClang
        ? "clang is unavailable"
        : !hasBubblewrap
          ? "bwrap is unavailable"
          : !hasAr
            ? "ar is unavailable"
            : false;

const hostedProject = {
  name: "jvm-hosted",
  entry: "hosted.ts",
  output: "jvmhosted",
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
  subclasses: [
    { baseBinaryName: "fixture/Host", overrides: ["onEvent"] },
  ],
  target: {
    triple: "x86_64-unknown-linux-gnu",
    executionPlatform: "x86_64-linux",
  },
  sdk: {
    vendor: "openjdk",
    name: "jdk",
    version: "21",
    deploymentTarget: "21",
  },
} as const;

test(
  "a JVM the runtime did not create loads compiled TypeScript and adopts it",
  { skip },
  async () => {
    /* The inversion completed: instead of compiled TypeScript creating a
     * JVM, a plain Java program loads the compiled library, JNI_OnLoad
     * adopts the VM, the owner thread boots the instance per the library
     * contract (the calling thread IS the instance selector), and the
     * program's verdict ends the HOST process — including a generated
     * subclass answering the base's virtual dispatch from inside a process
     * TypeScript did not start. */
    execFileSync(pnpm, [
      "--dir",
      scriptcRoot,
      "--filter",
      "@scriptc/compiler",
      "build",
    ]);
    assert.equal(existsSync(scriptCCompilerDistribution()), true);

    const project = hostedProject;

    const scratch = mkdtempSync(join(tmpdir(), "nts-jvm-hosted-"));
    try {
      const built = await buildJvmApplication({
        projectRoot: fixtureRoot,
        project,
        scratch: join(scratch, "c"),
        backend: "c",
        product: "hosted-library",
        javaHome: javaHome!,
        tools: {
          clang: executable("clang"),
          node: process.execPath,
          sandbox: executable("bwrap"),
          ar: executable("ar"),
        },
      });
      assert.ok(built.productPath.endsWith("libjvmhosted.so"));
      /* The executor names outputs with a digest prefix; System.loadLibrary
       * wants the exact soname, so the runner prepares its library
       * directory the way any deployment would. */
      const libraryDirectory = join(scratch, "lib");
      mkdirSync(libraryDirectory, { recursive: true });
      copyFileSync(built.productPath, join(libraryDirectory, "libjvmhosted.so"));

      const hostClasses = join(scratch, "host-classes");
      execFileSync(join(javaHome!, "bin/javac"), [
        "-d",
        hostClasses,
        join(fixtureRoot, "host/HostMain.java"),
      ]);
      const run = spawnSync(
        join(javaHome!, "bin/java"),
        [
          "-cp",
          [
            hostClasses,
            built.builtClassesPath,
            built.builtSubclassesPath,
          ].join(":"),
          `-Djava.library.path=${libraryDirectory}`,
          "HostMain",
        ],
        { encoding: "utf8", timeout: 120_000 },
      );
      assert.equal(
        run.status,
        0,
        `hosted: status ${run.status}\n${run.stdout}\n${run.stderr}`,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test(
  "a hosted library reaching the timers surface refuses by name",
  { skip },
  async () => {
    /* The trigger program, committed BEFORE its arm: a hosted verdict
     * riding a setTimeout. Library emission requires an async_free
     * module graph today, so the refusal is the COMPILER's and the park
     * never sees a timer it would strand; this pin is what notices the
     * refusal lifting, at which point hosted-timers.ts goes live and
     * the park must become the loop (the recipe is written at the park). */
    const scratch = mkdtempSync(join(tmpdir(), "nts-jvm-hosted-timers-"));
    try {
      await assert.rejects(
        buildJvmApplication({
          projectRoot: fixtureRoot,
          project: {
            ...hostedProject,
            name: "jvm-hosted-timers",
            entry: "hosted-timers.ts",
            output: "jvmhostedtimers",
          },
          scratch: join(scratch, "c"),
          backend: "c",
          product: "hosted-library",
          javaHome: javaHome!,
          tools: {
            clang: executable("clang"),
            node: process.execPath,
            sandbox: executable("bwrap"),
            ar: executable("ar"),
          },
        }),
        /async_free module graph.*timers surface \(setTimeout family\)/u,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
