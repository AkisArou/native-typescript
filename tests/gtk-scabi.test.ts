import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  CBindgenError,
  digestClangAbiEvidence,
  generateClangAbiProbe,
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
  GirIngestionError,
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
  notify: readonly string[] = [],
  methods: readonly string[] = ["get_label", "set_label"],
): GirSnapshot {
  return ingestGir(girSource, {
    logicalPath: "fixtures/gir/Gtk-4.0.selected.gir",
    namespace: { name: "Gtk", version: "4.0" },
    classes: [
      { name: "Widget" },
      {
        name: "Button",
        constructors: ["new_with_label"],
        methods,
        signals,
        notify,
      },
    ],
    records: [{ name: "Requisition", fields: ["width", "height"] }],
    enumerations: withOrientation
      ? [{ name: "Orientation", members: ["horizontal", "vertical"] }]
      : [],
  });
}

/**
 * An enumeration whose first member's name begins with a digit, and a method
 * returning it.
 *
 * `GTK_LICENSE_0BSD` is the real one this reproduces; `2d`, `24h`, `2big` and
 * `802_3` are others, across ninety-three enumerations in the installed GIRs.
 * Three separate layers each assumed a member name is a C identifier, and each
 * refused it: ingestion dropped the member from the selection, the probe
 * refused the candidate, and generation could not spell the declaration. Every
 * method typed by the enumeration disappeared with it, reported as a result
 * outside the implemented slice — naming the projection rather than the
 * selection that had already removed the type.
 */
function digitLeadingEnumSnapshot(): GirSnapshot {
  const source = girSource.replace(
    "  </namespace>",
    `    <enumeration name="License"
                 glib:type-name="GtkLicense"
                 glib:get-type="gtk_license_get_type"
                 c:type="GtkLicense">
      <member name="0bsd"
              value="0"
              c:identifier="GTK_LICENSE_0BSD"
              glib:nick="0bsd"
              glib:name="GTK_LICENSE_0BSD"/>
      <member name="custom"
              value="1"
              c:identifier="GTK_LICENSE_CUSTOM"
              glib:nick="custom"
              glib:name="GTK_LICENSE_CUSTOM"/>
    </enumeration>
  </namespace>`,
  ).replace(
    "<method name=\"get_label\"",
    `<method name="get_license" c:identifier="gtk_button_get_license">
        <return-value transfer-ownership="none">
          <type name="License" c:type="GtkLicense"/>
        </return-value>
        <parameters>
          <instance-parameter name="self" transfer-ownership="none">
            <type name="Button" c:type="GtkButton*"/>
          </instance-parameter>
        </parameters>
      </method>
      <method name="get_label"`,
  );
  return ingestGir(source, {
    logicalPath: "fixtures/gir/Gtk-4.0.selected.gir",
    namespace: { name: "Gtk", version: "4.0" },
    classes: [
      { name: "Widget" },
      { name: "Button", methods: ["get_license"] },
    ],
    enumerations: [{ name: "License", members: ["0bsd", "custom"] }],
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
  const gobjectAdapter = generateGObjectAdapterSource(
    selected,
    importedNamespaces.map(({ snapshot: imported }) => imported),
  );
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
const systemGdkGir = "/usr/share/gir-1.0/Gdk-4.0.gir";
const gio2Package = {
  name: "@native-typescript/gio2",
  version: "0.0.0",
  namespace: "native-typescript.gio2",
  instance: "native-typescript.gio2@0.0.0",
} as const;
const gdk4Package = {
  name: "@native-typescript/gdk4",
  version: "0.0.0",
  namespace: "native-typescript.gdk4",
  instance: "native-typescript.gdk4@0.0.0",
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
      gio_application: {
        package: gio2Package,
        type: "gio_application",
        destructor: "gio_application_release",
      },
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
          // the generated error contract survives translation — and that a
          // failable member is keyed by its own C symbol, because it binds
          // that symbol rather than a wrapper around it.
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
      imports: ["gio_application_connect_activate", "g_application_register"],
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
    // names from the operation. The detection names the slot the compiler
    // appended, and the result stays the member's own — register() answers
    // whether the application registered, which is what it always meant.
    const registerBinding = composed.input.bindings.find(({ declaration }) =>
      declaration.name === "Application.register"
    );
    assert.ok(registerBinding);
    if (!registerBinding) return;
    assert.deepEqual(registerBinding.error, {
      detect: {
        kind: "outParameterIsNotNull",
        parameter: registerBinding.parameters.length - 1,
      },
      message: { kind: "symbol", symbol: "nts_gio_error_message" },
      release: { kind: "symbol", symbol: "nts_gio_error_free" },
    });
    assert.equal(registerBinding.result.projection.kind, "boolean");
    assert.equal(registerBinding.entry.symbol, "g_application_register");

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
      gio_application: {
        package: gio2Package,
        type: "gio_application",
        destructor: "gio_application_release",
      },
    });
  },
);

test(
  "a method taking another namespace's object imports the handle it names",
  { skip: !existsSync(systemGtkGir) || !existsSync(systemGdkGir) },
  () => {
    /* gtk_widget_set_cursor(GtkWidget *, GdkCursor *). The cursor is Gdk's
     * object, and there is exactly one of it: gtk4 imports the handle type
     * gdk4 defines rather than declaring a second one for the same class,
     * which is what makes a value constructed through gdk4 the same type
     * here. */
    const gdk = ingestGir(readFileSync(systemGdkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gdk-4.0.gir",
      namespace: { name: "Gdk", version: "4.0" },
      classes: [{ name: "Cursor", constructors: ["new_from_name"] }],
    });
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [
        { name: "Widget", methods: ["set_cursor"] },
        { name: "Label", constructors: ["new"] },
      ],
    });

    const generated = generateGObjectScabiPackage(
      options(gtk, [{ snapshot: gdk, package: gdk4Package }]),
    );

    assert.match(
      generated.declarations,
      /^import type \{ Cursor as GdkCursor \} from "@native-typescript\/gdk4";$/mu,
    );
    // GIR marks the cursor nullable, and clearing one is what that means.
    assert.match(
      generated.declarations,
      /setCursor\(cursor: GdkCursor \| null\): void;/u,
    );
    assert.deepEqual(generated.manifest.imports, {
      gdk_cursor: {
        package: gdk4Package,
        type: "gdk_cursor",
        /* Derived exactly as gdk4 derives it, so owning one of these here
         * releases it through the binding that package declares. */
        destructor: "gdk_cursor_release",
      },
    });
    // Imported, so defined nowhere here: the pointer is the whole
    // representation a signature needs, and composition proves the rest.
    assert.equal(generated.manifest.types.gdk_cursor, undefined);
    const setCursor = generated.manifest.bindings.gtk_widget_set_cursor;
    assert.ok(setCursor && setCursor.kind !== "constant");
    assert.deepEqual(setCursor.signature.parameters[1], {
      name: "cursor",
      type: "gdk_cursor",
      passMode: "pointer",
      nullable: true,
      ownership: { kind: "borrowed", scope: "call" },
    });
  },
);

