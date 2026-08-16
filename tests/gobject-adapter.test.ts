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
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import {
  CBindgenError,
} from "@native-typescript/bindgen-c";
import {
  defineArtifactGraph,
  executeArtifactGraph,
  resolvePkgConfigSdk,
} from "@native-typescript/core";
import type { ArtifactActionDefinition } from "@native-typescript/core";
import {
  generateGObjectAdapterSource,
  ingestGir,
  planGObjectAdapterObject,
} from "@native-typescript/bindgen-gir";

const repositoryRoot = resolve(import.meta.dirname, "..");
const girPath = resolve(repositoryRoot, "fixtures/gir/Gtk-4.0.selected.gir");
const girSource = readFileSync(girPath, "utf8");
const nativeFixturePath = resolve(
  repositoryRoot,
  "fixtures/gobject-adapter/fixture.c",
);
const nativeSignalPayloadFixturePath = resolve(
  repositoryRoot,
  "fixtures/gobject-adapter/signal-payload.c",
);
const installedGtkGirPath = "/usr/share/gir-1.0/Gtk-4.0.gir";
const installedGioGirPath = "/usr/share/gir-1.0/Gio-2.0.gir";
const hasGtk = spawnSync("pkg-config", ["--exists", "gtk4"]).status === 0;
const hasClang = spawnSync("clang", ["--version"]).status === 0;
const hasXvfb = spawnSync("xvfb-run", ["--help"]).status === 0;
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

function adapter(transferOwnership: "none" | "full" = "none") {
  const source = transferOwnership === "none"
    ? girSource
    : girSource.replace(
        `<constructor name="new_with_label" c:identifier="gtk_button_new_with_label">
        <return-value transfer-ownership="none">`,
        `<constructor name="new_with_label" c:identifier="gtk_button_new_with_label">
        <return-value transfer-ownership="full">`,
      );
  const snapshot = ingestGir(source, {
    logicalPath: "fixtures/gir/Gtk-4.0.selected.gir",
    namespace: { name: "Gtk", version: "4.0" },
    classes: [{ name: "Widget" }, { name: "Button", constructors: ["new_with_label"] }],
  });
  return generateGObjectAdapterSource(snapshot);
}

function signalAdapter() {
  const snapshot = ingestGir(girSource, {
    logicalPath: "fixtures/gir/Gtk-4.0.selected.gir",
    namespace: { name: "Gtk", version: "4.0" },
    classes: [{ name: "Widget" }, {
      name: "Button",
      constructors: ["new_with_label"],
      signals: ["clicked"],
    }],
  });
  return generateGObjectAdapterSource(snapshot);
}

function valueMethodAdapter() {
  const snapshot = ingestGir(girSource, {
    logicalPath: "fixtures/gir/Gtk-4.0.selected.gir",
    namespace: { name: "Gtk", version: "4.0" },
    classes: [{ name: "Widget", methods: ["get_preferred_size"] }],
    records: [{ name: "Requisition", fields: ["width", "height"] }],
  });
  return generateGObjectAdapterSource(snapshot);
}

function scalarSignalAdapter() {
  const source = girSource.replace(
    `<glib:signal name="clicked" when="first" action="1">
        <return-value transfer-ownership="none">
          <type name="none" c:type="void"/>
        </return-value>
      </glib:signal>`,
    `<glib:signal name="resized" when="first">
        <return-value transfer-ownership="none">
          <type name="none" c:type="void"/>
        </return-value>
        <parameters>
          <parameter name="width" transfer-ownership="none">
            <type name="gint" c:type="gint"/>
          </parameter>
          <parameter name="scale" transfer-ownership="none">
            <type name="gdouble" c:type="gdouble"/>
          </parameter>
        </parameters>
      </glib:signal>`,
  );
  const snapshot = ingestGir(source, {
    logicalPath: "fixtures/gir/Gtk-4.0.selected.gir",
    namespace: { name: "Gtk", version: "4.0" },
    classes: [{ name: "Widget" }, { name: "Button", signals: ["resized"] }],
  });
  return generateGObjectAdapterSource(snapshot);
}

