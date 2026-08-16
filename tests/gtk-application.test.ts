import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  defineArtifactGraph,
  digestArtifactPath,
  executeArtifactGraph,
  planScriptCExecutable,
  planScriptCProgramEmission,
} from "@native-typescript/core";
import { parseScabiManifest } from "@native-typescript/scabi";
import {
  composeScriptCNativePrograms,
  translateScabiNativeProgram,
} from "@native-typescript/scriptc";
import type { ScriptCNativeTranslationSuccess } from "@native-typescript/scriptc";
import { ingestGir } from "@native-typescript/bindgen-gir";
import type { GObjectAdapterSource } from "@native-typescript/bindgen-gir";
import { planGtkTargetObjects, targetRuntimeArtifactIds } from "@native-typescript/target-gtk";
import {
  executable,
  executionPlatform,
  nativeTarget,
  sha256,
  sourceArtifact,
  sourceFileArtifact,
} from "./support/artifacts.ts";
import {
  bindingToolPath,
  ingestGioApplication,
  planNamespaceAnalysis,
  systemGioGir,
  systemGtkGir,
  toolIdentity,
} from "./support/gir-analysis.ts";

const workspace = join(import.meta.dirname, "..");
const scriptcRoot = join(workspace, "third_party/scriptc");
const scriptcRuntimeRoot = join(scriptcRoot, "packages/runtime");
const scriptcRuntimeInclude = join(scriptcRuntimeRoot, "src");
const fixtureRoot = join(workspace, "fixtures/gtk-application");
const targetRoot = join(workspace, "packages/target-gtk");
const applicationRoot = join(targetRoot, "application");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const hasGtk = spawnSync("pkg-config", ["--exists", "gtk4"]).status === 0;
const hasXvfb = spawnSync("xvfb-run", ["--help"]).status === 0;
const hasClang = spawnSync("clang", ["--version"]).status === 0;
const hasBubblewrap = spawnSync("bwrap", ["--version"]).status === 0;

/* The whole non-throwing lifecycle, plus register() which is throws=1 and so
 * reaches the boundary through a generated adapter. */
const gioLifecycleMethods = [
  "activate",
  "get_application_id",
  "get_is_remote",
  "hold",
  "quit",
  "register",
  "release",
  "set_application_id",
] as const;

