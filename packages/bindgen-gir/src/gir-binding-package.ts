import type { ClangAbiEvidenceSnapshot } from "@native-typescript/bindgen-c";
import type {
  ArtifactActionDefinition,
  ArtifactDefinition,
} from "@native-typescript/core";
import { canonicalizeJson } from "@native-typescript/scabi";
import type { PackageIdentity } from "@native-typescript/scabi";
import type { GObjectScabiGenerationOptions } from "./gobject-scabi.ts";

export const girBindingToolFile = "gir-binding-tool-cli.mjs";

const girNamespaceNamePattern = /^[A-Z][A-Za-z0-9]*$/u;
const girNamespaceVersionPattern = /^[0-9]+(?:\.[0-9]+)*$/u;

/**
 * The package slug for a GIR namespace, matching its published package name:
 * `Gtk-4.0` is `gtk4` and `Gio-2.0` is `gio2`. Artifact and action identities
 * are derived from it so two namespaces analysed in one build cannot collide.
 */
export function girPackageSlug(namespace: {
  readonly name: string;
  readonly version: string;
}): string {
  if (
    !girNamespaceNamePattern.test(namespace.name) ||
    !girNamespaceVersionPattern.test(namespace.version)
  ) {
    throw new Error(
      `Malformed GIR namespace ${namespace.name}-${namespace.version}`,
    );
  }
  return `${namespace.name.toLowerCase()}${namespace.version.split(".")[0]}`;
}

export interface GirBindingPackageRequest {
  readonly schema: "native-typescript.gir-binding-package-request";
  readonly schemaVersion: 2;
  /**
   * The GIR namespace this package projects. It is declared here rather than
   * read from the snapshot so the request stays an independent,
   * content-addressed statement of intent that the snapshot is checked
   * against. A namespace version is not an SDK version: Gio-2.0 and Gtk-4.0
   * are both reached through the GTK SDK.
   */
  readonly namespace: {
    readonly name: string;
    readonly version: string;
  };
  /**
   * Namespaces whose generated packages this one may reference, in canonical
   * order. Generation receives one snapshot per entry in the same order, so
   * the request alone fixes how many inputs the action consumes.
   */
  readonly importedNamespaces?: readonly {
    readonly namespace: {
      readonly name: string;
      readonly version: string;
    };
    readonly package: PackageIdentity;
  }[];
  readonly clang: ClangAbiEvidenceSnapshot["clang"];
  readonly generation: Omit<
    GObjectScabiGenerationOptions,
    "snapshot" | "evidence" | "gobjectAdapter" | "importedNamespaces"
  >;
}

export interface GirBindingPackageDescriptor {
  readonly schema: "native-typescript.gir-binding-package";
  readonly schemaVersion: 1;
  readonly package: GirBindingPackageRequest["generation"]["package"];
  readonly target: GirBindingPackageRequest["generation"]["target"];
  readonly files: {
    readonly declarations: {
      readonly path: "package.d.ts";
      readonly digest: string;
    };
    readonly manifest: {
      readonly path: "package.scabi.json";
      readonly digest: string;
    };
    readonly adapterSource: {
      readonly path: "gobject-adapters.c";
      readonly digest: string;
    };
    readonly adapterMetadata: {
      readonly path: "gobject-adapter.json";
    };
  };
}

export interface GirBindingPackageArtifactPlan {
  readonly artifact: ArtifactDefinition;
  readonly action: ArtifactActionDefinition;
}

export interface GirClangEvidenceArtifactPlan {
  readonly artifact: ArtifactDefinition;
  readonly action: ArtifactActionDefinition;
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  Object.freeze(value);
}