test(
  "an implemented interface declares its members once for every class",
  { skip: !existsSync(systemGtkGir) },
  () => {
    /* GObject puts `orientation` on GtkOrientable, which 24 widgets
     * implement. The interface declares the member and each class merges with
     * it, so the binding's receiver is the interface's own handle and the
     * identity upcast is what makes a Box a legal one. */
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [
        { name: "Widget" },
        { name: "Box", constructors: ["new"] },
      ],
      interfaces: [
        { name: "Orientable", methods: ["get_orientation", "set_orientation"] },
      ],
      enumerations: [
        { name: "Orientation", members: ["horizontal", "vertical"] },
      ],
    });

    const generated = generateGObjectScabiPackage(options(gtk));

    // Declared as what it is: no construction, no parent.
    assert.match(generated.declarations, /export interface Orientable \{/u);
    assert.doesNotMatch(generated.declarations, /class Orientable/u);
    assert.match(
      generated.declarations,
      /get orientation\(\): Orientation;/u,
    );
    // Merging, not redeclaration: Box's own body never mentions the member.
    assert.match(
      generated.declarations,
      /^export interface Box extends Orientable \{\}$/mu,
    );
    assert.equal(
      /export declare class Box[\s\S]*?\n\}/u.exec(generated.declarations)?.[0]
        .includes("get orientation("),
      false,
    );

    const box = generated.manifest.types.gtk_box;
    assert.ok(box && box.kind === "handle");
    if (!box || box.kind !== "handle") return;
    assert.deepEqual(box.upcasts, [
      { kind: "identity", target: "gtk_orientable" },
      { kind: "identity", target: "gtk_widget" },
    ]);
    /* GIR lists an inherited interface on every subclass; the edge is stated
     * where it is added. Widget does not implement Orientable, so Box does. */
    const widget = generated.manifest.types.gtk_widget;
    assert.ok(widget && widget.kind === "handle");
    if (!widget || widget.kind !== "handle") return;
    assert.deepEqual(widget.upcasts, []);

    const setter = generated.manifest.bindings.gtk_orientable_set_orientation;
    assert.ok(setter && setter.kind !== "constant");
    assert.equal(setter.kind, "setter");
    assert.equal(setter.declaration.name, "Orientable.orientation");
    assert.equal(setter.signature.parameters[0]?.type, "gtk_orientable");
  },
);

test(
  "a method handing back another namespace's object owns it through the owner",
  { skip: !existsSync(systemGtkGir) || !existsSync(systemGdkGir) },
  () => {
    /* gtk_widget_get_display() answers a GdkDisplay it keeps owning. The
     * adapter takes a reference, which makes the result an owned handle whose
     * type gdk4 declares — so what releases it is gdk4's binding, carried by
     * the import rather than declared a second time here. */
    const gdk = ingestGir(readFileSync(systemGdkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gdk-4.0.gir",
      namespace: { name: "Gdk", version: "4.0" },
      classes: [{ name: "Display", methods: ["is_closed"] }],
    });
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [
        { name: "Widget", methods: ["get_display"] },
        { name: "Label", constructors: ["new"] },
      ],
    });

    const generated = generateGObjectScabiPackage(
      options(gtk, [{ snapshot: gdk, package: gdk4Package }]),
    );

    assert.match(
      generated.declarations,
      /getDisplay\(\): GdkDisplay;/u,
    );
    const getDisplay = generated.manifest.bindings.gtk_widget_get_display;
    assert.ok(getDisplay && getDisplay.kind !== "constant");
    assert.deepEqual(getDisplay.signature.result.ownership, {
      kind: "owned",
      transfer: "to-runtime",
    });
    assert.equal(getDisplay.signature.result.type, "gdk_display");
    // Nothing local releases it, so nothing local is depended on for it.
    assert.deepEqual(getDisplay.dependencies.bindings, []);
    assert.equal(generated.manifest.bindings.gdk_display_release, undefined);
    assert.deepEqual(generated.manifest.imports, {
      gdk_display: {
        package: gdk4Package,
        type: "gdk_display",
        destructor: "gdk_display_release",
      },
    });
  },
);

test(
  "an imported interface is an object like any other",
  { skip: !existsSync(systemGtkGir) || !existsSync(systemGioGir) },
  () => {
    /* `gtk_drop_down_get_model` answers a `GListModel`, which Gio declares as
     * an interface rather than a class. Nothing downstream distinguishes
     * them — both are a handle another package owns — and this is also the
     * shape where the borrowed result is the only thing the adapter has to
     * wrap for the class. */
    const gio = ingestGir(readFileSync(systemGioGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gio-2.0.gir",
      namespace: { name: "Gio", version: "2.0" },
      classes: [],
      interfaces: [{ name: "ListModel", methods: ["get_n_items"] }],
    });
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [
        { name: "Widget" },
        { name: "DropDown", methods: ["get_model"] },
      ],
    });

    const generated = generateGObjectScabiPackage(
      options(gtk, [{ snapshot: gio, package: gio2Package }]),
    );

    assert.match(
      generated.declarations,
      /getModel\(\): GioListModel \| null;/u,
    );
    assert.deepEqual(generated.manifest.imports, {
      gio_list_model: {
        package: gio2Package,
        type: "gio_list_model",
        destructor: "gio_list_model_release",
      },
    });
  },
);

