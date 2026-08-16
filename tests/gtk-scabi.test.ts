import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  CBindgenError,
  digestClangAbiEvidence,
  renderCFunctionPointerType,
  renderCType,
} from "@native-typescript/bindgen-c";
import type {
  ClangAbiValue,
  ClangAbiEvidenceSnapshot,
  ClangAbiProbe,
} from "@native-typescript/bindgen-c";
import {
  canonicalizeJson,
  digestScabiManifest,
} from "@native-typescript/scabi";
import {
  composeScriptCNativePrograms,
  translateScabiNativeProgram,
} from "@native-typescript/scriptc";
import {
  defineGirBindingPackageRequest,
  generateGObjectAdapterSource,
  generateGObjectScabiPackage,
  generateGirClangAbiProbe,
  ingestGir,
  planGirBindingAnalysis,
  planGirBindingPackage,
  planGirClangEvidenceNormalization,
} from "@native-typescript/bindgen-gir";
import type {
  GObjectScabiGenerationOptions,
  GObjectScabiPackage,
  GirSnapshot,
} from "@native-typescript/bindgen-gir";

const repositoryRoot = resolve(import.meta.dirname, "..");
const girSource = readFileSync(
  resolve(repositoryRoot, "fixtures/gir/Gtk-4.0.selected.gir"),
  "utf8",
);

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function snapshot(
  signals: readonly string[] = [],
  withOrientation = false,
): GirSnapshot {
  return ingestGir(girSource, {
    logicalPath: "fixtures/gir/Gtk-4.0.selected.gir",
    namespace: { name: "Gtk", version: "4.0" },
    classes: [
      { name: "Widget" },
      {
        name: "Button",
        constructors: ["new_with_label"],
        methods: ["get_label", "set_label"],
        signals,
      },
    ],
    records: [{ name: "Requisition", fields: ["width", "height"] }],
    enumerations: withOrientation
      ? [{ name: "Orientation", members: ["horizontal", "vertical"] }]
      : [],
  });
}

function scalarSignalSnapshot(): GirSnapshot {
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
  return ingestGir(source, {
    logicalPath: "fixtures/gir/Gtk-4.0.selected.gir",
    namespace: { name: "Gtk", version: "4.0" },
    classes: [{ name: "Widget" }, {
      name: "Button",
      constructors: ["new_with_label"],
      methods: ["get_label", "set_label"],
      signals: ["resized"],
    }],
  });
}

function valueMethodSnapshot(): GirSnapshot {
  return ingestGir(girSource, {
    logicalPath: "fixtures/gir/Gtk-4.0.selected.gir",
    namespace: { name: "Gtk", version: "4.0" },
    classes: [{ name: "Widget", methods: ["get_preferred_size"] }],
    records: [{ name: "Requisition", fields: ["width", "height"] }],
  });
}

function flagsPropertySnapshot(): GirSnapshot {
  const source = girSource.replace(
    "  </namespace>",
    `    <bitfield name="EventControllerScrollFlags"
              glib:type-name="GtkEventControllerScrollFlags"
              glib:get-type="gtk_event_controller_scroll_flags_get_type"
              c:type="GtkEventControllerScrollFlags">
      <member name="vertical"
              value="1"
              c:identifier="GTK_EVENT_CONTROLLER_SCROLL_VERTICAL"
              glib:nick="vertical"
              glib:name="GTK_EVENT_CONTROLLER_SCROLL_VERTICAL"/>
      <member name="horizontal"
              value="2"
              c:identifier="GTK_EVENT_CONTROLLER_SCROLL_HORIZONTAL"
              glib:nick="horizontal"
              glib:name="GTK_EVENT_CONTROLLER_SCROLL_HORIZONTAL"/>
      <member name="both_axes"
              value="3"
              c:identifier="GTK_EVENT_CONTROLLER_SCROLL_BOTH_AXES"
              glib:nick="both-axes"
              glib:name="GTK_EVENT_CONTROLLER_SCROLL_BOTH_AXES"/>
    </bitfield>
    <class name="EventController"
           c:symbol-prefix="event_controller"
           c:type="GtkEventController"
           abstract="1"
           glib:type-name="GtkEventController"
           glib:get-type="gtk_event_controller_get_type"/>
    <class name="EventControllerScroll"
           c:symbol-prefix="event_controller_scroll"
           c:type="GtkEventControllerScroll"
           parent="EventController"
           glib:type-name="GtkEventControllerScroll"
           glib:get-type="gtk_event_controller_scroll_get_type">
      <constructor name="new" c:identifier="gtk_event_controller_scroll_new">
        <return-value transfer-ownership="full">
          <type name="EventController" c:type="GtkEventController*"/>
        </return-value>
        <parameters>
          <parameter name="flags" transfer-ownership="none">
            <type name="EventControllerScrollFlags"
                  c:type="GtkEventControllerScrollFlags"/>
          </parameter>
        </parameters>
      </constructor>
      <method name="get_flags"
              c:identifier="gtk_event_controller_scroll_get_flags"
              glib:get-property="flags">
        <return-value transfer-ownership="none">
          <type name="EventControllerScrollFlags"
                c:type="GtkEventControllerScrollFlags"/>
        </return-value>
        <parameters>
          <instance-parameter name="scroll" transfer-ownership="none">
            <type name="EventControllerScroll"
                  c:type="GtkEventControllerScroll*"/>
          </instance-parameter>
        </parameters>
      </method>
      <method name="set_flags"
              c:identifier="gtk_event_controller_scroll_set_flags"
              glib:set-property="flags">
        <return-value transfer-ownership="none">
          <type name="none" c:type="void"/>
        </return-value>
        <parameters>
          <instance-parameter name="scroll" transfer-ownership="none">
            <type name="EventControllerScroll"
                  c:type="GtkEventControllerScroll*"/>
          </instance-parameter>
          <parameter name="flags" transfer-ownership="none">
            <type name="EventControllerScrollFlags"
                  c:type="GtkEventControllerScrollFlags"/>
          </parameter>
        </parameters>
      </method>
    </class>
  </namespace>`,
  );
  return ingestGir(source, {
    logicalPath: "fixtures/gir/Gtk-4.0.flags.gir",
    namespace: { name: "Gtk", version: "4.0" },
    classes: [
      { name: "EventController", constructors: [], methods: [] },
      {
        name: "EventControllerScroll",
        constructors: ["new"],
        methods: ["get_flags", "set_flags"],
      },
    ],
    enumerations: [{
      name: "EventControllerScrollFlags",
      members: ["both_axes", "horizontal", "vertical"],
    }],
  });
}

function evidence(probe: ClangAbiProbe): ClangAbiEvidenceSnapshot {
  const clang = Object.freeze({
    toolId: "tool/clang",
    version: "test",
    digest: `sha256:${"a".repeat(64)}`,
    target: "x86_64-unknown-linux-gnu",
  });
  const functions = Object.freeze(probe.functions.map((function_) => {
    const type = renderCFunctionPointerType(function_, "");
    return Object.freeze({
      id: function_.id,
      symbol: function_.symbol,
      expectedType: type,
      clangType: type,
    });
  }));
  const physicalValue = (type: ClangAbiValue["type"]): ClangAbiValue => Object.freeze({
    type: Object.freeze(type),
    alignment: null,
    stackAlignment: null,
    extension: null,
    inRegister: false,
    byValue: null,
    structureReturn: null,
  });
  const records = Object.freeze(probe.records.map((record) => {
    const generated = record.definition === "generated";
    const directWord = Object.freeze({ kind: "integer" as const, bits: 64 });
    return Object.freeze({
      id: record.id,
      typeName: record.typeName,
      size: generated ? 16 : 8,
      alignment: 4,
      fields: Object.freeze(record.fields.map((field, index) => Object.freeze({
        name: field.name,
        expectedType: renderCType(field.type),
        clangType: renderCType(field.type),
        offset: index * (generated ? 8 : 4),
        size: generated ? 8 : 4,
        alignment: 4,
      }))),
      callingConvention: Object.freeze({
        result: physicalValue(generated
          ? { kind: "struct" as const, packed: false, fields: [directWord, directWord] }
          : directWord),
        parameters: Object.freeze(generated
          ? [physicalValue(directWord), physicalValue(directWord)]
          : [physicalValue(directWord)]),
      }),
    });
  }));
  const enums = Object.freeze(probe.enums.map((enum_) => Object.freeze({
    id: enum_.id,
    typeName: enum_.typeName,
    clangType: enum_.typeName,
    size: 4,
    alignment: 4,
    signed: false,
    members: Object.freeze(enum_.members.map((member) => Object.freeze({ ...member }))),
  })));
  const semanticInput = {
    probeDigest: probe.sourceDigest,
    clang,
    functions,
    records,
    enums,
  };
  return Object.freeze({
    schema: "native-typescript.clang-abi-evidence",
    schemaVersion: 3,
    probeDigest: probe.sourceDigest,
    semanticDigest: digestClangAbiEvidence(semanticInput),
    clang,
    functions,
    records,
    enums,
  });
}

