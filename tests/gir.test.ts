import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  GirIngestionError,
  ingestGir,
} from "@native-typescript/target-gtk";
import type {
  GirClassSelection,
  GirEnumerationSelection,
  GirRecordSelection,
  GirSnapshot,
} from "@native-typescript/target-gtk";

const repositoryRoot = resolve(import.meta.dirname, "..");
const fixturePath = resolve(
  repositoryRoot,
  "fixtures/gir/Gtk-4.0.selected.gir",
);
const fixtureSource = readFileSync(fixturePath, "utf8");
const fixtureDigest =
  "sha256:a490baa17455205ad75acab50456f549c5c60cfe1172daf32ed4e85654bd3d05";
// Button extends Widget inside Gtk, so the selection must carry the parent.
// Selecting no members still projects the ancestry without its surface.
const widgetSelection: GirClassSelection = Object.freeze({ name: "Widget" });
const buttonSelection: GirClassSelection = Object.freeze({
  name: "Button",
  constructors: Object.freeze(["new_with_label"]),
  methods: Object.freeze(["set_label", "get_label"]),
  signals: Object.freeze(["clicked"]),
});
const requisitionSelection: GirRecordSelection = Object.freeze({
  name: "Requisition",
  fields: Object.freeze(["width", "height"]),
});
const orientationSelection: GirEnumerationSelection = Object.freeze({
  name: "Orientation",
  members: Object.freeze(["horizontal", "vertical"]),
});

function ingestFixture(
  classes: readonly GirClassSelection[] = [widgetSelection, buttonSelection],
  records: readonly GirRecordSelection[] = [requisitionSelection],
  enumerations: readonly GirEnumerationSelection[] = [],
): GirSnapshot {
  return ingestGir(fixtureSource, {
    logicalPath: "fixtures/gir/Gtk-4.0.selected.gir",
    expectedDigest: fixtureDigest,
    namespace: { name: "Gtk", version: "4.0" },
    classes,
    records,
    enumerations,
  });
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value as Readonly<Record<string, unknown>>)) {
    assertDeepFrozen(child, seen);
  }
}

function ingestionDiagnostics(action: () => unknown): GirIngestionError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof GirIngestionError);
    return error;
  }
  assert.fail("Expected GIR ingestion to fail");
}

test("selected GIR metadata becomes a canonical immutable snapshot", () => {
  const snapshot = ingestFixture();

  assert.equal(snapshot.schema, "native-typescript.gir-snapshot");
  assert.equal(snapshot.schemaVersion, 3);
  assert.deepEqual(snapshot.source, {
    logicalPath: "fixtures/gir/Gtk-4.0.selected.gir",
    digest: fixtureDigest,
  });
  assert.deepEqual(snapshot.includes, [
    { name: "Gdk", version: "4.0" },
    { name: "Gsk", version: "4.0" },
  ]);
  assert.deepEqual(snapshot.packages, ["gtk4"]);
  assert.deepEqual(snapshot.cIncludes, ["gtk/gtk.h"]);
  assert.deepEqual(snapshot.enumerations, []);
  assert.deepEqual(snapshot.namespace, {
    name: "Gtk",
    version: "4.0",
    sharedLibraries: ["libgtk-4.so.1"],
    identifierPrefixes: ["Gtk"],
    symbolPrefixes: ["gtk"],
  });

  assert.deepEqual(snapshot.records, [{
    kind: "record",
    name: "Requisition",
    cType: "GtkRequisition",
    disguised: false,
    foreign: false,
    opaque: false,
    pointer: false,
    version: null,
    deprecated: false,
    deprecatedVersion: null,
    stability: null,
    glibTypeName: "GtkRequisition",
    glibGetType: "gtk_requisition_get_type",
    cSymbolPrefix: "requisition",
    annotations: [],
    fields: [
      {
        name: "width",
        readable: true,
        writable: true,
        bits: null,
        annotations: [],
        type: { kind: "named", name: "gint", cType: "int", arguments: [] },
      },
      {
        name: "height",
        readable: true,
        writable: true,
        bits: null,
        annotations: [],
        type: { kind: "named", name: "gint", cType: "int", arguments: [] },
      },
    ],
  }]);

  const button = snapshot.classes[0];
  assert.ok(button);
  assert.equal(button.name, "Button");
  assert.equal(button.cType, "GtkButton");
  assert.deepEqual(button.parent, { kind: "internal", name: "Widget" });
  assert.equal(button.glibGetType, "gtk_button_get_type");
  assert.deepEqual(button.interfaces, [
    { kind: "internal", name: "Accessible" },
    { kind: "internal", name: "Actionable" },
    { kind: "internal", name: "Buildable" },
    { kind: "internal", name: "ConstraintTarget" },
  ]);
  assert.deepEqual(button.constructors.map(({ name }) => name), ["new_with_label"]);
  assert.deepEqual(button.methods.map(({ name }) => name), ["get_label", "set_label"]);
  assert.deepEqual(button.signals.map(({ name }) => name), ["clicked"]);
  assertDeepFrozen(snapshot);
});