test(
  "a record whose contents are not readable projects as a handle",
  { skip: !existsSync(systemGtkGir) },
  () => {
    /* GtkTextIter is fourteen opaque fields, a copy and a free. It is not a
     * layout, so it crosses as an owned pointer whose destructor is the free
     * GTK declares — and the method that fills caller-allocated storage with
     * one hands it back through an adapter that reserved the storage. */
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [
        { name: "Widget" },
        { name: "TextBuffer", methods: ["get_start_iter", "get_iter_at_offset"] },
      ],
      records: [{ name: "TextIter", methods: ["forward_char", "get_offset"] }],
    });

    const generated = generateGObjectScabiPackage(options(gtk));

    // No construction and no hierarchy, so it is declared as what it is.
    assert.match(generated.declarations, /export interface TextIter \{/u);
    assert.doesNotMatch(generated.declarations, /class TextIter/u);
    assert.match(generated.declarations, /forwardChar\(\): boolean;/u);
    assert.match(generated.declarations, /getStartIter\(\): TextIter;/u);
    assert.match(
      generated.declarations,
      /getIterAtOffset\(charOffset: gint\): TextIter;/u,
    );
    /* The contract is not the surface: `copy` and `free` are read because the
     * projection needs them, and neither becomes a member unless asked for. */
    assert.doesNotMatch(generated.declarations, /copy\(\)|free\(\)/u);

    const iter = generated.manifest.types.gtk_text_iter;
    assert.ok(iter && iter.kind === "handle");
    if (!iter || iter.kind !== "handle") return;
    assert.deepEqual(iter, {
      kind: "handle",
      nativeName: "GtkTextIter",
      threadSafety: "confined",
      /* Not the pointer: `copy` makes a second object with the same contents,
       * so two of these are not one cell. */
      identity: "none",
      upcasts: [],
      destructor: "gtk_text_iter_free",
    });

    // The free is already a destructor, so it binds directly with no wrapper.
    const free = generated.manifest.bindings.gtk_text_iter_free;
    assert.ok(free && free.kind !== "constant");
    assert.equal(free.entry.symbol, "gtk_text_iter_free");
    /* Depending on no adapter input IS the statement that the SDK provides it;
     * the binding no longer says so a second time. */
    assert.deepEqual(free.dependencies.adapterInputs, []);

    const start =
      generated.manifest.bindings.nts_gobject_boxed_gtk_text_buffer_get_start_iter;
    assert.ok(start && start.kind !== "constant");
    assert.deepEqual(start.dependencies.adapterInputs, ["gtk4.gobject-adapters"]);
    assert.deepEqual(start.signature.result.ownership, {
      kind: "owned",
      transfer: "to-runtime",
    });
    assert.equal(start.signature.result.type, "gtk_text_iter");
    assert.deepEqual(start.dependencies.bindings, ["gtk_text_iter_free"]);
    assert.match(
      generateGObjectAdapterSource(gtk).source,
      /GtkTextIter value;[\s\S]*?gtk_text_buffer_get_start_iter\(instance, &value\);\n\s*return gtk_text_iter_copy\(&value\);/u,
    );
  },
);

test(
  "a boxed record signal payload is duplicated by its copy, never referenced",
  { skip: !existsSync(systemGtkGir) },
  () => {
    /* Delivery is queued, so a payload has to outlive the emission that
     * produced it — and HOW one is kept is a property of what it IS. A GObject
     * gains a reference; a boxed record has none to gain and answers its own
     * copy.
     *
     * Both arrive at the payload projection through the same table, because
     * both are handles. `g_object_ref` on a GtkTextIter would read fourteen
     * opaque words as a GTypeInstance and increment whichever of them came
     * first, and the free that pairs with the handle's destructor would then
     * release storage this program never owned. The C compiles either way,
     * which is why this is asserted rather than reviewed. */
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [
        { name: "Widget" },
        { name: "TextBuffer", methods: ["get_line_count"], signals: ["delete-range"] },
      ],
      records: [{ name: "TextIter", methods: ["get_offset"] }],
    });
    const source = generateGObjectAdapterSource(gtk).source;
    assert.match(source, /parameter_0000 = gtk_text_iter_copy\(parameter_0000\);/u);
    assert.doesNotMatch(source, /g_object_ref\(parameter_000\d\)/u);

    /* The copy is what the invocation owns, so what releases it is the type's
     * own free — the pairing the handle already declared. */
    const generated = generateGObjectScabiPackage(options(gtk));
    const iter = generated.manifest.types.gtk_text_iter;
    assert.ok(iter && iter.kind === "handle");
    if (!iter || iter.kind !== "handle") return;
    assert.equal(iter.destructor, "gtk_text_iter_free");

    /* An object payload still takes a reference: the fix distinguishes the two
     * rather than replacing one with the other. */
    const withObject = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [
        { name: "Widget" },
        { name: "ListBox", signals: ["row-activated"] },
        { name: "ListBoxRow", methods: ["get_index"] },
      ],
    });
    assert.match(
      generateGObjectAdapterSource(withObject).source,
      /g_object_ref\(parameter_0000\);/u,
    );
  },
);

test(
  "a boxed record crosses as an argument, not only as a result",
  { skip: !existsSync(systemGtkGir) },
  () => {
    /* The roadmap recorded record-typed parameters as refused everywhere,
     * which was true when a record could only be a layout. A boxed record is
     * an owned handle, and a handle is an input family — so what a caller
     * hands back is what it was given, borrowed for the call.
     *
     * This is the direction that matters for GTK: of the 62 live methods
     * taking a record parameter, none takes a value record and 49 take a
     * GtkTextIter. */
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [
        { name: "Widget" },
        { name: "TextBuffer", methods: ["get_start_iter", "place_cursor"] },
      ],
      records: [{ name: "TextIter", methods: ["forward_char"] }],
    });
    const generated = generateGObjectScabiPackage(options(gtk));

    const place = generated.manifest.bindings.gtk_text_buffer_place_cursor;
    assert.ok(place && "signature" in place);
    if (!place || !("signature" in place)) return;
    /* No wrapper: the SDK's own symbol takes the pointer the handle names. */
    assert.deepEqual(place.entry, { symbol: "gtk_text_buffer_place_cursor" });
    assert.deepEqual(place.dependencies.adapterInputs, []);
    assert.deepEqual(
      place.signature.parameters.map(({ name, type, ownership }) => ({
        name,
        type,
        ownership,
      })),
      [
        {
          name: "buffer",
          type: "gtk_text_buffer",
          ownership: { kind: "borrowed", scope: "call" },
        },
        {
          /* Borrowed for the call: the caller keeps the iterator, and GTK
           * reads through it without taking a reference. */
          name: "where",
          type: "gtk_text_iter",
          ownership: { kind: "borrowed", scope: "call" },
        },
      ],
    );
    assert.match(generated.declarations, /^ {2}placeCursor\(where: TextIter\): void;$/mu);

    /* And what one method hands back another accepts, which is the property
     * that makes an iterator usable rather than merely producible. */
    assert.match(generated.declarations, /^ {2}getStartIter\(\): TextIter;$/mu);
    const program = translateScabiNativeProgram(generated.manifest, {
      imports: ["gtk_text_buffer_place_cursor", "gtk_text_iter_free"],
      exports: [],
    });
    assert.equal(
      program.ok,
      true,
      program.ok ? undefined : JSON.stringify(program.diagnostics),
    );
  },
);

