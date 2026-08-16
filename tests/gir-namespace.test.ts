import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  defineArtifactGraph,
  executeArtifactGraph,
  resolvePkgConfigSdk,
  resolveSourceArtifact,
} from "@native-typescript/core";
import type {
  ArtifactActionDefinition,
  ArtifactDefinition,
} from "@native-typescript/core";
import { canonicalizeJson } from "@native-typescript/scabi";
import {
  defineGirBindingPackageRequest,
  girBindingToolFile,
  girPackageSlug,
  girBindingAnalysisArtifactIds,
  ingestGir,
  planGirBindingAnalysis,
} from "@native-typescript/bindgen-gir";

const workspace = join(import.meta.dirname, "..");
const systemGioGir = "/usr/share/gir-1.0/Gio-2.0.gir";
const systemGtkGir = "/usr/share/gir-1.0/Gtk-4.0.gir";
const nativeTarget = "x86_64-unknown-linux-gnu";
const executionPlatform = "x86_64-linux";
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

async function metadataArtifact(
  id: string,
  path: string,
  mediaType: string,
  sourcePaths: Record<string, string>,
): Promise<ArtifactDefinition> {
  const resolved = await resolveSourceArtifact({
    id,
    path,
    kind: mediaType === "text/javascript" ? "source" : "metadata",
    entryType: "file",
    mediaType,
    target: executionPlatform,
    domain: "host",
    cache: "exportable",
    fileName: id.split("/").at(-1)!,
    logicalPath: `generated/${id}`,
  });
  sourcePaths[id] = path;
  return resolved.artifact;
}

