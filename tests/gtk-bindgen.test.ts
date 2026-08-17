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
  parseClangAbiEvidence,
  planClangAbiProbe,
} from "@native-typescript/bindgen-c";
import {
  defineArtifactGraph,
  executeArtifactGraph,
  resolvePkgConfigSdk,
} from "@native-typescript/core";
import type { ArtifactActionDefinition } from "@native-typescript/core";
import {
  generateGObjectAdapterSource,
  generateGObjectScabiPackage,
  generateGirClangAbiProbe,
  ingestGir,
} from "@native-typescript/bindgen-gir";
import { translateScabiNativeProgram } from "@native-typescript/scriptc";

const systemGtkGir = "/usr/share/gir-1.0/Gtk-4.0.gir";
const systemGioGir = "/usr/share/gir-1.0/Gio-2.0.gir";
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
          methods: ["activate", "get_opacity", "get_preferred_size", "get_width", "set_opacity", "set_visible"],
        },
        {
          name: "Window",
          constructors: ["new"],
          methods: ["destroy", "present", "set_child", "set_default_size"],
        },
      ],
      records: [{ name: "Requisition", fields: ["width", "height"] }],
      enumerations: [{ name: "Orientation", members: ["horizontal", "vertical"] }],
    });
    const gobjectAdapter = generateGObjectAdapterSource(snapshot);
    const probe = generateGirClangAbiProbe(snapshot, gobjectAdapter);
    assert.deepEqual(probe.functions.map(({ symbol }) => symbol), [
      "gtk_button_new_with_label",
      "gtk_button_get_label",
      "gtk_button_set_label",
      "gtk_widget_activate",
      "gtk_widget_get_opacity",
      "gtk_widget_get_preferred_size",
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
    assert.deepEqual(probe.records.map(({ typeName }) => typeName), [
      "GtkRequisition",
      "NtsGtkWidgetPreferredSize",
    ]);
    assert.deepEqual(probe.enums, [{
      id: "Gtk.Orientation.enumeration",
      typeName: "GtkOrientation",
      members: [
        { name: "horizontal", cIdentifier: "GTK_ORIENTATION_HORIZONTAL", value: "0" },
        { name: "vertical", cIdentifier: "GTK_ORIENTATION_VERTICAL", value: "1" },
      ],
    }]);

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
    const plan = planClangAbiProbe({
      probe,
      sourceArtifactId: "source/gtk4/clang-abi-probe",
      rawAstArtifactId: "metadata/gtk4/clang-abi-ast",
      rawLlvmArtifactId: "metadata/gtk4/clang-abi-llvm",
      astActionId: "inspect/gtk4/clang-abi",
      llvmActionId: "inspect/gtk4/clang-calling-convention",
      logicalPath: "generated/gtk4/clang-abi-probe.c",
      arguments: sdk.compileArguments,
      tool: clang,
      executionPlatform,
      target,
    });
    const graph = defineArtifactGraph({
      artifacts: [plan.source, ...sdk.artifacts, plan.rawAst, plan.rawLlvm],
      actions: [plan.astAction, plan.llvmAction],
    });
    assert.equal(JSON.stringify(graph).includes("/usr/include"), false);

    const temporaryRoot = mkdtempSync(join(tmpdir(), "native-typescript-gtk-clang-"));
    try {
      const sourcePath = join(temporaryRoot, "clang-abi-probe.c");
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
      const llvm = report.artifacts.find(({ id }) => id === plan.rawLlvm.id);
      assert.ok(ast);
      assert.ok(llvm);
      const evidence = parseClangAbiEvidence(
        readFileSync(ast.path, "utf8"),
        readFileSync(llvm.path, "utf8"),
        {
        probe,
        clang: {
          toolId: clang.id,
          version: clang.version,
          digest: clang.digest,
          target,
        },
        },
      );
      assert.deepEqual(evidence.functions.map(({ symbol }) => symbol), [
        "gtk_button_new_with_label",
        "gtk_button_get_label",
        "gtk_button_set_label",
        "gtk_widget_activate",
        "gtk_widget_get_opacity",
        "gtk_widget_get_preferred_size",
        "gtk_widget_get_width",
        "gtk_widget_set_opacity",
        "gtk_widget_set_visible",
        "gtk_window_new",
        "gtk_window_destroy",
        "gtk_window_present",
        "gtk_window_set_child",
        "gtk_window_set_default_size",
      ]);
      assert.deepEqual(evidence.records[0], {
        id: "Gtk.Requisition.record",
        typeName: "GtkRequisition",
        size: 8,
        alignment: 4,
        fields: [
          {
            name: "width",
            expectedType: "int",
            clangType: "int",
            offset: 0,
            size: 4,
            alignment: 4,
          },
          {
            name: "height",
            expectedType: "int",
            clangType: "int",
            offset: 4,
            size: 4,
            alignment: 4,
          },
        ],
        callingConvention: {
          result: {
            type: { kind: "integer", bits: 64 },
            alignment: null,
            stackAlignment: null,
            extension: null,
            inRegister: false,
            byValue: null,
            structureReturn: null,
          },
          parameters: [{
            type: { kind: "integer", bits: 64 },
            alignment: null,
            stackAlignment: null,
            extension: null,
            inRegister: false,
            byValue: null,
            structureReturn: null,
          }],
        },
      });
      assert.equal(evidence.records[1]?.id, "Gtk.Widget.method.get_preferred_size.result");
      assert.equal(evidence.records[1]?.typeName, "NtsGtkWidgetPreferredSize");
      assert.equal(evidence.records[1]?.size, 16);
      assert.equal(evidence.records[1]?.alignment, 4);
      assert.deepEqual(evidence.records[1]?.fields.map(({ name, offset, size, alignment }) => ({
        name,
        offset,
        size,
        alignment,
      })), [
        { name: "minimumSize", offset: 0, size: 8, alignment: 4 },
        { name: "naturalSize", offset: 8, size: 8, alignment: 4 },
      ]);
      assert.deepEqual(evidence.enums, [{
        id: "Gtk.Orientation.enumeration",
        typeName: "GtkOrientation",
        clangType: "enum GtkOrientation",
        size: 4,
        alignment: 4,
        signed: false,
        members: [
          { name: "horizontal", cIdentifier: "GTK_ORIENTATION_HORIZONTAL", value: "0" },
          { name: "vertical", cIdentifier: "GTK_ORIENTATION_VERTICAL", value: "1" },
        ],
      }]);
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
            methods: ["activate", "get_opacity", "get_preferred_size", "get_width", "set_opacity", "set_visible"],
          },
          {
            name: "Window",
            constructors: ["new"],
            methods: ["destroy", "present", "set_child", "set_default_size"],
          },
        ],
        records: [{ name: "Requisition", fields: ["width", "height"] }],
        enumerations: [{ name: "Orientation", members: ["horizontal", "vertical"] }],
      });
      const gobjectAdapter = generateGObjectAdapterSource(bindingSnapshot);
      const generated = generateGObjectScabiPackage({
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
        "gtk_orientation_horizontal",
        "gtk_orientation_vertical",
        "gtk_signal_connection_connected",
        "gtk_signal_connection_disconnect",
        "gtk_signal_connection_release",
        "gtk_widget_activate",
        "gtk_widget_get_opacity",
        "gtk_widget_get_width",
        "gtk_widget_release",
        "gtk_widget_set_opacity",
        "gtk_widget_set_visible",
        "gtk_window_destroy",
        "gtk_window_new",
        "gtk_window_present",
        "gtk_window_release",
        "gtk_window_set_child",
        "gtk_window_set_default_size",
        "nts_gobject_value_gtk_widget_get_preferred_size",
      ]);
      assert.match(
        generated.declarations,
        /static withLabel\(label: string\): Button;/u,
      );
      /* A getter that can report the value as absent projects as a method:
       * a property would claim a stability a native read does not have. */
      assert.match(generated.declarations, /setLabel\(label: string\): void;/u);
      assert.match(generated.declarations, /getLabel\(\): string \| null;/u);
      /* A nullable getter keeps its method shape: a property would claim a
   * stability a native read does not have, and would break the null check
   * anyone writes first. */
  assert.doesNotMatch(generated.declarations, /get label|set label/u);
      assert.match(generated.declarations, /class Button extends Widget/u);
      assert.match(generated.declarations, /class Window extends Widget/u);
      assert.match(
        generated.declarations,
        /namespace Orientation \{[^}]*const Horizontal: Orientation;[^}]*const Vertical: Orientation;/su,
      );
      assert.match(
        generated.declarations,
        /interface Requisition \{[^}]*readonly width: gint;[^}]*readonly height: gint;/su,
      );
      assert.match(generated.declarations, /activate\(\): boolean;/u);
      assert.match(generated.declarations, /get opacity\(\): gdouble;/u);
      assert.match(generated.declarations, /getPreferredSize\(\): WidgetPreferredSize;/u);
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
      /* GIR marks `gtk_window_set_child`'s child nullable, and absence is
       * what clears the child. */
      assert.match(
        generated.declarations,
        /setChild\(child: Widget \| null\): void;/u,
      );
      assert.match(
        generated.declarations,
        /setDefaultSize\(width: gint, height: gint\): void;/u,
      );
      assert.deepEqual(generated.manifest.declarations.types, {
        gdouble: { module: ".", name: "gdouble" },
        gint: { module: ".", name: "gint" },
        gtk_orientation: { module: ".", name: "Orientation" },
        gtk_button: { module: ".", name: "Button" },
        gtk_requisition: { module: ".", name: "Requisition" },
        gtk_signal_connection: {
          module: ".",
          name: "SignalConnection",
        },
        gtk_widget: { module: ".", name: "Widget" },
        gtk_widget_preferred_size: { module: ".", name: "WidgetPreferredSize" },
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
        identity: "pointer",
        upcasts: [{ kind: "identity", target: "gtk_widget" }],
        destructor: "gtk_button_release",
      });
      assert.deepEqual(generated.manifest.types.gtk_orientation_storage, {
        kind: "integer",
        signed: false,
        bits: 32,
      });
      assert.deepEqual(generated.manifest.types.gtk_orientation, {
        kind: "enum",
        underlying: "gtk_orientation_storage",
        members: { Horizontal: "0", Vertical: "1" },
      });
      assert.deepEqual(generated.manifest.types.gtk_window, {
        kind: "handle",
        nativeName: "GtkWindow",
        threadSafety: "confined",
        identity: "pointer",
        upcasts: [{ kind: "identity", target: "gtk_widget" }],
        destructor: "gtk_window_release",
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
          "gtk_orientation_vertical",
          "gtk_widget_activate",
          "gtk_widget_get_opacity",
          "gtk_widget_get_width",
          "gtk_widget_release",
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
      assert.deepEqual(translated.input.constants, [{
        id: "native-typescript.gtk4@0.0.0#gtk_orientation_vertical",
        declaration: { module: "@native-typescript/gtk4", name: "Orientation.Vertical" },
        type: { kind: "nativeScalar", scalar: "u32" },
        value: "1",
      }]);
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
      /* Neither names a source type. Both are transparent aliases for
       * `number` — `gint` widened out of an exact slot, `gdouble` because
       * the slot is a double already — and registering either here would
       * hand the checker a branded reading of every plain number. */
      assert.deepEqual(
        translated.input.sourceTypes.filter(
          ({ declaration }) => declaration.name === "gdouble" || declaration.name === "gint",
        ),
        [],
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
      /* A double crosses as itself: the projection changes the source view
       * and converts nothing, so the slot stays the f64 it always was. */
      assert.deepEqual(getOpacity?.result, {
        type: { kind: "nativeScalar", scalar: "f64" },
        passMode: "value",
        ownership: { kind: "value" },
        projection: { kind: "number" },
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
        type: { kind: "f64" },
      });
      assert.deepEqual(setOpacity?.parameters[1], {
        name: "opacity",
        type: { kind: "nativeScalar", scalar: "f64" },
        passMode: "value",
        ownership: { kind: "value" },
        projection: { kind: "number", argument: 1 },
      });
      const getWidth = translated.input.bindings.find(
        ({ entry }) => entry.symbol === "gtk_widget_get_width",
      );
      /* The slot stays an exact i32; the projection is what widens it into
       * the plain number the source reads. */
      assert.deepEqual(getWidth?.result, {
        type: { kind: "nativeScalar", scalar: "i32" },
        passMode: "value",
        ownership: { kind: "value" },
        projection: { kind: "number" },
      });
      const setDefaultSize = translated.input.bindings.find(
        ({ entry }) => entry.symbol === "gtk_window_set_default_size",
      );
      /* The source takes plain numbers and the physical slots stay exact, so
       * each argument is an f64 the checked ingress converts. */
      assert.deepEqual(setDefaultSize?.arguments.slice(1), [
        { name: "width", type: { kind: "f64" } },
        { name: "height", type: { kind: "f64" } },
      ]);
      assert.deepEqual(
        setDefaultSize?.parameters.slice(1).map(({ type, projection }) => ({
          type,
          projection,
        })),
        [
          {
            type: { kind: "nativeScalar", scalar: "i32" },
            projection: { kind: "number", argument: 1 },
          },
          {
            type: { kind: "nativeScalar", scalar: "i32" },
            projection: { kind: "number", argument: 2 },
          },
        ],
      );
      const connect = translated.input.bindings.find(
        ({ entry }) => entry.symbol === "nts_gobject_connect_gtk_button_clicked",
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

test(
  "target Clang proves the storage of an enumeration another namespace owns",
  {
    skip:
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      !existsSync(systemGtkGir) ||
      !existsSync(systemGioGir) ||
      !hasGtk ||
      !hasClang ||
      !hasBubblewrap,
  },
  async () => {
    // gtk_application_new() takes a GApplicationFlags, which Gio owns. The
    // importing package proves that storage against its own headers rather
    // than trusting the owning package, so SDK skew between two packages
    // cannot pass unnoticed.
    const gio = ingestGir(readFileSync(systemGioGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gio-2.0.gir",
      namespace: { name: "Gio", version: "2.0" },
      classes: [{ name: "Application" }],
      enumerations: [
        { name: "ApplicationFlags", members: ["default_flags", "is_service"] },
      ],
    });
    const snapshot = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [{ name: "Application", constructors: ["new"] }],
    });
    const gobjectAdapter = generateGObjectAdapterSource(snapshot);
    const probe = generateGirClangAbiProbe(snapshot, gobjectAdapter, [gio]);

    // The foreign enumeration is a probe candidate because a selected callable
    // reaches it. Nothing else from Gio is.
    assert.deepEqual(probe.enums.map(({ id, typeName }) => ({ id, typeName })), [
      { id: "Gio.ApplicationFlags.bitfield", typeName: "GApplicationFlags" },
    ]);

    const clangPath = executable("clang");
    const clang = toolIdentity(clangPath);
    const sdk = await resolvePkgConfigSdk({
      id: "gtk4-foreign-enum-evidence",
      executable: executable("pkg-config"),
      modules: ["gtk4"],
      target,
    });
    const plan = planClangAbiProbe({
      probe,
      sourceArtifactId: "source/gtk4/clang-abi-probe",
      rawAstArtifactId: "metadata/gtk4/clang-abi-ast",
      rawLlvmArtifactId: "metadata/gtk4/clang-abi-llvm",
      astActionId: "inspect/gtk4/clang-abi",
      llvmActionId: "inspect/gtk4/clang-calling-convention",
      logicalPath: "generated/gtk4/clang-abi-probe.c",
      arguments: sdk.compileArguments,
      tool: clang,
      executionPlatform,
      target,
    });
    const graph = defineArtifactGraph({
      artifacts: [plan.source, ...sdk.artifacts, plan.rawAst, plan.rawLlvm],
      actions: [plan.astAction, plan.llvmAction],
    });

    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "native-typescript-foreign-enum-"),
    );
    try {
      const sourcePath = join(temporaryRoot, "clang-abi-probe.c");
      writeFileSync(sourcePath, probe.source);
      const report = await executeArtifactGraph(graph, {
        buildRoot: join(temporaryRoot, "build"),
        sourcePaths: { ...sdk.sourcePaths, [plan.source.id]: sourcePath },
        tools: { [clang.id]: { path: clangPath } },
        sandbox: { kind: "bubblewrap", path: executable("bwrap") },
      });
      const ast = report.artifacts.find(({ id }) => id === plan.rawAst.id);
      const llvm = report.artifacts.find(({ id }) => id === plan.rawLlvm.id);
      assert.ok(ast && llvm);
      if (!ast || !llvm) return;
      const evidence = parseClangAbiEvidence(
        readFileSync(ast.path, "utf8"),
        readFileSync(llvm.path, "utf8"),
        {
          probe,
          clang: {
            toolId: clang.id,
            version: clang.version,
            digest: clang.digest,
            target,
          },
        },
      );
      const flags = evidence.enums[0];
      assert.ok(flags);
      assert.equal(flags.id, "Gio.ApplicationFlags.bitfield");
      assert.equal(flags.typeName, "GApplicationFlags");
      assert.equal(flags.size, 4);
      assert.deepEqual(
        flags.members.map(({ cIdentifier, value }) => ({ cIdentifier, value })),
        [
          { cIdentifier: "G_APPLICATION_DEFAULT_FLAGS", value: "0" },
          { cIdentifier: "G_APPLICATION_IS_SERVICE", value: "1" },
        ],
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test(
  "a throwing callable is not a direct probe candidate",
  { skip: !existsSync(systemGioGir) },
  () => {
    // GIR omits the trailing GError** from a throws=1 callable, so asserting
    // its GIR parameter list against the header is a guaranteed ABI mismatch.
    // Clang would report that first and bury the real reason, which generation
    // states precisely.
    const gio = ingestGir(readFileSync(systemGioGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gio-2.0.gir",
      namespace: { name: "Gio", version: "2.0" },
      classes: [
        { name: "Application", constructors: ["new"], methods: ["register"] },
      ],
      enumerations: [{ name: "ApplicationFlags", members: ["default_flags"] }],
    });
    const probe = generateGirClangAbiProbe(gio, generateGObjectAdapterSource(gio));
    assert.equal(
      probe.functions.some(({ symbol }) => symbol === "g_application_register"),
      false,
    );
    // The constructor beside it still is one, so this excludes the throwing
    // member rather than the class.
    assert.equal(
      probe.functions.some(({ symbol }) => symbol === "g_application_new"),
      true,
    );
  },
);