test(
  "a record selects one projection or the other, never both",
  { skip: !existsSync(systemGtkGir) },
  () => {
    const source = readFileSync(systemGtkGir, "utf8");
    const select = (record: Record<string, unknown>) =>
      ingestionError(() =>
        ingestGir(source, {
          logicalPath: "system-sdk/gir/Gtk-4.0.gir",
          namespace: { name: "Gtk", version: "4.0" },
          classes: [{ name: "Widget" }],
          records: [record as never],
        })
      );
    for (const record of [
      { name: "Requisition" },
      { name: "Requisition", fields: ["width"], methods: ["copy"] },
    ]) {
      assert.match(
        select(record).diagnostics[0]?.message ?? "",
        /must select either fields or methods/u,
      );
    }
    /* A record asked for as a handle has to be one. `GtkBitset` declares a
     * copy and no free, so there would be nothing to release what the
     * allocation produced. */
    assert.match(
      ingestionError(() =>
        ingestGir(source, {
          logicalPath: "system-sdk/gir/Gtk-4.0.gir",
          namespace: { name: "Gtk", version: "4.0" },
          classes: [{ name: "Widget" }],
          records: [{ name: "Bitset", methods: ["get_size"] }],
        })
      ).diagnostics.map(({ message }) => message).join("\n"),
      /requires the copy and free it is duplicated and released by/u,
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
  "a member that fills storage may also say whether it worked",
  { skip: !existsSync(systemGtkGir) },
  () => {
    /* gtk_gesture_get_bounding_box_center() answers whether the gesture has
      * a bounding box and fills the centre either way — the most idiomatic
      * shape GTK has for "did it work, and here is the value", and 31 of its
      * 80 live methods with out-parameters take it. Reporting absence instead
      * would discard the coordinates, which is why the answer is a FIELD. */
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [
        { name: "EventController" },
        { name: "Gesture", methods: ["get_bounding_box_center"] },
      ],
    });
    const adapter = generateGObjectAdapterSource(gtk);
    const method = adapter.valueMethods[0];
    assert.ok(method);
    if (method === undefined) return;
    assert.equal(method.answers, true);

    /* The answer leads the record, and the call's result lands in it. */
    assert.ok(adapter.source.includes([
      "typedef struct NtsGtkGestureBoundingBoxCenter {",
      "  gboolean answered;",
      "  gdouble x;",
      "  gdouble y;",
      "} NtsGtkGestureBoundingBoxCenter;",
    ].join("\n")), adapter.source);
    assert.match(adapter.source, /result\.answered = gtk_gesture_get_bounding_box_center\(/u);

    const generated = generateGObjectScabiPackage(options(gtk));
    const record = generated.manifest.types.gtk_gesture_bounding_box_center;
    assert.ok(record && record.kind === "struct");
    if (!record || record.kind !== "struct") return;
    /* The manifest says "read this as a boolean" with the field's TYPE. There
     * is no second marker: a boolean type already carries its storage and its
     * two representations, and the translator turns that into the projection. */
    assert.deepEqual(record.fields.map(({ name, type }) => ({ name, type })), [
      { name: "answered", type: "gboolean" },
      { name: "x", type: "gdouble" },
      { name: "y", type: "gdouble" },
    ]);
    assert.match(generated.declarations, /^ {2}readonly answered: boolean;$/mu);

    /* And it survives translation as C's own truth test over the storage. */
    const program = translateScabiNativeProgram(generated.manifest, {
      imports: ["nts_gobject_value_gtk_gesture_get_bounding_box_center"],
      exports: [],
    });
    assert.equal(
      program.ok,
      true,
      program.ok ? undefined : JSON.stringify(program.diagnostics),
    );
    if (!program.ok) return;
    const translated = program.input.types.find(({ id }) =>
      id.endsWith("#type:gtk_gesture_bounding_box_center")
    );
    assert.ok(translated && translated.kind === "struct");
    if (!translated || translated.kind !== "struct") return;
    assert.equal(translated.fields[0]?.name, "answered");
    assert.equal(translated.fields[0]?.projection, "boolean");
    assert.deepEqual(translated.fields[0]?.type, { kind: "nativeScalar", scalar: "i32" });
  },
);

test(
  "a vector of strings crosses in both directions, freed by the symbol its transfer names",
  { skip: !existsSync(systemGtkGir) },
  () => {
    /* Three real members, one per ownership shape the SDK actually uses.
     *
     * gtk_widget_set_css_classes() takes a vector the caller keeps.
     * gtk_icon_theme_get_icon_names() returns one the CALLER must free,
     * elements and all — GIR's `full`. gtk_alert_dialog_get_buttons() returns one the
     * DIALOG keeps, which is GIR's `none` and is a borrow anchored to the
     * receiver rather than a free — and it is nullable, so the absent vector
     * is a value here too.
     *
     * The three differ in one field, and that is the point: which symbol
     * frees the vector, or none at all. */
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [
        { name: "Widget", methods: ["set_css_classes"] },
        { name: "IconTheme", methods: ["get_icon_names", "set_resource_path"] },
        { name: "AlertDialog", methods: ["get_buttons"] },
      ],
    });
    const generated = generateGObjectScabiPackage(options(gtk));

    const input = generated.manifest.bindings.gtk_widget_set_css_classes;
    assert.ok(input && input.kind === "method");
    if (!input || input.kind !== "method") return;
    const classes = input.signature.parameters[1];
    assert.deepEqual(classes?.marshal, {
      kind: "string-vector",
      encoding: "utf-8",
      termination: "nul",
      embeddedNul: "reject",
    });
    /* Borrowed for the call and freeing nothing: the managed array owns the
     * strings, and the vector exists only for the duration of the call. */
    assert.deepEqual(classes?.ownership, { kind: "borrowed", scope: "call" });
    assert.equal(classes?.type, "const_utf8_vector");

    const owned = generated.manifest.bindings.gtk_icon_theme_get_icon_names;
    assert.ok(owned && owned.kind === "method");
    if (!owned || owned.kind !== "method") return;
    /* `full` hands over the elements too, so freeing the vector alone would
     * leak every string in it. The symbol says so; nothing else has to. */
    assert.deepEqual(owned.signature.result.marshal, {
      kind: "string-vector",
      encoding: "utf-8",
      termination: "nul",
      embeddedNul: "reject",
      release: "g_strfreev",
    });
    assert.deepEqual(owned.signature.result.ownership, { kind: "value" });

    const borrowed = generated.manifest.bindings.gtk_alert_dialog_get_buttons;
    assert.ok(borrowed && borrowed.kind === "method");
    if (!borrowed || borrowed.kind !== "method") return;
    assert.deepEqual(borrowed.signature.result.marshal, {
      kind: "string-vector",
      encoding: "utf-8",
      termination: "nul",
      embeddedNul: "reject",
    });
    assert.equal(borrowed.signature.result.nullable, true);
    assert.equal(borrowed.signature.result.type, "nullable_const_utf8_vector");
    /* Nothing to free, so the copy has to happen while the dialog that owns
     * the vector is still alive — which is what the anchor records. */
    assert.deepEqual(borrowed.signature.result.ownership, {
      kind: "borrowed",
      scope: "receiver",
      anchor: "self",
    });

    /* And an input the source may omit. Absence reaches the callee as NULL,
     * which is not an empty vector — gtk_icon_theme_set_resource_path() takes
     * one because "no search path" and "an empty search path" are different
     * instructions. */
    const optional = generated.manifest.bindings.gtk_icon_theme_set_resource_path;
    assert.ok(optional && optional.kind === "method");
    if (!optional || optional.kind !== "method") return;
    const pathParameter = optional.signature.parameters[1];
    assert.equal(pathParameter?.nullable, true);
    assert.equal(pathParameter?.type, "nullable_const_utf8_vector");
    assert.deepEqual(pathParameter?.ownership, { kind: "borrowed", scope: "call" });

    /* The source sees ordinary arrays in both directions. The vector is a
     * physical shape; no program ever names one. */
    assert.match(
      generated.declarations,
      /^ {2}setCssClasses\(classes: readonly string\[\]\): void;$/mu,
    );
    assert.match(generated.declarations, /^ {2}getIconNames\(\): string\[\];$/mu);
    assert.match(
      generated.declarations,
      /^ {2}setResourcePath\(path: readonly string\[\] \| null\): void;$/mu,
    );

    const program = translateScabiNativeProgram(generated.manifest, {
      imports: [
        "gtk_widget_set_css_classes",
        "gtk_icon_theme_get_icon_names",
        "gtk_alert_dialog_get_buttons",
        "gtk_icon_theme_set_resource_path",
      ],
      exports: [],
    });
    assert.equal(
      program.ok,
      true,
      program.ok ? undefined : JSON.stringify(program.diagnostics),
    );
    if (!program.ok) return;
    const byId = new Map(program.input.bindings.map((binding) => [binding.id, binding]));
    const find = (suffix: string) =>
      [...byId.values()].find(({ id }) => id.endsWith(suffix));

    /* One slot, not two: the terminator is the length. */
    const loweredInput = find("#gtk_widget_set_css_classes");
    assert.deepEqual(loweredInput?.arguments[1]?.type, {
      kind: "array",
      elem: { kind: "string" },
    });
    assert.deepEqual(loweredInput?.parameters[1]?.projection, {
      kind: "utf8CStringArray",
      argument: 1,
    });

    assert.deepEqual(find("#gtk_icon_theme_get_icon_names")?.result.projection, {
      kind: "utf8CStringArray",
      nullable: false,
      release: { kind: "symbol", symbol: "g_strfreev" },
    });
    /* The nullable input lowers to the source form that admits both arms,
     * and to the same one physical slot: absence is a NULL vector, not a
     * missing parameter. */
    const loweredOptional = find("#gtk_icon_theme_set_resource_path");
    assert.deepEqual(loweredOptional?.arguments[1]?.type, { kind: "nullableStringArray" });
    assert.equal(loweredOptional?.parameters.length, 2);
    assert.deepEqual(loweredOptional?.parameters[1]?.projection, {
      kind: "utf8CStringArray",
      argument: 1,
    });

    assert.deepEqual(find("#gtk_alert_dialog_get_buttons")?.result.projection, {
      kind: "utf8CStringArray",
      nullable: true,
      release: { kind: "none" },
    });
  },
);