function packageIdentity(slug: string): {
  readonly name: string;
  readonly version: string;
  readonly namespace: string;
  readonly instance: string;
} {
  return {
    name: `@native-typescript/${slug}`,
    version: "0.0.0",
    namespace: `native-typescript.${slug}`,
    instance: `native-typescript.${slug}@0.0.0`,
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
    // Both packages are produced by one graph. Artifact and action identities
    // derive from the package slug, so this is where a collision between two
    // namespaces would surface, and gtk4's generation consumes gio2's snapshot
    // as a declared input rather than reading it from anywhere ambient.
    const gio = ingestGir(readFileSync(systemGioGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gio-2.0.gir",
      namespace: { name: "Gio", version: "2.0" },
      // The whole non-throwing lifecycle surface. Only register() is missing,
      // and only because it is throws=1.
      classes: [
        {
          name: "Application",
          constructors: ["new"],
          methods: [
            "activate",
            "get_application_id",
            "get_is_remote",
            "hold",
            "quit",
            "release",
            "set_application_id",
          ],
          signals: ["activate"],
        },
      ],
      enumerations: [
        { name: "ApplicationFlags", members: ["default_flags", "is_service"] },
      ],
    });
    const gtk = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [{ name: "Application", constructors: ["new"] }],
    });

    const scratch = mkdtempSync(join(tmpdir(), "nts-two-namespace-"));
    try {
      const clangPath = executable("clang");
      const nodePath = process.execPath;
      const clangTool = await toolIdentity("tool/clang", clangPath);
      const nodeTool = await toolIdentity("tool/node", nodePath);
      const sdk = await resolvePkgConfigSdk({
        id: "gtk4",
        executable: executable("pkg-config"),
        modules: ["gtk4"],
        target: nativeTarget,
      });

      const sourcePaths: Record<string, string> = { ...sdk.sourcePaths };
      const artifacts = [...sdk.artifacts];
      const actions = [];

      const toolArtifact = await metadataArtifact(
        "tool-input/bindgen-gir/generator",
        bindingToolPath,
        "text/javascript",
        sourcePaths,
      );
      artifacts.push(toolArtifact);

      const plans = [];
      for (const [snapshot, imported, sdkModules] of [
        [gio, [], ["gio-2.0"]],
        [gtk, [gio], ["gtk4"]],
      ] as const) {
        const slug = girPackageSlug(snapshot.namespace);
        const request = defineGirBindingPackageRequest({
          namespace: { ...snapshot.namespace },
          importedNamespaces: imported.map((entry) => ({
            namespace: {
              name: entry.namespace.name,
              version: entry.namespace.version,
            },
            package: packageIdentity(girPackageSlug(entry.namespace)),
          })),
          clang: {
            toolId: clangTool.id,
            version: clangTool.version,
            digest: clangTool.digest,
            target: nativeTarget,
          },
          generation: {
            package: packageIdentity(slug),
            target: {
              triple: nativeTarget,
              architecture: "x86_64",
              pointerWidth: 64,
              endianness: "little",
              objectFormat: "elf",
              minimumPlatformVersion: "glibc-2.17",
              abi: "sysv-amd64",
              features: ["gtk4"],
            },
            sdk: {
              vendor: "GNOME",
              name: "GTK",
              version: "4.0",
              deploymentTarget: nativeTarget,
              modules: [...sdkModules],
            },
            linkInputs: sdk.systemLibraries.map((name, order) => ({
              id: name,
              kind: "system-library" as const,
              name,
              order,
            })),
            adapterInput: {
              id: `${slug}.gobject-adapters`,
              output: "gobject-adapters.o",
            },
          },
        });

        const snapshotPath = join(scratch, `${slug}-snapshot.json`);
        writeFileSync(snapshotPath, canonicalizeJson(snapshot));
        const requestPath = join(scratch, `${slug}-request.json`);
        writeFileSync(requestPath, canonicalizeJson(request));
        const snapshotArtifact = await metadataArtifact(
          `metadata/${slug}/selected-gir`,
          snapshotPath,
          "application/vnd.native-typescript.gir-snapshot+json",
          sourcePaths,
        );
        const requestArtifact = await metadataArtifact(
          `metadata/${slug}/binding-package-request`,
          requestPath,
          "application/vnd.native-typescript.gtk-binding-package-request+json",
          sourcePaths,
        );
        const plan = planGirBindingAnalysis({
          snapshot,
          request,
          requestArtifact: requestArtifact.id,
          snapshotArtifact: snapshotArtifact.id,
          generatorArtifact: toolArtifact.id,
          importedSnapshots: imported,
          importedSnapshotArtifacts: imported.map(
            (entry) => `metadata/${girPackageSlug(entry.namespace)}/selected-gir`,
          ),
          clangArguments: sdk.compileArguments,
          clangTool,
          nodeTool,
          executionPlatform,
          target: nativeTarget,
        });
        const probePath = join(scratch, `${slug}-probe.c`);
        writeFileSync(probePath, plan.probe.source);
        sourcePaths[plan.clang.source.id] = probePath;
        artifacts.push(snapshotArtifact, requestArtifact, ...plan.artifacts);
        actions.push(...plan.actions);
        plans.push({ slug, plan });
      }

      const graph = defineArtifactGraph({ artifacts, actions });
      const report = await executeArtifactGraph(graph, {
        buildRoot: join(scratch, "build"),
        sourcePaths,
        tools: {
          [clangTool.id]: { path: clangPath },
          [nodeTool.id]: { path: nodePath },
        },
        sandbox: { kind: "bubblewrap", path: executable("bwrap") },
      });

      // Both packages exist, and gtk4 imports the type gio2 owns.
      for (const { slug, plan } of plans) {
        const produced = report.artifacts.find(
          ({ id }) => id === plan.bindings.artifact.id,
        );
        assert.ok(produced, `${slug} package was not produced`);
      }
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
      // gio2 owns ApplicationFlags and its member constants; gtk4 imports the
      // type and re-exports nothing.
      assert.match(
        gioDeclarations,
        /export declare namespace ApplicationFlags \{[^}]*const DefaultFlags: ApplicationFlags;/su,
      );
      for (const member of [
        "activate(): void;",
        "quit(): void;",
        "hold(): void;",
        "release(): void;",
        "getIsRemote(): boolean;",
        "onActivate(callback: (application: Application) => void): SignalConnection;",
      ]) {
        assert.equal(
          gioDeclarations.includes(member),
          true,
          `gio2 declarations are missing ${member}`,
        );
      }

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
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