function options(
  selected = snapshot(),
  importedNamespaces: GObjectScabiGenerationOptions["importedNamespaces"] = [],
): GObjectScabiGenerationOptions {
  const gobjectAdapter = generateGObjectAdapterSource(selected);
  return {
    snapshot: selected,
    evidence: evidence(
      generateGirClangAbiProbe(
        selected,
        gobjectAdapter,
        importedNamespaces.map(({ snapshot: imported }) => imported),
      ),
    ),
    gobjectAdapter,
    importedNamespaces,
    package: {
      name: "@native-typescript/gtk4",
      version: "0.0.0",
      namespace: "native-typescript.gtk4",
      instance: "native-typescript.gtk4@0.0.0",
    },
    target: {
      triple: "x86_64-unknown-linux-gnu",
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
      version: "4.0",
      deploymentTarget: "x86_64-unknown-linux-gnu",
      modules: ["gtk4"],
    },
    linkInputs: [
      { id: "gtk4", kind: "system-library", name: "gtk4", order: 0 },
    ],
    adapterInput: {
      id: "gtk4.gobject-adapters",
      output: "gobject-adapters.o",
    },
  };
}

const systemGtkGir = "/usr/share/gir-1.0/Gtk-4.0.gir";
const systemGioGir = "/usr/share/gir-1.0/Gio-2.0.gir";
const gio2Package = {
  name: "@native-typescript/gio2",
  version: "0.0.0",
  namespace: "native-typescript.gio2",
  instance: "native-typescript.gio2@0.0.0",
} as const;

test(
  "a class whose parent is in another namespace projects across the package boundary",
  { skip: !existsSync(systemGtkGir) || !existsSync(systemGioGir) },
  () => {
    // Gtk.Application extends Gio.Application. GIR namespaces are package
    // boundaries, so the ancestry has to cross from gtk4 into gio2.
    const gio = ingestGir(readFileSync(systemGioGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gio-2.0.gir",
      namespace: { name: "Gio", version: "2.0" },
      classes: [{ name: "Application" }],
    });
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      // Window carries a constructor so the adapter has work to do;
      // Application contributes only its cross-namespace ancestry.
      classes: [
        { name: "Widget" },
        { name: "Window", constructors: ["new"] },
        { name: "Application" },
      ],
    });
    const gtkApplication = gtk.classes.find(({ name }) => name === "Application");
    assert.deepEqual(gtkApplication?.parent, {
      kind: "external",
      namespace: "Gio",
      name: "Application",
    });

    const generated = generateGObjectScabiPackage(
      options(gtk, [{ snapshot: gio, package: gio2Package }]),
    );

    // The ABI side names the owning package and the type inside it.
    assert.deepEqual(generated.manifest.imports, {
      gio_application: { package: gio2Package, type: "gio_application" },
    });
    // The TypeScript side names the module it is imported from.
    assert.deepEqual(
      generated.manifest.declarations.types.gio_application,
      { module: "@native-typescript/gio2", name: "Application" },
    );
    // gtk4 must not define a type gio2 owns.
    assert.equal(generated.manifest.types.gio_application, undefined);

    const application = generated.manifest.types.gtk_application;
    assert.ok(application && application.kind === "handle");
    if (!application || application.kind !== "handle") return;
    assert.deepEqual(application.upcasts, [
      { kind: "identity", target: "gio_application" },
    ]);

    assert.match(
      generated.declarations,
      /^import type \{ Application as GioApplication \} from "@native-typescript\/gio2";$/mu,
    );
    assert.match(
      generated.declarations,
      /export declare class Application extends GioApplication \{/u,
    );
  },
);

test(
  "two generated packages compose into one program across the namespace edge",
  { skip: !existsSync(systemGtkGir) || !existsSync(systemGioGir) },
  () => {
    // The whole chain: generate gio2, generate gtk4 importing from it,
    // translate both, and compose. Composition is the only stage that sees
    // both manifests, so this is where the imported handle has to resolve.
    const gio = ingestGir(readFileSync(systemGioGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gio-2.0.gir",
      namespace: { name: "Gio", version: "2.0" },
      classes: [
        { name: "Cancellable", constructors: ["new"] },
        {
          name: "Application",
          // register() reports failure through a GError, so this also proves
          // the generated error contract survives translation.
          methods: ["quit", "register"],
          signals: ["activate"],
        },
      ],
    });
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [
        { name: "Widget" },
        { name: "Window", constructors: ["new"] },
        // remove_window is void over two handles, so reaching it reaches
        // Gtk.Application and therefore its imported ancestry.
        { name: "Application", methods: ["remove_window"] },
      ],
    });

    const gioGenerated = generateGObjectScabiPackage({
      ...options(gio),
      package: gio2Package,
      sdk: {
        vendor: "GNOME",
        name: "GLib",
        version: "2.0",
        deploymentTarget: "x86_64-unknown-linux-gnu",
        modules: ["gio-2.0"],
      },
      linkInputs: [
        { id: "gio-2.0", kind: "system-library", name: "gio-2.0", order: 0 },
      ],
      adapterInput: { id: "gio2.gobject-adapters", output: "gobject-adapters.o" },
    });
    const gtkGenerated = generateGObjectScabiPackage(
      options(gtk, [{ snapshot: gio, package: gio2Package }]),
    );

    const gioProgram = translateScabiNativeProgram(gioGenerated.manifest, {
      imports: ["gio_application_connect_activate", "gio_application_register"],
      exports: [],
    });
    const gtkProgram = translateScabiNativeProgram(gtkGenerated.manifest, {
      imports: ["gtk_application_remove_window", "gtk_window_new"],
      exports: [],
    });
    assert.equal(
      gioProgram.ok,
      true,
      gioProgram.ok ? undefined : JSON.stringify(gioProgram.diagnostics),
    );
    assert.equal(
      gtkProgram.ok,
      true,
      gtkProgram.ok ? undefined : JSON.stringify(gtkProgram.diagnostics),
    );
    if (!gioProgram.ok || !gtkProgram.ok) return;

    const composed = composeScriptCNativePrograms([gtkProgram, gioProgram]);
    assert.equal(
      composed.ok,
      true,
      composed.ok ? undefined : JSON.stringify(composed.diagnostics),
    );
    if (!composed.ok) return;

    // The generated error contract reaches Native IR with the adapter symbols
    // resolved, so the emitters call the accessor pair rather than deriving
    // names from the operation.
    const registerBinding = composed.input.bindings.find(({ declaration }) =>
      declaration.name === "Application.register"
    );
    assert.ok(registerBinding);
    if (!registerBinding) return;
    assert.deepEqual(registerBinding.error, {
      kind: "errorHandle",
      messageSymbol: "nts_gio_error_message",
      releaseSymbol: "nts_gio_error_free",
    });
    assert.equal(registerBinding.result.projection.kind, "errorChannel");

    // One program now holds both packages' handles, joined by the upcast.
    const application = composed.input.types.find(
      ({ id }) => id === "native-typescript.gtk4@0.0.0#type:gtk_application",
    );
    assert.ok(application && application.kind === "handle");
    if (!application || application.kind !== "handle") return;
    assert.deepEqual(application.upcasts, [
      {
        kind: "identity",
        target: "native-typescript.gio2@0.0.0#type:gio_application",
      },
    ]);
    assert.equal(
      composed.input.types.some(
        ({ id }) => id === "native-typescript.gio2@0.0.0#type:gio_application",
      ),
      true,
    );

    // Without gio2 the gtk4 program has a handle ancestry it cannot satisfy.
    const alone = composeScriptCNativePrograms([gtkProgram]);
    assert.equal(alone.ok, false);
    if (alone.ok) return;
    assert.match(
      alone.diagnostics.map(({ message }) => message).join("\n"),
      /is not provided by any composed package/u,
    );
  },
);

