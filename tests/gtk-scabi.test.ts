import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  CBindgenError,
  renderCFunctionPointerType,
} from "@native-typescript/bindgen-c";
import type {
  ClangFunctionEvidenceSnapshot,
  ClangFunctionProbe,
} from "@native-typescript/bindgen-c";
import {
  canonicalizeJson,
  digestScabiManifest,
} from "@native-typescript/scabi";
import {
  generateGirClangFunctionProbe,
  generateGObjectAdapterSource,
  generateGtkScabiPackage,
  ingestGir,
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

function snapshot(signals: readonly string[] = []): GirSnapshot {
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
  });
}

function evidence(probe: ClangFunctionProbe): ClangFunctionEvidenceSnapshot {
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
  const semanticValue = {
    schema: "native-typescript.clang-function-evidence",
    schemaVersion: 1,
    probeDigest: probe.sourceDigest,
    clang,
    functions,
  };
  return Object.freeze({
    schema: "native-typescript.clang-function-evidence",
    schemaVersion: 1,
    probeDigest: probe.sourceDigest,
    semanticDigest: sha256(JSON.stringify(semanticValue)),
    clang,
    functions,
  });
}

function options(selected = snapshot()): GtkScabiGenerationOptions {
  return {
    snapshot: selected,
    evidence: evidence(generateGirClangFunctionProbe(selected)),
    gobjectAdapter: generateGObjectAdapterSource(selected),
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
      id: "gtk4.gobject-constructors",
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
    gtk_button: { module: ".", name: "Button" },
  });
  assert.deepEqual(generated.manifest.adapterInputs[0]?.bindings, [
    "gtk_button_new_with_label",
    "gtk_button_release",
  ]);
  assert.match(generated.declarations, /export interface Button/u);
  assert.match(generated.declarations, /getLabel\(\): string \| null;/u);
  assert.match(generated.declarations, /setLabel\(label: string\): void;/u);
  assert.match(
    generated.declarations,
    /createButtonWithLabel\(label: string\): Button;/u,
  );
  assertDeepFrozen(generated);
  assert.deepEqual(generateGtkScabiPackage(options()), generated);
});

test("GTK SCABI generation rejects unverified evidence and reached signals", () => {
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

  const signalError = generationError(() =>
    generateGtkScabiPackage(options(snapshot(["clicked"])))
  );
  assert.equal(
    signalError.diagnostics.some(({ path }) => path === "Gtk/Button/signals"),
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
