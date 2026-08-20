import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const skip =
  process.platform !== "linux" || process.arch !== "x64"
    ? "the JVM application lane targets x86_64 Linux"
    : javaHome === null
      ? "no JDK with include/jni.h on this host"
      : !hasClang
        ? "clang is unavailable"
        : !hasBubblewrap
          ? "bwrap is unavailable"
          : false;

test(
  "compiled TypeScript drives a live JVM through both backends with no hand-written C",
  { skip },
  async () => {
    /* Everything this executable calls is either generated from class-file
     * metadata or shipped by the target: the app constructs a Java object,
     * dispatches instance and static methods, crosses strings both ways,
     * and reports through the runtime's exit-code note. The build is the
     * product's own pipeline, including the Clang ABI probe against the
     * real jni.h. */
    execFileSync(pnpm, [
      "--dir",
      scriptcRoot,
      "--filter",
      "@scriptc/compiler",
      "build",
    ]);
    assert.equal(existsSync(scriptCCompilerDistribution()), true);

    const project = {
      name: "jvm-app",
      entry: "app.ts",
      output: "jvm-app",
      packageSlug: "fixture",
      /* Milestone 3: the classes are not committed inputs but the output of
       * a planned javac action inside this very build. */
      javaSources: {
        root: join(workspace, "fixtures/jvm/src"),
        logicalPath: "fixtures/jvm/src",
        files: ["fixture/Widget.java"],
      },
      classes: [
        {
          binaryName: "fixture/Widget",
          constructors: ["(I)V"],
          methods: [
            "depth",
            "checkedAdd",
            "resized",
            "compareDepth",
            "label",
            "greet",
            { name: "resize", descriptor: "(II)V" },
            { name: "resize", descriptor: "(D)V" },
          ],
        },
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

    const scratch = mkdtempSync(join(tmpdir(), "nts-jvm-application-"));
    try {
      for (const backend of ["c", "llvm"] as const) {
        const built = await buildJvmApplication({
          projectRoot: fixtureRoot,
          project,
          scratch: join(scratch, backend),
          backend,
          javaHome: javaHome!,
          tools: {
            clang: executable("clang"),
            node: process.execPath,
            sandbox: executable("bwrap"),
          },
        });

        // The surface the application imports is generated, not hand-written.
        const declarations = readFileSync(
          join(built.generatedPackagePath, "package.d.ts"),
          "utf8",
        );
        assert.match(declarations, /export declare class Widget \{/u);
        assert.match(declarations, /static greet\(a0: string \| null\): string \| null;/u);

        assert.ok(built.builtClassesPath !== undefined);
        const run = spawnSync(built.productPath, [], {
          encoding: "utf8",
          env: {
            ...process.env,
            NT_JVM_CLASSPATH: built.builtClassesPath,
            LD_LIBRARY_PATH: built.jvmLibraryPath,
          },
          timeout: 120_000,
        });
        assert.equal(
          run.status,
          0,
          `backend ${backend}: status ${run.status}\n${run.stdout}\n${run.stderr}`,
        );
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