test("imported namespaces are declared inputs of the generation action", () => {
  const request = defineGirBindingPackageRequest({
    namespace: { name: "Gtk", version: "4.0" },
    importedNamespaces: [
      { namespace: { name: "Gio", version: "2.0" }, package: gio2Package },
    ],
    clang: options().evidence.clang,
    generation: {
      package: options().package,
      target: options().target,
      sdk: options().sdk,
      linkInputs: options().linkInputs,
      adapterInput: options().adapterInput,
    },
  });
  const plan = planGirBindingPackage({
    request,
    requestArtifact: "metadata/gtk4/request",
    snapshotArtifact: "metadata/gtk4/snapshot",
    normalizedEvidenceArtifact: "metadata/gtk4/evidence",
    generatorArtifact: "tool-input/gir/generator",
    importedSnapshotArtifacts: ["metadata/gio2/snapshot"],
    artifactId: "package/gtk4/bindings",
    actionId: "generate/gtk4/binding-package",
    tool: { id: "tool/node", version: "24", digest: `sha256:${"c".repeat(64)}` },
    executionPlatform: "x86_64-linux",
    target: "x86_64-unknown-linux-gnu",
  });

  // The imported snapshot is a content-verified input, so changing it
  // invalidates this package rather than silently reusing a cached result.
  assert.equal(plan.action.inputs.includes("metadata/gio2/snapshot"), true);

  // Normalization regenerates the probe to read the raw AST, so it must take
  // the same imported snapshots the compiled probe covered.
  const normalization = planGirClangEvidenceNormalization({
    request,
    requestArtifact: "metadata/gtk4/request",
    snapshotArtifact: "metadata/gtk4/snapshot",
    rawAstArtifact: "metadata/gtk4/ast",
    rawLlvmArtifact: "metadata/gtk4/llvm",
    generatorArtifact: "tool-input/gir/generator",
    importedSnapshotArtifacts: ["metadata/gio2/snapshot"],
    artifactId: "metadata/gtk4/evidence",
    actionId: "normalize/gtk4/clang-abi-evidence",
    tool: { id: "tool/node", version: "24", digest: `sha256:${"c".repeat(64)}` },
    executionPlatform: "x86_64-linux",
    target: "x86_64-unknown-linux-gnu",
  });
  assert.equal(
    normalization.action.inputs.includes("metadata/gio2/snapshot"),
    true,
  );
  assert.throws(
    () =>
      planGirClangEvidenceNormalization({
        request,
        requestArtifact: "metadata/gtk4/request",
        snapshotArtifact: "metadata/gtk4/snapshot",
        rawAstArtifact: "metadata/gtk4/ast",
        rawLlvmArtifact: "metadata/gtk4/llvm",
        generatorArtifact: "tool-input/gir/generator",
        artifactId: "metadata/gtk4/evidence",
        actionId: "normalize/gtk4/clang-abi-evidence",
        tool: { id: "tool/node", version: "24", digest: `sha256:${"c".repeat(64)}` },
        executionPlatform: "x86_64-linux",
        target: "x86_64-unknown-linux-gnu",
      }),
    /declares 1 imported namespace\(s\) but received 0/u,
  );
  assert.equal(
    plan.action.arguments.some(
      (argument) =>
        argument.kind === "input-path" &&
        argument.artifact === "metadata/gio2/snapshot",
    ),
    true,
  );

  // The request fixes how many snapshots the action consumes.
  assert.throws(
    () =>
      planGirBindingPackage({
        request,
        requestArtifact: "metadata/gtk4/request",
        snapshotArtifact: "metadata/gtk4/snapshot",
        normalizedEvidenceArtifact: "metadata/gtk4/evidence",
        generatorArtifact: "tool-input/gir/generator",
        artifactId: "package/gtk4/bindings",
        actionId: "generate/gtk4/binding-package",
        tool: { id: "tool/node", version: "24", digest: `sha256:${"c".repeat(64)}` },
        executionPlatform: "x86_64-linux",
        target: "x86_64-unknown-linux-gnu",
      }),
    /declares 1 imported namespace\(s\) but received 0/u,
  );

  interface ImportedNamespace {
    readonly namespace: { readonly name: string; readonly version: string };
    readonly package: {
      readonly name: string;
      readonly version: string;
      readonly namespace: string;
      readonly instance: string;
    };
  }

  function requestImporting(
    importedNamespaces: readonly ImportedNamespace[],
  ): unknown {
    return defineGirBindingPackageRequest({
      namespace: { name: "Gtk", version: "4.0" },
      importedNamespaces,
      clang: options().evidence.clang,
      generation: {
        package: options().package,
        target: options().target,
        sdk: options().sdk,
        linkInputs: options().linkInputs,
        adapterInput: options().adapterInput,
      },
    });
  }

  // A namespace cannot import itself.
  assert.throws(
    () =>
      requestImporting([
        { namespace: { name: "Gtk", version: "4.0" }, package: gio2Package },
      ]),
    /imports its own namespace/u,
  );

  // Several namespaces are ordinary, and their order is canonical so one
  // selection has one serialization.
  const gdk4Package = {
    name: "@native-typescript/gdk4",
    version: "0.0.0",
    namespace: "native-typescript.gdk4",
    instance: "native-typescript.gdk4@0.0.0",
  };
  assert.doesNotThrow(() =>
    requestImporting([
      { namespace: { name: "Gdk", version: "4.0" }, package: gdk4Package },
      { namespace: { name: "Gio", version: "2.0" }, package: gio2Package },
    ]),
  );
  for (const outOfOrder of ([
    [
      { namespace: { name: "Gio", version: "2.0" }, package: gio2Package },
      { namespace: { name: "Gdk", version: "4.0" }, package: gdk4Package },
    ],
    [
      { namespace: { name: "Gio", version: "2.0" }, package: gio2Package },
      { namespace: { name: "Gio", version: "2.0" }, package: gio2Package },
    ],
  ] as readonly (readonly ImportedNamespace[])[])) {
    assert.throws(
      () => requestImporting(outOfOrder),
      /unique and in canonical order/u,
    );
  }

  // Two declared namespaces need two snapshot inputs, in the same order.
  const twoImports = defineGirBindingPackageRequest({
    namespace: { name: "Gtk", version: "4.0" },
    importedNamespaces: [
      { namespace: { name: "Gdk", version: "4.0" }, package: gdk4Package },
      { namespace: { name: "Gio", version: "2.0" }, package: gio2Package },
    ],
    clang: options().evidence.clang,
    generation: {
      package: options().package,
      target: options().target,
      sdk: options().sdk,
      linkInputs: options().linkInputs,
      adapterInput: options().adapterInput,
    },
  });
  const twoPlan = planGirBindingPackage({
    request: twoImports,
    requestArtifact: "metadata/gtk4/request",
    snapshotArtifact: "metadata/gtk4/snapshot",
    normalizedEvidenceArtifact: "metadata/gtk4/evidence",
    generatorArtifact: "tool-input/gir/generator",
    importedSnapshotArtifacts: [
      "metadata/gdk4/snapshot",
      "metadata/gio2/snapshot",
    ],
    artifactId: "package/gtk4/bindings",
    actionId: "generate/gtk4/binding-package",
    tool: { id: "tool/node", version: "24", digest: `sha256:${"c".repeat(64)}` },
    executionPlatform: "x86_64-linux",
    target: "x86_64-unknown-linux-gnu",
  });
  assert.deepEqual(
    twoPlan.action.arguments
      .flatMap((argument) =>
        argument.kind === "input-path" ? [argument.artifact] : [],
      )
      .filter((artifact) => artifact.endsWith("/snapshot")),
    ["metadata/gtk4/snapshot", "metadata/gdk4/snapshot", "metadata/gio2/snapshot"],
  );
});

