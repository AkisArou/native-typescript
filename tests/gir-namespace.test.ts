import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  girBindingAnalysisArtifactIds,
  girPackageSlug,
  ingestGir,
} from "@native-typescript/bindgen-gir";

const systemGioGir = "/usr/share/gir-1.0/Gio-2.0.gir";

test("GIR package slugs and analysis identities are derived per namespace", () => {
  assert.equal(girPackageSlug({ name: "Gtk", version: "4.0" }), "gtk4");
  assert.equal(girPackageSlug({ name: "Gio", version: "2.0" }), "gio2");
  assert.equal(girPackageSlug({ name: "GObject", version: "2.0" }), "gobject2");

  // Two namespaces analysed in one build must not collide on artifact IDs.
  const gtk = girBindingAnalysisArtifactIds({ name: "Gtk", version: "4.0" });
  const gio = girBindingAnalysisArtifactIds({ name: "Gio", version: "2.0" });
  assert.deepEqual(gtk, {
    probeSource: "source/gtk4/clang-abi-probe",
    rawAst: "metadata/gtk4/clang-abi-ast",
    rawLlvm: "metadata/gtk4/clang-abi-llvm",
    evidence: "metadata/gtk4/normalized-clang-abi-evidence",
    bindings: "package/gtk4/bindings",
  });
  assert.equal(
    new Set([...Object.values(gtk), ...Object.values(gio)]).size,
    Object.values(gtk).length + Object.values(gio).length,
  );

  for (const malformed of [
    { name: "gtk", version: "4.0" },
    { name: "Gtk", version: "" },
    { name: "Gtk-4", version: "4.0" },
  ]) {
    assert.throws(() => girPackageSlug(malformed), /Malformed GIR namespace/u);
  }
});

test(
  "a second GIR namespace ingests through the same namespace-neutral path",
  { skip: !existsSync(systemGioGir) },
  () => {
    // Nothing in GIR ingestion is specific to the GTK toolkit. Gio is the
    // namespace that carries the GApplication lifecycle the GTK application
    // projection is built on.
    const snapshot = ingestGir(readFileSync(systemGioGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gio-2.0.gir",
      namespace: { name: "Gio", version: "2.0" },
      classes: [
        {
          name: "Application",
          constructors: ["new"],
          methods: ["register", "activate", "get_is_remote", "quit"],
          signals: ["activate"],
        },
      ],
    });

    assert.deepEqual(snapshot.namespace.name, "Gio");
    assert.deepEqual(snapshot.namespace.version, "2.0");

    const application = snapshot.classes[0];
    assert.ok(application);
    assert.equal(application.cType, "GApplication");
    assert.equal(application.cSymbolPrefix, "application");

    // GObject.Object is outside the selected namespace, so Gio.Application is
    // a valid root for this package's projected hierarchy.
    assert.deepEqual(application.parent, {
      kind: "external",
      namespace: "GObject",
      name: "Object",
    });
    assert.deepEqual(application.interfaces, [
      { kind: "internal", name: "ActionGroup" },
      { kind: "internal", name: "ActionMap" },
    ]);

    // The exact C entry points the non-blocking lifecycle lowers to.
    assert.deepEqual(
      application.methods.map(({ cIdentifier }) => cIdentifier),
      [
        "g_application_activate",
        "g_application_get_is_remote",
        "g_application_quit",
        "g_application_register",
      ],
    );
    assert.deepEqual(
      application.constructors.map(({ cIdentifier }) => cIdentifier),
      ["g_application_new"],
    );
    assert.deepEqual(application.signals.map(({ name }) => name), ["activate"]);
  },
);