export function validateGirBindingPackageRequest(
  request: GirBindingPackageRequest,
): void {
  if (
    request.schema !== "native-typescript.gir-binding-package-request" ||
    request.schemaVersion !== 2
  ) {
    throw new Error("Unsupported GIR binding-package request schema");
  }
  if (
    typeof request.clang !== "object" ||
    request.clang === null ||
    typeof request.generation !== "object" ||
    request.generation === null ||
    typeof request.namespace !== "object" ||
    request.namespace === null ||
    !girNamespaceNamePattern.test(request.namespace.name) ||
    !girNamespaceVersionPattern.test(request.namespace.version)
  ) {
    throw new Error("GIR binding-package request is incomplete");
  }
  const importedNames = (request.importedNamespaces ?? []).map(
    ({ namespace }) => namespace.name,
  );
  for (const [index, name] of importedNames.entries()) {
    if (name === request.namespace.name) {
      throw new Error(
        `GIR binding request imports its own namespace ${name}`,
      );
    }
    if (index > 0 && importedNames[index - 1]! >= name) {
      throw new Error(
        "GIR binding request imported namespaces must be unique and in canonical order",
      );
    }
  }
  if (request.clang.target !== request.generation.target.triple) {
    throw new Error(
      `GIR Clang evidence targets ${request.clang.target}, but package generation targets ` +
        request.generation.target.triple,
    );
  }
}

export function defineGirBindingPackageRequest(
  input: Omit<GirBindingPackageRequest, "schema" | "schemaVersion">,
): GirBindingPackageRequest {
  const request = JSON.parse(canonicalizeJson({
    schema: "native-typescript.gir-binding-package-request",
    schemaVersion: 2,
    ...input,
  })) as GirBindingPackageRequest;
  validateGirBindingPackageRequest(request);
  deepFreeze(request);
  return request;
}

function validatePlannerInput(input: {
  readonly request: GirBindingPackageRequest;
  readonly tool: ArtifactActionDefinition["tool"];
  readonly target: string;
}): void {
  validateGirBindingPackageRequest(input.request);
  if (input.tool.id !== "tool/node") {
    throw new Error(
      `GIR binding generation requires tool/node, but received ${input.tool.id}`,
    );
  }
  if (input.request.generation.target.triple !== input.target) {
    throw new Error(
      `GIR binding request targets ${input.request.generation.target.triple}, ` +
        `but the artifact targets ${input.target}`,
    );
  }
}

export function planGirClangEvidenceNormalization(input: {
  readonly request: GirBindingPackageRequest;
  readonly requestArtifact: string;
  readonly snapshotArtifact: string;
  readonly rawAstArtifact: string;
  readonly rawLlvmArtifact: string;
  readonly generatorArtifact: string;
  /**
   * The same imported snapshots the generation action receives. Normalization
   * regenerates the probe to interpret the raw AST, so it must see the exact
   * candidate set the probe was compiled from.
   */
  readonly importedSnapshotArtifacts?: readonly string[];
  readonly artifactId: string;
  readonly actionId: string;
  readonly tool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
}): GirClangEvidenceArtifactPlan {
  validatePlannerInput(input);
  const importedSnapshots = input.importedSnapshotArtifacts ?? [];
  const importedNamespaces = input.request.importedNamespaces ?? [];
  if (importedSnapshots.length !== importedNamespaces.length) {
    throw new Error(
      `GIR evidence normalization declares ${importedNamespaces.length} imported ` +
        `namespace(s) but received ${importedSnapshots.length} snapshot input(s)`,
    );
  }
  return Object.freeze({
    artifact: Object.freeze({
      id: input.artifactId,
      kind: "metadata",
      entryType: "file",
      mediaType:
        "application/vnd.native-typescript.clang-abi-evidence+json",
      target: input.target,
      domain: "target",
      cache: "exportable",
      origin: Object.freeze({
        kind: "action",
        action: input.actionId,
        fileName: "clang-abi-evidence.json",
      }),
    }),
    action: Object.freeze({
      id: input.actionId,
      implementation: Object.freeze({
        id: "native-typescript/gir-clang-abi-evidence",
        version: String(input.request.schemaVersion),
      }),
      tool: Object.freeze({ ...input.tool }),
      arguments: Object.freeze([
        Object.freeze({
          kind: "input-path" as const,
          artifact: input.generatorArtifact,
        }),
        Object.freeze({ kind: "literal" as const, value: "normalize-evidence" }),
        Object.freeze({
          kind: "input-path" as const,
          artifact: input.snapshotArtifact,
        }),
        Object.freeze({
          kind: "input-path" as const,
          artifact: input.rawAstArtifact,
        }),
        Object.freeze({
          kind: "input-path" as const,
          artifact: input.rawLlvmArtifact,
        }),
        Object.freeze({
          kind: "input-path" as const,
          artifact: input.requestArtifact,
        }),
        Object.freeze({
          kind: "output-path" as const,
          artifact: input.artifactId,
        }),
        ...importedSnapshots.map((artifact) =>
          Object.freeze({ kind: "input-path" as const, artifact })
        ),
      ]),
      environment: Object.freeze([]),
      inputs: Object.freeze([
        input.generatorArtifact,
        input.snapshotArtifact,
        input.rawAstArtifact,
        input.rawLlvmArtifact,
        input.requestArtifact,
        ...importedSnapshots,
      ]),
      outputs: Object.freeze([input.artifactId]),
      standardOutput: Object.freeze({ kind: "report" as const }),
      workingDirectory: "isolated",
      network: "denied",
      executionPlatform: input.executionPlatform,
      target: input.target,
      deterministic: true,
      cacheable: true,
    }),
  });
}