test(
  "a constructor taking another namespace's flags projects and proves its storage",
  { skip: !existsSync(systemGtkGir) || !existsSync(systemGioGir) },
  () => {
    // gtk_application_new(const char *id, GApplicationFlags flags). The flags
    // type belongs to Gio, so only its TypeScript name is foreign: an enum
    // lowers to a bare scalar, and this package proves that scalar against its
    // own headers.
    const gio = ingestGir(readFileSync(systemGioGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gio-2.0.gir",
      namespace: { name: "Gio", version: "2.0" },
      classes: [{ name: "Application" }],
      enumerations: [
        { name: "ApplicationFlags", members: ["default_flags", "is_service"] },
      ],
    });
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [{ name: "Application", constructors: ["new"] }],
    });

    const generated = generateGObjectScabiPackage(
      options(gtk, [{ snapshot: gio, package: gio2Package }]),
    );

    // Defined here for its ABI, declared as gio2's for its identity.
    const flags = generated.manifest.types.gio_application_flags;
    assert.ok(flags && flags.kind === "flags");
    if (!flags || flags.kind !== "flags") return;
    assert.equal(flags.underlying, "gio_application_flags_storage");
    assert.deepEqual(
      generated.manifest.declarations.types.gio_application_flags,
      { module: "@native-typescript/gio2", name: "ApplicationFlags" },
    );

    // No SCABI type import is involved: the representation is a bare scalar.
    assert.equal(generated.manifest.imports?.gio_application_flags, undefined);

    // gio2 owns the member constants; gtk4 must not re-export them.
    assert.equal(
      Object.values(generated.manifest.bindings).some(
        (binding) =>
          binding.kind === "constant" &&
          binding.declaration.name.startsWith("ApplicationFlags."),
      ),
      false,
    );

    assert.match(
      generated.declarations,
      /^import type \{ ApplicationFlags as GioApplicationFlags \} from "@native-typescript\/gio2";$/mu,
    );
    assert.match(
      generated.declarations,
      /constructor\(applicationId: string \| null, flags: GioApplicationFlags\);/u,
    );

    // Both import mechanisms are in play at once here, and they are different:
    // the parent is an imported SCABI type with a cross-package identity,
    // while the flags are defined locally and only named foreign.
    assert.match(
      generated.declarations,
      /export declare class Application extends GioApplication \{/u,
    );
    assert.deepEqual(generated.manifest.imports, {
      gio_application: { package: gio2Package, type: "gio_application" },
    });
  },
);

test("a namespace cannot be supplied as its own import", () => {
  // Easy to reach by wiring a build's imported namespaces carelessly, and
  // meaningless: a package's own declarations are not foreign to it.
  const selected = snapshot();
  const failure = generationError(() =>
    generateGObjectScabiPackage(
      options(selected, [{ snapshot: selected, package: options().package }]),
    )
  );
  assert.equal(
    failure.diagnostics.some(({ message }) =>
      message.includes("cannot be the namespace being generated")
    ),
    true,
    failure.diagnostics.map(({ message }) => message).join("\n"),
  );
});

test(
  "a throwing member whose own result carries information is refused",
  { skip: !existsSync(systemGioGir) },
  () => {
    // The adapter discards the wrapped call's result, which is only sound when
    // that result says nothing beyond success. g_application_register() returns
    // gboolean and projects; a member returning a value must not silently lose
    // it.
    const gio = ingestGir(readFileSync(systemGioGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gio-2.0.gir",
      namespace: { name: "Gio", version: "2.0" },
      classes: [
        {
          name: "Credentials",
          constructors: ["new"],
          // throws=1 and returns a uid_t, which is a value rather than a
          // status, so discarding it would lose information.
          methods: ["get_unix_user"],
        },
      ],
    });
    const throwing = gio.classes[0]?.methods[0];
    assert.ok(throwing?.throws);
    if (!throwing?.throws) return;
    const failure = generationError(() => generateGObjectAdapterSource(gio));
    assert.equal(
      failure.diagnostics.some(({ message }) =>
        message.includes("gboolean or void")
      ),
      true,
      failure.diagnostics.map(({ message }) => message).join("\n"),
    );
  },
);

test("a namespace cannot be supplied as its own import", () => {
  // Easy to reach by wiring a build's imported namespaces carelessly, and
  // meaningless: a package's own declarations are not foreign to it.
  const selected = snapshot();
  const failure = generationError(() =>
    generateGObjectScabiPackage(
      options(selected, [{ snapshot: selected, package: options().package }]),
    )
  );
  assert.equal(
    failure.diagnostics.some(({ message }) =>
      message.includes("cannot be the namespace being generated")
    ),
    true,
    failure.diagnostics.map(({ message }) => message).join("\n"),
  );
});

test(
  "an unsupplied parent namespace leaves the hierarchy rooted here",
  { skip: !existsSync(systemGtkGir) },
  () => {
    // Gtk.Widget extends GObject.InitiallyUnowned, which is deliberately
    // outside the generated surface. Importing is opt-in, so omitting the
    // namespace truncates rather than failing.
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [{ name: "Widget" }, { name: "Window", constructors: ["new"] }],
    });
    const generated = generateGObjectScabiPackage(options(gtk));
    assert.equal(generated.manifest.imports, undefined);
    const widget = generated.manifest.types.gtk_widget;
    assert.ok(widget && widget.kind === "handle");
    if (!widget || widget.kind !== "handle") return;
    assert.deepEqual(widget.upcasts, []);
    assert.doesNotMatch(generated.declarations, /^import /mu);
  },
);

test(
  "unsigned and wide GLib integers project as plain numbers over exact slots",
  { skip: !existsSync(systemGtkGir) },
  () => {
    /* GTK spends unsigned integers freely — spacings, counts, digits — and a
     * projection that admitted only gint refused those members while blaming
     * GObject handles for it. Each width keeps its own exact ABI type, and
     * each declares the JavaScript-number conversion, so the spelling still
     * says what the value means while the value behaves like the number it
     * is. The manifest is where the width lives; the alias is transparent. */
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [
        { name: "Widget" },
        { name: "Grid", constructors: ["new"], methods: ["set_row_spacing"] },
        { name: "Entry", constructors: ["new"], methods: ["get_text_length"] },
      ],
    });
    const generated = generateGObjectScabiPackage(options(gtk));

    assert.deepEqual(generated.manifest.types["guint"], {
      kind: "integer",
      signed: false,
      bits: 32,
    });
    assert.deepEqual(generated.manifest.types["guint16"], {
      kind: "integer",
      signed: false,
      bits: 16,
    });
    assert.match(generated.declarations, /export type guint = number;\n/u);
    assert.match(generated.declarations, /export type guint16 = number;\n/u);
    /* Nothing here still carries an exact representation, so the brand symbol
     * itself must not be declared. */
    assert.ok(!generated.declarations.includes("nativeScalar"));
    const setRowSpacing = generated.manifest.bindings.gtk_grid_set_row_spacing;
    assert.equal(
      setRowSpacing?.kind === "constant"
        ? undefined
        : setRowSpacing?.signature.parameters[1]?.conversion,
      "number",
    );
    const getTextLength = generated.manifest.bindings.gtk_entry_get_text_length;
    assert.equal(
      getTextLength?.kind === "constant"
        ? undefined
        : getTextLength?.signature.result.conversion,
      "number",
    );
    assert.match(generated.declarations, /setRowSpacing\(spacing: guint\): void;/u);
    assert.match(generated.declarations, /getTextLength\(\): guint16;/u);
  },
);

