import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  defineArtifactGraph,
  digestArtifactPath,
  executeArtifactGraph,
  planCObjectCompilation,
  resolvePkgConfigCompileSdk,
} from "@native-typescript/core";
import type {
  ArtifactActionArgument,
  ArtifactActionDefinition,
  ArtifactDefinition,
} from "@native-typescript/core";
import { parseScabiManifest } from "@native-typescript/scabi";
import { translateScabiNativeProgram } from "@native-typescript/scriptc";
import {
  glibRuntimeArtifactIds,
  planGlibRuntimeObject,
} from "@native-typescript/target-gtk";

const workspace = join(import.meta.dirname, "..");
const scriptcRoot = join(workspace, "third_party/scriptc");
const fixtureRoot = join(workspace, "fixtures/gtk-counter");
const targetRoot = join(workspace, "packages/target-gtk");
const runtimeInclude = join(scriptcRoot, "packages/runtime/src");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const nativeTarget = "x86_64-unknown-linux-gnu";
const executionPlatform = "x86_64-linux";
const hasGtk = spawnSync("pkg-config", ["--exists", "gtk4"]).status === 0;
const hasXvfb = spawnSync("xvfb-run", ["--help"]).status === 0;

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function executable(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching explicit PATH entries.
    }
  }
  throw new Error(`Required executable is unavailable: ${name}`);
}

async function sourceArtifact(options: {
  readonly id: string;
  readonly path: string;
  readonly fileName: string;
  readonly logicalPath: string;
}): Promise<ArtifactDefinition> {
  const content = await digestArtifactPath(options.path, "directory");
  return {
    id: options.id,
    kind: "source-tree",
    entryType: "directory",
    mediaType: "inode/directory",
    target: nativeTarget,
    domain: "target",
    cache: "exportable",
    origin: {
      kind: "source",
      digest: content.digest,
      fileName: options.fileName,
      logicalPath: options.logicalPath,
    },
  };
}

function literalArguments(values: readonly string[]): readonly ArtifactActionArgument[] {
  return values.map((value) => ({ kind: "literal", value }));
}