export function planGirBindingPackage(input: {
  readonly request: GirBindingPackageRequest;
  readonly requestArtifact: string;
  readonly snapshotArtifact: string;
  readonly normalizedEvidenceArtifact: string;
  readonly generatorArtifact: string;
  /**
   * One snapshot artifact per entry in `request.importedNamespaces`, in the
   * same order. The request fixes the count, so a missing or extra input is a
   * planning error rather than a mismatch discovered inside the sandbox.
   */
  readonly importedSnapshotArtifacts?: readonly string[];
  readonly artifactId: string;
  readonly actionId: string;
  readonly tool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
}): GirBindingPackageArtifactPlan {
  validatePlannerInput(input);
  const importedSnapshots = input.importedSnapshotArtifacts ?? [];
  const importedNamespaces = input.request.importedNamespaces ?? [];
  if (importedSnapshots.length !== importedNamespaces.length) {
    throw new Error(
      `GIR binding generation declares ${importedNamespaces.length} imported ` +
        `namespace(s) but received ${importedSnapshots.length} snapshot input(s)`,
    );
  }
  return Object.freeze({
    artifact: Object.freeze({
      id: input.artifactId,
      kind: "source-tree",
      entryType: "directory",
      mediaType: "application/vnd.native-typescript.gtk-binding-package",
      target: input.target,
      domain: "target",
      cache: "exportable",
      origin: Object.freeze({
        kind: "action",
        action: input.actionId,
        fileName: "gtk-binding-package",
      }),
    }),
    action: Object.freeze({
      id: input.actionId,
      implementation: Object.freeze({
        id: "native-typescript/gir-binding-package",
        version: String(input.request.schemaVersion),
      }),
      tool: Object.freeze({ ...input.tool }),
      arguments: Object.freeze([
        Object.freeze({
          kind: "input-path" as const,
          artifact: input.generatorArtifact,
        }),
        Object.freeze({ kind: "literal" as const, value: "generate-package" }),
        Object.freeze({
          kind: "input-path" as const,
          artifact: input.snapshotArtifact,
        }),
        Object.freeze({
          kind: "input-path" as const,
          artifact: input.normalizedEvidenceArtifact,
        }),
        Object.freeze({
          kind: "input-path" as const,
          artifact: input.requestArtifact,
        }),
        Object.freeze({
          kind: "output-path" as const,
          artifact: input.artifactId,
        }),
        ...importedSnapshots.map((artifact) =>
          Object.freeze({ kind: "input-path" as const, artifact })
        ),
      ]),
      environment: Object.freeze([]),
      inputs: Object.freeze([
        input.generatorArtifact,
        input.snapshotArtifact,
        input.normalizedEvidenceArtifact,
        input.requestArtifact,
        ...importedSnapshots,
      ]),
      outputs: Object.freeze([input.artifactId]),
      standardOutput: Object.freeze({ kind: "report" as const }),
      workingDirectory: "isolated",
      network: "denied",
      executionPlatform: input.executionPlatform,
      target: input.target,
      deterministic: true,
      cacheable: true,
    }),
  });
}