test("selected GIR enumerations preserve exact members and native identities", () => {
  const snapshot = ingestFixture([], [], [orientationSelection]);

  assert.deepEqual(snapshot.classes, []);
  assert.deepEqual(snapshot.records, []);
  assert.deepEqual(snapshot.enumerations, [{
    kind: "enumeration",
    name: "Orientation",
    cType: "GtkOrientation",
    glibTypeName: "GtkOrientation",
    glibGetType: "gtk_orientation_get_type",
    version: null,
    deprecated: false,
    deprecatedVersion: null,
    stability: null,
    annotations: [],
    members: [
      {
        name: "horizontal",
        value: "0",
        cIdentifier: "GTK_ORIENTATION_HORIZONTAL",
        glibNick: "horizontal",
        glibName: "GTK_ORIENTATION_HORIZONTAL",
        version: null,
        deprecated: false,
        deprecatedVersion: null,
        stability: null,
        annotations: [],
      },
      {
        name: "vertical",
        value: "1",
        cIdentifier: "GTK_ORIENTATION_VERTICAL",
        glibNick: "vertical",
        glibName: "GTK_ORIENTATION_VERTICAL",
        version: null,
        deprecated: false,
        deprecatedVersion: null,
        stability: null,
        annotations: [],
      },
    ],
  }]);
  assertDeepFrozen(snapshot);
});

test("GIR callables preserve C, ownership, nullability, receiver, and signal semantics", () => {
  const button = ingestFixture().classes[0];
  assert.ok(button);

  const constructor = button.constructors[0];
  assert.ok(constructor);
  assert.equal(constructor.cIdentifier, "gtk_button_new_with_label");
  assert.deepEqual(constructor.result, {
    transferOwnership: "none",
    nullable: false,
    skip: false,
    scope: null,
    closureParameter: null,
    destroyParameter: null,
    annotations: [],
    type: {
      kind: "named",
      name: "Widget",
      cType: "GtkWidget*",
      arguments: [],
    },
  });
  assert.equal(constructor.parameters[0]?.name, "label");
  assert.equal(constructor.parameters[0]?.transferOwnership, "none");

  const getLabel = button.methods.find(({ name }) => name === "get_label");
  assert.ok(getLabel);
  assert.equal(getLabel.result.nullable, true);
  assert.equal(getLabel.result.transferOwnership, "none");
  assert.equal(getLabel.result.type.kind, "named");
  assert.equal(getLabel.result.type.cType, "const char*");
  assert.equal(getLabel.parameters[0]?.kind, "instance");
  assert.equal(getLabel.parameters[0]?.type.kind, "named");
  assert.equal(getLabel.parameters[0]?.type.cType, "GtkButton*");
  assert.equal(getLabel.glibGetProperty, "label");
  assert.equal(
    button.methods.find(({ name }) => name === "set_label")?.glibSetProperty,
    "label",
  );

  const clicked = button.signals[0];
  assert.ok(clicked);
  assert.equal(clicked.cIdentifier, null);
  assert.equal(clicked.signalWhen, "first");
  assert.equal(clicked.signalAction, true);
  assert.equal(clicked.signalDetailed, false);
  assert.equal(clicked.signalNoHooks, false);
  assert.equal(clicked.signalNoRecurse, false);
  assert.equal(clicked.signalEmitter, null);
  assert.equal(clicked.result.type.kind, "named");
  assert.equal(clicked.result.type.cType, "void");
});