test(
  "compiled TypeScript drives a real GTK window through the attached loop",
  {
    skip:
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      !hasGtk ||
      !hasXvfb,
  },
  async () => {
    const manifest = parseScabiManifest(
      readFileSync(join(fixtureRoot, "package.scabi.json"), "utf8"),
    );
    assert.equal(
      manifest.declarations.digest,
      sha256(join(fixtureRoot, "package.d.ts")),
    );
    assert.equal(
      manifest.sdk.metadataDigest,
      sha256(join(fixtureRoot, "include/nts_gtk_counter.h")),
    );

    const translated = translateScabiNativeProgram(manifest, {
      imports: [
        "runtime_start",
        "counter_create",
        "counter_schedule_click",
        "counter_destroy",
        "quit",
        "complete",
      ],
      exports: [],
    });
    assert.equal(
      translated.ok,
      true,
      translated.ok
        ? undefined
        : translated.diagnostics
            .map(({ code, path, message }) => `${code} ${path}: ${message}`)
            .join("\n"),
    );
    if (!translated.ok) return;

    assert.deepEqual(
      translated.linkInputIds,
      manifest.linkInputs.map(({ id }) => id).sort(),
    );

    const scratch = mkdtempSync(join(tmpdir(), "nts-gtk-app-"));
    try {
      const clangPath = executable("clang");
      const pkgConfigPath = executable("pkg-config");
      const sandboxPath = executable("bwrap");
      const clangProbe = spawnSync(clangPath, ["--version"], { encoding: "utf8" });
      assert.equal(clangProbe.status, 0, clangProbe.stderr);
      const clangVersion = /clang version ([^\s]+)/u.exec(clangProbe.stdout)?.[1];
      assert.ok(clangVersion);
      const clangContent = await digestArtifactPath(clangPath, "file");
      const clangTool: ArtifactActionDefinition["tool"] = {
        id: "tool/clang",
        version: clangVersion,
        digest: clangContent.digest,
      };
      const gtkSdk = await resolvePkgConfigCompileSdk({
        id: "gtk4",
        executable: pkgConfigPath,
        modules: ["gtk4"],
        target: nativeTarget,
      });
      assert.equal(gtkSdk.modules[0]?.name, "gtk4");

      const runtimeHeadersPath = join(targetRoot, "runtime");
      const fixtureTreePath = fixtureRoot;
      const localArtifacts = await Promise.all([
        sourceArtifact({
          id: "source/fixture/gtk-counter",
          path: fixtureTreePath,
          fileName: "gtk-counter",
          logicalPath: "fixtures/gtk-counter",
        }),
        sourceArtifact({
          id: "headers/scriptc/runtime",
          path: runtimeInclude,
          fileName: "scriptc-runtime",
          logicalPath: "third_party/scriptc/packages/runtime/src",
        }),
      ]);
      const baseArguments: readonly ArtifactActionArgument[] = [
        ...literalArguments([
          "-std=c11",
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-pedantic",
        ]),
        ...gtkSdk.arguments,
      ];
      const runtimeTreeContent = await digestArtifactPath(
        runtimeHeadersPath,
        "directory",
      );
      const runtimeObject = planGlibRuntimeObject({
        sourceTreeDigest: runtimeTreeContent.digest,
        scriptcRuntimeHeaders: { artifact: "headers/scriptc/runtime" },
        arguments: baseArguments,
        tool: clangTool,
        executionPlatform,
        target: nativeTarget,
      });
      const counterArguments: readonly ArtifactActionArgument[] = [
        ...baseArguments,
        { kind: "literal", value: "-I" },
        {
          kind: "input-path",
          artifact: "source/fixture/gtk-counter",
          path: "include",
        },
        { kind: "literal", value: "-I" },
        {
          kind: "input-path",
          artifact: glibRuntimeArtifactIds.sourceTree,
        },
        { kind: "literal", value: "-I" },
        { kind: "input-path", artifact: "headers/scriptc/runtime" },
      ];
      const counterObject = planCObjectCompilation({
        actionId: "compile/fixture/gtk-counter",
        artifactId: "object/fixture/gtk-counter",
        artifactFileName: "nts_gtk_counter.o",
        source: {
          artifact: "source/fixture/gtk-counter",
          path: "src/nts_gtk_counter.c",
        },
        arguments: counterArguments,
        tool: clangTool,
        executionPlatform,
        target: nativeTarget,
        deterministic: false,
        cacheable: false,
      });
      const graph = defineArtifactGraph({
        artifacts: [
          ...gtkSdk.artifacts,
          ...localArtifacts,
          runtimeObject.sourceTree,
          runtimeObject.object,
          counterObject.artifact,
        ],
        actions: [runtimeObject.action, counterObject.action],
      });
      const serializedGraph = JSON.stringify(graph);
      for (const physicalPath of Object.values(gtkSdk.sourcePaths)) {
        assert.equal(serializedGraph.includes(physicalPath), false);
      }
      const objectReport = await executeArtifactGraph(graph, {
        buildRoot: join(scratch, "native-objects"),
        sourcePaths: {
          ...gtkSdk.sourcePaths,
          [glibRuntimeArtifactIds.sourceTree]: runtimeHeadersPath,
          "source/fixture/gtk-counter": fixtureTreePath,
          "headers/scriptc/runtime": runtimeInclude,
        },
        tools: { "tool/clang": { path: clangPath } },
        sandbox: { kind: "bubblewrap", path: sandboxPath },
        maxConcurrency: 2,
      });
      const objects = [
        objectReport.artifacts.find(({ id }) => id === runtimeObject.object.id)?.path,
        objectReport.artifacts.find(({ id }) => id === counterObject.artifact.id)?.path,
      ];
      assert.equal(objects.every((path) => path !== undefined), true);

      const systemLibraries = manifest.linkInputs
        .filter(({ kind }) => kind === "system-library")
        .sort((left, right) => left.order - right.order)
        .map(({ name }) => name);
      execFileSync(
        pnpm,
        ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"],
      );
      const { compile } = await import(
        "../third_party/scriptc/packages/compiler/dist/index.js"
      );
      for (const backend of ["c", "llvm"] as const) {
        const outDir = join(scratch, backend);
        const result = await compile(join(fixtureRoot, "app.ts"), {
          outDir,
          outPath: join(outDir, "gtk-counter"),
          backend,
          emitIr: true,
          externalTypes: {
            [manifest.package.name]: join(fixtureRoot, "package.d.ts"),
          },
          native: translated.input,
          nativeLinkInputs: objects as string[],
          nativeSystemLibraries: systemLibraries,
        });
        assert.equal(
          result.ok,
          true,
          result.ok
            ? undefined
            : result.diagnostics
                .map((diagnostic) => diagnostic.message)
                .join("\n"),
        );
        if (!result.ok) continue;

        const run = spawnSync(
          "xvfb-run",
          [
            "-a",
            "--server-args=-screen 0 1024x768x24",
            result.binaryPath,
          ],
          {
            env: {
              ...process.env,
              GDK_BACKEND: "x11",
              GDK_DISABLE: "gl,vulkan",
              GSETTINGS_BACKEND: "memory",
              GSK_RENDERER: "cairo",
              NO_AT_BRIDGE: "1",
            },
            encoding: "utf8",
          },
        );
        assert.deepEqual(
          {
            status: run.status,
            signal: run.signal,
            stdout: run.stdout,
            stderr: run.stderr,
          },
          { status: 0, signal: null, stdout: "", stderr: "" },
          backend,
        );
      }
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  },
);