test(
  "a 32-bit float projects as a plain number over its own width",
  { skip: !existsSync(systemGtkGir) },
  () => {
    /* `gtk_label_set_xalign` takes a gfloat. The slot stays 32 bits and the
     * declaration is a plain number, because a float in a foreign signature
     * is a slot rather than a second precision to compute in — the crossing
     * reads exactly and writes by rounding, which is what its width means. */
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [
        { name: "Widget" },
        {
          name: "Label",
          constructors: ["new"],
          methods: ["set_xalign", "get_xalign"],
        },
      ],
    });
    const generated = generateGObjectScabiPackage(options(gtk));

    assert.deepEqual(generated.manifest.types["gfloat"], {
      kind: "float",
      bits: 32,
    });
    assert.match(generated.declarations, /export type gfloat = number;\n/u);
    /* A property, because the getter and setter agree and neither can fail. */
    assert.match(generated.declarations, /get xalign\(\): gfloat;\n {2}set xalign\(value: gfloat\);/u);
    const setter = generated.manifest.bindings.gtk_label_set_xalign;
    assert.equal(
      setter?.kind === "constant"
        ? undefined
        : setter?.signature.parameters[1]?.conversion,
      "number",
    );
  },
);

test(
  "a branded GLib scalar declares the operations no operator can carry",
  { skip: !existsSync(systemGtkGir) },
  () => {
    /* `GtkMediaStream.get_duration()` answers in microseconds as a gint64,
     * which is the one GLib numeric family a double cannot carry
     * injectively, so it keeps an exact BigInt carrier — and with it the
     * inability to reach a plain number without saying so. */
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [
        { name: "Widget" },
        { name: "Grid", constructors: ["new"] },
        { name: "MediaStream", methods: ["get_duration"] },
      ],
    });
    const generated = generateGObjectScabiPackage(options(gtk));

    assert.match(
      generated.declarations,
      /export type gint64 = bigint & \{ readonly \[nativeScalar\]: "gint64" \};/u,
    );
    /* Only the conversions: `(a / b) as gint64` is an ordinary operator
     * expression, so arithmetic has nothing to declare. */
    assert.match(
      generated.declarations,
      /export declare namespace gint64 \{\n {2}function toNumber\(value: gint64\): number;\n {2}function fromNumber\(value: number\): gint64;\n\}/u,
    );
    assert.match(generated.declarations, /getDuration\(\): gint64;/u);
    /* A converted scalar has nothing to declare: it is a plain number and
     * every operator already works on one. */
    assert.doesNotMatch(generated.declarations, /namespace gint \{/u);
  },
);

test(
  "a parameter outside the slice is not reported as a GObject handle",
  { skip: !existsSync(systemGtkGir) },
  () => {
    /* A Pango attribute list is a boxed record from another namespace, so
     * Label.set_attributes cannot project. Naming the type is the whole value
     * of the diagnostic: blaming handle inputs sends the reader looking for a
     * class never involved. */
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [
        { name: "Widget" },
        { name: "Label", constructors: ["new"], methods: ["set_attributes"] },
      ],
    });
    const error = generationError(() =>
      generateGObjectScabiPackage(options(gtk)),
    );
    assert.equal(error.diagnostics.length, 1);
    assert.match(
      error.diagnostics[0]?.message ?? "",
      /Parameter type 'Pango.AttrList' is outside the implemented slice/u,
    );
  },
);

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value as Readonly<Record<string, unknown>>)) {
    assertDeepFrozen(child, seen);
  }
}

function generationError(action: () => unknown): CBindgenError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof CBindgenError);
    return error;
  }
  assert.fail("Expected GTK SCABI generation to fail");
}

test("verified Gtk.Button metadata becomes canonical declarations and SCABI", () => {
  const generated = generateGObjectScabiPackage(options());
  assert.equal(generated.schema, "native-typescript.gobject-scabi-package");
  assert.equal(generated.schemaVersion, 1);
  assert.equal(generated.manifestSource, canonicalizeJson(generated.manifest));
  assert.equal(generated.manifestDigest, digestScabiManifest(generated.manifest));
  assert.equal(generated.declarationsDigest, sha256(generated.declarations));
  assert.equal(generated.manifest.declarations.digest, generated.declarationsDigest);
  assert.equal(generated.manifest.sdk.metadataDigest, sha256(canonicalizeJson({
    gir: options().snapshot.source.digest,
    clang: options().evidence.semanticDigest,
  })));
  assert.deepEqual(generated.manifest.declarations.types, {
    gint: { module: ".", name: "gint" },
    gtk_button: { module: ".", name: "Button" },
    gtk_requisition: { module: ".", name: "Requisition" },
    gtk_widget: { module: ".", name: "Widget" },
  });
  assert.deepEqual(generated.manifest.types.gtk_requisition, {
    kind: "struct",
    size: 8,
    alignment: 4,
    packing: "default",
    triviallyCopyable: true,
    destruction: "trivial",
    abiPassing: {
      result: {
        type: { kind: "integer", bits: 64 },
        alignment: null,
        stackAlignment: null,
        extension: null,
        inRegister: false,
        byValue: false,
        structureReturn: false,
      },
      parameters: [{
        type: { kind: "integer", bits: 64 },
        alignment: null,
        stackAlignment: null,
        extension: null,
        inRegister: false,
        byValue: false,
        structureReturn: false,
      }],
    },
    fields: [
      { name: "width", type: "gint", offset: 0, conversion: "number" },
      { name: "height", type: "gint", offset: 4, conversion: "number" },
    ],
  });
  assert.deepEqual(generated.manifest.adapterInputs[0]?.bindings, [
    "gtk_button_new_with_label",
    "gtk_button_release",
  ]);
  assert.match(generated.declarations, /export declare class Button/u);
  assert.match(
    generated.declarations,
    /export interface Requisition \{\n  readonly width: gint;\n  readonly height: gint;\n\}/u,
  );
  assert.match(generated.declarations, /getLabel\(\): string \| null;/u);
  assert.match(generated.declarations, /setLabel\(label: string\): void;/u);
  /* A nullable getter keeps its method shape: a property would claim a
   * stability a native read does not have, and would break the null check
   * anyone writes first. */
  assert.doesNotMatch(generated.declarations, /get label|set label/u);
  const labelGetter = generated.manifest.bindings.gtk_button_get_label;
  assert.ok(labelGetter && labelGetter.kind !== "constant");
  /* Both are ordinary methods now: a nullable read is a call, and the SCABI
   * binding kind says so as plainly as the declaration does. */
  assert.equal(labelGetter.kind, "method");
  assert.equal(labelGetter.declaration.name, "Button.getLabel");
  const labelSetter = generated.manifest.bindings.gtk_button_set_label;
  assert.ok(labelSetter && labelSetter.kind !== "constant");
  assert.equal(labelSetter.kind, "method");
  assert.equal(labelSetter.declaration.name, "Button.setLabel");
  assert.match(
    generated.declarations,
    /static withLabel\(label: string\): Button;/u,
  );
  const constructor = generated.manifest.bindings.gtk_button_new_with_label;
  assert.ok(constructor && constructor.kind !== "constant");
  assert.equal(constructor.kind, "factory");
  assert.deepEqual(constructor.declaration, { module: ".", name: "Button.withLabel" });
  assertDeepFrozen(generated);
  assert.deepEqual(generateGObjectScabiPackage(options()), generated);
});

test("a deprecated member binds and says so at the call site", () => {
  /* Deprecation is the library's opinion about its own API, not a fact about
   * the API's ABI, so it must not decide whether a member binds: an
   * application migrating off one still has to call it. What it does decide is
   * that the caller is told, in the one place they will see it. */
  const source = girSource.replace(
    '<method name="set_label" c:identifier="gtk_button_set_label" glib:set-property="label">',
    '<method name="set_label" c:identifier="gtk_button_set_label" ' +
      'glib:set-property="label" deprecated="1" deprecated-version="4.10">',
  );
  const selected = ingestGir(source, {
    logicalPath: "fixtures/gir/Gtk-4.0.selected.gir",
    namespace: { name: "Gtk", version: "4.0" },
    classes: [
      { name: "Widget" },
      {
        name: "Button",
        constructors: ["new_with_label"],
        methods: ["get_label", "set_label"],
      },
    ],
    records: [{ name: "Requisition", fields: ["width", "height"] }],
  });
  const generated = generateGObjectScabiPackage(options(selected));
  assert.match(
    generated.declarations,
    /\/\*\* @deprecated Deprecated by the library since version 4\.10\. \*\/\n\s*setLabel\(label: string\): void;/u,
  );
  /* The member it does not mark stays unannotated, so the notice means
   * something rather than decorating everything. */
  assert.match(generated.declarations, /\n\s*getLabel\(\): string \| null;/u);
  assert.equal(
    (generated.declarations.match(/@deprecated/gu) ?? []).length,
    1,
    "only the deprecated member is marked",
  );
});