test("GIR preserves lifecycle, availability, relationships, and annotations", () => {
  const source = fixtureSource
    .replace(
      'glib:get-type="gtk_button_get_type"',
      'glib:get-type="gtk_button_get_type" glib:ref-func="g_object_ref" glib:unref-func="g_object_unref"',
    )
    .replace(
      '<method name="get_label" c:identifier="gtk_button_get_label" glib:get-property="label">',
      `<method name="get_label"
              c:identifier="gtk_button_get_label"
              deprecated="1"
              deprecated-version="4.2"
              stability="Unstable"
              shadowed-by="get_label_v2"
              moved-to="Button.get_label_v2"
              glib:get-property="label">
        <attribute name="zeta" value="last"/>
        <attribute name="alpha" value="first"/>`,
    )
    .replace(
      '<return-value transfer-ownership="none" nullable="1">',
      `<return-value transfer-ownership="none" nullable="1" skip="1">
          <attribute name="return-note" value="borrowed"/>`,
    )
    .replace(
      '<instance-parameter name="button" transfer-ownership="none">',
      `<instance-parameter name="button" transfer-ownership="none">
            <attribute name="receiver-note" value="owner-context"/>`,
    )
    .replace(
      '<glib:signal name="clicked" when="first" action="1">',
      '<glib:signal name="clicked" when="first" action="1" detailed="1" no-hooks="1" no-recurse="1" emitter="emit_clicked">',
    );

  const snapshot = ingestGir(source, {
    logicalPath: "fixtures/gir/annotated.gir",
    namespace: { name: "Gtk", version: "4.0" },
    classes: [widgetSelection, { name: "Button", methods: ["get_label"], signals: ["clicked"] }],
  });
  const button = snapshot.classes[0];
  assert.ok(button);
  assert.equal(button.glibRefFunction, "g_object_ref");
  assert.equal(button.glibUnrefFunction, "g_object_unref");

  const method = button.methods[0];
  assert.ok(method);
  assert.equal(method.deprecated, true);
  assert.equal(method.deprecatedVersion, "4.2");
  assert.equal(method.stability, "Unstable");
  assert.equal(method.shadowedBy, "get_label_v2");
  assert.equal(method.movedTo, "Button.get_label_v2");
  assert.equal(method.glibGetProperty, "label");
  assert.deepEqual(method.annotations, [
    { name: "alpha", value: "first" },
    { name: "zeta", value: "last" },
  ]);
  assert.equal(method.result.skip, true);
  assert.deepEqual(method.result.annotations, [
    { name: "return-note", value: "borrowed" },
  ]);
  assert.deepEqual(method.parameters[0]?.annotations, [
    { name: "receiver-note", value: "owner-context" },
  ]);

  const signal = button.signals[0];
  assert.ok(signal);
  assert.equal(signal.signalDetailed, true);
  assert.equal(signal.signalNoHooks, true);
  assert.equal(signal.signalNoRecurse, true);
  assert.equal(signal.signalEmitter, "emit_clicked");
});

test("GIR snapshots do not depend on selection order or unselected declarations", () => {
  const canonical = ingestFixture(
    [widgetSelection, buttonSelection],
    [requisitionSelection],
    [orientationSelection],
  );
  const reordered = ingestFixture([
    {
      name: "Button",
      constructors: ["new_with_label"],
      methods: ["get_label", "set_label"],
      signals: ["clicked"],
    },
    widgetSelection,
  ], [requisitionSelection], [{
    name: "Orientation",
    members: ["vertical", "horizontal"],
  }]);

  assert.deepEqual(reordered, canonical);
  assert.equal(
    canonical.classes[0]?.methods.some(({ name }) => name === "unselected_callback"),
    false,
  );
});

test("GIR type references preserve arrays and nested generic arguments", () => {
  const insertionPoint = '      <glib:signal name="clicked" when="first" action="1">';
  const source = fixtureSource.replace(
    insertionPoint,
    `      <method name="complex_types" c:identifier="gtk_button_complex_types">
        <return-value transfer-ownership="full">
          <array c:type="char**" zero-terminated="1">
            <type name="utf8" c:type="char*"/>
          </array>
        </return-value>
        <parameters>
          <instance-parameter name="button" transfer-ownership="none">
            <type name="Button" c:type="GtkButton*"/>
          </instance-parameter>
          <parameter name="widgets" transfer-ownership="none">
            <type name="GLib.List" c:type="GList*">
              <type name="Widget" c:type="GtkWidget*"/>
            </type>
          </parameter>
        </parameters>
      </method>
${insertionPoint}`,
  );
  assert.notEqual(source, fixtureSource);

  const snapshot = ingestGir(source, {
    logicalPath: "fixtures/gir/complex-types.gir",
    namespace: { name: "Gtk", version: "4.0" },
    classes: [widgetSelection, { name: "Button", methods: ["complex_types"] }],
  });
  const method = snapshot.classes[0]?.methods[0];
  assert.ok(method);
  assert.deepEqual(method.result, {
    transferOwnership: "full",
    nullable: false,
    skip: false,
    scope: null,
    closureParameter: null,
    destroyParameter: null,
    annotations: [],
    type: {
      kind: "array",
      cType: "char**",
      lengthParameter: null,
      fixedSize: null,
      zeroTerminated: true,
      element: {
        kind: "named",
        name: "utf8",
        cType: "char*",
        arguments: [],
      },
    },
  });
  assert.deepEqual(method.parameters[1]?.type, {
    kind: "named",
    name: "GLib.List",
    cType: "GList*",
    arguments: [
      {
        kind: "named",
        name: "Widget",
        cType: "GtkWidget*",
        arguments: [],
      },
    ],
  });
});

