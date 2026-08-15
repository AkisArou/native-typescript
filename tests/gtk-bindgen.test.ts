import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  parseClangFunctionEvidence,
  planClangFunctionProbe,
} from "@native-typescript/bindgen-c";
import {
  defineArtifactGraph,
  executeArtifactGraph,
  resolvePkgConfigSdk,
} from "@native-typescript/core";
import type { ArtifactActionDefinition } from "@native-typescript/core";
import {
  generateGObjectAdapterSource,
  generateGirClangFunctionProbe,
  generateGtkScabiPackage,
  ingestGir,
} from "@native-typescript/target-gtk";
import { translateScabiNativeProgram } from "@native-typescript/scriptc";

const systemGtkGir = "/usr/share/gir-1.0/Gtk-4.0.gir";
const target = "x86_64-unknown-linux-gnu";
const executionPlatform = "x86_64-linux";
const hasGtk = spawnSync("pkg-config", ["--exists", "gtk4"]).status === 0;
const hasClang = spawnSync("clang", ["--version"]).status === 0;
const hasBubblewrap = spawnSync("bwrap", ["--version"]).status === 0;

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

function toolIdentity(path: string): ArtifactActionDefinition["tool"] {
  const result = spawnSync(path, ["--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const version = /clang version ([^\s]+)/u.exec(result.stdout)?.[1];
  assert.ok(version);
  return {
    id: "tool/clang",
    version,
    digest: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
  };
}

test(
  "selected Gtk GIR callables agree with authoritative Clang headers",
  {
    skip:
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      !existsSync(systemGtkGir) ||
      !hasGtk ||
      !hasClang ||
      !hasBubblewrap,
  },
  async () => {
    const snapshot = ingestGir(readFileSync(systemGtkGir, "utf8"), {
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
    const probe = generateGirClangFunctionProbe(snapshot);
    assert.deepEqual(probe.functions.map(({ symbol }) => symbol), [
      "gtk_button_new_with_label",
      "gtk_button_get_label",
      "gtk_button_set_label",
      "gtk_widget_activate",
      "gtk_widget_get_opacity",
      "gtk_widget_get_width",
      "gtk_widget_set_opacity",
      "gtk_widget_set_visible",
      "gtk_window_new",
      "gtk_window_destroy",
      "gtk_window_present",
      "gtk_window_set_child",
      "gtk_window_set_default_size",
    ]);
    assert.equal(probe.source.includes("clicked"), false);

    const clangPath = executable("clang");
    const pkgConfigPath = executable("pkg-config");
    const bubblewrapPath = executable("bwrap");
    const clang = toolIdentity(clangPath);
    const sdk = await resolvePkgConfigSdk({
      id: "gtk4-clang-evidence",
      executable: pkgConfigPath,
      modules: ["gtk4"],
      target,
    });
    const plan = planClangFunctionProbe({
      probe,
      sourceArtifactId: "source/gtk4/clang-function-probe",
      rawAstArtifactId: "metadata/gtk4/clang-function-ast",
      actionId: "inspect/gtk4/clang-functions",
      logicalPath: "generated/gtk4/clang-function-probe.c",
      arguments: sdk.compileArguments,
      tool: clang,
      executionPlatform,
      target,
    });
    const graph = defineArtifactGraph({
      artifacts: [plan.source, ...sdk.artifacts, plan.rawAst],
      actions: [plan.action],
    });
    assert.equal(JSON.stringify(graph).includes("/usr/include"), false);

    const temporaryRoot = mkdtempSync(join(tmpdir(), "native-typescript-gtk-clang-"));
    try {
      const sourcePath = join(temporaryRoot, "clang-function-probe.c");
      writeFileSync(sourcePath, probe.source);
      const report = await executeArtifactGraph(graph, {
        buildRoot: join(temporaryRoot, "build"),
        sourcePaths: {
          ...sdk.sourcePaths,
          [plan.source.id]: sourcePath,
        },
        tools: { [clang.id]: { path: clangPath } },
        sandbox: { kind: "bubblewrap", path: bubblewrapPath },
      });
      const ast = report.artifacts.find(({ id }) => id === plan.rawAst.id);
      assert.ok(ast);
      const evidence = parseClangFunctionEvidence(readFileSync(ast.path, "utf8"), {
        probe,
        clang: {
          toolId: clang.id,
          version: clang.version,
          digest: clang.digest,
          target,
        },
      });
      assert.deepEqual(evidence.functions.map(({ symbol }) => symbol), [
        "gtk_button_new_with_label",
        "gtk_button_get_label",
        "gtk_button_set_label",
        "gtk_widget_activate",
        "gtk_widget_get_opacity",
        "gtk_widget_get_width",
        "gtk_widget_set_opacity",
        "gtk_widget_set_visible",
        "gtk_window_new",
        "gtk_window_destroy",
        "gtk_window_present",
        "gtk_window_set_child",
        "gtk_window_set_default_size",
      ]);
      assert.match(evidence.semanticDigest, /^sha256:[0-9a-f]{64}$/u);

      const bindingSnapshot = ingestGir(readFileSync(systemGtkGir, "utf8"), {
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
      const gobjectAdapter = generateGObjectAdapterSource(bindingSnapshot);
      const generated = generateGtkScabiPackage({
        snapshot: bindingSnapshot,
        evidence,
        gobjectAdapter,
        package: {
          name: "@native-typescript/gtk4",
          version: "0.0.0",
          namespace: "native-typescript.gtk4",
          instance: "native-typescript.gtk4@0.0.0",
        },
        target: {
          triple: target,
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
          version: bindingSnapshot.namespace.version,
          deploymentTarget: target,
          modules: ["gtk4"],
        },
        linkInputs: [
          { id: "gtk4", kind: "system-library", name: "gtk4", order: 0 },
        ],
        adapterInput: {
          id: "gtk4.gobject-adapters",
          output: "gobject-adapters.o",
        },
      });
      assert.equal(generated.manifest.declarations.digest, generated.declarationsDigest);
      assert.deepEqual(Object.keys(generated.manifest.bindings), [
        "gtk_button_connect_clicked",
        "gtk_button_get_label",
        "gtk_button_new_with_label",
        "gtk_button_release",
        "gtk_button_set_label",
        "gtk_signal_connection_connected",
        "gtk_signal_connection_disconnect",
        "gtk_signal_connection_release",
        "gtk_widget_activate",
        "gtk_widget_get_opacity",
        "gtk_widget_get_width",
        "gtk_widget_set_opacity",
        "gtk_widget_set_visible",
        "gtk_window_destroy",
        "gtk_window_new",
        "gtk_window_present",
        "gtk_window_release",
        "gtk_window_set_child",
        "gtk_window_set_default_size",
      ]);
      assert.match(
        generated.declarations,
        /static withLabel\(label: string\): Button;/u,
      );
      assert.match(generated.declarations, /set label\(value: string\);/u);
      assert.match(generated.declarations, /get label\(\): string \| null;/u);
      assert.doesNotMatch(generated.declarations, /getLabel|setLabel/u);
      assert.match(generated.declarations, /class Button extends Widget/u);
      assert.match(generated.declarations, /class Window extends Widget/u);
      assert.match(generated.declarations, /activate\(\): boolean;/u);
      assert.match(generated.declarations, /get opacity\(\): gdouble;/u);
      assert.match(generated.declarations, /getWidth\(\): gint;/u);
      assert.match(generated.declarations, /set opacity\(value: gdouble\);/u);
      assert.doesNotMatch(generated.declarations, /getOpacity|setOpacity/u);
      assert.match(generated.declarations, /setVisible\(visible: boolean\): void;/u);
      assert.match(
        generated.declarations,
        /onClicked\(callback: \(button: Button\) => void\): SignalConnection;/u,
      );
      assert.doesNotMatch(generated.declarations, /dispose\(\): void;/u);
      assert.match(generated.declarations, /readonly connected: boolean;/u);
      assert.match(generated.declarations, /setChild\(child: Widget\): void;/u);
      assert.match(
        generated.declarations,
        /setDefaultSize\(width: gint, height: gint\): void;/u,
      );
      assert.deepEqual(generated.manifest.declarations.types, {
        gdouble: { module: ".", name: "gdouble" },
        gint: { module: ".", name: "gint" },
        gtk_button: { module: ".", name: "Button" },
        gtk_signal_connection: {
          module: ".",
          name: "SignalConnection",
        },
        gtk_widget: { module: ".", name: "Widget" },
        gtk_window: { module: ".", name: "Window" },
      });
      assert.match(
        generated.declarations,
        /class Window extends Widget \{[^}]*constructor\(\);/su,
      );
      assert.deepEqual(generated.manifest.types.gtk_button, {
        kind: "handle",
        nativeName: "GtkButton",
        threadSafety: "confined",
        identity: "platform",
        upcasts: [{ kind: "identity", target: "gtk_widget" }],
      });
      assert.deepEqual(generated.manifest.types.gtk_window, {
        kind: "handle",
        nativeName: "GtkWindow",
        threadSafety: "confined",
        identity: "platform",
        upcasts: [{ kind: "identity", target: "gtk_widget" }],
      });
      const constructor = generated.manifest.bindings.gtk_button_new_with_label;
      assert.ok(constructor && constructor.kind !== "constant");
      assert.equal(constructor.kind, "factory");
      assert.deepEqual(constructor.declaration, {
        module: ".",
        name: "Button.withLabel",
      });
      assert.deepEqual(constructor.entry, {
        kind: "adapter-symbol",
        symbol: "nts_gobject_adopt_gtk_button_new_with_label",
      });
      const translated = translateScabiNativeProgram(generated.manifest, {
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
      assert.equal(translated.ok, true);
      if (!translated.ok) return;
      assert.deepEqual(
        translated.input.bindings.find(
          ({ entry }) => entry.symbol === "nts_gobject_adopt_gtk_button_new_with_label",
        )?.sourceCall,
        { kind: "function" },
      );
      assert.deepEqual(
        translated.input.bindings.find(
          ({ entry }) => entry.symbol === "nts_gobject_adopt_gtk_window_new",
        )?.sourceCall,
        { kind: "constructor" },
      );
      assert.deepEqual(
        translated.input.sourceTypes.filter(
          ({ declaration }) => declaration.name === "gdouble" || declaration.name === "gint",
        ),
        [
          {
            declaration: { module: "@native-typescript/gtk4", name: "gdouble" },
            type: { kind: "nativeScalar", scalar: "f64" },
          },
          {
            declaration: { module: "@native-typescript/gtk4", name: "gint" },
            type: { kind: "nativeScalar", scalar: "i32" },
          },
        ],
      );
      const buttonType = translated.input.types.find(
        ({ id }) => id.endsWith("#type:gtk_button"),
      );
      const widgetType = translated.input.types.find(
        ({ id }) => id.endsWith("#type:gtk_widget"),
      );
      assert.equal(buttonType?.kind, "handle");
      assert.equal(widgetType?.kind, "handle");
      if (buttonType?.kind !== "handle" || widgetType?.kind !== "handle") return;
      assert.deepEqual(buttonType.upcasts, [
        { kind: "identity", target: widgetType.id },
      ]);
      const activate = translated.input.bindings.find(
        ({ entry }) => entry.symbol === "gtk_widget_activate",
      );
      assert.deepEqual(activate?.result, {
        type: { kind: "nativeScalar", scalar: "i32" },
        passMode: "value",
        ownership: { kind: "value" },
        projection: { kind: "boolean", falseValue: "0", trueValue: "1" },
      });
      const setVisible = translated.input.bindings.find(
        ({ entry }) => entry.symbol === "gtk_widget_set_visible",
      );
      assert.deepEqual(setVisible?.arguments, [
        { name: "widget", type: { kind: "nativeHandle", typeId: widgetType.id } },
        { name: "visible", type: { kind: "bool" } },
      ]);
      assert.deepEqual(setVisible?.parameters[1], {
        name: "visible",
        type: { kind: "nativeScalar", scalar: "i32" },
        passMode: "value",
        ownership: { kind: "value" },
        projection: {
          kind: "boolean",
          argument: 1,
          falseValue: "0",
          trueValue: "1",
        },
      });
      const getOpacity = translated.input.bindings.find(
        ({ entry }) => entry.symbol === "gtk_widget_get_opacity",
      );
      assert.deepEqual(getOpacity?.sourceCall, {
        kind: "getter",
        receiverArgument: 0,
      });
      assert.deepEqual(getOpacity?.result, {
        type: { kind: "nativeScalar", scalar: "f64" },
        passMode: "value",
        ownership: { kind: "value" },
        projection: { kind: "direct" },
      });
      const setOpacity = translated.input.bindings.find(
        ({ entry }) => entry.symbol === "gtk_widget_set_opacity",
      );
      assert.deepEqual(setOpacity?.sourceCall, {
        kind: "setter",
        receiverArgument: 0,
        valueArgument: 1,
      });
      assert.deepEqual(setOpacity?.arguments[1], {
        name: "opacity",
        type: { kind: "nativeScalar", scalar: "f64" },
      });
      assert.deepEqual(setOpacity?.parameters[1], {
        name: "opacity",
        type: { kind: "nativeScalar", scalar: "f64" },
        passMode: "value",
        ownership: { kind: "value" },
        projection: { kind: "argument", argument: 1 },
      });
      const getWidth = translated.input.bindings.find(
        ({ entry }) => entry.symbol === "gtk_widget_get_width",
      );
      assert.deepEqual(getWidth?.result, {
        type: { kind: "nativeScalar", scalar: "i32" },
        passMode: "value",
        ownership: { kind: "value" },
        projection: { kind: "direct" },
      });
      const setDefaultSize = translated.input.bindings.find(
        ({ entry }) => entry.symbol === "gtk_window_set_default_size",
      );
      assert.deepEqual(setDefaultSize?.arguments.slice(1), [
        { name: "width", type: { kind: "nativeScalar", scalar: "i32" } },
        { name: "height", type: { kind: "nativeScalar", scalar: "i32" } },
      ]);
      assert.deepEqual(
        setDefaultSize?.parameters.slice(1).map(({ projection }) => projection),
        [
          { kind: "argument", argument: 1 },
          { kind: "argument", argument: 2 },
        ],
      );
      const connect = translated.input.bindings.find(
        ({ entry }) => entry.symbol === "nts_gobject_connect_button_clicked",
      );
      assert.equal(connect?.arguments[1]?.type.kind, "func");
      assert.equal(connect?.arguments[1]?.callback?.lifetime, "until-cancelled");
      assert.deepEqual(translated.build.adapterInputs.map(({ id }) => id), [
        "gtk4.gobject-adapters",
      ]);
      assert.deepEqual(
        translated.input.bindings
          .find(({ entry }) =>
            entry.symbol === "nts_gobject_adopt_gtk_button_new_with_label"
          )
          ?.parameters[0]?.projection,
        { kind: "utf8CString", argument: 0 },
      );
      const getter = translated.input.bindings.find(
        ({ entry }) => entry.symbol === "gtk_button_get_label",
      );
      assert.deepEqual(getter?.result, {
        type: {
          kind: "nativePointer",
          pointee: "i8",
          const: true,
          addressSpace: 0,
        },
        passMode: "pointer",
        ownership: {
          kind: "borrowed",
          scope: "receiver",
          anchor: "button",
        },
        projection: { kind: "utf8CString", nullable: true },
      });
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);