test(
  "a generated GTK application drives its own lifecycle with no hand-written C",
  {
    skip:
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      !existsSync(systemGioGir) ||
      !existsSync(systemGtkGir) ||
      !existsSync(bindingToolPath) ||
      !hasGtk ||
      !hasXvfb ||
      !hasClang ||
      !hasBubblewrap,
  },
  async () => {
    /* Everything this executable calls is either generated from GIR or shipped
     * by the target. There is no fixture C at all, so a failure here is a
     * failure of the generated surface rather than of scaffolding written to
     * flatter it. */
    const scratch = mkdtempSync(join(tmpdir(), "nts-gtk-application-"));
    try {
      const clangPath = executable("clang");
      const nodePath = process.execPath;
      const sandboxPath = executable("bwrap");
      const clangTool = await toolIdentity("tool/clang", clangPath);
      const nodeTool = await toolIdentity("tool/node", nodePath);
      const tools = {
        [clangTool.id]: { path: clangPath },
        [nodeTool.id]: { path: nodePath },
      };
      const sandbox = { kind: "bubblewrap" as const, path: sandboxPath };

      const gio = ingestGioApplication(gioLifecycleMethods);
      const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
        logicalPath: "system-sdk/gir/Gtk-4.0.gir",
        namespace: { name: "Gtk", version: "4.0" },
        classes: [{ name: "Application", constructors: ["new"] }],
      });
      const analysis = await planNamespaceAnalysis({
        scratch,
        suffix: "lifecycle",
        selections: [
          { snapshot: gio, imports: [], sdkModules: ["gio-2.0"] },
          { snapshot: gtk, imports: [gio], sdkModules: ["gtk4"] },
        ],
        clangTool,
        nodeTool,
      });
      const analysisReport = await executeArtifactGraph(analysis.graph, {
        buildRoot: join(scratch, "analysis"),
        sourcePaths: analysis.sourcePaths,
        tools,
        sandbox,
      });

      const generated = new Map<
        string,
        {
          readonly declarations: string;
          readonly declarationsPath: string;
          readonly adapterPath: string;
          readonly adapter: GObjectAdapterSource;
          readonly manifest: ReturnType<typeof parseScabiManifest>;
        }
      >();
      for (const { slug, bindingsArtifactId } of analysis.packages) {
        const artifact = analysisReport.artifacts.find(
          ({ id }) => id === bindingsArtifactId,
        );
        assert.ok(artifact, slug);
        if (!artifact) return;
        const declarationsPath = join(artifact.path, "package.d.ts");
        const adapterPath = join(artifact.path, "gobject-adapters.c");
        generated.set(slug, {
          declarations: readFileSync(declarationsPath, "utf8"),
          declarationsPath,
          adapterPath,
          adapter: JSON.parse(
            readFileSync(join(artifact.path, "gobject-adapter.json"), "utf8"),
          ) as GObjectAdapterSource,
          manifest: parseScabiManifest(
            readFileSync(join(artifact.path, "package.scabi.json"), "utf8"),
          ),
        });
      }
      const gio2 = generated.get("gio2");
      const gtk4 = generated.get("gtk4");
      assert.ok(gio2);
      assert.ok(gtk4);
      if (!gio2 || !gtk4) return;

      // The lifecycle the fixture calls has to exist before it can be linked.
      assert.match(gio2.declarations, /register\(cancellable: Cancellable\): void;/u);
      assert.match(
        gio2.declarations,
        /const NonUnique: ApplicationFlags;/u,
      );
      assert.match(
        gtk4.declarations,
        /class Application extends GioApplication/u,
      );

      /* Three packages compose into one program: the two generated namespaces
       * and the target's own bootstrap. */
      const applicationManifest = parseScabiManifest(
        readFileSync(join(applicationRoot, "package.scabi.json"), "utf8"),
      );
      assert.equal(
        applicationManifest.declarations.digest,
        sha256(join(applicationRoot, "package.d.ts")),
      );
      const translations: ScriptCNativeTranslationSuccess[] = [];
      for (const [manifest, imports] of [
        [applicationManifest, ["application_start", "application_quit"]],
        [gio2.manifest, Object.keys(gio2.manifest.bindings)],
        [gtk4.manifest, Object.keys(gtk4.manifest.bindings)],
      ] as const) {
        const translated = translateScabiNativeProgram(manifest, {
          imports: [...imports],
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
        translations.push(translated);
      }
      const [first, ...rest] = translations;
      assert.ok(first);
      if (!first) return;
      const composed = composeScriptCNativePrograms([first, ...rest]);
      assert.equal(
        composed.ok,
        true,
        composed.ok
          ? undefined
          : composed.diagnostics
              .map(({ code, path, message }) => `${code} ${path}: ${message}`)
              .join("\n"),
      );
      if (!composed.ok) return;
      assert.deepEqual(
        composed.build.adapterInputs.map(({ id }) => id).toSorted(),
        ["gio2.gobject-adapters", "gtk4.gobject-adapters"],
      );

      const runtimeHeadersPath = join(targetRoot, "runtime");
      const runtimeTreeContent = await digestArtifactPath(
        runtimeHeadersPath,
        "directory",
      );
      const targetObjects = planGtkTargetObjects({
        adapters: [
          { slug: "gio2", adapter: gio2.adapter },
          { slug: "gtk4", adapter: gtk4.adapter },
        ],
        targetRuntimeSourceTreeDigest: runtimeTreeContent.digest,
        scriptcRuntimeHeaders: { artifact: "headers/scriptc/runtime" },
        sdkArguments: analysis.sdk.compileArguments,
        tool: clangTool,
        executionPlatform,
        target: nativeTarget,
      });

      const localArtifacts = await Promise.all([
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

      execFileSync(pnpm, [
        "--dir",
        scriptcRoot,
        "--filter",
        "@scriptc/compiler",
        "build",
      ]);
      const { planExecutableCompilation, planExecutableExternalCBuild } =
        await import("../third_party/scriptc/packages/compiler/dist/index.js");
      const compilerEmitterPath = join(scriptcRoot, "packages/compiler/dist");
      const compilerEmitter = await sourceArtifact({
        id: "tool-input/scriptc/emitter",
        path: compilerEmitterPath,
        fileName: "scriptc-emitter",
        logicalPath: "third_party/scriptc/packages/compiler/dist",
        target: executionPlatform,
        domain: "host",
      });

      const linkInputs = [
        targetObjects.runtime.object.id,
        targetObjects.application.object.id,
        ...targetObjects.adapters.map(({ plan }) => plan.object.id),
      ];
      const systemLibraries = composed.build.linkInputs
        .filter(({ kind }) => kind === "system-library")
        .toSorted((left, right) => left.order - right.order)
        .map(({ name }) => name);

      for (const backend of ["c", "llvm"] as const) {
        const planned = planExecutableCompilation(join(fixtureRoot, "app.ts"), {
          backend,
          sourceRoot: fixtureRoot,
          externalTypes: {
            [applicationManifest.package.name]: join(
              applicationRoot,
              "package.d.ts",
            ),
            [gio2.manifest.package.name]: gio2.declarationsPath,
            [gtk4.manifest.package.name]: gtk4.declarationsPath,
          },
          native: composed.input,
          nativeLinkInputs: linkInputs,
          nativeSystemLibraries: systemLibraries,
        });
        assert.equal(
          planned.ok,
          true,
          planned.ok
            ? undefined
            : planned.diagnostics
                .map((diagnostic: { message: string }) => diagnostic.message)
                .join("\n"),
        );
        if (!planned.ok) continue;

        const programId = `generated/scriptc/${backend}/program`;
        const outputId = `product/gtk-application/${backend}`;
        const planId = `metadata/scriptc/${backend}/compilation-plan`;
        const planPath = join(scratch, `${backend}-compilation-plan.json`);
        writeFileSync(planPath, JSON.stringify(planned.plan));
        const planArtifact = await sourceFileArtifact({
          id: planId,
          path: planPath,
          fileName: "compilation-plan.json",
          logicalPath: `generated/scriptc/${backend}/compilation-plan.json`,
          kind: "metadata",
          mediaType: "application/vnd.scriptc.executable-compilation-plan+json",
          domain: "host",
          cache: "exportable",
          target: executionPlatform,
        });
        const emissionPlan = planScriptCProgramEmission({
          actionId: `emit/scriptc-program/${backend}`,
          plan: planned.plan,
          planArtifact: planId,
          compilerArtifact: compilerEmitter.id,
          artifactId: programId,
          artifactFileName: backend === "llvm" ? "program.ll" : "program.c",
          tool: nodeTool,
          executionPlatform,
          targetPlatform: "linux",
          target: nativeTarget,
        });
        const externalResult = await planExecutableExternalCBuild(planned.plan, {
          program: programId,
          runtime: "runtime/scriptc",
          linkInputs,
          output: outputId,
        });
        const executablePlan = planScriptCExecutable({
          actionId: `link/scriptc-executable/${backend}`,
          plan: externalResult.plan,
          artifactFileName: "gtk-application",
          tool: clangTool,
          driverPlatform: "linux",
          executionPlatform,
          target: nativeTarget,
        });

        const graph = defineArtifactGraph({
          artifacts: [
            ...analysis.sdk.artifacts,
            ...localArtifacts,
            compilerEmitter,
            planArtifact,
            ...targetObjects.artifacts,
            emissionPlan.artifact,
            executablePlan.artifact,
          ],
          actions: [
            emissionPlan.action,
            ...targetObjects.actions,
            executablePlan.action,
          ],
        });
        const report = await executeArtifactGraph(graph, {
          buildRoot: join(scratch, `${backend}-artifacts`),
          sourcePaths: {
            ...analysis.sdk.sourcePaths,
            [targetRuntimeArtifactIds.sourceTree]: runtimeHeadersPath,
            "runtime/scriptc": scriptcRuntimeRoot,
            "headers/scriptc/runtime": scriptcRuntimeInclude,
            [compilerEmitter.id]: compilerEmitterPath,
            [planArtifact.id]: planPath,
            ...Object.fromEntries(
              targetObjects.adapters.map(({ slug, plan }) => [
                plan.source.id,
                generated.get(slug)!.adapterPath,
              ]),
            ),
          },
          tools,
          sandbox,
          maxConcurrency: 2,
        });
        const product = report.artifacts.find(({ id }) => id === outputId);
        assert.ok(product);
        if (!product) continue;

        const run = spawnSync(
          "xvfb-run",
          ["-a", "--server-args=-screen 0 1024x768x24", product.path],
          {
            env: {
              ...process.env,
              /* A registering GtkApplication probes desktop portals over the
               * session bus. Whether that bus exists is a property of the
               * machine, not of the program, so the application is run without
               * one — being non-unique, it never needed a bus name. */
              DBUS_SESSION_BUS_ADDRESS: "disabled:",
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
          { status: 0, signal: null, stdout: "activated 1\n", stderr: "" },
          backend,
        );
      }
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  },
);
