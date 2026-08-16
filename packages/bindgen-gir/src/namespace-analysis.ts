import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defineArtifactGraph,
  resolveSourceArtifact,
} from "@native-typescript/core";
import type {
  ArtifactActionDefinition,
  ArtifactDefinition,
  ResolvedPkgConfigSdk,
} from "@native-typescript/core";
import { canonicalizeJson } from "@native-typescript/scabi";
import {
  defineGirBindingPackageRequest,
  girPackageSlug,
} from "./gir-binding-package.ts";
import { planGirBindingAnalysis } from "./gir-binding-analysis.ts";
import type { GirSnapshot } from "./gir-model.ts";

/**
 * Plans one analysis subgraph per selected namespace inside a single artifact
 * graph.
 *
 * Generating one namespace and generating several differ only in what each
 * request imports, so both go through here. Every identity derives from the
 * package slug, which is what keeps two namespaces from colliding silently,
 * and a dependent namespace consumes its imports' snapshots as declared inputs
 * rather than reading them from anywhere ambient.
 */

export interface GirNamespaceSelection {
  readonly snapshot: GirSnapshot;
  /** Namespaces this one references. Must be planned before it. */
  readonly imports: readonly GirSnapshot[];
  /** pkg-config modules whose headers the probe includes. */
  readonly sdkModules: readonly string[];
}

export interface GirGeneratedPackage {
  readonly slug: string;
  /** Package directory, once the analysis graph has run. */
  readonly bindingsArtifactId: string;
  readonly generationActionId: string;
  readonly adapterInputId: string;
  readonly packageName: string;
}

export interface GirNamespaceAnalysis {
  readonly graph: ReturnType<typeof defineArtifactGraph>;
  readonly sourcePaths: Readonly<Record<string, string>>;
  readonly packages: readonly GirGeneratedPackage[];
}

export function girPackageIdentity(slug: string): {
  readonly name: string;
  readonly version: string;
  readonly namespace: string;
  readonly instance: string;
} {
  return Object.freeze({
    name: `@native-typescript/${slug}`,
    version: "0.0.0",
    namespace: `native-typescript.${slug}`,
    instance: `native-typescript.${slug}@0.0.0`,
  });
}

async function fileArtifact(
  id: string,
  path: string,
  mediaType: string,
  executionPlatform: string,
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

export async function planGirNamespaceAnalysis(input: {
  readonly selections: readonly GirNamespaceSelection[];
  readonly sdk: ResolvedPkgConfigSdk;
  /** Where request, snapshot, and probe files are materialised. */
  readonly scratch: string;
  /** Distinguishes several analyses sharing one scratch directory. */
  readonly suffix?: string;
  readonly generatorPath: string;
  readonly clangTool: ArtifactActionDefinition["tool"];
  readonly nodeTool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
  readonly targetFeatures?: readonly string[];
}): Promise<GirNamespaceAnalysis> {
  const suffix = input.suffix ?? "1";
  const sourcePaths: Record<string, string> = { ...input.sdk.sourcePaths };
  const artifacts: ArtifactDefinition[] = [...input.sdk.artifacts];
  const actions: ArtifactActionDefinition[] = [];
  const generator = await fileArtifact(
    "tool-input/bindgen-gir/generator",
    input.generatorPath,
    "text/javascript",
    input.executionPlatform,
    sourcePaths,
  );
  artifacts.push(generator);

  const packages: GirGeneratedPackage[] = [];
  for (const { snapshot, imports, sdkModules } of input.selections) {
    const slug = girPackageSlug(snapshot.namespace);
    const adapterInputId = `${slug}.gobject-adapters`;
    const identity = girPackageIdentity(slug);
    const request = defineGirBindingPackageRequest({
      namespace: { ...snapshot.namespace },
      importedNamespaces: imports.map((entry) => ({
        namespace: {
          name: entry.namespace.name,
          version: entry.namespace.version,
        },
        package: girPackageIdentity(girPackageSlug(entry.namespace)),
      })),
      clang: {
        toolId: input.clangTool.id,
        version: input.clangTool.version,
        digest: input.clangTool.digest,
        target: input.target,
      },
      generation: {
        package: identity,
        target: {
          triple: input.target,
          architecture: "x86_64",
          pointerWidth: 64,
          endianness: "little",
          objectFormat: "elf",
          minimumPlatformVersion: "glibc-2.17",
          abi: "sysv-amd64",
          features: [...(input.targetFeatures ?? ["gtk4", "glib-main-context"])],
        },
        sdk: {
          vendor: "GNOME",
          name: "GTK",
          version: "4.0",
          deploymentTarget: input.target,
          modules: [...sdkModules],
        },
        linkInputs: input.sdk.systemLibraries.map((name, order) => ({
          id: name,
          kind: "system-library" as const,
          name,
          order,
        })),
        adapterInput: { id: adapterInputId, output: "gobject-adapters.o" },
      },
    });

    const snapshotPath = join(input.scratch, `${slug}-snapshot-${suffix}.json`);
    writeFileSync(snapshotPath, canonicalizeJson(snapshot));
    const requestPath = join(input.scratch, `${slug}-request-${suffix}.json`);
    writeFileSync(requestPath, canonicalizeJson(request));
    const snapshotArtifact = await fileArtifact(
      `metadata/${slug}/selected-gir`,
      snapshotPath,
      "application/vnd.native-typescript.gir-snapshot+json",
      input.executionPlatform,
      sourcePaths,
    );
    const requestArtifact = await fileArtifact(
      `metadata/${slug}/binding-package-request`,
      requestPath,
      "application/vnd.native-typescript.gtk-binding-package-request+json",
      input.executionPlatform,
      sourcePaths,
    );
    const plan = planGirBindingAnalysis({
      snapshot,
      request,
      requestArtifact: requestArtifact.id,
      snapshotArtifact: snapshotArtifact.id,
      generatorArtifact: generator.id,
      importedSnapshots: imports,
      importedSnapshotArtifacts: imports.map(
        (entry) => `metadata/${girPackageSlug(entry.namespace)}/selected-gir`,
      ),
      clangArguments: input.sdk.compileArguments,
      clangTool: input.clangTool,
      nodeTool: input.nodeTool,
      executionPlatform: input.executionPlatform,
      target: input.target,
    });
    const probePath = join(input.scratch, `${slug}-probe-${suffix}.c`);
    writeFileSync(probePath, plan.probe.source);
    sourcePaths[plan.clang.source.id] = probePath;
    artifacts.push(snapshotArtifact, requestArtifact, ...plan.artifacts);
    actions.push(...plan.actions);
    packages.push({
      slug,
      bindingsArtifactId: plan.bindings.artifact.id,
      generationActionId: plan.bindings.action.id,
      adapterInputId,
      packageName: identity.name,
    });
  }

  return Object.freeze({
    graph: defineArtifactGraph({ artifacts, actions }),
    sourcePaths,
    packages: Object.freeze(packages),
  });
}
