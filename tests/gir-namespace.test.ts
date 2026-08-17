import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  defineArtifactGraph,
  executeArtifactGraph,
} from "@native-typescript/core";
import type { ArtifactActionDefinition } from "@native-typescript/core";
import {
  girBindingAnalysisArtifactIds,
  girBindingToolFile,
  girPackageSlug,
  ingestGir,
} from "@native-typescript/bindgen-gir";
import {
  ingestGioApplication,
  planNamespaceAnalysis,
} from "./support/gir-analysis.ts";

const workspace = join(import.meta.dirname, "..");
const systemGioGir = "/usr/share/gir-1.0/Gio-2.0.gir";
const systemGtkGir = "/usr/share/gir-1.0/Gtk-4.0.gir";
const bindingToolPath = join(
  workspace,
  "packages/bindgen-gir/node_modules/.runtime",
  girBindingToolFile,
);
const hasGtk = spawnSync("pkg-config", ["--exists", "gtk4"]).status === 0;
const hasClang = spawnSync("clang", ["--version"]).status === 0;
const hasBubblewrap = spawnSync("bwrap", ["--version"]).status === 0;

function executable(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Required executable is unavailable: ${name}`);
}

async function toolIdentity(
  id: string,
  path: string,
): Promise<ArtifactActionDefinition["tool"]> {
  return {
    id,
    version: "test",
    digest: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
  };
}


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

const gioLifecycleMethods = [
  "activate",
  "get_application_id",
  "get_is_remote",
  "hold",
  "quit",
  // Reports failure through a GError, so it reaches the boundary through the
  // adapter that absorbed its out-parameter.
  "register",
  "release",
  "set_application_id",
] as const;

interface AnalysisSubgraph {
  readonly graph: ReturnType<typeof defineArtifactGraph>;
  readonly sourcePaths: Readonly<Record<string, string>>;
  readonly generationActionId: string;
}

/**
 * Plans gio2 and gtk4 as two analysis subgraphs of one artifact graph, with
 * gtk4 importing gio2. `gioMethods` varies gio2's selection so a caller can
 * observe what changing an imported namespace does to the dependent package.
 */
async function planTwoNamespaceAnalysis(options: {
  readonly scratch: string;
  readonly suffix: string;
  readonly gioMethods: readonly string[];
  readonly clangTool: ArtifactActionDefinition["tool"];
  readonly nodeTool: ArtifactActionDefinition["tool"];
}): Promise<AnalysisSubgraph> {
  const gio = ingestGioApplication(options.gioMethods);
  const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
    logicalPath: "system-sdk/gir/Gtk-4.0.gir",
    namespace: { name: "Gtk", version: "4.0" },
    classes: [{ name: "Application", constructors: ["new"] }],
  });
  const analysis = await planNamespaceAnalysis({
    scratch: options.scratch,
    suffix: options.suffix,
    selections: [
      { snapshot: gio, imports: [], sdkModules: ["gio-2.0"] },
      { snapshot: gtk, imports: [gio], sdkModules: ["gtk4"] },
    ],
    clangTool: options.clangTool,
    nodeTool: options.nodeTool,
  });
  const gtk4 = analysis.packages.find(({ slug }) => slug === "gtk4");
  assert.ok(gtk4);
  return {
    graph: analysis.graph,
    sourcePaths: analysis.sourcePaths,
    generationActionId: gtk4?.generationActionId ?? "",
  };
}

test(
  "two namespaces' analysis subgraphs execute in one artifact graph",
  {
    skip:
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      !existsSync(systemGtkGir) ||
      !existsSync(systemGioGir) ||
      !hasGtk ||
      !hasClang ||
      !hasBubblewrap ||
      !existsSync(bindingToolPath),
  },
  async () => {
    // Both packages come out of one graph. Artifact and action identities
    // derive from the package slug, so a collision between two namespaces
    // would surface here, and gtk4's generation consumes gio2's snapshot as a
    // declared input rather than reading it from anywhere ambient.
    const scratch = mkdtempSync(join(tmpdir(), "nts-two-namespace-"));
    try {
      const clangPath = executable("clang");
      const nodePath = process.execPath;
      const clangTool = await toolIdentity("tool/clang", clangPath);
      const nodeTool = await toolIdentity("tool/node", nodePath);
      const cache = { kind: "local" as const, path: join(scratch, "cache") };
      const tools = {
        [clangTool.id]: { path: clangPath },
        [nodeTool.id]: { path: nodePath },
      };
      const sandbox = { kind: "bubblewrap" as const, path: executable("bwrap") };

      const first = await planTwoNamespaceAnalysis({
        scratch,
        suffix: "a",
        gioMethods: gioLifecycleMethods,
        clangTool,
        nodeTool,
      });
      const report = await executeArtifactGraph(first.graph, {
        buildRoot: join(scratch, "build-a"),
        sourcePaths: first.sourcePaths,
        tools,
        sandbox,
        cache,
      });

      // gio2 spells its string parameters `const gchar*` where gtk4 writes
      // `const char*`; both are borrowed UTF-8 and both must project.
      const gioPackage = report.artifacts.find(
        ({ id }) => id === "package/gio2/bindings",
      );
      assert.ok(gioPackage);
      if (!gioPackage) return;
      const gioDeclarations = readFileSync(
        join(gioPackage.path, "package.d.ts"),
        "utf8",
      );
      assert.match(
        gioDeclarations,
        /constructor\(applicationId: string \| null, flags: ApplicationFlags\);/u,
      );
      for (const member of [
        "activate(): void;",
        "quit(): void;",
        "hold(): void;",
        "release(): void;",
        "getIsRemote(): boolean;",
        // Native IR supports an optional handle input, but a derived handle
        // does not upcast through a nullable union, so generation projects
        // the non-null subset for now.
        "register(cancellable: Cancellable | null): void;",
        "onActivate(callback: (application: Application) => void): SignalConnection;",
      ]) {
        assert.equal(
          gioDeclarations.includes(member),
          true,
          `gio2 declarations are missing ${member}`,
        );
      }
      // gio2 owns ApplicationFlags and its member constants.
      assert.match(
        gioDeclarations,
        /export declare namespace ApplicationFlags \{[^}]*const DefaultFlags: ApplicationFlags;/su,
      );

      const gtkPackage = report.artifacts.find(
        ({ id }) => id === "package/gtk4/bindings",
      );
      assert.ok(gtkPackage);
      if (!gtkPackage) return;
      const manifest = JSON.parse(
        readFileSync(join(gtkPackage.path, "package.scabi.json"), "utf8"),
      ) as {
        readonly imports?: Record<string, { readonly package: { name: string } }>;
        readonly types: Record<string, { readonly kind: string }>;
      };
      assert.equal(
        manifest.imports?.gio_application?.package.name,
        "@native-typescript/gio2",
      );
      assert.equal(manifest.types.gio_application, undefined);
      assert.equal(manifest.types.gio_application_flags?.kind, "flags");

      const declarations = readFileSync(
        join(gtkPackage.path, "package.d.ts"),
        "utf8",
      );
      assert.match(
        declarations,
        /import type \{ Application as GioApplication \} from "@native-typescript\/gio2";/u,
      );
      assert.match(
        declarations,
        /constructor\(applicationId: string \| null, flags: GioApplicationFlags\);/u,
      );

      // Re-planned identically, gtk4's generation is a verified cache hit.
      const repeat = await planTwoNamespaceAnalysis({
        scratch,
        suffix: "b",
        gioMethods: gioLifecycleMethods,
        clangTool,
        nodeTool,
      });
      const cachedReport = await executeArtifactGraph(repeat.graph, {
        buildRoot: join(scratch, "build-b"),
        sourcePaths: repeat.sourcePaths,
        tools,
        sandbox,
        cache,
      });
      assert.equal(
        cachedReport.actions.find(({ id }) => id === repeat.generationActionId)
          ?.status,
        "cached",
      );

      // Changing only the imported namespace must invalidate the dependent
      // package. Dropping a gio2 method leaves gtk4's own snapshot, request,
      // and probe byte-identical — gtk4 reaches only ApplicationFlags — so the
      // invalidation can only come from the imported snapshot being a declared
      // input of gtk4's generation.
      const changed = await planTwoNamespaceAnalysis({
        scratch,
        suffix: "c",
        gioMethods: gioLifecycleMethods.filter((name) => name !== "hold"),
        clangTool,
        nodeTool,
      });
      const changedReport = await executeArtifactGraph(changed.graph, {
        buildRoot: join(scratch, "build-c"),
        sourcePaths: changed.sourcePaths,
        tools,
        sandbox,
        cache,
      });
      assert.equal(
        changedReport.actions.find(({ id }) => id === changed.generationActionId)
          ?.status,
        "executed",
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