test("Clang-proven GTK enums become idiomatic exact constants", () => {
  const generated = generateGObjectScabiPackage(options(snapshot([], true)));

  assert.match(
    generated.declarations,
    /export type Orientation = number & \{ readonly \[nativeScalar\]: "Orientation" \};/u,
  );
  assert.match(
    generated.declarations,
    /export declare namespace Orientation \{\n  const Horizontal: Orientation;\n  const Vertical: Orientation;\n\}/u,
  );
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
  assert.deepEqual(generated.manifest.declarations.types.gtk_orientation, {
    module: ".",
    name: "Orientation",
  });
  assert.deepEqual(generated.manifest.bindings.gtk_orientation_vertical, {
    kind: "constant",
    declaration: { module: ".", name: "Orientation.Vertical" },
    type: "gtk_orientation",
    value: "1",
    dependencies: {
      bindings: [],
      linkInputs: [],
      adapterInputs: [],
      permissions: [],
    },
  });

  const translated = translateScabiNativeProgram(generated.manifest, {
    imports: ["gtk_orientation_vertical"],
    exports: [],
  });
  assert.equal(translated.ok, true);
  if (!translated.ok) return;
  assert.deepEqual(translated.input.sourceTypes, [{
    declaration: { module: "@native-typescript/gtk4", name: "Orientation" },
    type: { kind: "nativeScalar", scalar: "u32" },
  }]);
  assert.deepEqual(translated.input.constants, [{
    id: "native-typescript.gtk4@0.0.0#gtk_orientation_vertical",
    declaration: { module: "@native-typescript/gtk4", name: "Orientation.Vertical" },
    type: { kind: "nativeScalar", scalar: "u32" },
    value: "1",
  }]);
  assert.deepEqual(translated.build, { linkInputs: [], adapterInputs: [] });
});

test("Clang-proven GTK flags project through constructors and properties", () => {
  const generated = generateGObjectScabiPackage(options(flagsPropertySnapshot()));

  assert.match(
    generated.declarations,
    /export type EventControllerScrollFlags = number & \{ readonly \[nativeScalar\]: "EventControllerScrollFlags" \};/u,
  );
  assert.match(
    generated.declarations,
    /export declare namespace EventControllerScrollFlags \{\n  const BothAxes: EventControllerScrollFlags;\n  const Horizontal: EventControllerScrollFlags;\n  const Vertical: EventControllerScrollFlags;\n  function combine\(first: EventControllerScrollFlags, \.\.\.rest: readonly EventControllerScrollFlags\[\]\): EventControllerScrollFlags;\n\}/u,
  );
  assert.match(
    generated.declarations,
    /export declare class EventControllerScroll extends EventController \{[^}]*constructor\(flags: EventControllerScrollFlags\);[^}]*get flags\(\): EventControllerScrollFlags;[^}]*set flags\(value: EventControllerScrollFlags\);/su,
  );
  assert.deepEqual(
    generated.manifest.types.gtk_event_controller_scroll_flags,
    {
      kind: "flags",
      underlying: "gtk_event_controller_scroll_flags_storage",
      members: { BothAxes: "3", Horizontal: "2", Vertical: "1" },
    },
  );
  const getter = generated.manifest.bindings.gtk_event_controller_scroll_get_flags;
  assert.ok(getter && getter.kind !== "constant");
  assert.equal(getter.kind, "getter");
  assert.equal(getter.signature.result.type, "gtk_event_controller_scroll_flags");
  const setter = generated.manifest.bindings.gtk_event_controller_scroll_set_flags;
  assert.ok(setter && setter.kind !== "constant");
  assert.equal(setter.kind, "setter");
  assert.equal(setter.signature.parameters[1]?.type, "gtk_event_controller_scroll_flags");

  const translated = translateScabiNativeProgram(generated.manifest, {
    imports: [
      "gtk_event_controller_scroll_flags_both_axes",
      "gtk_event_controller_scroll_flags_horizontal",
      "gtk_event_controller_scroll_flags_vertical",
      "gtk_event_controller_scroll_get_flags",
      "gtk_event_controller_scroll_new",
      "gtk_event_controller_scroll_set_flags",
    ],
    exports: [],
  });
  assert.equal(translated.ok, true);
  if (!translated.ok) return;
  assert.deepEqual(
    translated.input.constants.map(({ declaration, value }) => ({ declaration, value })),
    [
      {
        declaration: {
          module: "@native-typescript/gtk4",
          name: "EventControllerScrollFlags.BothAxes",
        },
        value: "3",
      },
      {
        declaration: {
          module: "@native-typescript/gtk4",
          name: "EventControllerScrollFlags.Horizontal",
        },
        value: "2",
      },
      {
        declaration: {
          module: "@native-typescript/gtk4",
          name: "EventControllerScrollFlags.Vertical",
        },
        value: "1",
      },
    ],
  );
  assert.equal(
    translated.input.bindings.find(
      ({ declaration }) => declaration.name === "EventControllerScroll.flags" &&
        declaration.module === "@native-typescript/gtk4",
    )?.result.type.kind,
    "nativeScalar",
  );
  assert.deepEqual(translated.input.operations, [{
    id: "native-typescript.gtk4@0.0.0#source-operation/gtk_event_controller_scroll_flags/combine",
    declaration: {
      module: "@native-typescript/gtk4",
      name: "EventControllerScrollFlags.combine",
    },
    kind: "integer-reduce",
    operator: "|",
    type: { kind: "nativeScalar", scalar: "u32" },
  }]);
});

test("GTK caller-allocated record outputs project as one nested value result", () => {
  const generated = generateGObjectScabiPackage(options(valueMethodSnapshot()));
  assert.match(
    generated.declarations,
    /export interface WidgetPreferredSize \{\n  readonly minimumSize: Requisition;\n  readonly naturalSize: Requisition;\n\}/u,
  );
  assert.match(
    generated.declarations,
    /getPreferredSize\(\): WidgetPreferredSize;/u,
  );
  const resultType = generated.manifest.types.gtk_widget_preferred_size;
  assert.ok(resultType?.kind === "struct");
  assert.deepEqual(resultType.fields, [
    { name: "minimumSize", type: "gtk_requisition", offset: 0 },
    { name: "naturalSize", type: "gtk_requisition", offset: 8 },
  ]);
  const binding = generated.manifest.bindings.nts_gobject_value_gtk_widget_get_preferred_size;
  assert.ok(binding && binding.kind !== "constant");
  assert.equal(binding.entry.kind, "adapter-symbol");
  assert.equal(binding.declaration.name, "Widget.getPreferredSize");
  assert.equal(binding.signature.parameters.length, 1);
  assert.equal(binding.signature.result.type, "gtk_widget_preferred_size");
  assert.deepEqual(generated.manifest.adapterInputs[0]?.bindings, [
    "nts_gobject_value_gtk_widget_get_preferred_size",
  ]);
  const translated = translateScabiNativeProgram(generated.manifest, {
    imports: ["nts_gobject_value_gtk_widget_get_preferred_size"],
    exports: [],
  });
  assert.equal(translated.ok, true);
  if (!translated.ok) return;
  assert.deepEqual(translated.input.types.map(({ kind }) => kind), [
    "handle",
    "struct",
    "struct",
  ]);
});

