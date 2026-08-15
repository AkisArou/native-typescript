import type { ClangAbiEvidenceSnapshot } from "@native-typescript/bindgen-c";
import type {
  ArtifactActionDefinition,
  ArtifactDefinition,
} from "@native-typescript/core";
import { canonicalizeJson } from "@native-typescript/scabi";
import type { GtkScabiGenerationOptions } from "./gtk-scabi.ts";

export const gtkBindingToolFile = "gtk-binding-tool-cli.mjs";

export interface GtkBindingPackageRequest {
  readonly schema: "native-typescript.gtk-binding-package-request";
  readonly schemaVersion: 1;
  readonly clang: ClangAbiEvidenceSnapshot["clang"];
  readonly generation: Omit<
    GtkScabiGenerationOptions,
    "snapshot" | "evidence" | "gobjectAdapter"
  >;
}

export interface GtkBindingPackageDescriptor {
  readonly schema: "native-typescript.gtk-binding-package";
  readonly schemaVersion: 1;
  readonly package: GtkBindingPackageRequest["generation"]["package"];
  readonly target: GtkBindingPackageRequest["generation"]["target"];
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

export interface GtkBindingPackageArtifactPlan {
  readonly artifact: ArtifactDefinition;
  readonly action: ArtifactActionDefinition;
}

export interface GtkClangEvidenceArtifactPlan {
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

export function validateGtkBindingPackageRequest(
  request: GtkBindingPackageRequest,
): void {
  if (
    request.schema !== "native-typescript.gtk-binding-package-request" ||
    request.schemaVersion !== 1
  ) {
    throw new Error("Unsupported GTK binding-package request schema");
  }
  if (
    typeof request.clang !== "object" ||
    request.clang === null ||
    typeof request.generation !== "object" ||
    request.generation === null
  ) {
    throw new Error("GTK binding-package request is incomplete");
  }
  if (request.clang.target !== request.generation.target.triple) {
    throw new Error(
      `GTK Clang evidence targets ${request.clang.target}, but package generation targets ` +
        request.generation.target.triple,
    );
  }
}

export function defineGtkBindingPackageRequest(
  input: Omit<GtkBindingPackageRequest, "schema" | "schemaVersion">,
): GtkBindingPackageRequest {
  const request = JSON.parse(canonicalizeJson({
    schema: "native-typescript.gtk-binding-package-request",
    schemaVersion: 1,
    ...input,
  })) as GtkBindingPackageRequest;
  validateGtkBindingPackageRequest(request);
  deepFreeze(request);
  return request;
}

function validatePlannerInput(input: {
  readonly request: GtkBindingPackageRequest;
  readonly tool: ArtifactActionDefinition["tool"];
  readonly target: string;
}): void {
  validateGtkBindingPackageRequest(input.request);
  if (input.tool.id !== "tool/node") {
    throw new Error(
      `GTK binding generation requires tool/node, but received ${input.tool.id}`,
    );
  }
  if (input.request.generation.target.triple !== input.target) {
    throw new Error(
      `GTK binding request targets ${input.request.generation.target.triple}, ` +
        `but the artifact targets ${input.target}`,
    );
  }
}

export function planGtkClangEvidenceNormalization(input: {
  readonly request: GtkBindingPackageRequest;
  readonly requestArtifact: string;
  readonly snapshotArtifact: string;
  readonly rawAstArtifact: string;
  readonly rawLlvmArtifact: string;
  readonly generatorArtifact: string;
  readonly artifactId: string;
  readonly actionId: string;
  readonly tool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
}): GtkClangEvidenceArtifactPlan {
  validatePlannerInput(input);
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
        id: "native-typescript/gtk-clang-abi-evidence",
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
      ]),
      environment: Object.freeze([]),
      inputs: Object.freeze([
        input.generatorArtifact,
        input.snapshotArtifact,
        input.rawAstArtifact,
        input.rawLlvmArtifact,
        input.requestArtifact,
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

export function planGtkBindingPackage(input: {
  readonly request: GtkBindingPackageRequest;
  readonly requestArtifact: string;
  readonly snapshotArtifact: string;
  readonly normalizedEvidenceArtifact: string;
  readonly generatorArtifact: string;
  readonly artifactId: string;
  readonly actionId: string;
  readonly tool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
}): GtkBindingPackageArtifactPlan {
  validatePlannerInput(input);
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
        id: "native-typescript/gtk-binding-package",
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
      ]),
      environment: Object.freeze([]),
      inputs: Object.freeze([
        input.generatorArtifact,
        input.snapshotArtifact,
        input.normalizedEvidenceArtifact,
        input.requestArtifact,
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