test(
  "a returned string the caller must free names the symbol that frees it",
  { skip: !existsSync(systemGtkGir) },
  () => {
    /* gtk_css_provider_to_string() builds a string for the caller — GIR's
     * transfer `full`, spelled `char *` — while gtk_icon_theme_get_theme_name()
     * does the same and gtk_widget_get_name() hands back one the widget keeps.
     * The projection is identical; what differs is one field, and reading it
     * off the transfer is the whole of the decision. */
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [
        { name: "CssProvider", methods: ["to_string"] },
        { name: "IconTheme", methods: ["get_theme_name"] },
      ],
    });
    const generated = generateGObjectScabiPackage(options(gtk));

    const owned = generated.manifest.bindings.gtk_css_provider_to_string;
    assert.ok(owned && owned.kind === "method");
    if (!owned || owned.kind !== "method") return;
    assert.deepEqual(owned.signature.result.marshal, {
      kind: "string",
      encoding: "utf-8",
      length: { kind: "nul" },
      termination: "nul",
      embeddedNul: "reject",
      release: "g_free",
    });
    /* Consumed by the projection: the bytes are copied and the pointer freed
     * inside the call, so nothing the program holds outlives it. That is why
     * this is a value rather than a borrow anchored to the provider. */
    assert.deepEqual(owned.signature.result.ownership, { kind: "value" });
    /* And the slot is not const, because a const one is a slot nobody could
     * free — the spelling has to agree with the transfer. */
    assert.equal(owned.signature.result.type, "utf8");
    assert.match(generated.declarations, /^ {2}toString\(\): string;$/mu);

    const program = translateScabiNativeProgram(generated.manifest, {
      imports: ["gtk_css_provider_to_string", "gtk_icon_theme_get_theme_name"],
      exports: [],
    });
    assert.equal(
      program.ok,
      true,
      program.ok ? undefined : JSON.stringify(program.diagnostics),
    );
    if (!program.ok) return;
    const find = (suffix: string) =>
      program.input.bindings.find(({ id }) => id.endsWith(suffix));
    assert.deepEqual(find("#gtk_css_provider_to_string")?.result.projection, {
      kind: "utf8CString",
      nullable: false,
      release: { kind: "symbol", symbol: "g_free" },
    });
    assert.deepEqual(find("#gtk_css_provider_to_string")?.result.ownership, {
      kind: "value",
    });
  },
);

