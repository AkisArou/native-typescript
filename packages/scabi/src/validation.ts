import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import schema from "./scabi-v14.schema.json" with { type: "json" };
import { canonicalizeJson } from "./canonical-json.ts";
import type {
  CallableBinding,
  ConstantBinding,
  NativeBindingId,
  ScabiManifest,
} from "./model.ts";

export type ScabiDiagnosticCode =
  | "NTS2001"
  | "NTS2002"
  | "NTS2003"
  | "NTS2010"
  | "NTS2011"
  | "NTS2012"
  | "NTS2013"
  | "NTS2014"
  | "NTS2020"
  | "NTS2021"
  | "NTS2030"
  | "NTS2040"
  | "NTS2050";

export interface ScabiDiagnostic {
  readonly code: ScabiDiagnosticCode;
  readonly severity: "error";
  readonly path: string;
  readonly message: string;
}

export type ScabiValidationResult =
  | {
      readonly ok: true;
      readonly manifest: ScabiManifest;
      readonly diagnostics: readonly [];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly ScabiDiagnostic[];
    };

export interface ParseScabiOptions {
  readonly requireCanonical?: boolean;
}

export class ScabiValidationError extends Error {
  override readonly name = "ScabiValidationError";
  readonly diagnostics: readonly ScabiDiagnostic[];

  constructor(diagnostics: readonly ScabiDiagnostic[]) {
    const summary = diagnostics
      .map(
        (diagnostic) =>
          `${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
      )
      .join("\n");
    super(`SCABI validation failed with ${diagnostics.length} error(s)\n${summary}`);
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strict: true,
});
const validateShape = ajv.compile<ScabiManifest>(schema);

function diagnostic(
  code: ScabiDiagnosticCode,
  path: string,
  message: string,
): ScabiDiagnostic {
  return Object.freeze({ code, severity: "error", path, message });
}

function schemaDiagnostic(error: ErrorObject): ScabiDiagnostic {
  const missingProperty =
    error.keyword === "required" &&
    typeof error.params.missingProperty === "string"
      ? `/${error.params.missingProperty}`
      : "";
  const path = `${error.instancePath}${missingProperty}` || "/";
  return diagnostic(
    "NTS2001",
    path,
    error.message === undefined ? "JSON Schema validation failed" : error.message,
  );
}

function deepFreeze(value: unknown, visited = new Set<object>()): void {
  if (value === null || typeof value !== "object" || visited.has(value)) {
    return;
  }
  visited.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, visited);
  }
  Object.freeze(value);
}

function snapshotManifest(manifest: ScabiManifest): ScabiManifest {
  const snapshot = JSON.parse(canonicalizeJson(manifest)) as ScabiManifest;
  deepFreeze(snapshot);
  return snapshot;
}

function validateTypeImports(
  manifest: ScabiManifest,
  diagnostics: ScabiDiagnostic[],
): void {
  for (const [typeId, entry] of Object.entries(manifest.imports ?? {})) {
    const path = `/imports/${typeId}`;
    if (manifest.types[typeId] !== undefined) {
      diagnostics.push(diagnostic(
        "NTS2010",
        path,
        `Native type ${typeId} is imported from ${entry.package.name} but also ` +
          "defined here; a package cannot both import and define one identity",
      ));
    }
    if (entry.package.instance === manifest.package.instance) {
      diagnostics.push(diagnostic(
        "NTS2010",
        path,
        `Native type ${typeId} is imported from this package's own instance`,
      ));
    }
    const declaration = manifest.declarations.types[typeId];
    if (declaration === undefined) {
      diagnostics.push(diagnostic(
        "NTS2010",
        path,
        `Imported native type ${typeId} has no TypeScript declaration identity`,
      ));
    } else if (declaration.module === ".") {
      diagnostics.push(diagnostic(
        "NTS2010",
        path,
        `Imported native type ${typeId} is declared local to this package`,
      ));
    }
  }
}

/* A constant's only envelope rule: it is folded at compile time, so nothing
 * about it can be a runtime dependency. Whether its value inhabits its
 * declared type is a format question the compiler answers. */
function validateConstantBinding(
  _manifest: ScabiManifest,
  id: NativeBindingId,
  binding: ConstantBinding,
  diagnostics: ScabiDiagnostic[],
): void {
  if (
    binding.dependencies.bindings.length > 0 ||
    binding.dependencies.linkInputs.length > 0 ||
    binding.dependencies.adapterInputs.length > 0 ||
    binding.dependencies.permissions.length > 0
  ) {
    diagnostics.push(diagnostic(
      "NTS2021",
      `/bindings/${id}/dependencies`,
      "Compile-time constants cannot have runtime dependencies",
    ));
  }
}

