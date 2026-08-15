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
  planScriptCProgramEmission,
  resolvePkgConfigSdk,
  resolveSourceArtifact,
} from "@native-typescript/core";
import type {
  ArtifactActionArgument,
  ArtifactActionDefinition,
  ArtifactDefinition,
} from "@native-typescript/core";
import {
  canonicalizeJson,
  parseScabiManifest,
} from "@native-typescript/scabi";
import {
  composeScriptCNativePrograms,
  translateScabiNativeProgram,
} from "@native-typescript/scriptc";
import type { ScriptCNativeTypeDefinition } from "@native-typescript/scriptc";
import {
  defineGtkBindingPackageRequest,
  gtkBindingToolFile,
  glibRuntimeArtifactIds,
  ingestGir,
  planGtkBindingAnalysis,
  planGtkTargetObjects,
} from "@native-typescript/target-gtk";
import type {
  GObjectAdapterSource,
  GtkBindingPackageDescriptor,
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
  readonly target?: string;
  readonly domain?: ArtifactDefinition["domain"];
}): Promise<ArtifactDefinition> {
  const resolved = await resolveSourceArtifact({
    id: options.id,
    path: options.path,
    kind: "source-tree",
    entryType: "directory",
    mediaType: "inode/directory",
    target: options.target ?? nativeTarget,
    domain: options.domain ?? "target",
    cache: "exportable",
    fileName: options.fileName,
    logicalPath: options.logicalPath,
  });
  return resolved.artifact;
}