test(
  "a path parameter crosses as the string it is on this target",
  { skip: !existsSync(systemGtkGir) },
  () => {
    /* GIR spells a path `filename` rather than `utf8`, and the difference is
     * an ENCODING rather than a shape: both are `const char *`, and GLib's
     * file name encoding is what `G_FILENAME_ENCODING` names — UTF-8 unless
     * it says otherwise, which on `x86_64-unknown-linux-gnu` it does not.
     *
     * So a path and a string are the same bytes here and one projection
     * carries both. The alternative is converting through
     * `g_filename_from_utf8`, which can fail, and would make every
     * path-taking member failable — including the many GTK declares as void
     * and non-throwing. That buys portability this project does not target
     * and costs twenty members their shape. */
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [{ name: "CssProvider", methods: ["load_from_path"] }],
    });
    const generated = generateGObjectScabiPackage(options(gtk));
    const binding = generated.manifest.bindings.gtk_css_provider_load_from_path;
    assert.ok(binding && binding.kind === "method");
    if (!binding || binding.kind !== "method") return;

    const path = binding.signature.parameters[1];
    assert.equal(path?.type, "const_utf8");
    assert.deepEqual(path?.marshal, {
      kind: "string",
      encoding: "utf-8",
      length: { kind: "nul" },
      termination: "nul",
      embeddedNul: "reject",
    });
    assert.deepEqual(path?.ownership, { kind: "borrowed", scope: "call" });
    assert.match(generated.declarations, /^ {2}loadFromPath\(path: string\): void;$/mu);

    const program = translateScabiNativeProgram(generated.manifest, {
      imports: ["gtk_css_provider_load_from_path"],
      exports: [],
    });
    assert.equal(
      program.ok,
      true,
      program.ok ? undefined : JSON.stringify(program.diagnostics),
    );
  },
);

test(
  "a property's accessors must agree about the type, not about the spelling",
  { skip: !existsSync(systemGtkGir) },
  () => {
    /* `css-classes` is a GObject property whose accessors are written
     * differently in C and identically in GIR: the getter hands over a vector
     * (`char **`, transfer full) and the setter borrows one
     * (`const char **`, transfer none). Both name `array<utf8>`.
     *
     * What differs is ownership and constness, which this generator already
     * projects per position and which do not make one property into two —
     * `get cssClasses(): string[]` beside `set cssClasses(v: readonly string[])`
     * is a coherent pair, because the getter's type is assignable to the
     * setter's. Comparing the raw GIR reference compared the C spelling too,
     * and refused fifteen of GTK's eighteen accessor pairs on that basis. */
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [{ name: "Widget", methods: ["set_css_classes", "get_css_classes"] }],
    });
    const generated = generateGObjectScabiPackage(options(gtk));
    assert.equal(
      generated.manifest.bindings.gtk_widget_get_css_classes?.kind,
      "getter",
    );
    assert.equal(
      generated.manifest.bindings.gtk_widget_set_css_classes?.kind,
      "setter",
    );

    /* What stays refused is a pair that genuinely is not one property.
     * `gtk_entry_buffer_set_text` takes a LENGTH beside its value, so the
     * setter is not the getter's inverse however the types are compared. */
    const buffer = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [{ name: "EntryBuffer", methods: ["get_text", "set_text"] }],
    });
    assert.throws(
      () => generateGObjectScabiPackage(options(buffer)),
      (error: unknown) =>
        error instanceof Error &&
        /do not form one coherent property type contract/u.test(error.message),
    );
  },
);

test(
  "a throwing member keeps its own result and binds its own symbol",
  { skip: !existsSync(systemGtkGir) },
  () => {
    // gtk_recent_manager_purge_items() returns how many items it purged and
    // reports failure through a GError. It is the whole chain in one member:
    // the count is a gint the source sees widened into a number, and the
    // failure arrives somewhere else entirely, so neither reading interferes
    // with the other. Nothing generated stands between the two.
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [{ name: "RecentManager", methods: ["purge_items"] }],
    });
    const generated = generateGObjectScabiPackage(options(gtk));
    const binding = generated.manifest.bindings.gtk_recent_manager_purge_items;
    assert.ok(binding && binding.kind === "method");
    if (!binding || binding.kind !== "method") return;
    // Its own symbol, not a wrapper: no adapter absorbs the slot any more.
    assert.deepEqual(binding.entry, { symbol: "gtk_recent_manager_purge_items" });
    assert.deepEqual(binding.error, {
      kind: "error-out",
      message: "gtk_error_message",
      release: "gtk_error_free",
    });
    // The accessors are ordinary bindings, so they are reachability
    // dependencies like a destructor rather than free-floating symbols.
    assert.deepEqual([...binding.dependencies.bindings].sort(), [
      "gtk_error_free",
      "gtk_error_message",
    ]);
    // GIR omits the trailing GError** because the caller does not supply it.
    // The compiler owns that slot, so the manifest names the visible
    // parameters and nothing else.
    assert.deepEqual(
      binding.signature.parameters.map(({ name }) => name),
      ["manager"],
    );
    assert.equal(binding.signature.result.type, "gint");
    assert.equal(binding.signature.result.conversion, "number");
    assert.match(generated.declarations, /^ {2}purgeItems\(\): gint;$/mu);

    // And it survives translation, which is where a converted result beside a
    // failure contract would have been refused before: a sentinel would read
    // the exact scalar the source never sees, and a slot reads nothing.
    const program = translateScabiNativeProgram(generated.manifest, {
      imports: ["gtk_recent_manager_purge_items"],
      exports: [],
    });
    assert.equal(
      program.ok,
      true,
      program.ok ? undefined : JSON.stringify(program.diagnostics),
    );
    if (!program.ok) return;
    const translated = program.input.bindings.find(({ id }) =>
      id.endsWith("#gtk_recent_manager_purge_items")
    );
    assert.equal(translated?.error.detect.kind, "outParameterIsNotNull");
    assert.equal(translated?.result.projection.kind, "number");
    // The slot the compiler appends is the last parameter, which is where a
    // GError ** sits, and the detection names that position.
    assert.equal(
      translated?.error.detect.kind === "outParameterIsNotNull"
        ? translated.error.detect.parameter
        : null,
      (translated?.parameters.length ?? 0) - 1,
    );
    assert.equal(translated?.parameters.at(-1)?.type.kind, "nativeErrorOut");
    assert.deepEqual(translated?.parameters.at(-1)?.projection, { kind: "errorOut" });
    // The message and release are resolved to the symbols the namespace's
    // accessors bind, so no emitter has to look a binding id back up.
    assert.deepEqual(translated?.error.message, {
      kind: "symbol",
      symbol: "nts_gtk_error_message",
    });
    assert.deepEqual(translated?.error.release, {
      kind: "symbol",
      symbol: "nts_gtk_error_free",
    });
  },
);

