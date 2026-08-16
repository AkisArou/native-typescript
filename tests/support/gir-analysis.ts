import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defineArtifactGraph,
  resolvePkgConfigSdk,
  resolveSourceArtifact,
} from "@native-typescript/core";
import type {
  ArtifactActionDefinition,
  ArtifactDefinition,
  ResolvedPkgConfigSdk,
} from "@native-typescript/core";
import { canonicalizeJson } from "@native-typescript/scabi";
import {
  executable,
  executionPlatform,
  nativeTarget,
} from "./artifacts.ts";
import {
  defineGirBindingPackageRequest,
  girBindingToolFile,
  girPackageSlug,
  ingestGir,
  planGirBindingAnalysis,
} from "@native-typescript/bindgen-gir";

/**
 * Shared GIR analysis planning for the gates that need generated packages.
 *
 * Generating one namespace and generating several differ only in what each
 * request imports, so both live here rather than in whichever gate happened to
 * need the second namespace first. A gate that drifted from this would be
 * proving something about its own scaffolding instead of about generation.
 */

export const workspace = join(import.meta.dirname, "..", "..");
export const systemGioGir = "/usr/share/gir-1.0/Gio-2.0.gir";
export const systemGtkGir = "/usr/share/gir-1.0/Gtk-4.0.gir";
export const bindingToolPath = join(
  workspace,
  "packages/bindgen-gir/node_modules/.runtime",
  girBindingToolFile,
);

export async function toolIdentity(
  id: string,
  path: string,
): Promise<ArtifactActionDefinition["tool"]> {
  return {
    id,
    version: "test",
    digest: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
  };
}

export async function metadataArtifact(
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

export function packageIdentity(slug: string): {
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

export type GirSnapshot = ReturnType<typeof ingestGir>;

export interface NamespaceSelection {
  readonly snapshot: GirSnapshot;
  /** Namespaces this one references. Their snapshots become declared inputs. */
  readonly imports: readonly GirSnapshot[];
  readonly sdkModules: readonly string[];
}

export interface GeneratedPackage {
  readonly slug: string;
  /** The generated package directory, once the graph has run. */
  readonly bindingsArtifactId: string;
  readonly generationActionId: string;
  readonly adapterInputId: string;
}

export interface NamespaceAnalysis {
  readonly graph: ReturnType<typeof defineArtifactGraph>;
  readonly sourcePaths: Readonly<Record<string, string>>;
  readonly packages: readonly GeneratedPackage[];
  readonly sdk: ResolvedPkgConfigSdk;
}

/**
 * Plans one analysis subgraph per selected namespace inside a single artifact
 * graph. Every identity derives from the package slug, so two namespaces
 * cannot collide silently, and a dependent namespace consumes its imports'
 * snapshots as declared inputs rather than reading them from anywhere ambient.
 *
 * Selections are ordered: a namespace may only import ones planned before it.
 */
export async function planNamespaceAnalysis(options: {
  readonly scratch: string;
  readonly suffix: string;
  readonly selections: readonly NamespaceSelection[];
  readonly clangTool: ArtifactActionDefinition["tool"];
  readonly nodeTool: ArtifactActionDefinition["tool"];
  readonly pkgConfig?: string;
}): Promise<NamespaceAnalysis> {
  const sdk = await resolvePkgConfigSdk({
    id: "gtk4",
    executable: options.pkgConfig ?? executable("pkg-config"),
    modules: ["gtk4"],
    target: nativeTarget,
  });
  const sourcePaths: Record<string, string> = { ...sdk.sourcePaths };
  const artifacts: ArtifactDefinition[] = [...sdk.artifacts];
  const actions: ArtifactActionDefinition[] = [];
  const toolArtifact = await metadataArtifact(
    "tool-input/bindgen-gir/generator",
    bindingToolPath,
    "text/javascript",
    sourcePaths,
  );
  artifacts.push(toolArtifact);

  const packages: GeneratedPackage[] = [];
  for (const { snapshot, imports, sdkModules } of options.selections) {
    const slug = girPackageSlug(snapshot.namespace);
    const adapterInputId = `${slug}.gobject-adapters`;
    const request = defineGirBindingPackageRequest({
      namespace: { ...snapshot.namespace },
      importedNamespaces: imports.map((entry) => ({
        namespace: {
          name: entry.namespace.name,
          version: entry.namespace.version,
        },
        package: packageIdentity(girPackageSlug(entry.namespace)),
      })),
      clang: {
        toolId: options.clangTool.id,
        version: options.clangTool.version,
        digest: options.clangTool.digest,
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
          features: ["gtk4", "glib-main-context"],
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
        adapterInput: { id: adapterInputId, output: "gobject-adapters.o" },
      },
    });

    const snapshotPath = join(
      options.scratch,
      `${slug}-snapshot-${options.suffix}.json`,
    );
    writeFileSync(snapshotPath, canonicalizeJson(snapshot));
    const requestPath = join(
      options.scratch,
      `${slug}-request-${options.suffix}.json`,
    );
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
      importedSnapshots: imports,
      importedSnapshotArtifacts: imports.map(
        (entry) => `metadata/${girPackageSlug(entry.namespace)}/selected-gir`,
      ),
      clangArguments: sdk.compileArguments,
      clangTool: options.clangTool,
      nodeTool: options.nodeTool,
      executionPlatform,
      target: nativeTarget,
    });
    const probePath = join(options.scratch, `${slug}-probe-${options.suffix}.c`);
    writeFileSync(probePath, plan.probe.source);
    sourcePaths[plan.clang.source.id] = probePath;
    artifacts.push(snapshotArtifact, requestArtifact, ...plan.artifacts);
    actions.push(...plan.actions);
    packages.push({
      slug,
      bindingsArtifactId: plan.bindings.artifact.id,
      generationActionId: plan.bindings.action.id,
      adapterInputId,
    });
  }

  return {
    graph: defineArtifactGraph({ artifacts, actions }),
    sourcePaths,
    packages,
    sdk,
  };
}

/** The Gio lifecycle surface a GTK application drives. */
export function ingestGioApplication(
  methods: readonly string[],
): GirSnapshot {
  return ingestGir(readFileSync(systemGioGir, "utf8"), {
    logicalPath: "system-sdk/gir/Gio-2.0.gir",
    namespace: { name: "Gio", version: "2.0" },
    classes: [
      // register() takes a GCancellable, so its class is part of the selection.
      { name: "Cancellable", constructors: ["new"] },
      {
        name: "Application",
        constructors: ["new"],
        methods: [...methods],
        signals: ["activate"],
      },
    ],
    enumerations: [
      {
        name: "ApplicationFlags",
        /* non_unique keeps a test application off the session bus, so it never
         * defers to a running instance or waits on a name it cannot own. */
        members: ["default_flags", "is_service", "non_unique"],
      },
    ],
  });
}