async function sourceFileArtifact(options: {
  readonly id: string;
  readonly path: string;
  readonly fileName: string;
  readonly logicalPath: string;
  readonly kind: ArtifactDefinition["kind"];
  readonly mediaType: string;
  readonly domain: ArtifactDefinition["domain"];
  readonly cache: ArtifactDefinition["cache"];
  readonly target?: string;
}): Promise<ArtifactDefinition> {
  const resolved = await resolveSourceArtifact({
    id: options.id,
    path: options.path,
    kind: options.kind,
    entryType: "file",
    mediaType: options.mediaType,
    target: options.target ?? nativeTarget,
    domain: options.domain,
    cache: options.cache,
    fileName: options.fileName,
    logicalPath: options.logicalPath,
  });
  return resolved.artifact;
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
      const nodePath = process.execPath;
      const nodeContent = await digestArtifactPath(nodePath, "file");
      const nodeTool: ArtifactActionDefinition["tool"] = {
        id: "tool/node",
        version: process.versions.node,
        digest: nodeContent.digest,
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
            name: "Box",
            constructors: ["new"],
            methods: ["append"],
          },
          {
            name: "Button",
            constructors: ["new_with_label"],
            methods: ["get_label", "set_label"],
            signals: ["clicked"],
          },
          {
            name: "DrawingArea",
            constructors: ["new"],
            methods: ["set_content_height", "set_content_width"],
            signals: ["resize"],
          },
          {
            name: "EventController",
            constructors: [],
            methods: [],
          },
          {
            name: "EventControllerScroll",
            constructors: ["new"],
            methods: ["get_flags", "set_flags"],
          },
          {
            name: "Overlay",
            constructors: ["new"],
            methods: ["add_overlay", "set_child"],
          },
          {
            name: "Widget",
            methods: ["activate", "get_opacity", "get_preferred_size", "get_width", "set_opacity", "set_visible"],
          },
          {
            name: "Window",
            constructors: ["new"],
            methods: [
              "destroy",
              "get_title",
              "present",
              "set_child",
              "set_default_size",
              "set_title",
            ],
          },
        ],
        records: [{ name: "Requisition", fields: ["width", "height"] }],
        enumerations: [
          {
            name: "EventControllerScrollFlags",
            members: ["both_axes", "horizontal", "vertical"],
          },
          { name: "Orientation", members: ["horizontal", "vertical"] },
        ],
      });
      const gtkBindingRequest = defineGtkBindingPackageRequest({
        clang: {
          toolId: clangTool.id,
          version: clangTool.version,
          digest: clangTool.digest,
          target: nativeTarget,
        },
        generation: {
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
        },
      });
      const gtkSnapshotPath = join(scratch, "gtk4-selected-gir.json");
      const gtkBindingRequestPath = join(scratch, "gtk4-binding-request.json");
      writeFileSync(gtkSnapshotPath, canonicalizeJson(gtkSnapshot));
      writeFileSync(
        gtkBindingRequestPath,
        canonicalizeJson(gtkBindingRequest),
      );
      const gtkBindingToolPath = join(
        targetRoot,
        "node_modules/.runtime",
        gtkBindingToolFile,
      );
      const gtkSnapshotArtifact = await sourceFileArtifact({
        id: "metadata/gtk4/selected-gir",
        path: gtkSnapshotPath,
        fileName: "selected-gir.json",
        logicalPath: "generated/gtk4/selected-gir.json",
        kind: "metadata",
        mediaType: "application/vnd.native-typescript.gir-snapshot+json",
        domain: "host",
        cache: "exportable",
        target: executionPlatform,
      });
      const gtkBindingRequestArtifact = await sourceFileArtifact({
        id: "metadata/gtk4/binding-package-request",
        path: gtkBindingRequestPath,
        fileName: "binding-package-request.json",
        logicalPath: "generated/gtk4/binding-package-request.json",
        kind: "metadata",
        mediaType:
          "application/vnd.native-typescript.gtk-binding-package-request+json",
        domain: "host",
        cache: "exportable",
        target: executionPlatform,
      });
      const gtkBindingToolArtifact = await sourceFileArtifact({
        id: "tool-input/target-gtk/binding-package-generator",
        path: gtkBindingToolPath,
        fileName: gtkBindingToolFile,
        logicalPath: "packages/target-gtk/runtime/gtk-binding-tool-cli.mjs",
        kind: "source",
        mediaType: "text/javascript",
        domain: "host",
        cache: "exportable",
        target: executionPlatform,
      });
      const gtkAnalysisPlan = planGtkBindingAnalysis({
        snapshot: gtkSnapshot,
        request: gtkBindingRequest,
        requestArtifact: gtkBindingRequestArtifact.id,
        snapshotArtifact: gtkSnapshotArtifact.id,
        generatorArtifact: gtkBindingToolArtifact.id,
        clangArguments: gtkSdk.compileArguments,
        clangTool,
        nodeTool,
        executionPlatform,
        target: nativeTarget,
      });
      const gtkProbePath = join(scratch, "gtk4-function-probe.c");
      writeFileSync(gtkProbePath, gtkAnalysisPlan.probe.source);
      const analysisGraph = defineArtifactGraph({
        artifacts: [
          ...gtkSdk.artifacts,
          gtkSnapshotArtifact,
          gtkBindingRequestArtifact,
          gtkBindingToolArtifact,
          ...gtkAnalysisPlan.artifacts,
        ],
        actions: gtkAnalysisPlan.actions,
      });
      const analysisBindings = {
        sourcePaths: {
          ...gtkSdk.sourcePaths,
          [gtkAnalysisPlan.clang.source.id]: gtkProbePath,
          [gtkSnapshotArtifact.id]: gtkSnapshotPath,
          [gtkBindingRequestArtifact.id]: gtkBindingRequestPath,
          [gtkBindingToolArtifact.id]: gtkBindingToolPath,
        },
        tools: {
          [clangTool.id]: { path: clangPath },
          [nodeTool.id]: { path: nodePath },
        },
        sandbox: { kind: "bubblewrap" as const, path: sandboxPath },
        cache: { kind: "local" as const, path: join(scratch, "gtk4-cache") },
      };
      const analysisReport = await executeArtifactGraph(analysisGraph, {
        ...analysisBindings,
        buildRoot: join(scratch, "gtk4-analysis"),
      });
      const cachedAnalysisReport = await executeArtifactGraph(analysisGraph, {
        ...analysisBindings,
        buildRoot: join(scratch, "gtk4-analysis-cached"),
      });
      assert.equal(
        cachedAnalysisReport.actions.find(
          ({ id }) => id === gtkAnalysisPlan.bindings.action.id,
        )?.status,
        "cached",
      );
      const generatedGtkArtifact = analysisReport.artifacts.find(
        ({ id }) => id === gtkAnalysisPlan.bindings.artifact.id,
      );
      assert.ok(generatedGtkArtifact);
      const generatedGtkPath = generatedGtkArtifact.path;
      const generatedGtkDeclarationsPath = join(generatedGtkPath, "package.d.ts");
      const generatedGtkAdapterPath = join(
        generatedGtkPath,
        "gobject-adapters.c",
      );
      const generatedGtkManifest = parseScabiManifest(
        readFileSync(join(generatedGtkPath, "package.scabi.json"), "utf8"),
      );
      const generatedGtkDeclarations = readFileSync(generatedGtkDeclarationsPath, "utf8");
      assert.match(
        generatedGtkDeclarations,
        /class Box extends Widget \{[^}]*constructor\(orientation: Orientation, spacing: gint\);[^}]*append\(child: Widget\): void;/su,
      );
      assert.match(
        generatedGtkDeclarations,
        /namespace Orientation \{[^}]*const Vertical: Orientation;/su,
      );
      assert.match(
        generatedGtkDeclarations,
        /class EventControllerScroll extends EventController \{[^}]*constructor\(flags: EventControllerScrollFlags\);[^}]*get flags\(\): EventControllerScrollFlags;[^}]*set flags\(value: EventControllerScrollFlags\);/su,
      );
      assert.match(
        generatedGtkDeclarations,
        /namespace EventControllerScrollFlags \{[^}]*const BothAxes: EventControllerScrollFlags;[^}]*const Horizontal: EventControllerScrollFlags;[^}]*const Vertical: EventControllerScrollFlags;[^}]*function combine\(first: EventControllerScrollFlags, \.\.\.rest: readonly EventControllerScrollFlags\[\]\): EventControllerScrollFlags;/su,
      );
      assert.match(
        generatedGtkDeclarations,
        /class Window extends Widget \{[^}]*get title\(\): string \| null;[^}]*set title\(value: string \| null\);/su,
      );
      const gobjectAdapter = JSON.parse(
        readFileSync(join(generatedGtkPath, "gobject-adapter.json"), "utf8"),
      ) as GObjectAdapterSource;
      const generatedGtkDescriptor = JSON.parse(
        readFileSync(join(generatedGtkPath, "binding-package.json"), "utf8"),
      ) as GtkBindingPackageDescriptor;
      assert.equal(
        generatedGtkDescriptor.files.manifest.digest,
        sha256(join(generatedGtkPath, "package.scabi.json")),
      );
      assert.equal(
        generatedGtkDescriptor.files.adapterSource.digest,
        sha256(generatedGtkAdapterPath),
      );
      const gtkTranslated = translateScabiNativeProgram(generatedGtkManifest, {
        imports: [
          "gtk_box_append",
          "gtk_box_new",
          "gtk_button_get_label",
          "gtk_button_connect_clicked",
          "gtk_button_new_with_label",
          "gtk_button_set_label",
          "gtk_drawing_area_connect_resize",
          "gtk_drawing_area_new",
          "gtk_drawing_area_set_content_height",
          "gtk_drawing_area_set_content_width",
          "gtk_event_controller_scroll_flags_both_axes",
          "gtk_event_controller_scroll_flags_horizontal",
          "gtk_event_controller_scroll_flags_vertical",
          "gtk_event_controller_scroll_get_flags",
          "gtk_event_controller_scroll_new",
          "gtk_event_controller_scroll_set_flags",
          "gtk_overlay_add_overlay",
          "gtk_overlay_new",
          "gtk_overlay_set_child",
          "gtk_orientation_vertical",
          "gtk_signal_connection_connected",
          "gtk_widget_activate",
          "gtk_widget_get_opacity",
          "gtk_widget_get_width",
          "gtk_widget_set_opacity",
          "gtk_widget_set_visible",
          "gtk_window_destroy",
          "gtk_window_get_title",
          "gtk_window_new",
          "gtk_window_present",
          "gtk_window_set_child",
          "gtk_window_set_default_size",
          "gtk_window_set_title",
          "nts_gobject_value_gtk_widget_get_preferred_size",
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
      assert.deepEqual(gtkTranslated.input.constants, [
        {
          id: "native-typescript.gtk4@0.0.0#gtk_event_controller_scroll_flags_both_axes",
          declaration: {
            module: "@native-typescript/gtk4",
            name: "EventControllerScrollFlags.BothAxes",
          },
          type: { kind: "nativeScalar", scalar: "u32" },
          value: "3",
        },
        {
          id: "native-typescript.gtk4@0.0.0#gtk_event_controller_scroll_flags_horizontal",
          declaration: {
            module: "@native-typescript/gtk4",
            name: "EventControllerScrollFlags.Horizontal",
          },
          type: { kind: "nativeScalar", scalar: "u32" },
          value: "2",
        },
        {
          id: "native-typescript.gtk4@0.0.0#gtk_event_controller_scroll_flags_vertical",
          declaration: {
            module: "@native-typescript/gtk4",
            name: "EventControllerScrollFlags.Vertical",
          },
          type: { kind: "nativeScalar", scalar: "u32" },
          value: "1",
        },
        {
          id: "native-typescript.gtk4@0.0.0#gtk_orientation_vertical",
          declaration: { module: "@native-typescript/gtk4", name: "Orientation.Vertical" },
          type: { kind: "nativeScalar", scalar: "u32" },
          value: "1",
        },
      ]);
      assert.deepEqual(gtkTranslated.input.operations, [{
        id: "native-typescript.gtk4@0.0.0#source-operation/gtk_event_controller_scroll_flags/combine",
        declaration: {
          module: "@native-typescript/gtk4",
          name: "EventControllerScrollFlags.combine",
        },
        kind: "integer-reduce",
        operator: "|",
        type: { kind: "nativeScalar", scalar: "u32" },
      }]);
      const translatedConnect = gtkTranslated.input.bindings.find(
        ({ declaration }) => declaration.name === "Button.onClicked",
      );
      assert.deepEqual(
        translatedConnect?.arguments[1]?.callback?.registrationOwner,
        { kind: "argument", argument: 0 },
      );
      assert.deepEqual(
        translatedConnect?.arguments[1]?.callback?.sourceArguments,
        [{ kind: "registration-owner" }],
      );
      assert.deepEqual(
        translatedConnect?.arguments[1]?.type.kind === "func"
          ? translatedConnect.arguments[1].type.params
          : undefined,
        [translatedConnect?.arguments[0]?.type],
      );
      const physicalCallback = translatedConnect?.parameters.find(
        ({ projection }) => projection.kind === "callbackFunction",
      );
      assert.deepEqual(
        physicalCallback?.type.kind === "nativeCallback"
          ? physicalCallback.type.signature.parameters
          : undefined,
        [],
      );
      const translatedResize = gtkTranslated.input.bindings.find(
        ({ declaration }) => declaration.name === "DrawingArea.onResize",
      );
      assert.deepEqual(
        translatedResize?.arguments[1]?.callback?.sourceArguments,
        [
          { kind: "registration-owner" },
          { kind: "callback-parameter", parameter: 0 },
          { kind: "callback-parameter", parameter: 1 },
        ],
      );
      assert.deepEqual(
        translatedResize?.arguments[1]?.type.kind === "func"
          ? translatedResize.arguments[1].type.params.slice(1)
          : undefined,
        [
          { kind: "nativeScalar", scalar: "i32" },
          { kind: "nativeScalar", scalar: "i32" },
        ],
      );
      for (const declarationName of [
        "Button",
        "DrawingArea",
        "Overlay",
        "SignalConnection",
      ]) {
        const definition: ScriptCNativeTypeDefinition | undefined =
          gtkTranslated.input.types.find(
          ({ declaration }) => declaration.name === declarationName,
          );
        assert.equal(
          definition?.kind === "handle" ? definition.cycleCollection : undefined,
          "traceable",
        );
      }
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
      const targetObjects = planGtkTargetObjects({
        adapter: gobjectAdapter,
        glibRuntimeSourceTreeDigest: runtimeTreeContent.digest,
        scriptcRuntimeHeaders: { artifact: "headers/scriptc/runtime" },
        sdkArguments: gtkSdk.compileArguments,
        tool: clangTool,
        executionPlatform,
        target: nativeTarget,
      });
      const runtimeObject = targetObjects.runtime;
      const gobjectAdapterObject = targetObjects.adapters;
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
      const {
        planExecutableCompilation,
        planExecutableExternalCBuild,
      } = await import(
        "../third_party/scriptc/packages/compiler/dist/index.js"
      );
      const compilerEmitterPath = join(scriptcRoot, "packages/compiler/dist");
      const compilerEmitter = await sourceArtifact({
        id: "tool-input/scriptc/emitter",
        path: compilerEmitterPath,
        fileName: "scriptc-emitter",
        logicalPath: "third_party/scriptc/packages/compiler/dist",
        target: executionPlatform,
        domain: "host",
      });
      for (const backend of ["c", "llvm"] as const) {
        const planned = planExecutableCompilation(join(fixtureRoot, "app.ts"), {
          backend,
          sourceRoot: fixtureRoot,
          externalTypes: {
            [manifest.package.name]: join(fixtureRoot, "package.d.ts"),
            [generatedGtkManifest.package.name]: generatedGtkDeclarationsPath,
          },
          native: translated.input,
          nativeLinkInputs: [
            runtimeObject.object.id,
            counterObject.artifact.id,
            gobjectAdapterObject.object.id,
          ],
          nativeSystemLibraries: systemLibraries,
        });
        assert.equal(
          planned.ok,
          true,
          planned.ok
            ? undefined
            : planned.diagnostics
                .map((diagnostic) => diagnostic.message)
                .join("\n"),
        );
        if (!planned.ok) continue;

        const programId = `generated/scriptc/${backend}/program`;
        const outputId = `product/gtk-counter/${backend}`;
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
        const externalResult = await planExecutableExternalCBuild(
          planned.plan,
          {
            program: programId,
            runtime: "runtime/scriptc",
            linkInputs: [
              runtimeObject.object.id,
              counterObject.artifact.id,
              gobjectAdapterObject.object.id,
            ],
            output: outputId,
          },
        );
        assert.equal(
          externalResult.bindings.runtimeDirectory,
          scriptcRuntimeRoot,
        );
        const executablePlan = planScriptCExecutable({
          actionId: `link/scriptc-executable/${backend}`,
          plan: externalResult.plan,
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
            compilerEmitter,
            planArtifact,
            ...targetObjects.artifacts,
            counterObject.artifact,
            emissionPlan.artifact,
            executablePlan.artifact,
          ],
          actions: [
            emissionPlan.action,
            ...targetObjects.actions,
            counterObject.action,
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
          compilerEmitterPath,
          generatedGtkAdapterPath,
          planPath,
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
            [compilerEmitter.id]: compilerEmitterPath,
            [planArtifact.id]: planPath,
            [gobjectAdapterObject.source.id]: generatedGtkAdapterPath,
          },
          tools: {
            "tool/clang": { path: clangPath },
            "tool/node": { path: nodePath },
          },
          sandbox: { kind: "bubblewrap", path: sandboxPath },
          maxConcurrency: 2,
        });
        const product = report.artifacts.find(({ id }) => id === outputId);
        assert.ok(product);

        const run = spawnSync(
          "xvfb-run",
          [
            "-a",
            "--server-args=-screen 0 1024x768x24",
            product.path,
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
