import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  defineArtifactGraph,
  digestArtifactPath,
  executeArtifactGraph,
  planCObjectCompilation,
  planScriptCExecutable,
  resolvePkgConfigSdk,
} from "@native-typescript/core";
import type {
  ArtifactActionArgument,
  ArtifactActionDefinition,
  ArtifactDefinition,
} from "@native-typescript/core";
import {
  parseClangFunctionEvidence,
  planClangFunctionProbe,
} from "@native-typescript/bindgen-c";
import { parseScabiManifest } from "@native-typescript/scabi";
import {
  composeScriptCNativePrograms,
  translateScabiNativeProgram,
} from "@native-typescript/scriptc";
import {
  generateGObjectAdapterSource,
  generateGirClangFunctionProbe,
  generateGtkScabiPackage,
  glibRuntimeArtifactIds,
  ingestGir,
  planGlibRuntimeObject,
  planGObjectAdapterObject,
} from "@native-typescript/target-gtk";

const workspace = join(import.meta.dirname, "..");
const scriptcRoot = join(workspace, "third_party/scriptc");
const fixtureRoot = join(workspace, "fixtures/gtk-counter");
const targetRoot = join(workspace, "packages/target-gtk");
const scriptcRuntimeRoot = join(scriptcRoot, "packages/runtime");
const scriptcRuntimeInclude = join(scriptcRuntimeRoot, "src");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const systemGtkGir = "/usr/share/gir-1.0/Gtk-4.0.gir";
const nativeTarget = "x86_64-unknown-linux-gnu";
const executionPlatform = "x86_64-linux";
const hasGtk = spawnSync("pkg-config", ["--exists", "gtk4"]).status === 0;
const hasXvfb = spawnSync("xvfb-run", ["--help"]).status === 0;
const hasClang = spawnSync("clang", ["--version"]).status === 0;
const hasBubblewrap = spawnSync("bwrap", ["--version"]).status === 0;

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