function installedScalarSignalAdapter() {
  const snapshot = ingestGir(readFileSync(installedGtkGirPath, "utf8"), {
    logicalPath: "sdk/Gtk-4.0.gir",
    namespace: { name: "Gtk", version: "4.0" },
    classes: [{ name: "Widget" }, {
      name: "DrawingArea",
      constructors: ["new"],
      signals: ["resize"],
    }],
  });
  return generateGObjectAdapterSource(snapshot);
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value as Readonly<Record<string, unknown>>)) {
    assertDeepFrozen(child, seen);
  }
}

test(
  "adapters for same-named classes in two namespaces do not collide",
  { skip: !existsSync(installedGtkGirPath) || !existsSync(installedGioGirPath) },
  () => {
    // Gio.Application and Gtk.Application link into one executable, and a
    // class name is unique only inside its namespace. Symbols keyed by class
    // name alone produced a duplicate definition at link time.
    const gio = ingestGir(readFileSync(installedGioGirPath, "utf8"), {
      logicalPath: "system-sdk/gir/Gio-2.0.gir",
      namespace: { name: "Gio", version: "2.0" },
      classes: [{ name: "Application", constructors: ["new"], signals: ["activate"] }],
    });
    const gtk = ingestGir(readFileSync(installedGtkGirPath, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [{ name: "Application", constructors: ["new"] }],
    });

    function definedSymbols(source: string): readonly string[] {
      return [
        ...source.matchAll(
          /^(?:static\s+)?[A-Za-z_][\w \t*]*?([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/gmu,
        ),
      ].map((match) => match[1]!);
    }

    const gioSymbols = definedSymbols(generateGObjectAdapterSource(gio).source);
    const gtkSymbols = definedSymbols(generateGObjectAdapterSource(gtk).source);
    assert.ok(gioSymbols.length > 0 && gtkSymbols.length > 0);
    assert.deepEqual(
      gioSymbols.filter((symbol) => gtkSymbols.includes(symbol)),
      [],
    );

    // The release adapter is the one that was keyed by class name alone.
    assert.equal(gioSymbols.includes("nts_gobject_release_gio_application"), true);
    assert.equal(gtkSymbols.includes("nts_gobject_release_gtk_application"), true);
  },
);

test("GObject constructors normalize borrowed floating results to one strong reference", () => {
  const generated = adapter();
  assert.equal(generated.schema, "native-typescript.gobject-adapter-source");
  assert.equal(generated.schemaVersion, 6);
  assert.match(generated.sourceDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(generated.constructors, [
    {
      id: "Button.constructor.new_with_label",
      className: "Button",
      nativeType: "GtkButton",
      sourceSymbol: "gtk_button_new_with_label",
      adapterSymbol: "nts_gobject_adopt_gtk_button_new_with_label",
      releaseSymbol: "nts_gobject_release_gtk_button",
      sourceTransfer: "none",
      acquisition: "ref-sink",
      nullable: false,
    },
  ]);
  assert.equal(generated.signalConnection, null);
  assert.deepEqual(generated.signals, []);
  assert.match(
    generated.source,
    /GtkButton \*nts_gobject_adopt_gtk_button_new_with_label\(const char \* parameter_0000\)/u,
  );
  assert.match(generated.source, /g_object_ref_sink\(value\);/u);
  assert.equal(generated.source.includes("g_object_is_floating"), false);
  assert.match(
    generated.source,
    /void nts_gobject_release_gtk_button\(GtkButton \*value\)/u,
  );
  assertDeepFrozen(generated);
  assert.deepEqual(adapter(), generated);
});

test("zero-payload GObject signals share one deterministic connection ABI", () => {
  const generated = signalAdapter();
  assert.deepEqual(generated.signalConnection, {
    nativeType: "NtsGtkSignalConnection",
    disconnectSymbol: "nts_gtk_signal_connection_disconnect",
    connectedSymbol: "nts_gtk_signal_connection_connected",
    releaseSymbol: "nts_gtk_signal_connection_release",
  });
  assert.deepEqual(generated.signals, [{
    id: "Button.signal.clicked",
    className: "Button",
    nativeType: "GtkButton",
    signalName: "clicked",
    connectSymbol: "nts_gobject_connect_gtk_button_clicked",
    callbackType: "NtsGObjectGtkButtonClickedCallback",
    parameters: [],
  }]);
  assert.match(
    generated.source,
    /NtsGtkSignalConnection \*nts_gobject_connect_gtk_button_clicked/u,
  );
  assert.match(generated.source, /typedef struct NtsGObjectGtkButtonClickedConnection/u);
  assert.match(
    generated.source,
    /void nts_gtk_signal_connection_disconnect\(NtsGtkSignalConnection \*connection\)/u,
  );
  assert.match(
    generated.source,
    /gboolean nts_gtk_signal_connection_connected\(const NtsGtkSignalConnection \*connection\)/u,
  );
  assert.match(
    generated.source,
    /void nts_gtk_signal_connection_release\(NtsGtkSignalConnection \*connection\)/u,
  );
  assert.match(generated.source, /g_signal_connect\(instance, "clicked"/u);
  assert.match(generated.source, /g_object_ref\(instance\)/u);
  assert.match(generated.source, /g_signal_handler_disconnect/u);
  assert.match(generated.source, /g_object_unref\(connection->instance\)/u);
  assertDeepFrozen(generated);
  assert.deepEqual(signalAdapter(), generated);
});

test("caller-allocated record outputs become one value-returning adapter", () => {
  const generated = valueMethodAdapter();
  assert.deepEqual(generated.valueMethods, [{
    id: "Widget.method.get_preferred_size",
    className: "Widget",
    nativeType: "GtkWidget",
    sourceSymbol: "gtk_widget_get_preferred_size",
    adapterSymbol: "nts_gobject_value_gtk_widget_get_preferred_size",
    resultName: "WidgetPreferredSize",
    resultNativeType: "NtsGtkWidgetPreferredSize",
    outputs: [
      { parameterName: "minimum_size", fieldName: "minimumSize", recordName: "Requisition", nativeType: "GtkRequisition" },
      { parameterName: "natural_size", fieldName: "naturalSize", recordName: "Requisition", nativeType: "GtkRequisition" },
    ],
  }]);
  assert.match(
    generated.source,
    /typedef struct NtsGtkWidgetPreferredSize \{\n  GtkRequisition minimumSize;\n  GtkRequisition naturalSize;\n\} NtsGtkWidgetPreferredSize;/u,
  );
  assert.match(
    generated.source,
    /gtk_widget_get_preferred_size\(instance, &result\.minimumSize, &result\.naturalSize\);/u,
  );
  assert.match(generated.source, /memset\(&result, 0, sizeof result\);/u);
  assertDeepFrozen(generated);
  assert.deepEqual(valueMethodAdapter(), generated);
});

test("GObject signal adapters forward exact scalar payloads", () => {
  const generated = scalarSignalAdapter();
  assert.deepEqual(generated.signals, [{
    id: "Button.signal.resized",
    className: "Button",
    nativeType: "GtkButton",
    signalName: "resized",
    connectSymbol: "nts_gobject_connect_gtk_button_resized",
    callbackType: "NtsGObjectGtkButtonResizedCallback",
    parameters: [
      { name: "width", nativeType: "gint", sourceType: "gint" },
      { name: "scale", nativeType: "gdouble", sourceType: "gdouble" },
    ],
  }]);
  assert.match(
    generated.source,
    /typedef void \(\*NtsGObjectGtkButtonResizedCallback\)\(gint parameter_0000, gdouble parameter_0001, void \*context\);/u,
  );
  assert.match(
    generated.source,
    /connection->callback\(parameter_0000, parameter_0001, connection->context\);/u,
  );
  assertDeepFrozen(generated);
  assert.deepEqual(scalarSignalAdapter(), generated);
});

test("unsupported GObject signal shapes fail with a stable diagnostic", () => {
  const detailedSource = girSource.replace(
    '<glib:signal name="clicked" when="first" action="1">',
    '<glib:signal name="clicked" when="first" action="1" detailed="1">',
  );
  const snapshot = ingestGir(detailedSource, {
    logicalPath: "fixtures/gir/Gtk-4.0.selected.gir",
    namespace: { name: "Gtk", version: "4.0" },
    classes: [{ name: "Widget" }, { name: "Button", signals: ["clicked"] }],
  });
  assert.throws(
    () => generateGObjectAdapterSource(snapshot),
    (error: unknown) => {
      assert.ok(error instanceof CBindgenError);
      assert.deepEqual(error.diagnostics, [{
        code: "NTS5001",
        severity: "error",
        path: "Button/signal/clicked",
        message: "Only non-detailed void GObject signals with exact scalar payloads are implemented",
      }]);
      return true;
    },
  );
});

test("unsupported GObject signal payloads fail at the exact parameter", () => {
  const source = girSource.replace(
    `<return-value transfer-ownership="none">
          <type name="none" c:type="void"/>
        </return-value>
      </glib:signal>`,
    `<return-value transfer-ownership="none">
          <type name="none" c:type="void"/>
        </return-value>
        <parameters>
          <parameter name="text" transfer-ownership="none">
            <type name="utf8" c:type="const char*"/>
          </parameter>
        </parameters>
      </glib:signal>`,
  );
  const snapshot = ingestGir(source, {
    logicalPath: "fixtures/gir/Gtk-4.0.selected.gir",
    namespace: { name: "Gtk", version: "4.0" },
    classes: [{ name: "Widget" }, { name: "Button", signals: ["clicked"] }],
  });
  assert.throws(
    () => generateGObjectAdapterSource(snapshot),
    (error: unknown) => {
      assert.ok(error instanceof CBindgenError);
      assert.deepEqual(error.diagnostics, [{
        code: "NTS5001",
        severity: "error",
        path: "Button/signal/clicked/parameters/0",
        message: "Only exact gint and gdouble GObject signal payloads are implemented",
      }]);
      return true;
    },
  );
});

test("owned GObject constructor results preserve an existing reference and sink only floating results", () => {
  const generated = adapter("full");
  assert.equal(generated.constructors[0]?.sourceTransfer, "full");
  assert.equal(generated.constructors[0]?.acquisition, "sink-if-floating");
  assert.match(generated.source, /if \(g_object_is_floating\(value\)\)/u);
  assert.match(generated.source, /g_object_ref_sink\(value\);/u);
});

test("generated GObject adapters are first-class artifact graph inputs", () => {
  const generated = adapter();
  const plan = planGObjectAdapterObject({
    adapter: generated,
    sourceArtifactId: "source/gtk/gobject-adapters",
    objectArtifactId: "object/gtk/gobject-adapters",
    actionId: "compile/gtk/gobject-adapters",
    logicalPath: "generated/gtk/gobject-adapters.c",
    artifactFileName: "gobject-adapters.o",
    arguments: [],
    tool: {
      id: "tool/clang",
      version: "test",
      digest: `sha256:${"0".repeat(64)}`,
    },
    executionPlatform: "x86_64-linux",
    target: "x86_64-unknown-linux-gnu",
  });
  const graph = defineArtifactGraph({
    artifacts: [plan.source, plan.object],
    actions: [plan.action],
  });
  assert.equal(plan.source.origin.kind, "source");
  assert.equal(plan.source.origin.digest, generated.sourceDigest);
  assert.deepEqual(plan.action.inputs, [plan.source.id]);
  assert.deepEqual(plan.action.outputs, [plan.object.id]);
  assert.equal(plan.action.cacheable, false);
  assert.equal(JSON.stringify(graph).includes(repositoryRoot), false);
  assertDeepFrozen(plan);
});

test(
  "a generated GTK constructor adapter releases its exact strong reference",
  {
    skip:
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      !existsSync(nativeFixturePath) ||
      !hasGtk ||
      !hasClang ||
      !hasXvfb ||
      !hasBubblewrap,
  },
  async () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "native-typescript-gobject-adapter-"),
    );
    try {
      const generatedPath = join(temporaryRoot, "gobject-adapters.c");
      const executablePath = join(temporaryRoot, "gobject-adapter-test");
      const generated = adapter();
      writeFileSync(generatedPath, generated.source);
      const clangPath = executable("clang");
      const pkgConfigPath = executable("pkg-config");
      const sdk = await resolvePkgConfigSdk({
        id: "gtk4-gobject-adapter",
        executable: pkgConfigPath,
        modules: ["gtk4"],
        target: "x86_64-unknown-linux-gnu",
      });
      const plan = planGObjectAdapterObject({
        adapter: generated,
        sourceArtifactId: "source/gtk/gobject-adapters",
        objectArtifactId: "object/gtk/gobject-adapters",
        actionId: "compile/gtk/gobject-adapters",
        logicalPath: "generated/gtk/gobject-adapters.c",
        artifactFileName: "gobject-adapters.o",
        arguments: sdk.compileArguments,
        tool: toolIdentity(clangPath),
        executionPlatform: "x86_64-linux",
        target: "x86_64-unknown-linux-gnu",
      });
      const graph = defineArtifactGraph({
        artifacts: [plan.source, ...sdk.artifacts, plan.object],
        actions: [plan.action],
      });
      const report = await executeArtifactGraph(graph, {
        buildRoot: join(temporaryRoot, "build"),
        sourcePaths: {
          ...sdk.sourcePaths,
          [plan.source.id]: generatedPath,
        },
        tools: { [plan.action.tool.id]: { path: clangPath } },
        sandbox: { kind: "bubblewrap", path: executable("bwrap") },
      });
      const object = report.artifacts.find(({ id }) => id === plan.object.id);
      assert.ok(object);
      const pkgConfig = spawnSync(
        "pkg-config",
        ["--cflags", "--libs", "gtk4"],
        { encoding: "utf8" },
      );
      assert.equal(pkgConfig.status, 0, pkgConfig.stderr);
      const flags = pkgConfig.stdout.trim().split(/\s+/u).filter(Boolean);
      const compile = spawnSync(
        "clang",
        [
          "-std=gnu11",
          "-Wall",
          "-Wextra",
          "-Werror",
          nativeFixturePath,
          object.path,
          ...flags,
          "-o",
          executablePath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(compile.status, 0, compile.stderr);
      const run = spawnSync("xvfb-run", ["-a", executablePath], {
        encoding: "utf8",
        env: { ...process.env, G_DEBUG: "fatal-warnings" },
      });
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test(
  "two namespaces' generated adapters link into one executable",
  {
    skip:
      process.platform !== "linux" ||
      !existsSync(installedGtkGirPath) ||
      !existsSync(installedGioGirPath) ||
      !hasGtk ||
      !hasClang,
  },
  () => {
    // The symbol-disjointness check above is textual. This is the property it
    // stands for: two adapter objects in one link. A collision here is a
    // "multiple definition" error from the linker, which is how the
    // Gio.Application / Gtk.Application clash would have surfaced.
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "native-typescript-adapter-link-"),
    );
    try {
      const gio = ingestGir(readFileSync(installedGioGirPath, "utf8"), {
        logicalPath: "system-sdk/gir/Gio-2.0.gir",
        namespace: { name: "Gio", version: "2.0" },
        classes: [
          { name: "Application", constructors: ["new"], signals: ["activate"] },
        ],
      });
      const gtk = ingestGir(readFileSync(installedGtkGirPath, "utf8"), {
        logicalPath: "system-sdk/gir/Gtk-4.0.gir",
        namespace: { name: "Gtk", version: "4.0" },
        classes: [{ name: "Application", constructors: ["new"] }],
      });

      const pkgConfig = spawnSync(
        "pkg-config",
        ["--cflags", "--libs", "gtk4"],
        { encoding: "utf8" },
      );
      assert.equal(pkgConfig.status, 0, pkgConfig.stderr);
      const flags = pkgConfig.stdout.trim().split(/\s+/u).filter(Boolean);

      const objects: string[] = [];
      for (const [name, snapshot] of [
        ["gio", gio],
        ["gtk", gtk],
      ] as const) {
        const sourcePath = join(temporaryRoot, `${name}-adapters.c`);
        const objectPath = join(temporaryRoot, `${name}-adapters.o`);
        writeFileSync(sourcePath, generateGObjectAdapterSource(snapshot).source);
        const compile = spawnSync(
          "clang",
          [
            "-std=gnu11",
            "-Wall",
            "-Wextra",
            "-Werror",
            ...flags.filter((flag) => !flag.startsWith("-l")),
            "-c",
            sourcePath,
            "-o",
            objectPath,
          ],
          { encoding: "utf8" },
        );
        assert.equal(compile.status, 0, compile.stderr);
        objects.push(objectPath);
      }

      const mainPath = join(temporaryRoot, "main.c");
      const executablePath = join(temporaryRoot, "adapter-link");
      writeFileSync(mainPath, "int main(void) { return 0; }\n");
      const link = spawnSync(
        "clang",
        [mainPath, ...objects, ...flags, "-o", executablePath],
        { encoding: "utf8" },
      );
      assert.equal(link.status, 0, link.stderr);
      assert.doesNotMatch(link.stderr, /multiple definition/u);
      assert.equal(spawnSync(executablePath).status, 0);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test(
  "a generated GTK signal adapter forwards real scalar payloads and disconnects",
  {
    skip:
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      !existsSync(nativeSignalPayloadFixturePath) ||
      !existsSync(installedGtkGirPath) ||
      !hasGtk ||
      !hasClang ||
      !hasXvfb ||
      !hasBubblewrap,
  },
  async () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "native-typescript-gobject-signal-payload-"),
    );
    try {
      const generatedPath = join(temporaryRoot, "gobject-adapters.c");
      const executablePath = join(temporaryRoot, "gobject-signal-payload-test");
      const generated = installedScalarSignalAdapter();
      writeFileSync(generatedPath, generated.source);
      const clangPath = executable("clang");
      const pkgConfigPath = executable("pkg-config");
      const sdk = await resolvePkgConfigSdk({
        id: "gtk4-gobject-signal-payload",
        executable: pkgConfigPath,
        modules: ["gtk4"],
        target: "x86_64-unknown-linux-gnu",
      });
      const plan = planGObjectAdapterObject({
        adapter: generated,
        sourceArtifactId: "source/gtk/gobject-signal-payload-adapters",
        objectArtifactId: "object/gtk/gobject-signal-payload-adapters",
        actionId: "compile/gtk/gobject-signal-payload-adapters",
        logicalPath: "generated/gtk/gobject-signal-payload-adapters.c",
        artifactFileName: "gobject-signal-payload-adapters.o",
        arguments: sdk.compileArguments,
        tool: toolIdentity(clangPath),
        executionPlatform: "x86_64-linux",
        target: "x86_64-unknown-linux-gnu",
      });
      const graph = defineArtifactGraph({
        artifacts: [plan.source, ...sdk.artifacts, plan.object],
        actions: [plan.action],
      });
      const report = await executeArtifactGraph(graph, {
        buildRoot: join(temporaryRoot, "build"),
        sourcePaths: {
          ...sdk.sourcePaths,
          [plan.source.id]: generatedPath,
        },
        tools: { [plan.action.tool.id]: { path: clangPath } },
        sandbox: { kind: "bubblewrap", path: executable("bwrap") },
      });
      const object = report.artifacts.find(({ id }) => id === plan.object.id);
      assert.ok(object);
      const pkgConfig = spawnSync(
        "pkg-config",
        ["--cflags", "--libs", "gtk4"],
        { encoding: "utf8" },
      );
      assert.equal(pkgConfig.status, 0, pkgConfig.stderr);
      const flags = pkgConfig.stdout.trim().split(/\s+/u).filter(Boolean);
      const compile = spawnSync(
        "clang",
        [
          "-std=gnu11",
          "-Wall",
          "-Wextra",
          "-Werror",
          nativeSignalPayloadFixturePath,
          object.path,
          ...flags,
          "-o",
          executablePath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(compile.status, 0, compile.stderr);
      const run = spawnSync("xvfb-run", ["-a", executablePath], {
        encoding: "utf8",
        env: { ...process.env, G_DEBUG: "fatal-warnings" },
      });
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);