test(
  "a throwing member with out-parameters names the slice it needs",
  { skip: !existsSync(systemGtkGir) },
  () => {
    // gtk_builder_value_from_string() throws AND fills caller-supplied
    // storage. Its failure has a shape now and its outputs do not, so the
    // refusal has to name the outputs rather than the GError — naming the
    // half that already works would send a reader looking in the wrong place.
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [{ name: "Builder", methods: ["value_from_string"] }],
    });
    const callable = gtk.classes[0]?.methods[0];
    assert.equal(callable?.throws, true);
    assert.equal(
      callable?.parameters.some((parameter) => parameter.direction !== "in"),
      true,
    );
    const failure = generationError(() => generateGObjectAdapterSource(gtk));
    assert.equal(
      failure.diagnostics.some(({ message }) =>
        message.includes("with out-parameters is not projected")
      ),
      true,
      failure.diagnostics.map(({ message }) => message).join("\n"),
    );
  },
);

test(
  "a throwing constructor names the adapter that would have to carry its slot",
  { skip: !existsSync(systemGioGir) },
  () => {
    // A constructor's result becomes a handle, which needs the adopting
    // adapter to take a reference first. That adapter would have to FORWARD
    // the compiler's error slot rather than own it, and no adapter does. A
    // method needs no adapter at all, which is exactly why it binds directly
    // and this does not — so the refusal has to say adapter, not GError.
    const gio = ingestGir(readFileSync(systemGioGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gio-2.0.gir",
      namespace: { name: "Gio", version: "2.0" },
      classes: [{ name: "Subprocess", constructors: ["newv"] }],
    });
    assert.equal(gio.classes[0]?.constructors[0]?.throws, true);
    const failure = generationError(() => generateGObjectAdapterSource(gio));
    assert.equal(
      failure.diagnostics.some(({ message }) =>
        message.includes("forward the compiler's error slot")
      ),
      true,
      failure.diagnostics.map(({ message }) => message).join("\n"),
    );
  },
);

test(
  "a throwing member whose result is outside the slice still fails precisely",
  { skip: !existsSync(systemGioGir) },
  () => {
    // g_credentials_get_unix_user() returns a uid_t, which no entry in the
    // scalar table claims — POSIX does not fix its signedness, so nothing here
    // may guess a width for it. Keeping its own result is what makes this
    // reachable at all; being reachable is not the same as being projectable,
    // and the refusal has to name the result rather than the GError.
    const gio = ingestGir(readFileSync(systemGioGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gio-2.0.gir",
      namespace: { name: "Gio", version: "2.0" },
      classes: [
        { name: "Credentials", constructors: ["new"], methods: ["get_unix_user"] },
      ],
    });
    const throwing = gio.classes[0]?.methods[0];
    assert.ok(throwing?.throws);
    if (!throwing?.throws) return;
    const failure = generationError(() => generateGObjectScabiPackage(options(gio)));
    assert.equal(
      failure.diagnostics.some(({ message }) =>
        message.includes("Method result is outside the")
      ),
      true,
      failure.diagnostics.map(({ message }) => message).join("\n"),
    );
  },
);


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
  "a signal that asks a question is answered during its emission",
  { skip: !existsSync(systemGtkGir) },
  () => {
    /* `Window::close-request` asks whether the application handled the
     * request and consumes the answer while deciding what to do, so its
     * handler cannot be delivered in a later turn. It is registered once and
     * asked many times, which is why the contract is until-cancelled with a
     * synchronous answer rather than call-scoped. */
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [
        { name: "Widget" },
        { name: "Window", constructors: ["new"], signals: ["close-request"] },
      ],
    });
    const generated = generateGObjectScabiPackage(options(gtk));

    /* A boolean answer, and no sender: a borrowed managed handle is exactly
     * what this delivery cannot hand over. */
    assert.match(
      generated.declarations,
      /onCloseRequest\(callback: \(\) => boolean\): SignalConnection;/u,
    );
    const connect = generated.manifest.bindings.gtk_window_connect_close_request;
    assert.ok(connect && connect.kind !== "constant");
    const contract = connect.signature.parameters[1]?.callback;
    assert.equal(contract?.synchronousReturn, true);
    assert.equal(contract?.registrationOwner, "window");
    assert.deepEqual(contract?.allowedInvocationExecutors, [
      { kind: "same-as-caller" },
    ]);
    assert.deepEqual(contract?.sourceArguments, []);
    const callback = generated.manifest.types.gtk_window_close_request_callback;
    assert.equal(
      callback?.kind === "callback" ? callback.signature.result.type : undefined,
      "gboolean",
    );
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