async function generatedSourceArtifact(options: {
  readonly id: string;
  readonly path: string;
  readonly fileName: string;
  readonly logicalPath: string;
  readonly mediaType: string;
}): Promise<ArtifactDefinition> {
  const content = await digestArtifactPath(options.path, "file");
  return {
    id: options.id,
    kind: "generated-source",
    entryType: "file",
    mediaType: options.mediaType,
    target: nativeTarget,
    domain: "target",
    cache: "none",
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
  "compiled TypeScript delivers a generated GTK signal through a real window loop",
  {
    skip:
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      !existsSync(systemGtkGir) ||
      !hasGtk ||
      !hasXvfb ||
      !hasClang ||
      !hasBubblewrap,
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

    const runtimeTranslated = translateScabiNativeProgram(manifest, {
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
      runtimeTranslated.ok,
      true,
      runtimeTranslated.ok
        ? undefined
        : runtimeTranslated.diagnostics
            .map(({ code, path, message }) => `${code} ${path}: ${message}`)
            .join("\n"),
    );
    if (!runtimeTranslated.ok) return;

    assert.deepEqual(
      runtimeTranslated.build.linkInputs,
      manifest.linkInputs,
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
      const gtkSdk = await resolvePkgConfigSdk({
        id: "gtk4",
        executable: pkgConfigPath,
        modules: ["gtk4"],
        target: nativeTarget,
      });
      assert.equal(gtkSdk.modules[0]?.name, "gtk4");

      const gtkSnapshot = ingestGir(readFileSync(systemGtkGir, "utf8"), {
        logicalPath: "system-sdk/gir/Gtk-4.0.gir",
        namespace: { name: "Gtk", version: "4.0" },
        classes: [
          {
            name: "Button",
            constructors: ["new_with_label"],
            methods: ["get_label", "set_label"],
            signals: ["clicked"],
          },
          {
            name: "Widget",
            methods: ["activate", "get_opacity", "get_width", "set_opacity", "set_visible"],
          },
          {
            name: "Window",
            constructors: ["new"],
            methods: ["destroy", "present", "set_child", "set_default_size"],
          },
        ],
      });
      const gtkProbe = generateGirClangFunctionProbe(gtkSnapshot);
      const gtkProbePlan = planClangFunctionProbe({
        probe: gtkProbe,
        sourceArtifactId: "source/gtk4/clang-function-probe",
        evidenceArtifactId: "metadata/gtk4/clang-function-evidence",
        actionId: "inspect/gtk4/clang-functions",
        logicalPath: "generated/gtk4/clang-function-probe.c",
        arguments: gtkSdk.compileArguments,
        tool: clangTool,
        executionPlatform,
        target: nativeTarget,
      });
      const gtkProbePath = join(scratch, "gtk4-function-probe.c");
      writeFileSync(gtkProbePath, gtkProbe.source);
      const evidenceReport = await executeArtifactGraph(
        defineArtifactGraph({
          artifacts: [
            gtkProbePlan.source,
            ...gtkSdk.artifacts,
            gtkProbePlan.evidence,
          ],
          actions: [gtkProbePlan.action],
        }),
        {
          buildRoot: join(scratch, "gtk4-evidence"),
          sourcePaths: {
            ...gtkSdk.sourcePaths,
            [gtkProbePlan.source.id]: gtkProbePath,
          },
          tools: { [clangTool.id]: { path: clangPath } },
          sandbox: { kind: "bubblewrap", path: sandboxPath },
        },
      );
      const evidenceArtifact = evidenceReport.artifacts.find(
        ({ id }) => id === gtkProbePlan.evidence.id,
      );
      assert.ok(evidenceArtifact);
      const gtkEvidence = parseClangFunctionEvidence(
        readFileSync(evidenceArtifact.path, "utf8"),
        {
          probe: gtkProbe,
          clang: {
            toolId: clangTool.id,
            version: clangTool.version,
            digest: clangTool.digest,
            target: nativeTarget,
          },
        },
      );
      const gobjectAdapter = generateGObjectAdapterSource(gtkSnapshot);
      const generatedGtk = generateGtkScabiPackage({
        snapshot: gtkSnapshot,
        evidence: gtkEvidence,
        gobjectAdapter,
        package: {
          name: "@native-typescript/gtk4",
          version: "0.0.0",
          namespace: "native-typescript.gtk4",
          instance: "native-typescript.gtk4@0.0.0",
        },
        target: {
          triple: nativeTarget,
          architecture: "x86_64",
          pointerWidth: 64,
          endianness: "little",
          objectFormat: "elf",
          minimumPlatformVersion: "glibc-2.17",
          abi: "sysv-amd64",
          features: ["gtk4", "glib-main-context"],
        },
        sdk: {
          vendor: "GNOME",
          name: "GTK",
          version: gtkSnapshot.namespace.version,
          deploymentTarget: nativeTarget,
          modules: ["gtk4"],
        },
        linkInputs: gtkSdk.systemLibraries.map((name, order) => ({
          id: name,
          kind: "system-library" as const,
          name,
          order,
        })),
        adapterInput: {
          id: "gtk4.gobject-adapters",
          output: "gobject-adapters.o",
        },
      });
      const generatedGtkDeclarationsPath = join(scratch, "gtk4.d.ts");
      const generatedGtkAdapterPath = join(scratch, "gobject-adapters.c");
      writeFileSync(generatedGtkDeclarationsPath, generatedGtk.declarations);
      writeFileSync(generatedGtkAdapterPath, gobjectAdapter.source);
      const gobjectAdapterObject = planGObjectAdapterObject({
        adapter: gobjectAdapter,
        sourceArtifactId: "source/gtk4/gobject-adapters",
        objectArtifactId: "object/gtk4/gobject-adapters",
        actionId: "compile/gtk4/gobject-adapters",
        logicalPath: "generated/gtk4/gobject-adapters.c",
        artifactFileName: "gobject-adapters.o",
        arguments: gtkSdk.compileArguments,
        tool: clangTool,
        executionPlatform,
        target: nativeTarget,
      });
      const gtkTranslated = translateScabiNativeProgram(generatedGtk.manifest, {
        imports: [
          "gtk_button_get_label",
          "gtk_button_connect_clicked",
          "gtk_button_new_with_label",
          "gtk_button_set_label",
          "gtk_widget_activate",
          "gtk_widget_get_opacity",
          "gtk_widget_get_width",
          "gtk_widget_set_opacity",
          "gtk_widget_set_visible",
          "gtk_window_destroy",
          "gtk_window_new",
          "gtk_window_present",
          "gtk_window_set_child",
          "gtk_window_set_default_size",
        ],
        exports: [],
      });
      assert.equal(
        gtkTranslated.ok,
        true,
        gtkTranslated.ok
          ? undefined
          : gtkTranslated.diagnostics
              .map(({ code, path, message }) => `${code} ${path}: ${message}`)
              .join("\n"),
      );
      if (!gtkTranslated.ok) return;
      assert.deepEqual(
        gtkTranslated.build.linkInputs.map(({ name }) => name),
        gtkSdk.systemLibraries,
      );
      const translated = composeScriptCNativePrograms([
        runtimeTranslated,
        gtkTranslated,
      ]);
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
      assert.deepEqual(translated.build.adapterInputs.map(({ id }) => id), [
        "gtk4.gobject-adapters",
      ]);
      assert.deepEqual(
        translated.build.linkInputs.map(({ id }) => id),
        runtimeTranslated.build.linkInputs.map(({ id }) => id),
      );

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
          id: "runtime/scriptc",
          path: scriptcRuntimeRoot,
          fileName: "scriptc-runtime",
          logicalPath: "third_party/scriptc/packages/runtime",
        }),
        sourceArtifact({
          id: "headers/scriptc/runtime",
          path: scriptcRuntimeInclude,
          fileName: "scriptc-runtime-headers",
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
        ...gtkSdk.compileArguments,
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
      const systemLibraries = translated.build.linkInputs
        .filter(({ kind }) => kind === "system-library")
        .sort((left, right) => left.order - right.order)
        .map(({ name }) => name);
      execFileSync(
        pnpm,
        ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"],
      );
      const { compile, compileC, planExternalCCommand } = await import(
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
            [generatedGtk.manifest.package.name]: generatedGtkDeclarationsPath,
          },
          native: translated.input,
          nativeLinkInputs: [
            runtimeObject.object.id,
            counterObject.artifact.id,
            gobjectAdapterObject.object.id,
          ],
          nativeSystemLibraries: systemLibraries,
          nativeBuildExecutor: async (request) => {
            const programId = `generated/scriptc/${backend}/program`;
            const outputId = `product/gtk-counter/${backend}`;
            const generatedProgram = await generatedSourceArtifact({
              id: programId,
              path: request.cPath,
              fileName: backend === "llvm" ? "program.ll" : "program.c",
              logicalPath: `generated/scriptc/${backend}/program.${
                backend === "llvm" ? "ll" : "c"
              }`,
              mediaType: backend === "llvm" ? "text/x-llvm" : "text/x-c",
            });
            const result: { binaryPath: string | null } = { binaryPath: null };
            await compileC({
              ...request,
              commandExecutor: async (command) => {
                const linkInputPaths = request.linkInputs ?? [];
                assert.equal(linkInputPaths.length, 3);
                const external = planExternalCCommand(command, {
                  program: { id: programId, path: request.cPath },
                  runtime: {
                    id: "runtime/scriptc",
                    path: scriptcRuntimeRoot,
                  },
                  linkInputs: [
                    {
                      id: runtimeObject.object.id,
                      path: linkInputPaths[0]!,
                    },
                    {
                      id: counterObject.artifact.id,
                      path: linkInputPaths[1]!,
                    },
                    {
                      id: gobjectAdapterObject.object.id,
                      path: linkInputPaths[2]!,
                    },
                  ],
                  output: { id: outputId, path: request.outPath },
                });
                assert.equal(
                  external.bindings.runtimeDirectory,
                  scriptcRuntimeRoot,
                );
                const executablePlan = planScriptCExecutable({
                  actionId: `link/scriptc-executable/${backend}`,
                  plan: external.plan,
                  artifactFileName: "gtk-counter",
                  tool: clangTool,
                  driverPlatform: "linux",
                  executionPlatform,
                  target: nativeTarget,
                });
                const graph = defineArtifactGraph({
                  artifacts: [
                    ...gtkSdk.artifacts,
                    ...localArtifacts,
                    runtimeObject.sourceTree,
                    runtimeObject.object,
                    counterObject.artifact,
                    gobjectAdapterObject.source,
                    gobjectAdapterObject.object,
                    generatedProgram,
                    executablePlan.artifact,
                  ],
                  actions: [
                    runtimeObject.action,
                    counterObject.action,
                    gobjectAdapterObject.action,
                    executablePlan.action,
                  ],
                });
                const serializedGraph = JSON.stringify(graph);
                for (const physicalPath of [
                  ...Object.values(gtkSdk.sourcePaths),
                  runtimeHeadersPath,
                  fixtureTreePath,
                  scriptcRuntimeRoot,
                  scriptcRuntimeInclude,
                  generatedGtkAdapterPath,
                  request.cPath,
                ]) {
                  assert.equal(serializedGraph.includes(physicalPath), false);
                }
                const report = await executeArtifactGraph(graph, {
                  buildRoot: join(scratch, `${backend}-artifacts`),
                  sourcePaths: {
                    ...gtkSdk.sourcePaths,
                    [glibRuntimeArtifactIds.sourceTree]: runtimeHeadersPath,
                    "source/fixture/gtk-counter": fixtureTreePath,
                    "runtime/scriptc": scriptcRuntimeRoot,
                    "headers/scriptc/runtime": scriptcRuntimeInclude,
                    [gobjectAdapterObject.source.id]: generatedGtkAdapterPath,
                    [programId]: request.cPath,
                  },
                  tools: { "tool/clang": { path: clangPath } },
                  sandbox: { kind: "bubblewrap", path: sandboxPath },
                  maxConcurrency: 2,
                });
                const product = report.artifacts.find(({ id }) => id === outputId);
                assert.ok(product);
                result.binaryPath = product.path;
              },
            });
            assert.ok(result.binaryPath);
            return { binaryPath: result.binaryPath };
          },
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
