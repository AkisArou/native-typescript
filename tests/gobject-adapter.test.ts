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
  defineArtifactGraph,
  executeArtifactGraph,
  resolvePkgConfigCompileSdk,
} from "@native-typescript/core";
import type { ArtifactActionDefinition } from "@native-typescript/core";
import {
  generateGObjectAdapterSource,
  ingestGir,
  planGObjectAdapterObject,
} from "@native-typescript/target-gtk";

const repositoryRoot = resolve(import.meta.dirname, "..");
const girPath = resolve(repositoryRoot, "fixtures/gir/Gtk-4.0.selected.gir");
const girSource = readFileSync(girPath, "utf8");
const nativeFixturePath = resolve(
  repositoryRoot,
  "fixtures/gobject-adapter/fixture.c",
);
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
        '<return-value transfer-ownership="none">',
        '<return-value transfer-ownership="full">',
      );
  const snapshot = ingestGir(source, {
    logicalPath: "fixtures/gir/Gtk-4.0.selected.gir",
    namespace: { name: "Gtk", version: "4.0" },
    classes: [{ name: "Button", constructors: ["new_with_label"] }],
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

test("GObject constructors normalize borrowed floating results to one strong reference", () => {
  const generated = adapter();
  assert.equal(generated.schema, "native-typescript.gobject-adapter-source");
  assert.equal(generated.schemaVersion, 1);
  assert.match(generated.sourceDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(generated.constructors, [
    {
      id: "Button.constructor.new_with_label",
      className: "Button",
      nativeType: "GtkButton",
      sourceSymbol: "gtk_button_new_with_label",
      adapterSymbol: "nts_gobject_adopt_gtk_button_new_with_label",
      releaseSymbol: "nts_gobject_release_button",
      sourceTransfer: "none",
      acquisition: "ref-sink",
      nullable: false,
    },
  ]);
  assert.match(
    generated.source,
    /GtkButton \*nts_gobject_adopt_gtk_button_new_with_label\(const char \* parameter_0000\)/u,
  );
  assert.match(generated.source, /g_object_ref_sink\(value\);/u);
  assert.equal(generated.source.includes("g_object_is_floating"), false);
  assert.match(
    generated.source,
    /void nts_gobject_release_button\(GtkButton \*value\)/u,
  );
  assertDeepFrozen(generated);
  assert.deepEqual(adapter(), generated);
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
      const sdk = await resolvePkgConfigCompileSdk({
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
        arguments: sdk.arguments,
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