test("GTK evidence and binding generation are immutable cacheable actions", () => {
  const generation = options();
  const request = defineGirBindingPackageRequest({
    namespace: { name: "Gtk", version: "4.0" },
    clang: generation.evidence.clang,
    generation: {
      package: generation.package,
      target: generation.target,
      sdk: generation.sdk,
      linkInputs: generation.linkInputs,
      adapterInput: generation.adapterInput,
    },
  });
  const nodeTool = {
    id: "tool/node",
    version: "24.19.0",
    digest: `sha256:${"b".repeat(64)}`,
  };
  const evidencePlan = planGirClangEvidenceNormalization({
    request,
    requestArtifact: "metadata/gtk4/request",
    snapshotArtifact: "metadata/gtk4/snapshot",
    rawAstArtifact: "metadata/gtk4/clang-ast",
    rawLlvmArtifact: "metadata/gtk4/clang-llvm",
    generatorArtifact: "tool-input/target-gtk/generator",
    artifactId: "metadata/gtk4/clang-evidence",
    actionId: "normalize/gtk4/clang-evidence",
    tool: nodeTool,
    executionPlatform: "x86_64-linux",
    target: "x86_64-unknown-linux-gnu",
  });
  const plan = planGirBindingPackage({
    request,
    requestArtifact: "metadata/gtk4/request",
    snapshotArtifact: "metadata/gtk4/snapshot",
    normalizedEvidenceArtifact: evidencePlan.artifact.id,
    generatorArtifact: "tool-input/target-gtk/generator",
    artifactId: "package/gtk4/bindings",
    actionId: "generate/gtk4/bindings",
    tool: nodeTool,
    executionPlatform: "x86_64-linux",
    target: "x86_64-unknown-linux-gnu",
  });

  assertDeepFrozen(request);
  assertDeepFrozen(evidencePlan);
  assertDeepFrozen(plan);
  assert.deepEqual(evidencePlan.action.inputs, [
    "tool-input/target-gtk/generator",
    "metadata/gtk4/snapshot",
    "metadata/gtk4/clang-ast",
    "metadata/gtk4/clang-llvm",
    "metadata/gtk4/request",
  ]);
  assert.equal(evidencePlan.artifact.entryType, "file");
  assert.equal(evidencePlan.artifact.cache, "exportable");
  assert.equal(evidencePlan.action.deterministic, true);
  assert.equal(evidencePlan.action.cacheable, true);
  assert.deepEqual(plan.action.inputs, [
    "tool-input/target-gtk/generator",
    "metadata/gtk4/snapshot",
    "metadata/gtk4/clang-evidence",
    "metadata/gtk4/request",
  ]);
  assert.equal(plan.artifact.entryType, "directory");
  assert.equal(plan.artifact.cache, "exportable");
  assert.equal(plan.action.deterministic, true);
  assert.equal(plan.action.cacheable, true);
  assert.throws(
    () => planGirBindingPackage({
      request,
      requestArtifact: "metadata/gtk4/request",
      snapshotArtifact: "metadata/gtk4/snapshot",
      normalizedEvidenceArtifact: "metadata/gtk4/clang-evidence",
      generatorArtifact: "tool-input/target-gtk/generator",
      artifactId: "package/gtk4/bindings",
      actionId: "generate/gtk4/bindings",
      tool: { ...nodeTool, id: "tool/tsx" },
      executionPlatform: "x86_64-linux",
      target: "x86_64-unknown-linux-gnu",
    }),
    /requires tool\/node/u,
  );
});

test("GTK binding analysis composes one immutable target plan", () => {
  const selected = snapshot(["clicked"]);
  const generation = options(selected);
  const request = defineGirBindingPackageRequest({
    namespace: { name: "Gtk", version: "4.0" },
    clang: generation.evidence.clang,
    generation: {
      package: generation.package,
      target: generation.target,
      sdk: generation.sdk,
      linkInputs: generation.linkInputs,
      adapterInput: generation.adapterInput,
    },
  });
  const clangTool = {
    id: generation.evidence.clang.toolId,
    version: generation.evidence.clang.version,
    digest: generation.evidence.clang.digest,
  };
  const nodeTool = {
    id: "tool/node",
    version: "24.19.0",
    digest: `sha256:${"b".repeat(64)}`,
  };
  const plan = planGirBindingAnalysis({
    snapshot: selected,
    request,
    snapshotArtifact: "metadata/gtk4/snapshot",
    requestArtifact: "metadata/gtk4/request",
    generatorArtifact: "tool-input/target-gtk/generator",
    clangArguments: [{ kind: "input-path", artifact: "sdk/gtk4/include" }],
    clangTool,
    nodeTool,
    executionPlatform: "x86_64-linux",
    target: "x86_64-unknown-linux-gnu",
  });

  assertDeepFrozen(plan);
  assert.equal(plan.probe.sourceDigest, plan.clang.source.origin.kind === "source"
    ? plan.clang.source.origin.digest
    : undefined);
  assert.deepEqual(plan.artifacts.map(({ id }) => id), [
    "source/gtk4/clang-abi-probe",
    "metadata/gtk4/clang-abi-ast",
    "metadata/gtk4/clang-abi-llvm",
    "metadata/gtk4/normalized-clang-abi-evidence",
    "package/gtk4/bindings",
  ]);
  assert.deepEqual(plan.actions.map(({ id }) => id), [
    "inspect/gtk4/clang-abi",
    "inspect/gtk4/clang-calling-convention",
    "normalize/gtk4/clang-abi-evidence",
    "generate/gtk4/binding-package",
  ]);
  assert.deepEqual(plan.evidence.action.inputs.slice(2, 4), [
    plan.clang.rawAst.id,
    plan.clang.rawLlvm.id,
  ]);
  assert.equal(plan.bindings.action.inputs.includes(plan.evidence.artifact.id), true);
  assert.throws(
    () => planGirBindingAnalysis({
      snapshot: selected,
      request,
      snapshotArtifact: "metadata/gtk4/snapshot",
      requestArtifact: "metadata/gtk4/request",
      generatorArtifact: "tool-input/target-gtk/generator",
      clangArguments: [],
      clangTool: { ...clangTool, version: "different" },
      nodeTool,
      executionPlatform: "x86_64-linux",
      target: "x86_64-unknown-linux-gnu",
    }),
    /Clang tool does not match/u,
  );
});

test("GTK SCABI generation rejects unverified evidence and adapter drift", () => {
  const invalidEvidence = options();
  Object.assign(invalidEvidence, {
    evidence: Object.freeze({
      ...invalidEvidence.evidence,
      probeDigest: `sha256:${"0".repeat(64)}`,
    }),
  });
  const evidenceError = generationError(() => generateGObjectScabiPackage(invalidEvidence));
  assert.equal(
    evidenceError.diagnostics.some(({ path }) => path === "evidence/probeDigest"),
    true,
  );

  const invalidRecord = options();
  const firstRecord = invalidRecord.evidence.records[0]!;
  const firstField = firstRecord.fields[0]!;
  Object.assign(invalidRecord, {
    evidence: Object.freeze({
      ...invalidRecord.evidence,
      records: Object.freeze([Object.freeze({
        ...firstRecord,
        fields: Object.freeze([
          Object.freeze({ ...firstField, expectedType: "double" }),
          ...firstRecord.fields.slice(1),
        ]),
      })]),
    }),
  });
  const recordError = generationError(() => generateGObjectScabiPackage(invalidRecord));
  assert.equal(
    recordError.diagnostics.some(
      ({ path }) => path === "evidence/records/0/fields/0",
    ),
    true,
  );

  const invalidAdapter = options();
  const constructors = invalidAdapter.gobjectAdapter.constructors.map(
    (constructor, index) => index === 0
      ? Object.freeze({ ...constructor, adapterSymbol: "nts_tampered_adapter" })
      : constructor,
  );
  Object.assign(invalidAdapter, {
    gobjectAdapter: Object.freeze({
      ...invalidAdapter.gobjectAdapter,
      constructors: Object.freeze(constructors),
    }),
  });
  const adapterError = generationError(() => generateGObjectScabiPackage(invalidAdapter));
  assert.equal(
    adapterError.diagnostics.some(({ path }) => path === "gobjectAdapter"),
    true,
  );
});

