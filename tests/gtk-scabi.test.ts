import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
import { translateScabiNativeProgram } from "@native-typescript/scriptc";
import {
  generateGirClangAbiProbe,
  generateGObjectAdapterSource,
  generateGtkScabiPackage,
  defineGtkBindingPackageRequest,
  ingestGir,
  planGtkBindingPackage,
  planGtkBindingAnalysis,
  planGtkClangEvidenceNormalization,
} from "@native-typescript/target-gtk";
import type {
  GirSnapshot,
  GtkScabiGenerationOptions,
  GtkScabiPackage,
} from "@native-typescript/target-gtk";

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
    classes: [{
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

function options(selected = snapshot()): GtkScabiGenerationOptions {
  const gobjectAdapter = generateGObjectAdapterSource(selected);
  return {
    snapshot: selected,
    evidence: evidence(generateGirClangAbiProbe(selected, gobjectAdapter)),
    gobjectAdapter,
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
  const generated = generateGtkScabiPackage(options());
  assert.equal(generated.schema, "native-typescript.gtk-scabi-package");
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
      { name: "width", type: "gint", offset: 0 },
      { name: "height", type: "gint", offset: 4 },
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
  assert.match(generated.declarations, /get label\(\): string \| null;/u);
  assert.match(generated.declarations, /set label\(value: string\);/u);
  assert.doesNotMatch(generated.declarations, /getLabel|setLabel/u);
  const labelGetter = generated.manifest.bindings.gtk_button_get_label;
  assert.ok(labelGetter && labelGetter.kind !== "constant");
  assert.equal(labelGetter.kind, "getter");
  assert.equal(labelGetter.declaration.name, "Button.label");
  const labelSetter = generated.manifest.bindings.gtk_button_set_label;
  assert.ok(labelSetter && labelSetter.kind !== "constant");
  assert.equal(labelSetter.kind, "setter");
  assert.equal(labelSetter.declaration.name, "Button.label");
  assert.match(
    generated.declarations,
    /static withLabel\(label: string\): Button;/u,
  );
  const constructor = generated.manifest.bindings.gtk_button_new_with_label;
  assert.ok(constructor && constructor.kind !== "constant");
  assert.equal(constructor.kind, "factory");
  assert.deepEqual(constructor.declaration, { module: ".", name: "Button.withLabel" });
  assertDeepFrozen(generated);
  assert.deepEqual(generateGtkScabiPackage(options()), generated);
});

test("Clang-proven GTK enums become idiomatic exact constants", () => {
  const generated = generateGtkScabiPackage(options(snapshot([], true)));

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
  const generated = generateGtkScabiPackage(options(flagsPropertySnapshot()));

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
  const generated = generateGtkScabiPackage(options(valueMethodSnapshot()));
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
  const request = defineGtkBindingPackageRequest({
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
  const evidencePlan = planGtkClangEvidenceNormalization({
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
  const plan = planGtkBindingPackage({
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
    () => planGtkBindingPackage({
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
  const request = defineGtkBindingPackageRequest({
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
  const plan = planGtkBindingAnalysis({
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
    () => planGtkBindingAnalysis({
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
  const evidenceError = generationError(() => generateGtkScabiPackage(invalidEvidence));
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
  const recordError = generationError(() => generateGtkScabiPackage(invalidRecord));
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
  const adapterError = generationError(() => generateGtkScabiPackage(invalidAdapter));
  assert.equal(
    adapterError.diagnostics.some(({ path }) => path === "gobjectAdapter"),
    true,
  );
});

test("GTK SCABI lowers a zero-payload signal to a receiver-owned connection", () => {
  const generated = generateGtkScabiPackage(options(snapshot(["clicked"])));
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
  assert.equal(connect.entry.symbol, "nts_gobject_connect_button_clicked");
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
  const generated = generateGtkScabiPackage(options(scalarSignalSnapshot()));
  assert.match(
    generated.declarations,
    /onResized\(callback: \(button: Button, width: gint, scale: gdouble\) => void\): SignalConnection;/u,
  );
  assert.deepEqual(generated.manifest.declarations.types, {
    gdouble: { module: ".", name: "gdouble" },
    gint: { module: ".", name: "gint" },
    gtk_button: { module: ".", name: "Button" },
    gtk_signal_connection: { module: ".", name: "SignalConnection" },
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
          },
          {
            name: "scale",
            type: "gdouble",
            passMode: "value",
            nullable: false,
            ownership: { kind: "value" },
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
  assert.deepEqual(nativeConnect.arguments[1]?.type, {
    kind: "func",
    params: [
      {
        kind: "nativeHandle",
        typeId: "native-typescript.gtk4@0.0.0#type:gtk_button",
      },
      { kind: "nativeScalar", scalar: "i32" },
      { kind: "nativeScalar", scalar: "f64" },
    ],
    ret: { kind: "void" },
  });
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
  } satisfies Partial<GtkScabiGenerationOptions>);
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
  } satisfies Partial<GtkScabiGenerationOptions>);

  assert.deepEqual(
    generateGtkScabiPackage(left),
    generateGtkScabiPackage(right),
  );
});

test("GTK SCABI generation result is structurally typed", () => {
  const generated: GtkScabiPackage = generateGtkScabiPackage(options());
  assert.match(generated.manifestDigest, /^sha256:[0-9a-f]{64}$/u);
});