function ingestionError(action: () => unknown): GirIngestionError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof GirIngestionError);
    return error;
  }
  assert.fail("Expected GIR ingestion to fail");
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
  /* Widget is projected and therefore releasable, whether or not this
   * selection constructs one: the handle type names the release as its
   * destructor, so the symbol exists for anything that comes to own one. */
  assert.deepEqual(generated.manifest.adapterInputs[0]?.bindings, [
    "gtk_button_new_with_label",
    "gtk_widget_release",
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

test("an enumeration member may begin with a digit at every layer that names it", () => {
  const selected = digitLeadingEnumSnapshot();

  /* Ingestion. The member has to survive selection, because a refused member
   * takes its enumeration with it and every method typed by it off the
   * surface. */
  const license = selected.enumerations.find((enum_) => enum_.name === "License");
  assert.ok(license, "the enumeration survived selection");
  assert.deepEqual(license.members.map((member) => member.name), ["0bsd", "custom"]);

  /* The probe. A member's `name` is the label GIR gave it and its
   * `cIdentifier` is the constant emitted into C; only the second is a C
   * identifier, and holding the first to that rule is what refused the
   * candidate. The emitted translation unit still names the constant, not the
   * label. */
  const gobjectAdapter = generateGObjectAdapterSource(selected, []);
  const girProbe = generateGirClangAbiProbe(selected, gobjectAdapter, []);
  const licenseCandidate = girProbe.enums.find(
    (enum_) => enum_.id === "Gtk.License.enumeration",
  );
  assert.ok(licenseCandidate, "the enumeration reached the probe");
  assert.deepEqual(
    licenseCandidate.members.map((member) => member.name),
    ["0bsd", "custom"],
  );
  const compiled = generateClangAbiProbe({
    includes: ["gtk/gtk.h"],
    functions: [],
    records: [],
    enums: [licenseCandidate],
  });
  assert.match(compiled.source, /GTK_LICENSE_0BSD == \(GtkLicense\)\(0\)/u);
  /* The label does appear in the emitted C, but only inside the assertion's
   * diagnostic string, where it names which member disagreed. Outside string
   * literals the translation unit sees the C identifier and nothing else,
   * which is why relaxing the label's rule cannot produce invalid C. */
  const outsideStrings = compiled.source.replace(/"(?:[^"\\]|\\.)*"/gu, '""');
  assert.doesNotMatch(outsideStrings, /0bsd/u);
  assert.match(compiled.source, /mismatch for Gtk\.License\.enumeration\.0bsd/u);

  /* Generation. `0bsd` is not a TypeScript identifier, so the declaration name
   * takes a leading underscore — the smallest rule that makes it legal without
   * renaming any member that was already spellable. */
  const generated = generateGObjectScabiPackage(options(selected));
  assert.match(
    generated.declarations,
    /export declare namespace License \{\n  const _0bsd: License;\n  const Custom: License;\n\}/u,
  );
  assert.deepEqual(generated.manifest.types.gtk_license, {
    kind: "enum",
    underlying: "gtk_license_storage",
    members: { _0bsd: "0", Custom: "1" },
  });

  /* And the member that motivated all of it: a method returning the
   * enumeration, which is the thing that vanished when any layer refused. */
  const getter = generated.manifest.bindings.gtk_button_get_license;
  assert.ok(getter && getter.kind !== "constant");
  assert.equal(getter.signature.result.type, "gtk_license");
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
  assert.deepEqual(binding.dependencies.adapterInputs, ["gtk4.gobject-adapters"]);
  assert.equal(binding.declaration.name, "Widget.getPreferredSize");
  assert.equal(binding.signature.parameters.length, 1);
  assert.equal(binding.signature.result.type, "gtk_widget_preferred_size");
  assert.deepEqual(generated.manifest.adapterInputs[0]?.bindings, [
    "gtk_widget_release",
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
    destructor: "gtk_signal_connection_release",
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
    registrationOwner: "button",
    cancellationBinding: "gtk_signal_connection_disconnect",
    contextParameter: "context",
    allowedInvocationExecutors: [{ kind: "same-as-caller" }],
    synchronousReturn: false,
    arguments: [],
    sourceArguments: [{ kind: "registration-owner" }],
  });
  /* The position owns the connection; which binding releases one is the
   * handle type's to say. */
  assert.deepEqual(connect.signature.result.ownership, {
    kind: "owned",
    transfer: "to-runtime",
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
  /* One release for the chain, hosted where it is emitted. Button names
   * Widget's rather than declaring its own — how a GObject is released does
   * not vary by class, and the compiler admits a destructor typed at any
   * type the handle identity-upcasts to. */
  const release = generated.manifest.bindings.gtk_widget_release;
  assert.ok(release && release.kind !== "constant");
  assert.equal(generated.manifest.bindings.gtk_button_release, undefined);
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
    assert.equal(constructorOwnership.destructor, undefined);
  }
  const buttonType = generated.manifest.types.gtk_button;
  assert.ok(buttonType && buttonType.kind === "handle");
  if (buttonType?.kind === "handle") {
    assert.equal(buttonType.destructor, "gtk_widget_release");
  }
  assert.deepEqual(generated.manifest.adapterInputs[0]?.bindings, [
    "gtk_button_connect_clicked",
    "gtk_button_new_with_label",
    "gtk_signal_connection_connected",
    "gtk_signal_connection_disconnect",
    "gtk_signal_connection_release",
    "gtk_widget_release",
  ]);
  assertDeepFrozen(generated);
});

test("GTK SCABI lowers a property observer to a payload-free connection", () => {
  const selected = snapshot([], false, ["label"]);
  const generated = generateGObjectScabiPackage(options(selected));
  /* The observer's shape is a zero-payload listening signal: GObject reports
   * the change, and the value is read back off the sender. */
  assert.match(
    generated.declarations,
    /onNotifyLabel\(callback: \(button: Button\) => void\): SignalConnection;/u,
  );
  const connect = generated.manifest.bindings.gtk_button_connect_notify_label;
  assert.ok(connect && connect.kind !== "constant");
  assert.equal(
    connect.entry.symbol,
    "nts_gobject_connect_gtk_button_notify_label",
  );
  assert.deepEqual(connect.signature.parameters[1]?.callback, {
    registrationOwner: "button",
    cancellationBinding: "gtk_signal_connection_disconnect",
    contextParameter: "context",
    allowedInvocationExecutors: [{ kind: "same-as-caller" }],
    synchronousReturn: false,
    arguments: [],
    sourceArguments: [{ kind: "registration-owner" }],
  });
  const callback = generated.manifest.types.gtk_button_notify_label_callback;
  assert.ok(callback && callback.kind === "callback");
  /* The `GParamSpec` GObject passes says which property changed, which the
   * registration detail already fixed. The adapter absorbs it, so it never
   * becomes part of the boundary's vocabulary. */
  assert.deepEqual(callback.signature.parameters, []);
  const source = generateGObjectAdapterSource(selected).source;
  assert.match(source, /g_signal_connect\(instance, "notify::label"/u);
  assert.match(source, /GParamSpec \*pspec, void \*opaque/u);
  assert.match(source, /\(void\)pspec;/u);
});

test("GTK SCABI refuses to observe a property it cannot read", () => {
  /* Without the getter the notification is a subscription to nothing: it
   * carries no value, and the only way to learn the new one is gone. */
  const error = generationError(() =>
    generateGObjectScabiPackage(
      options(snapshot([], false, ["label"], ["set_label"])),
    ),
  );
  assert.equal(error.diagnostics.length, 1);
  assert.match(
    error.diagnostics[0]?.message ?? "",
    /observed GObject property must have a selected getter/u,
  );
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
      // The closure slot, at the position the toolkit passes it.
      { kind: "nativeContext", addressSpace: 0 },
    ],
  );
  assert.deepEqual(nativeConnect.arguments[1]?.callback, {
    owner: { kind: "argument", argument: 0 },
    cancellationBinding:
      "native-typescript.gtk4@0.0.0#gtk_signal_connection_disconnect",
    allowedInvocationExecutors: ["same-as-caller"],
    synchronousReturn: false,
    sourceArguments: [
      { kind: "registration-owner" },
      { kind: "callback-parameter", parameter: 0 },
      { kind: "callback-parameter", parameter: 1 },
    ],
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