test("GTK SCABI lowers a zero-payload signal to a receiver-owned connection", () => {
  const generated = generateGObjectScabiPackage(options(snapshot(["clicked"])));
  assert.match(
    generated.declarations,
    /onClicked\(callback: \(button: Button\) => void\): SignalConnection;/u,
  );
  assert.match(
    generated.declarations,
    /export interface SignalConnection/u,
  );
  assert.match(generated.declarations, /disconnect\(\): void;/u);
  assert.match(generated.declarations, /readonly connected: boolean;/u);
  assert.doesNotMatch(generated.declarations, /dispose\(\): void;/u);
  assert.deepEqual(generated.manifest.types.gtk_signal_connection, {
    kind: "handle",
    nativeName: "NtsGtkSignalConnection",
    threadSafety: "confined",
    identity: "none",
    upcasts: [],
  });
  const connect = generated.manifest.bindings.gtk_button_connect_clicked;
  assert.ok(connect && connect.kind !== "constant");
  assert.equal(connect.entry.symbol, "nts_gobject_connect_gtk_button_clicked");
  assert.deepEqual(connect.signature.parameters[1]?.ownership, {
    kind: "borrowed",
    scope: "registration",
    anchor: "button",
  });
  assert.deepEqual(connect.signature.parameters[1]?.callback, {
    lifetime: "until-cancelled",
    registrationOwner: "button",
    cancellationBinding: "gtk_signal_connection_disconnect",
    contextParameter: "context",
    allowedInvocationExecutors: [{ kind: "same-as-caller" }],
    deliveryExecutor: { kind: "runtime-owner" },
    synchronousReturn: false,
    arguments: [],
    sourceArguments: [{ kind: "registration-owner" }],
    reentrancy: "allowed",
    postDisposal: "not-invoked",
    shutdown: "drain",
  });
  assert.deepEqual(connect.signature.result.ownership, {
    kind: "owned",
    transfer: "to-runtime",
    destructor: "gtk_signal_connection_release",
  });
  const disconnect = generated.manifest.bindings.gtk_signal_connection_disconnect;
  assert.ok(disconnect && disconnect.kind !== "constant");
  assert.equal(disconnect.kind, "method");
  assert.deepEqual(disconnect.signature.parameters[0]?.ownership, {
    kind: "borrowed",
    scope: "call",
  });
  const connected = generated.manifest.bindings.gtk_signal_connection_connected;
  assert.ok(connected && connected.kind !== "constant");
  assert.equal(connected.kind, "getter");
  assert.equal(connected.signature.result.type, "gboolean");
  const release = generated.manifest.bindings.gtk_button_release;
  assert.ok(release && release.kind !== "constant");
  const constructor = generated.manifest.bindings.gtk_button_new_with_label;
  assert.ok(constructor && constructor.kind !== "constant");
  const constructorOwnership = constructor.signature.result.ownership;
  assert.equal(constructorOwnership.kind, "owned");
  assert.equal(
    constructorOwnership.kind === "owned" ? constructorOwnership.transfer : undefined,
    "to-runtime",
  );
  if (
    constructorOwnership.kind === "owned" &&
    constructorOwnership.transfer === "to-runtime"
  ) {
    assert.equal(constructorOwnership.destructor, "gtk_button_release");
  }
  assert.deepEqual(generated.manifest.adapterInputs[0]?.bindings, [
    "gtk_button_connect_clicked",
    "gtk_button_new_with_label",
    "gtk_button_release",
    "gtk_signal_connection_connected",
    "gtk_signal_connection_disconnect",
    "gtk_signal_connection_release",
  ]);
  assertDeepFrozen(generated);
});

test("GTK SCABI copies exact scalar signal payloads onto the owner", () => {
  const generated = generateGObjectScabiPackage(options(scalarSignalSnapshot()));
  assert.match(
    generated.declarations,
    /onResized\(callback: \(button: Button, width: gint, scale: gdouble\) => void\): SignalConnection;/u,
  );
  assert.deepEqual(generated.manifest.declarations.types, {
    gdouble: { module: ".", name: "gdouble" },
    gint: { module: ".", name: "gint" },
    gtk_button: { module: ".", name: "Button" },
    gtk_signal_connection: { module: ".", name: "SignalConnection" },
    gtk_widget: { module: ".", name: "Widget" },
  });
  assert.deepEqual(
    generated.manifest.types.gtk_button_resized_callback,
    {
      kind: "callback",
      signature: {
        callingConvention: "c",
        variadic: false,
        parameters: [
          {
            name: "width",
            type: "gint",
            passMode: "value",
            nullable: false,
            ownership: { kind: "value" },
            conversion: "number",
          },
          {
            name: "scale",
            type: "gdouble",
            passMode: "value",
            nullable: false,
            ownership: { kind: "value" },
            conversion: "number",
          },
        ],
        result: {
          type: "void",
          passMode: "value",
          nullable: false,
          ownership: { kind: "value" },
        },
      },
      context: { placement: "last", type: "void_ptr" },
    },
  );
  const connect = generated.manifest.bindings.gtk_button_connect_resized;
  assert.ok(connect && connect.kind !== "constant");
  assert.deepEqual(connect.signature.parameters[1]?.callback?.arguments, [
    { parameter: "width", transport: "copy" },
    { parameter: "scale", transport: "copy" },
  ]);
  assert.deepEqual(connect.signature.parameters[1]?.callback?.sourceArguments, [
    { kind: "registration-owner" },
    { kind: "callback-parameter", parameter: "width" },
    { kind: "callback-parameter", parameter: "scale" },
  ]);
  const translated = translateScabiNativeProgram(generated.manifest, {
    imports: ["gtk_button_connect_resized"],
    exports: [],
  });
  assert.equal(translated.ok, true);
  if (!translated.ok) return;
  const nativeConnect = translated.input.bindings.find(
    ({ id }) => id.endsWith("#gtk_button_connect_resized"),
  );
  assert.ok(nativeConnect);
  /* The queued gint payload stays exact in storage and reaches the handler as
   * a plain number; the gdouble payload is a double in both places, so it is
   * the same plain number without a conversion between them. */
  assert.deepEqual(nativeConnect.arguments[1]?.type, {
    kind: "func",
    params: [
      {
        kind: "nativeHandle",
        typeId: "native-typescript.gtk4@0.0.0#type:gtk_button",
      },
      { kind: "f64" },
      { kind: "f64" },
    ],
    ret: { kind: "void" },
  });
  const payloadSignature = nativeConnect.parameters[1]?.type;
  assert.deepEqual(
    payloadSignature?.kind === "nativeCallback"
      ? payloadSignature.signature.parameters
      : undefined,
    [
      { kind: "nativeScalar", scalar: "i32" },
      { kind: "nativeScalar", scalar: "f64" },
    ],
  );
  assert.deepEqual(nativeConnect.arguments[1]?.callback, {
    lifetime: "until-cancelled",
    registrationOwner: { kind: "argument", argument: 0 },
    cancellationBinding:
      "native-typescript.gtk4@0.0.0#gtk_signal_connection_disconnect",
    allowedInvocationExecutors: ["same-as-caller"],
    deliveryExecutor: "runtime-owner",
    synchronousReturn: false,
    transports: [{ kind: "copy" }, { kind: "copy" }],
    sourceArguments: [
      { kind: "registration-owner" },
      { kind: "callback-parameter", parameter: 0 },
      { kind: "callback-parameter", parameter: 1 },
    ],
    reentrancy: "allowed",
    postDisposal: "not-invoked",
    shutdown: "drain",
  });
  assertDeepFrozen(generated);
});

test("GTK SCABI generation canonicalizes unordered target inputs", () => {
  const left = options();
  Object.assign(left, {
    target: {
      ...left.target,
      features: ["gtk4", "glib-main-context"],
    },
    sdk: {
      ...left.sdk,
      modules: ["gtk4", "gobject-2.0"],
    },
    linkInputs: [
      { id: "gtk4", kind: "system-library", name: "gtk4", order: 1 },
      { id: "gobject", kind: "system-library", name: "gobject-2.0", order: 0 },
    ],
  } satisfies Partial<GObjectScabiGenerationOptions>);
  const right = options();
  Object.assign(right, {
    target: {
      ...right.target,
      features: [...left.target.features].reverse(),
    },
    sdk: {
      ...right.sdk,
      modules: [...left.sdk.modules].reverse(),
    },
    linkInputs: [...left.linkInputs].reverse(),
  } satisfies Partial<GObjectScabiGenerationOptions>);

  assert.deepEqual(
    generateGObjectScabiPackage(left),
    generateGObjectScabiPackage(right),
  );
});

test("GTK SCABI generation result is structurally typed", () => {
  const generated: GObjectScabiPackage = generateGObjectScabiPackage(options());
  assert.match(generated.manifestDigest, /^sha256:[0-9a-f]{64}$/u);
});