function validateBindingReference(
  manifest: ScabiManifest,
  ownerId: string,
  dependencySet: ReadonlySet<string>,
  reference: string,
  path: string,
  diagnostics: ScabiDiagnostic[],
): void {
  if (manifest.bindings[reference] === undefined) {
    diagnostics.push(
      diagnostic(
        "NTS2011",
        path,
        `Native binding ${reference} does not exist`,
      ),
    );
  } else if (!dependencySet.has(reference)) {
    diagnostics.push(
      diagnostic(
        "NTS2050",
        path,
        `Binding ${ownerId} must declare dependency ${reference}`,
      ),
    );
  }
}

/* What the envelope owns about a callable: that every binding it names is
 * reachable from its own dependencies. Whether the SHAPE is well formed —
 * ownership, marshalling, conversions, callbacks, destructor arity — is the
 * compiler's question and is asked by the layer that speaks its vocabulary.
 * It was asked here too, in parallel, until record 0006. */
function validateCallableBinding(
  manifest: ScabiManifest,
  id: string,
  binding: CallableBinding,
  diagnostics: ScabiDiagnostic[],
): void {
  const dependencies = new Set(binding.dependencies.bindings);
  if (binding.baseCall !== undefined) {
    /* The base call is reached only when a program writes `super.m(...)`, so
     * nothing else in the manifest names it and a selection that dropped it
     * would leave a link resolving to nothing. Checked here for the same
     * reason a destructor is: a reference the envelope carries is a reference
     * the envelope keeps honest, and the alternative is discovering it as a
     * missing symbol at link time with no path back to which binding meant it. */
    validateBindingReference(
      manifest,
      id,
      dependencies,
      binding.baseCall,
      `/bindings/${id}/baseCall`,
      diagnostics,
    );
  }
  if (binding.error.kind === "error-handle" || binding.error.kind === "error-out") {
    /* The two entries are ordinary bindings, so they are reachability
     * dependencies like a destructor rather than free-floating symbols. Both
     * shapes read and release the same way; only where the object arrives
     * differs, and that difference is not the envelope's business. */
    for (const [role, reference] of [
      ["message", binding.error.message],
      ["release", binding.error.release],
    ] as const) {
      validateBindingReference(
        manifest,
        id,
        dependencies,
        reference,
        `/bindings/${id}/error/${role}`,
        diagnostics,
      );
    }
  }
  const ownership = binding.signature.result.ownership;
  if (
    ownership.kind === "owned" &&
    ownership.transfer === "to-runtime" &&
    ownership.destructor !== undefined
  ) {
    validateBindingReference(
      manifest,
      id,
      dependencies,
      ownership.destructor,
      `/bindings/${id}/signature/result/ownership/destructor`,
      diagnostics,
    );
  }
  for (const [index, parameter] of binding.signature.parameters.entries()) {
    const parameterOwnership = parameter.ownership;
    if (
      parameterOwnership.kind === "owned" &&
      parameterOwnership.transfer === "to-runtime" &&
      parameterOwnership.destructor !== undefined
    ) {
      validateBindingReference(
        manifest,
        id,
        dependencies,
        parameterOwnership.destructor,
        `/bindings/${id}/signature/parameters/${index}/ownership/destructor`,
        diagnostics,
      );
    }
  }
}

function validateUniqueInputIds(
  manifest: ScabiManifest,
  diagnostics: ScabiDiagnostic[],
): void {
  const groups: ReadonlyArray<{
    readonly values: readonly { readonly id: string }[];
    readonly path: string;
  }> = [
    { values: manifest.linkInputs, path: "/linkInputs" },
    { values: manifest.adapterInputs, path: "/adapterInputs" },
    { values: manifest.permissions, path: "/permissions" },
  ];
  for (const group of groups) {
    const seen = new Set<string>();
    for (const [index, value] of group.values.entries()) {
      if (seen.has(value.id)) {
        diagnostics.push(
          diagnostic(
            "NTS2050",
            `${group.path}/${index}/id`,
            `Duplicate input ID ${value.id}`,
          ),
        );
      }
      seen.add(value.id);
    }
  }
}