test("GIR ingestion rejects missing selections and unsupported reachable metadata", () => {
  const missing = ingestionDiagnostics(() =>
    ingestFixture([widgetSelection, { name: "Button", methods: ["does_not_exist"] }])
  );
  assert.deepEqual(missing.diagnostics.map(({ code }) => code), ["NTS4003"]);
  assert.equal(Object.isFrozen(missing.diagnostics), true);
  assert.equal(Object.isFrozen(missing.diagnostics[0]), true);

  const missingField = ingestionDiagnostics(() =>
    ingestFixture(
      [widgetSelection, buttonSelection],
      [{ name: "Requisition", fields: ["depth"] }],
    )
  );
  assert.deepEqual(missingField.diagnostics.map(({ code }) => code), ["NTS4003"]);

  const missingMember = ingestionDiagnostics(() =>
    ingestFixture([], [], [{ name: "Orientation", members: ["diagonal"] }])
  );
  assert.deepEqual(missingMember.diagnostics.map(({ code }) => code), ["NTS4003"]);

  const invalidValue = ingestionDiagnostics(() =>
    ingestGir(fixtureSource.replace('value="1"', 'value="01"'), {
      logicalPath: "fixtures/gir/invalid-enum-value.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [],
      enumerations: [orientationSelection],
    })
  );
  assert.deepEqual(invalidValue.diagnostics.map(({ code }) => code), ["NTS4005"]);

  const unsupported = ingestionDiagnostics(() =>
    ingestFixture([widgetSelection, { name: "Button", methods: ["unselected_callback"] }])
  );
  assert.equal(
    unsupported.diagnostics.every(({ code }) => code === "NTS4004"),
    true,
  );
  assert.match(unsupported.message, /Inline callback types/u);

  const variadicSource = fixtureSource.replace(
    '<callback name="UnsupportedInlineCallback" c:type="void*"/>',
    "<varargs/>",
  );
  const variadic = ingestionDiagnostics(() =>
    ingestGir(variadicSource, {
      logicalPath: "fixtures/gir/variadic.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [widgetSelection, { name: "Button", methods: ["unselected_callback"] }],
    })
  );
  assert.deepEqual(variadic.diagnostics.map(({ code }) => code), ["NTS4004"]);
  assert.match(variadic.message, /Variadic parameters/u);

  const nonIntrospectableSource = fixtureSource.replace(
    '<method name="get_label" c:identifier="gtk_button_get_label" glib:get-property="label">',
    '<method name="get_label" c:identifier="gtk_button_get_label" glib:get-property="label" introspectable="0">',
  );
  const nonIntrospectable = ingestionDiagnostics(() =>
    ingestGir(nonIntrospectableSource, {
      logicalPath: "fixtures/gir/non-introspectable.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [widgetSelection, { name: "Button", methods: ["get_label"] }],
    })
  );
  assert.deepEqual(
    nonIntrospectable.diagnostics.map(({ code }) => code),
    ["NTS4004"],
  );
});

test("GIR class references resolve against the ingested namespace boundary", () => {
  // A same-namespace parent must be selected. Dropping it would silently cost
  // the generated class its `extends` clause and its identity upcast.
  const unselectedParent = ingestionDiagnostics(() =>
    ingestFixture([buttonSelection])
  );
  assert.deepEqual(
    unselectedParent.diagnostics.map(({ code, path }) => ({ code, path })),
    [{ code: "NTS4006", path: "namespace/Gtk/class/Button/@parent" }],
  );
  assert.match(unselectedParent.message, /is not selected/u);

  // Selecting the parent with no members still carries the ancestry.
  const withParent = ingestFixture([widgetSelection, buttonSelection]);
  assert.deepEqual(withParent.classes.map(({ name }) => name), [
    "Button",
    "Widget",
  ]);
  assert.deepEqual(withParent.classes[0]?.parent, {
    kind: "internal",
    name: "Widget",
  });

  // A cross-namespace parent is the deliberate edge of the selected surface,
  // and is preserved as an external reference rather than a bare string. Real
  // GTK roots its hierarchy this way: Gtk.Widget extends GObject.InitiallyUnowned.
  const external = ingestGir(
    fixtureSource.replace(
      '<class name="Widget"',
      '<class name="Widget" parent="GObject.InitiallyUnowned"',
    ),
    {
      logicalPath: "fixtures/gir/external-parent.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [widgetSelection, buttonSelection],
      records: [requisitionSelection],
    },
  );
  assert.deepEqual(external.classes[1]?.parent, {
    kind: "external",
    namespace: "GObject",
    name: "InitiallyUnowned",
  });

  // A reference qualified with the namespace being ingested is the same
  // referent as the bare spelling, so it normalizes to one form.
  const qualified = ingestGir(
    fixtureSource.replace('parent="Widget"', 'parent="Gtk.Widget"'),
    {
      logicalPath: "fixtures/gir/qualified-parent.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [widgetSelection, buttonSelection],
      records: [requisitionSelection],
    },
  );
  assert.deepEqual(qualified.classes[0]?.parent, {
    kind: "internal",
    name: "Widget",
  });
});

test("GIR ingestion rejects provenance, syntax, and ownership ambiguity", () => {
  const provenance = ingestionDiagnostics(() =>
    ingestGir(fixtureSource, {
      logicalPath: "fixtures/gir/Gtk-4.0.selected.gir",
      expectedDigest: `sha256:${"0".repeat(64)}`,
      namespace: { name: "Gtk", version: "4.0" },
      classes: [buttonSelection],
    })
  );
  assert.deepEqual(provenance.diagnostics.map(({ code }) => code), ["NTS4001"]);

  const malformed = ingestionDiagnostics(() =>
    ingestGir(fixtureSource.replace("</repository>", ""), {
      logicalPath: "fixtures/gir/malformed.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [buttonSelection],
    })
  );
  assert.equal(malformed.diagnostics.some(({ code }) => code === "NTS4002"), true);

  const ambiguousOwnership = ingestionDiagnostics(() =>
    ingestGir(
      fixtureSource.replace(
        `<constructor name="new_with_label" c:identifier="gtk_button_new_with_label">
        <return-value transfer-ownership="none">`,
        `<constructor name="new_with_label" c:identifier="gtk_button_new_with_label">
        <return-value>`,
      ),
      {
        logicalPath: "fixtures/gir/missing-ownership.gir",
        namespace: { name: "Gtk", version: "4.0" },
        classes: [buttonSelection],
      },
    )
  );
  assert.equal(
    ambiguousOwnership.diagnostics.some(({ code }) => code === "NTS4005"),
    true,
  );
});

const systemGtkGir = "/usr/share/gir-1.0/Gtk-4.0.gir";

test(
  "installed Gtk-4.0 GIR satisfies selected Button, Requisition, and Orientation contracts",
  { skip: !existsSync(systemGtkGir) },
  () => {
    const snapshot = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [widgetSelection, buttonSelection],
      records: [requisitionSelection],
      enumerations: [orientationSelection],
    });
    const button = snapshot.classes[0];
    assert.ok(button);
    assert.equal(button.cType, "GtkButton");
    assert.equal(button.constructors[0]?.cIdentifier, "gtk_button_new_with_label");
    assert.equal(
      button.methods.find(({ name }) => name === "get_label")?.result.nullable,
      true,
    );
    assert.equal(button.signals[0]?.name, "clicked");
    assert.deepEqual(snapshot.records[0]?.fields.map(({ name }) => name), [
      "width",
      "height",
    ]);
    assert.deepEqual(
      snapshot.enumerations[0]?.members.map(({ name, value, cIdentifier }) => ({
        name,
        value,
        cIdentifier,
      })),
      [
        { name: "horizontal", value: "0", cIdentifier: "GTK_ORIENTATION_HORIZONTAL" },
        { name: "vertical", value: "1", cIdentifier: "GTK_ORIENTATION_VERTICAL" },
      ],
    );
  },
);