function validateDependencies(
  manifest: ScabiManifest,
  diagnostics: ScabiDiagnostic[],
): void {
  const linkInputs = new Set(manifest.linkInputs.map(({ id }) => id));
  const adapterInputs = new Set(manifest.adapterInputs.map(({ id }) => id));
  const permissions = new Set(manifest.permissions.map(({ id }) => id));

  for (const [id, binding] of Object.entries(manifest.bindings)) {
    for (const reference of binding.dependencies.bindings) {
      if (manifest.bindings[reference] === undefined) {
        diagnostics.push(
          diagnostic(
            "NTS2011",
            `/bindings/${id}/dependencies/bindings`,
            `Native binding ${reference} does not exist`,
          ),
        );
      }
    }
    for (const reference of binding.dependencies.linkInputs) {
      if (!linkInputs.has(reference)) {
        diagnostics.push(
          diagnostic(
            "NTS2012",
            `/bindings/${id}/dependencies/linkInputs`,
            `Link input ${reference} does not exist`,
          ),
        );
      }
    }
    for (const reference of binding.dependencies.adapterInputs) {
      if (!adapterInputs.has(reference)) {
        diagnostics.push(
          diagnostic(
            "NTS2013",
            `/bindings/${id}/dependencies/adapterInputs`,
            `Adapter input ${reference} does not exist`,
          ),
        );
      }
    }
    for (const reference of binding.dependencies.permissions) {
      if (!permissions.has(reference)) {
        diagnostics.push(
          diagnostic(
            "NTS2014",
            `/bindings/${id}/dependencies/permissions`,
            `Permission ${reference} does not exist`,
          ),
        );
      }
    }
  }

  for (const [typeId, type] of Object.entries(manifest.types)) {
    if (type.kind !== "handle" || type.peerSlot === undefined) continue;
    for (const [role, binding] of [
      ["read", type.peerSlot.read],
      ["write", type.peerSlot.write],
    ] as const) {
      if (manifest.bindings[binding] === undefined) {
        diagnostics.push(diagnostic(
          "NTS2011",
          `/types/${typeId}/peerSlot/${role}`,
          `Managed peer ${role} binding ${binding} does not exist`,
        ));
      }
    }
  }

  for (const [index, adapter] of manifest.adapterInputs.entries()) {
    for (const binding of adapter.bindings) {
      if (manifest.bindings[binding] === undefined) {
        diagnostics.push(
          diagnostic(
            "NTS2011",
            `/adapterInputs/${index}/bindings`,
            `Native binding ${binding} does not exist`,
          ),
        );
      }
    }
  }
}

function validateSemantics(
  manifest: ScabiManifest,
): readonly ScabiDiagnostic[] {
  const diagnostics: ScabiDiagnostic[] = [];
  validateTypeImports(manifest, diagnostics);
  validateUniqueInputIds(manifest, diagnostics);
  validateDependencies(manifest, diagnostics);
  for (const [id, binding] of Object.entries(manifest.bindings)) {
    if (binding.kind === "constant") {
      validateConstantBinding(manifest, id, binding, diagnostics);
    } else {
      validateCallableBinding(manifest, id, binding, diagnostics);
    }
  }
  return Object.freeze(diagnostics);
}

export function validateScabiManifest(value: unknown): ScabiValidationResult {
  if (!validateShape(value)) {
    return Object.freeze({
      ok: false,
      diagnostics: Object.freeze(
        (validateShape.errors ?? []).map(schemaDiagnostic),
      ),
    });
  }

  const diagnostics = validateSemantics(value);
  if (diagnostics.length > 0) {
    return Object.freeze({ ok: false, diagnostics });
  }

  return Object.freeze({
    ok: true,
    manifest: snapshotManifest(value),
    diagnostics: Object.freeze([]) as readonly [],
  });
}

export function assertScabiManifest(value: unknown): ScabiManifest {
  const result = validateScabiManifest(value);
  if (!result.ok) {
    throw new ScabiValidationError(result.diagnostics);
  }
  return result.manifest;
}

export function parseScabiManifest(
  source: string,
  options: ParseScabiOptions = {},
): ScabiManifest {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    throw new ScabiValidationError([
      diagnostic("NTS2002", "/", message),
    ]);
  }

  if ((options.requireCanonical ?? true) && canonicalizeJson(value) !== source) {
    throw new ScabiValidationError([
      diagnostic(
        "NTS2003",
        "/",
        "Manifest source is not in canonical JSON form",
      ),
    ]);
  }

  return assertScabiManifest(value);
}
