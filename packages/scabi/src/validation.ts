import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import schema from "./scabi-v3.schema.json" with { type: "json" };
import { canonicalizeJson } from "./canonical-json.ts";
import type {
  AbiParameter,
  AbiResult,
  CallbackContract,
  CallbackType,
  CallableBinding,
  ConstantBinding,
  IntegerType,
  NativeBindingId,
  NativeLayout,
  NativePhysicalAbiType,
  NativePhysicalAbiValue,
  NativeType,
  NativeTypeId,
  OwnershipContract,
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

function typeReferences(type: NativeType): readonly NativeTypeId[] {
  switch (type.kind) {
    case "void":
    case "integer":
    case "float":
    case "opaque-value":
    case "platform-object":
      return [];
    case "handle":
      return type.upcasts.map(({ target }) => target);
    case "boolean":
      return [type.storage];
    case "enum":
    case "flags":
      return [type.underlying];
    case "pointer":
      return [type.pointee];
    case "array":
      return [type.element];
    case "slice":
      return [type.element, type.pointerType, type.lengthType];
    case "struct":
      return type.fields.map((field) => field.type);
    case "union":
      return [
        ...type.fields.map((field) => field.type),
        ...(type.discriminator === undefined ? [] : [type.discriminator]),
      ];
    case "callback":
      return [
        ...type.signature.parameters.map((parameter) => parameter.type),
        type.signature.result.type,
        ...(type.context.type === undefined ? [] : [type.context.type]),
      ];
  }
}

/** Type IDs another package owns, which this manifest only references. */
function importedTypeIds(manifest: ScabiManifest): ReadonlySet<string> {
  return new Set(Object.keys(manifest.imports ?? {}));
}

/**
 * Checks that every import is coherent on its own terms.
 *
 * Imports exist so one binding family can span several packages without
 * flattening them. `Gtk.Application` extends `Gio.Application`, and the two
 * project into separate packages because GIR namespaces are package
 * boundaries.
 *
 * The owning package identity is explicit rather than inferred from the
 * declaration's module, because a native type's compiler identity is scoped to
 * the package instance that defines it. Only the owning instance lets an
 * importer name the same type.
 *
 * Structural agreement is not checkable here, since only composition sees the
 * defining package. What is checkable is that the import names another
 * package, is not also defined locally, and carries the TypeScript declaration
 * identity the projection imports from.
 */
/**
 * A handle this package imports rather than defines.
 *
 * Only a handle may be imported: an upcast target needs no local structure,
 * and neither does a handle crossing a signature as a pointer. Every other
 * position needs the definition here, so nothing else resolves. The contracts
 * that do need the definition — thread-safety, identity, and the layout of
 * anything with one — are proven at composition, where both packages are
 * present; locally the kind is all any rule can act on, and this is it.
 */
const importedHandleReference = Object.freeze({
  kind: "handle" as const,
  imported: true as const,
});

type ReferencedType = NativeType | typeof importedHandleReference;

/** The type a signature position names, defined here or imported. */
function referencedType(
  manifest: ScabiManifest,
  typeId: NativeTypeId,
): ReferencedType | undefined {
  const defined = manifest.types[typeId];
  if (defined !== undefined) return defined;
  return manifest.imports?.[typeId] === undefined
    ? undefined
    : importedHandleReference;
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

function validateHandleUpcasts(
  manifest: ScabiManifest,
  diagnostics: ScabiDiagnostic[],
): void {
  for (const [id, type] of Object.entries(manifest.types)) {
    if (type.kind !== "handle") continue;
    if (
      type.destructor !== undefined &&
      !destructorConsumes(manifest, type.destructor, id)
    ) {
      diagnostics.push(diagnostic(
        "NTS2030",
        `/types/${id}/destructor`,
        `Destructor ${type.destructor} must consume one ${id} and return void`,
      ));
    }
    const targets = new Set<string>();
    let previous = "";
    type.upcasts.forEach((upcast, index) => {
      const path = `/types/${id}/upcasts/${index}/target`;
      if (targets.has(upcast.target)) {
        diagnostics.push(diagnostic(
          "NTS2021",
          path,
          `Handle upcast target ${upcast.target} is repeated`,
        ));
      }
      targets.add(upcast.target);
      if (index > 0 && previous >= upcast.target) {
        diagnostics.push(diagnostic(
          "NTS2021",
          path,
          "Handle upcast targets must be in ascending canonical order",
        ));
      }
      previous = upcast.target;
      if (upcast.target === id) {
        diagnostics.push(diagnostic("NTS2021", path, "A handle cannot upcast to itself"));
        return;
      }
      const target = manifest.types[upcast.target];
      // An imported target is opaque here, and composition resolves it against
      // the defining package. A target that is neither defined nor imported is
      // reported once by the type-reference pass.
      if (target === undefined) return;
      if (target.kind !== "handle") {
        diagnostics.push(diagnostic(
          "NTS2021",
          path,
          `Handle upcast target ${upcast.target} is not a handle`,
        ));
        return;
      }
      if (target.threadSafety !== type.threadSafety || target.identity !== type.identity) {
        diagnostics.push(diagnostic(
          "NTS2021",
          path,
          "Identity-upcast handles must have identical thread-safety and identity contracts",
        ));
      }
    });
  }

  const state = new Map<string, "active" | "complete">();
  const visit = (id: string): void => {
    const type = manifest.types[id];
    if (type?.kind !== "handle" || state.get(id) === "complete") return;
    state.set(id, "active");
    type.upcasts.forEach((upcast, index) => {
      const target = manifest.types[upcast.target];
      if (target?.kind !== "handle") return;
      if (state.get(upcast.target) === "active") {
        diagnostics.push(diagnostic(
          "NTS2021",
          `/types/${id}/upcasts/${index}/target`,
          `Handle upcast graph contains a cycle through ${upcast.target}`,
        ));
      } else {
        visit(upcast.target);
      }
    });
    state.set(id, "complete");
  };
  for (const id of Object.keys(manifest.types).sort()) visit(id);
}

function validateTypeReferences(
  manifest: ScabiManifest,
  diagnostics: ScabiDiagnostic[],
): void {
  const imported = importedTypeIds(manifest);
  const declarationIdentities = new Set<string>();
  for (const [typeId, declaration] of Object.entries(
    manifest.declarations.types,
  )) {
    if (manifest.types[typeId] === undefined && !imported.has(typeId)) {
      diagnostics.push(
        diagnostic(
          "NTS2010",
          `/declarations/types/${typeId}`,
          `Native type ${typeId} does not exist`,
        ),
      );
    }
    const identity = `${declaration.module}\0${declaration.name}`;
    if (declarationIdentities.has(identity)) {
      diagnostics.push(
        diagnostic(
          "NTS2021",
          `/declarations/types/${typeId}`,
          `Source type ${declaration.module}::${declaration.name} is mapped more than once`,
        ),
      );
    }
    declarationIdentities.add(identity);
  }

  // Handle upcast targets are the only position that currently tolerates an
  // imported type, because they need no local structure: the upcast is
  // representation-preserving and composition proves the target is a handle
  // with matching thread-safety and identity. Every other position needs the
  // definition here, so an import in one is reported as such rather than as a
  // missing type.
  for (const [id, type] of Object.entries(manifest.types)) {
    const upcastTargets = new Set(
      type.kind === "handle" ? type.upcasts.map(({ target }) => target) : [],
    );
    for (const reference of typeReferences(type)) {
      if (manifest.types[reference] !== undefined) continue;
      if (upcastTargets.has(reference) && imported.has(reference)) continue;
      diagnostics.push(
        diagnostic(
          "NTS2010",
          `/types/${id}`,
          imported.has(reference)
            ? `Native type ${reference} is imported and may only be a handle upcast target`
            : `Native type ${reference} does not exist`,
        ),
      );
    }
  }

  for (const [id, binding] of Object.entries(manifest.bindings)) {
    if (binding.kind === "constant") {
      if (manifest.types[binding.type] === undefined) {
        diagnostics.push(
          diagnostic(
            "NTS2010",
            `/bindings/${id}/type`,
            imported.has(binding.type)
              ? `Native type ${binding.type} is imported and may only be a handle upcast target`
              : `Native type ${binding.type} does not exist`,
          ),
        );
      }
      continue;
    }

    const positions: readonly AbiResult[] = [
      ...binding.signature.parameters,
      binding.signature.result,
    ];
    for (const position of positions) {
      if (manifest.types[position.type] !== undefined) continue;
      /* An imported handle crosses a signature as the pointer it is. The
       * position rules need only its kind, and everything that needs the
       * definition is proven at composition. */
      if (imported.has(position.type)) {
        if (position.passMode !== "pointer") {
          diagnostics.push(
            diagnostic(
              "NTS2010",
              `/bindings/${id}/signature`,
              `Imported native type ${position.type} is a handle, so it can ` +
                "only cross by pointer",
            ),
          );
        }
        continue;
      }
      diagnostics.push(
        diagnostic(
          "NTS2010",
          `/bindings/${id}/signature`,
          `Native type ${position.type} does not exist`,
        ),
      );
    }
  }
}

function isPowerOfTwo(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && Number.isInteger(Math.log2(value));
}

function canonicalIntegerValue(
  value: string | number | boolean,
  type: IntegerType,
  pointerWidth: 32 | 64,
): string | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) return null;
  } else if (
    value.length > 20 ||
    !/^-?(?:0|[1-9][0-9]*)$/u.test(value) ||
    value === "-0"
  ) {
    return null;
  }

  const integer = BigInt(value);
  const bits = type.bits === "pointer" ? pointerWidth : type.bits;
  const minimum = type.signed ? -(1n << BigInt(bits - 1)) : 0n;
  const maximum = type.signed
    ? (1n << BigInt(bits - 1)) - 1n
    : (1n << BigInt(bits)) - 1n;
  return integer < minimum || integer > maximum ? null : integer.toString();
}

function typeSize(
  manifest: ScabiManifest,
  typeId: NativeTypeId,
  active = new Set<NativeTypeId>(),
): number | undefined {
  if (active.has(typeId)) {
    return undefined;
  }
  const type = manifest.types[typeId];
  if (type === undefined) {
    return undefined;
  }
  active.add(typeId);

  try {
    switch (type.kind) {
      case "void":
        return 0;
      case "integer":
        return type.bits === "pointer"
          ? manifest.target.pointerWidth / 8
          : type.bits / 8;
      case "float":
        return type.bits / 8;
      case "boolean":
        return typeSize(manifest, type.storage, active);
      case "enum":
      case "flags":
        return typeSize(manifest, type.underlying, active);
      case "pointer":
      case "handle":
      case "callback":
      case "platform-object":
        return manifest.target.pointerWidth / 8;
      case "array": {
        const elementSize = typeSize(manifest, type.element, active);
        return elementSize === undefined ? undefined : elementSize * type.length;
      }
      case "slice":
        return (
          (typeSize(manifest, type.pointerType, active) ?? 0) +
          (typeSize(manifest, type.lengthType, active) ?? 0)
        );
      case "struct":
      case "union":
      case "opaque-value":
        return type.size;
    }
  } finally {
    active.delete(typeId);
  }
}

function typeAlignment(
  manifest: ScabiManifest,
  typeId: NativeTypeId,
  active = new Set<NativeTypeId>(),
): number | undefined {
  if (active.has(typeId)) return undefined;
  const type = manifest.types[typeId];
  if (type === undefined) return undefined;
  active.add(typeId);
  try {
    switch (type.kind) {
      case "void":
        return undefined;
      case "integer":
        return type.bits === "pointer" ? manifest.target.pointerWidth / 8 : type.bits / 8;
      case "float":
        return type.bits / 8;
      case "boolean":
        return typeAlignment(manifest, type.storage, active);
      case "enum":
      case "flags":
        return typeAlignment(manifest, type.underlying, active);
      case "pointer":
      case "callback":
      case "handle":
      case "platform-object":
        return manifest.target.pointerWidth / 8;
      case "array":
        return typeAlignment(manifest, type.element, active);
      case "slice":
        return Math.max(
          typeAlignment(manifest, type.pointerType, active) ?? 0,
          typeAlignment(manifest, type.lengthType, active) ?? 0,
        ) || undefined;
      case "struct":
      case "union":
      case "opaque-value":
        return type.alignment;
    }
  } finally {
    active.delete(typeId);
  }
}

function validateLayout(
  id: string,
  layout: NativeLayout,
  diagnostics: ScabiDiagnostic[],
): void {
  if (!isPowerOfTwo(layout.alignment)) {
    diagnostics.push(
      diagnostic(
        "NTS2020",
        `/types/${id}/alignment`,
        "Alignment must be a power of two",
      ),
    );
  }
  if (
    !Number.isSafeInteger(layout.size) ||
    !Number.isSafeInteger(layout.alignment)
  ) {
    diagnostics.push(
      diagnostic(
        "NTS2020",
        `/types/${id}`,
        "Layout size and alignment must be safe integers",
      ),
    );
  }
  if (
    layout.packing !== "default" &&
    (!Number.isSafeInteger(layout.packing) || !isPowerOfTwo(layout.packing))
  ) {
    diagnostics.push(
      diagnostic(
        "NTS2020",
        `/types/${id}/packing`,
        "Explicit packing must be a power-of-two safe integer",
      ),
    );
  }
  if (layout.size > 0 && layout.size % layout.alignment !== 0) {
    diagnostics.push(
      diagnostic(
        "NTS2020",
        `/types/${id}/size`,
        "Aggregate size must include tail padding to its alignment",
      ),
    );
  }
  if (layout.abiPassing !== undefined) {
    const validatePhysicalType = (
      type: NativePhysicalAbiType,
      path: string,
      allowVoid: boolean,
      depth = 0,
    ): void => {
      if (depth > 16) {
        diagnostics.push(diagnostic("NTS2020", path, "Physical ABI type nesting exceeds 16 levels"));
        return;
      }
      if (type.kind === "void") {
        if (!allowVoid) diagnostics.push(diagnostic("NTS2020", path, "void is valid only as the physical result"));
        return;
      }
      if (type.kind === "integer") {
        if (!Number.isSafeInteger(type.bits) || type.bits < 1) {
          diagnostics.push(diagnostic("NTS2020", `${path}/bits`, "Integer ABI width must be a positive safe integer"));
        }
        return;
      }
      if (type.kind === "pointer") {
        if (!Number.isSafeInteger(type.addressSpace) || type.addressSpace < 0) {
          diagnostics.push(diagnostic("NTS2020", `${path}/addressSpace`, "Pointer address space must be a non-negative safe integer"));
        }
        return;
      }
      if (type.kind === "array" || type.kind === "vector") {
        if (!Number.isSafeInteger(type.count) || type.count < 1) {
          diagnostics.push(diagnostic("NTS2020", `${path}/count`, "ABI element count must be a positive safe integer"));
        }
        validatePhysicalType(type.element, `${path}/element`, false, depth + 1);
        return;
      }
      if (type.kind === "struct") {
        for (const [index, field] of type.fields.entries()) {
          validatePhysicalType(field, `${path}/fields/${index}`, false, depth + 1);
        }
      }
    };
    const validateValue = (
      value: NativePhysicalAbiValue,
      path: string,
      allowVoid: boolean,
    ): void => {
      validatePhysicalType(value.type, `${path}/type`, allowVoid);
      for (const [name, alignment] of [
        ["alignment", value.alignment],
        ["stackAlignment", value.stackAlignment],
      ] as const) {
        if (
          alignment !== null &&
          (!Number.isSafeInteger(alignment) || !isPowerOfTwo(alignment))
        ) {
          diagnostics.push(
            diagnostic("NTS2020", `${path}/${name}`, "ABI alignment must be a power-of-two safe integer or null"),
          );
        }
      }
      if (value.extension !== null && value.type.kind !== "integer") {
        diagnostics.push(diagnostic("NTS2020", `${path}/extension`, "ABI extension requires an integer physical type"));
      }
      if ((value.byValue || value.structureReturn) && value.type.kind !== "pointer") {
        diagnostics.push(diagnostic("NTS2020", path, "byValue and structureReturn require a physical pointer"));
      }
      if (value.byValue && value.structureReturn) {
        diagnostics.push(diagnostic("NTS2020", path, "A physical ABI value cannot be both byValue and structureReturn"));
      }
    };
    validateValue(layout.abiPassing.result, `/types/${id}/abiPassing/result`, true);
    for (const [index, parameter] of layout.abiPassing.parameters.entries()) {
      validateValue(parameter, `/types/${id}/abiPassing/parameters/${index}`, false);
    }
    const structureReturns = layout.abiPassing.parameters
      .map((parameter, index) => ({ parameter, index }))
      .filter(({ parameter }) => parameter.structureReturn);
    if (
      layout.abiPassing.result.type.kind === "void"
        ? structureReturns.length !== 1 || structureReturns[0]?.index !== 0
        : structureReturns.length !== 0
    ) {
      diagnostics.push(
        diagnostic(
          "NTS2020",
          `/types/${id}/abiPassing`,
          "A void aggregate result requires exactly one leading structureReturn parameter; a direct result forbids one",
        ),
      );
    }
    if (layout.abiPassing.result.byValue || layout.abiPassing.result.structureReturn) {
      diagnostics.push(
        diagnostic("NTS2020", `/types/${id}/abiPassing/result`, "Result attributes belong on physical parameters"),
      );
    }
    const sourceParameters = layout.abiPassing.parameters.slice(
      structureReturns.length === 1 ? 1 : 0,
    );
    if (sourceParameters.length === 0) {
      diagnostics.push(
        diagnostic("NTS2020", `/types/${id}/abiPassing/parameters`, "Aggregate identity classification requires an input representation"),
      );
    }
  }
}

function validateTypes(
  manifest: ScabiManifest,
  diagnostics: ScabiDiagnostic[],
): void {
  for (const [id, type] of Object.entries(manifest.types)) {
    switch (type.kind) {
      case "boolean": {
        const storage = manifest.types[type.storage];
        if (storage?.kind !== "integer") {
          diagnostics.push(
            diagnostic(
              "NTS2021",
              `/types/${id}/storage`,
              "Boolean storage must reference an integer type",
            ),
          );
          break;
        }
        const falseValue = canonicalIntegerValue(
          type.falseValue,
          storage,
          manifest.target.pointerWidth,
        );
        const trueValue = canonicalIntegerValue(
          type.trueValue,
          storage,
          manifest.target.pointerWidth,
        );
        if (falseValue === null) {
          diagnostics.push(diagnostic(
            "NTS2021",
            `/types/${id}/falseValue`,
            "Boolean falseValue must be a canonical integer representable by its storage type",
          ));
        }
        if (trueValue === null) {
          diagnostics.push(diagnostic(
            "NTS2021",
            `/types/${id}/trueValue`,
            "Boolean trueValue must be a canonical integer representable by its storage type",
          ));
        }
        if (falseValue !== null && falseValue === trueValue) {
          diagnostics.push(diagnostic(
            "NTS2021",
            `/types/${id}/trueValue`,
            "Boolean falseValue and trueValue must be distinct",
          ));
        }
        break;
      }
      case "enum":
      case "flags": {
        const underlying = manifest.types[type.underlying];
        if (underlying?.kind !== "integer") {
          diagnostics.push(
            diagnostic(
              "NTS2021",
              `/types/${id}/underlying`,
              `${type.kind} underlying type must be an integer`,
            ),
          );
          break;
        }
        for (const [member, value] of Object.entries(type.members).sort(
          ([left], [right]) => left < right ? -1 : left > right ? 1 : 0,
        )) {
          if (canonicalIntegerValue(value, underlying, manifest.target.pointerWidth) === null) {
            diagnostics.push(diagnostic(
              "NTS2021",
              `/types/${id}/members/${member}`,
              `${type.kind} member values must be canonical integers representable by the underlying type`,
            ));
          }
        }
        break;
      }
      case "slice": {
        const pointer = manifest.types[type.pointerType];
        const length = manifest.types[type.lengthType];
        if (pointer?.kind !== "pointer" || pointer.pointee !== type.element) {
          diagnostics.push(
            diagnostic(
              "NTS2021",
              `/types/${id}/pointerType`,
              "Slice pointer must point to its element type",
            ),
          );
        }
        if (length?.kind !== "integer" || length.signed) {
          diagnostics.push(
            diagnostic(
              "NTS2021",
              `/types/${id}/lengthType`,
              "Slice length must use an unsigned integer type",
            ),
          );
        }
        break;
      }
      case "struct":
      case "union": {
        validateLayout(id, type, diagnostics);
        const fieldNames = new Set<string>();
        const occupiedRanges: Array<{
          readonly start: number;
          readonly end: number;
        }> = [];
        for (const [index, field] of type.fields.entries()) {
          if (fieldNames.has(field.name)) {
            diagnostics.push(
              diagnostic(
                "NTS2020",
                `/types/${id}/fields/${index}/name`,
                `Duplicate field ${field.name}`,
              ),
            );
          }
          fieldNames.add(field.name);
          if (field.conversion !== undefined) {
            const fieldType = manifest.types[field.type];
            if (fieldType === undefined || !carriesNumber(fieldType)) {
              diagnostics.push(
                diagnostic(
                  "NTS2021",
                  `/types/${id}/fields/${index}/conversion`,
                  "A number conversion requires a 32- or 64-bit float field or an integer field of at most 32 bits; a double cannot carry wider integers injectively",
                ),
              );
            }
            /* A bit field's storage is not the integer type's storage, so the
             * exact read the widening starts from does not exist yet. */
            if (field.bitField !== undefined) {
              diagnostics.push(
                diagnostic(
                  "NTS2021",
                  `/types/${id}/fields/${index}/conversion`,
                  "A bit field cannot declare a number conversion",
                ),
              );
            }
          }
          const fieldSize = typeSize(manifest, field.type);
          const fieldAlignment = typeAlignment(manifest, field.type);
          const effectiveFieldAlignment = fieldAlignment === undefined
            ? undefined
            : type.packing === "default"
              ? fieldAlignment
              : Math.min(fieldAlignment, type.packing);
          if (
            !Number.isSafeInteger(field.offset) ||
            fieldSize === undefined ||
            effectiveFieldAlignment === undefined ||
            type.size === 0 ||
            field.offset + fieldSize > type.size ||
            field.offset % effectiveFieldAlignment !== 0
          ) {
            diagnostics.push(
              diagnostic(
                "NTS2020",
                `/types/${id}/fields/${index}/offset`,
                "Field storage must fit within the aggregate",
              ),
            );
          }
          if (type.kind === "union" && field.offset !== 0) {
            diagnostics.push(
              diagnostic(
                "NTS2020",
                `/types/${id}/fields/${index}/offset`,
                "Union fields must begin at offset zero",
              ),
            );
          }
          if (
            type.kind === "struct" &&
            field.bitField === undefined &&
            fieldSize !== undefined
          ) {
            const end = field.offset + fieldSize;
            if (
              occupiedRanges.some(
                (range) => field.offset < range.end && end > range.start,
              )
            ) {
              diagnostics.push(
                diagnostic(
                  "NTS2020",
                  `/types/${id}/fields/${index}/offset`,
                  "Struct fields cannot overlap",
                ),
              );
            }
            occupiedRanges.push({ start: field.offset, end });
          }
        }
        break;
      }
      case "opaque-value":
        validateLayout(id, type, diagnostics);
        break;
      case "callback":
        for (const [index, parameter] of type.signature.parameters.entries()) {
          validateConversion(
            manifest,
            parameter,
            `/types/${id}/signature/parameters/${index}`,
            diagnostics,
          );
        }
        /* A handler's return value crosses back into native code, where the
         * exact scalar is the contract; only the payload it receives has a
         * source-visible carrier to choose. */
        if (type.signature.result.conversion !== undefined) {
          diagnostics.push(
            diagnostic(
              "NTS2021",
              `/types/${id}/signature/result/conversion`,
              "A callback result carries its exact native representation",
            ),
          );
        }
        if (
          type.context.placement === "none" &&
          type.context.type !== undefined
        ) {
          diagnostics.push(
            diagnostic(
              "NTS2021",
              `/types/${id}/context/type`,
              "A callback without context placement cannot declare a context type",
            ),
          );
        }
        if (
          type.context.placement !== "none" &&
          type.context.type === undefined
        ) {
          diagnostics.push(
            diagnostic(
              "NTS2021",
              `/types/${id}/context/type`,
              "Callback context type is required when context has a placement",
            ),
          );
        }
        break;
      default:
        break;
    }
  }
}

function validateConstantBinding(
  manifest: ScabiManifest,
  id: NativeBindingId,
  binding: ConstantBinding,
  diagnostics: ScabiDiagnostic[],
): void {
  const path = `/bindings/${id}`;
  if (
    binding.dependencies.bindings.length > 0 ||
    binding.dependencies.linkInputs.length > 0 ||
    binding.dependencies.adapterInputs.length > 0 ||
    binding.dependencies.permissions.length > 0
  ) {
    diagnostics.push(diagnostic(
      "NTS2021",
      `${path}/dependencies`,
      "Compile-time constants cannot have runtime dependencies",
    ));
  }

  const type = manifest.types[binding.type];
  if (type === undefined) return;
  switch (type.kind) {
    case "integer": {
      if (
        canonicalIntegerValue(binding.value, type, manifest.target.pointerWidth) === null
      ) {
        diagnostics.push(diagnostic(
          "NTS2021",
          `${path}/value`,
          "Integer constant value must be canonical and representable by its declared type",
        ));
      }
      break;
    }
    case "enum":
    case "flags": {
      const underlying = manifest.types[type.underlying];
      if (underlying?.kind !== "integer") return;
      const value = canonicalIntegerValue(
        binding.value,
        underlying,
        manifest.target.pointerWidth,
      );
      if (value === null) {
        diagnostics.push(diagnostic(
          "NTS2021",
          `${path}/value`,
          `${type.kind} constant value must be canonical and representable by its underlying type`,
        ));
      } else if (!Object.values(type.members).includes(value)) {
        diagnostics.push(diagnostic(
          "NTS2021",
          `${path}/value`,
          `${type.kind} constant value must name one of its declared members`,
        ));
      }
      break;
    }
    case "boolean":
      if (typeof binding.value !== "boolean") {
        diagnostics.push(diagnostic(
          "NTS2021",
          `${path}/value`,
          "Boolean constant value must be a JSON boolean",
        ));
      }
      break;
    case "float":
      if (
        typeof binding.value !== "number" ||
        !Number.isFinite(binding.value) ||
        Object.is(binding.value, -0) ||
        (type.bits === 32 && Math.fround(binding.value) !== binding.value)
      ) {
        diagnostics.push(diagnostic(
          "NTS2021",
          `${path}/value`,
          `Float constant value must be a finite, canonical, exactly representable f${type.bits} JSON number`,
        ));
      }
      break;
    default:
      diagnostics.push(diagnostic(
        "NTS2021",
        `${path}/type`,
        "Compile-time constants require an integer, enum, flags, boolean, or float type",
      ));
      break;
  }
}

/**
 * Whether a binding is the destructor of one value type: it takes exactly that
 * value, takes ownership of it, and answers nothing. Anything else is an
 * ordinary ownership-consuming call, which is outside the destructor slice.
 */
function destructorConsumes(
  manifest: ScabiManifest,
  destructorId: NativeBindingId,
  valueTypeId: NativeTypeId,
): boolean {
  const destructor = manifest.bindings[destructorId];
  if (destructor === undefined || destructor.kind === "constant") return false;
  const [parameter] = destructor.signature.parameters;
  return destructor.signature.parameters.length === 1 &&
    parameter?.type === valueTypeId &&
    parameter.ownership.kind === "owned" &&
    parameter.ownership.transfer === "to-native" &&
    manifest.types[destructor.signature.result.type]?.kind === "void";
}

function ownershipBindings(
  ownership: OwnershipContract,
): readonly NativeBindingId[] {
  switch (ownership.kind) {
    case "owned":
      return ownership.transfer === "to-runtime" && ownership.destructor !== undefined
        ? [ownership.destructor]
        : [];
    case "retained":
      return [ownership.retain, ownership.release];
    case "weak":
      return [ownership.upgrade];
    case "autoreleased":
      return [ownership.retain];
    case "process-proxy":
      return [ownership.release];
    case "value":
    case "borrowed":
    case "call-scoped":
      return [];
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

function validatePositionOwnership(
  manifest: ScabiManifest,
  bindingId: string,
  dependencySet: ReadonlySet<string>,
  position: AbiResult,
  path: string,
  isResult: boolean,
  diagnostics: ScabiDiagnostic[],
): void {
  const type = referencedType(manifest, position.type);
  if (type === undefined) {
    return;
  }

  const resourceBearing =
    type.kind === "pointer" ||
    type.kind === "handle" ||
    type.kind === "callback" ||
    type.kind === "platform-object";
  if (resourceBearing && position.ownership.kind === "value") {
    diagnostics.push(
      diagnostic(
        "NTS2030",
        `${path}/ownership`,
        `${type.kind} positions require an explicit lifetime contract`,
      ),
    );
  }
  if (!resourceBearing && position.ownership.kind !== "value") {
    diagnostics.push(
      diagnostic(
        "NTS2030",
        `${path}/ownership`,
        `${type.kind} positions must use value ownership`,
      ),
    );
  }

  if (
    position.ownership.kind === "owned" &&
    ((isResult && position.ownership.transfer !== "to-runtime") ||
      (!isResult && position.ownership.transfer !== "to-native"))
  ) {
    diagnostics.push(
      diagnostic(
        "NTS2030",
        `${path}/ownership/transfer`,
        isResult
          ? "Owned results must transfer to the runtime"
          : "Owned parameters must transfer to native code",
      ),
    );
  }
  if (isResult && position.ownership.kind === "call-scoped") {
    diagnostics.push(
      diagnostic(
        "NTS2030",
        `${path}/ownership`,
        "A call-scoped value cannot be returned",
      ),
    );
  }

  const pointerLike =
    type.kind === "pointer" ||
    type.kind === "handle" ||
    type.kind === "callback" ||
    type.kind === "platform-object";
  if (!pointerLike && position.nullable) {
    diagnostics.push(
      diagnostic(
        "NTS2021",
        `${path}/nullable`,
        `${type.kind} positions cannot be nullable`,
      ),
    );
  }
  if (type.kind === "pointer" && position.nullable && !type.nullable) {
    diagnostics.push(
      diagnostic(
        "NTS2021",
        `${path}/nullable`,
        "A position cannot widen a non-null pointer type to nullable",
      ),
    );
  }

  const validPassMode =
    type.kind === "pointer" || type.kind === "callback"
      ? position.passMode === "pointer" || position.passMode === "reference"
      : type.kind === "handle"
        ? position.passMode === "pointer" ||
          position.passMode === "platform-object"
        : type.kind === "platform-object"
          ? position.passMode === "platform-object" ||
            position.passMode === "pointer"
          : type.kind === "struct" ||
              type.kind === "union" ||
              type.kind === "opaque-value" ||
              type.kind === "array" ||
              type.kind === "slice"
            ? position.passMode === "value" ||
              position.passMode === "reference" ||
              (isResult && position.passMode === "hidden-return")
            : position.passMode === "value";
  if (!validPassMode) {
    diagnostics.push(
      diagnostic(
        "NTS2021",
        `${path}/passMode`,
        `Pass mode ${position.passMode} is invalid for ${type.kind}`,
      ),
    );
  }

  /* Where the destructor is named. A handle names one on its type, because
   * how it is released follows the object rather than the call that produced
   * it, and an importer that never sees a definition still gets it that way.
   * Everything else owned names one here, because there the producer really
   * does decide: one `u8*` is freed by the allocator that made it and another
   * is not. */
  if (position.ownership.kind === "owned" && position.ownership.transfer === "to-runtime") {
    const named = position.ownership.destructor;
    if (type.kind === "handle") {
      if (named !== undefined) {
        diagnostics.push(diagnostic(
          "NTS2030",
          `${path}/ownership/destructor`,
          `An owned handle position does not name a destructor: the handle type ${position.type} names it`,
        ));
      } else if ("imported" in type) {
        /* An imported handle's destructor is the owning package's binding, so
         * it is neither declared here nor a dependency of this one: what has
         * to be present is the import's statement of which binding it is. */
        if (manifest.imports?.[position.type]?.destructor === undefined) {
          diagnostics.push(diagnostic(
            "NTS2030",
            `${path}/ownership`,
            `Owning the imported ${position.type} requires its import to name the owner's destructor`,
          ));
        }
      } else if (type.destructor === undefined) {
        diagnostics.push(diagnostic(
          "NTS2030",
          `${path}/ownership`,
          `Owning a ${position.type} requires that handle type to name its destructor`,
        ));
      } else {
        validateBindingReference(
          manifest,
          bindingId,
          dependencySet,
          type.destructor,
          `${path}/ownership`,
          diagnostics,
        );
      }
    } else if (named === undefined) {
      diagnostics.push(diagnostic(
        "NTS2030",
        `${path}/ownership`,
        `An owned ${type.kind} position must name the destructor that releases it`,
      ));
    }
  }
  for (const reference of ownershipBindings(position.ownership)) {
    validateBindingReference(
      manifest,
      bindingId,
      dependencySet,
      reference,
      `${path}/ownership`,
      diagnostics,
    );
  }
}

/* A JavaScript-number carrier is only honest where a double holds every value
 * of the native type injectively and nothing else already reinterprets the
 * position. Everything wider than 32 bits, and every position that is a
 * pointer, a resource, or a marshalled buffer, keeps its own representation. */
/** The native types a JavaScript number can carry, and what the crossing
 * means for each. A 64-bit float is the identity — the slot IS the double.
 * The integer widths up to 32 bits are the ones a double holds injectively,
 * so reading is lossless and writing is checked. A 32-bit float reads
 * losslessly and writes by rounding to nearest float, which is the one lossy
 * crossing in the family and the only thing a 32-bit slot can mean; the slot
 * type is what declares it, since no other carrier would be more honest. */
/**
 * Whether a double holds every value of this type, so the crossing cannot
 * fail in either direction.
 *
 * True for both floats and for integers of at most 32 bits. A `size_t` or an
 * `int64_t` has values no double denotes, so it carries a number only where a
 * failing read is acceptable — see `carriesCheckedNumber`.
 */
function carriesNumber(type: ReferencedType): boolean {
  if (type.kind === "float") return type.bits === 32 || type.bits === 64;
  return type.kind === "integer" &&
    (type.bits === 8 || type.bits === 16 || type.bits === 32);
}

/**
 * Whether a position of this type may carry a number at all.
 *
 * A 64-bit or pointer-width integer qualifies: writing one is checked like
 * any other width, because a double that is integral and in range converts
 * exactly however wide the slot is, and reading one is checked too, because
 * the value may be one no double denotes. That second check is why a struct
 * field is not allowed to declare the conversion — a field read has no place
 * to fail — while a parameter or a result is.
 */
function carriesCheckedNumber(type: ReferencedType): boolean {
  return carriesNumber(type) ||
    (type.kind === "integer" && (type.bits === 64 || type.bits === "pointer"));
}

function validateConversion(
  manifest: ScabiManifest,
  position: AbiResult,
  path: string,
  diagnostics: ScabiDiagnostic[],
): void {
  if (position.conversion === undefined) {
    return;
  }
  const type = referencedType(manifest, position.type);
  if (type === undefined) {
    return;
  }
  if (!carriesCheckedNumber(type)) {
    diagnostics.push(
      diagnostic(
        "NTS2021",
        `${path}/conversion`,
        "A number conversion requires a float or an integer; a pointer, handle, or aggregate has no number to carry",
      ),
    );
    return;
  }
  if (
    position.passMode !== "value" ||
    position.ownership.kind !== "value" ||
    position.nullable
  ) {
    diagnostics.push(
      diagnostic(
        "NTS2021",
        `${path}/conversion`,
        "A number conversion requires a non-nullable integer passed by value",
      ),
    );
  }
  if (position.marshal !== undefined) {
    diagnostics.push(
      diagnostic(
        "NTS2021",
        `${path}/conversion`,
        "A marshalled position already declares its own source representation",
      ),
    );
  }
}

function validateMarshalling(
  manifest: ScabiManifest,
  bindingId: string,
  binding: CallableBinding,
  parameter: AbiParameter,
  index: number,
  diagnostics: ScabiDiagnostic[],
): void {
  if (parameter.marshal === undefined) {
    return;
  }
  const parameterType = manifest.types[parameter.type];
  if (parameterType?.kind !== "pointer") {
    diagnostics.push(
      diagnostic(
        "NTS2021",
        `/bindings/${bindingId}/signature/parameters/${index}/marshal`,
        "String and byte marshalling require a pointer ABI parameter",
      ),
    );
  }
  const length = parameter.marshal.length;
  if (length.kind === "nul") {
    if (
      parameter.marshal.kind !== "string" ||
      parameter.marshal.termination !== "nul" ||
      parameter.marshal.embeddedNul !== "reject"
    ) {
      diagnostics.push(
        diagnostic(
          "NTS2021",
          `/bindings/${bindingId}/signature/parameters/${index}/marshal`,
          "NUL-length strings require NUL termination and embedded-NUL rejection",
        ),
      );
    }
    return;
  }
  const lengthName = length.parameter;
  const lengthParameter = binding.signature.parameters.find(
    ({ name }) => name === lengthName,
  );
  const lengthType =
    lengthParameter === undefined
      ? undefined
      : manifest.types[lengthParameter.type];
  if (lengthType?.kind !== "integer" || lengthType.signed) {
    diagnostics.push(
      diagnostic(
        "NTS2021",
        `/bindings/${bindingId}/signature/parameters/${index}/marshal/length`,
        `Length parameter ${lengthName} must use an unsigned integer type`,
      ),
    );
  }
}

function callbackIsForeign(contract: CallbackContract): boolean {
  return contract.allowedInvocationExecutors.some(
    ({ kind }) => kind === "any-attached-thread",
  );
}

function validateCallback(
  manifest: ScabiManifest,
  bindingId: string,
  binding: CallableBinding,
  parameter: AbiParameter,
  index: number,
  dependencySet: ReadonlySet<string>,
  callbackType: CallbackType,
  diagnostics: ScabiDiagnostic[],
): void {
  const contract = parameter.callback;
  const path = `/bindings/${bindingId}/signature/parameters/${index}/callback`;
  if (contract === undefined) {
    diagnostics.push(
      diagnostic(
        "NTS2040",
        path,
        "Callback positions require a callback contract",
      ),
    );
    return;
  }

  if (
    contract.lifetime === "until-cancelled" &&
    contract.cancellationBinding === undefined
  ) {
    diagnostics.push(
      diagnostic(
        "NTS2040",
        `${path}/cancellationBinding`,
        "until-cancelled callbacks require a cancellation binding",
      ),
    );
  }
  if (
    contract.lifetime === "until-cancelled" &&
    contract.cancellationBinding !== undefined
  ) {
    const cancellation = manifest.bindings[contract.cancellationBinding];
    const cancellationParameter = cancellation?.kind === "constant"
      ? undefined
      : cancellation?.signature.parameters[0];
    const cancellationResult = cancellation?.kind === "constant"
      ? undefined
      : cancellation?.signature.result;
    const cancellationOwnership = cancellationParameter?.ownership;
    const validCancellationOwnership =
      cancellationOwnership?.kind === "owned" ||
      (cancellationOwnership?.kind === "borrowed" &&
        cancellationOwnership.scope === "call");
    if (
      cancellation !== undefined &&
      (cancellation.kind === "constant" ||
        cancellation.signature.parameters.length !== 1 ||
        cancellationParameter?.type !== binding.signature.result.type ||
        cancellationParameter.passMode !== "pointer" ||
        !validCancellationOwnership ||
        cancellationResult?.type !== "void" ||
        cancellationResult.passMode !== "value" ||
        cancellationResult.ownership.kind !== "value")
    ) {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          `${path}/cancellationBinding`,
          `Cancellation binding ${contract.cancellationBinding} must consume or borrow one matching result handle and return void`,
        ),
      );
    }
  }
  if (contract.lifetime === "call") {
    if (contract.registrationOwner !== "native-call") {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          `${path}/registrationOwner`,
          "Call-scoped callbacks must be owned by the native call",
        ),
      );
    }
  } else if (contract.registrationOwner !== "result") {
    const ownerIndex = binding.signature.parameters.findIndex(
      ({ name }) => name === contract.registrationOwner,
    );
    const owner = binding.signature.parameters[ownerIndex];
    if (
      binding.kind !== "method" ||
      ownerIndex !== 0 ||
      owner === undefined ||
      referencedType(manifest, owner.type)?.kind !== "handle" ||
      owner.passMode !== "pointer" ||
      owner.nullable ||
      owner.ownership.kind !== "borrowed" ||
      owner.ownership.scope !== "call"
    ) {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          `${path}/registrationOwner`,
          `Registration owner ${contract.registrationOwner} must name the borrowed non-null handle receiver`,
        ),
      );
    }
    if (
      parameter.ownership.kind !== "borrowed" ||
      parameter.ownership.scope !== "registration" ||
      parameter.ownership.anchor !== contract.registrationOwner
    ) {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          `/bindings/${bindingId}/signature/parameters/${index}/ownership`,
          "A receiver-owned callback must be registration-borrowed from that receiver",
        ),
      );
    }
  }
  const resultType = manifest.types[callbackType.signature.result.type];
  if (contract.synchronousReturn) {
    /* An answer has to exist before the call that asks for it returns, so
     * the handler runs on the calling executor. The registration may be
     * call-scoped or until-cancelled — a toolkit signal is registered once
     * and asked many times — but never foreign: answering means reading a
     * closure, and a foreign producer may never read one. */
    if (
      (contract.lifetime !== "call" && contract.lifetime !== "until-cancelled") ||
      callbackIsForeign(contract) ||
      contract.deliveryExecutor.kind !== "same-as-caller"
    ) {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          `${path}/synchronousReturn`,
          "Synchronous callback returns require call or until-cancelled lifetime on the calling executor",
        ),
      );
    }
    if (
      contract.lifetime === "until-cancelled" &&
      contract.arguments.some(({ transport }) => transport !== "borrow")
    ) {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          `${path}/synchronousReturn`,
          "A synchronously answered registration borrows its payloads: nothing outlives the call that asks",
        ),
      );
    }
  } else if (resultType?.kind !== "void") {
    diagnostics.push(
      diagnostic(
        "NTS2040",
        `${path}/synchronousReturn`,
        "A callback without a synchronous return must have a void ABI result",
      ),
    );
  }
  if (
    (contract.lifetime === "call") !==
    (parameter.ownership.kind === "call-scoped")
  ) {
    diagnostics.push(
      diagnostic(
        "NTS2040",
        `${path}/lifetime`,
        "Call lifetime and call-scoped ownership must be declared together",
      ),
    );
  }
  if (contract.cancellationBinding !== undefined) {
    validateBindingReference(
      manifest,
      bindingId,
      dependencySet,
      contract.cancellationBinding,
      `${path}/cancellationBinding`,
      diagnostics,
    );
  }

  if (contract.contextParameter !== undefined) {
    const context = binding.signature.parameters.find(
      ({ name }) => name === contract.contextParameter,
    );
    if (context === undefined) {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          `${path}/contextParameter`,
          `Context parameter ${contract.contextParameter} does not exist`,
        ),
      );
    } else if (
      callbackType.context.type !== undefined &&
      context.type !== callbackType.context.type
    ) {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          `${path}/contextParameter`,
          "Context parameter type does not match the callback ABI",
        ),
      );
    }
  } else if (callbackType.context.placement !== "none") {
    diagnostics.push(
      diagnostic(
        "NTS2040",
        `${path}/contextParameter`,
        "The callback ABI requires a context parameter",
      ),
    );
  }

  const callbackParameters = new Set(
    callbackType.signature.parameters.map(({ name }) => name),
  );
  const declaredArguments = new Set<string>();
  for (const [argumentIndex, argument] of contract.arguments.entries()) {
    if (!callbackParameters.has(argument.parameter)) {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          `${path}/arguments/${argumentIndex}/parameter`,
          `Callback parameter ${argument.parameter} does not exist`,
        ),
      );
    }
    if (declaredArguments.has(argument.parameter)) {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          `${path}/arguments/${argumentIndex}/parameter`,
          `Callback parameter ${argument.parameter} is declared twice`,
        ),
      );
    }
    declaredArguments.add(argument.parameter);
  }
  for (const name of callbackParameters) {
    if (!declaredArguments.has(name)) {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          `${path}/arguments`,
          `Callback parameter ${name} has no transport contract`,
        ),
      );
    }
  }

  const sourceArguments = contract.sourceArguments ??
    callbackType.signature.parameters.map(({ name }) => ({
      kind: "callback-parameter" as const,
      parameter: name,
    }));
  const projectedParameters = new Set<string>();
  let registrationOwnerCount = 0;
  for (const [argumentIndex, argument] of sourceArguments.entries()) {
    const argumentPath = `${path}/sourceArguments/${argumentIndex}`;
    const candidate = argument as unknown as Record<string, unknown>;
    if (
      candidate["kind"] === "callback-parameter" &&
      Object.keys(candidate).sort().join(",") === "kind,parameter" &&
      typeof candidate["parameter"] === "string"
    ) {
      const parameter = candidate["parameter"];
      if (!callbackParameters.has(parameter)) {
        diagnostics.push(
          diagnostic(
            "NTS2040",
            `${argumentPath}/parameter`,
            `Callback parameter ${parameter} does not exist`,
          ),
        );
      }
      if (projectedParameters.has(parameter)) {
        diagnostics.push(
          diagnostic(
            "NTS2040",
            `${argumentPath}/parameter`,
            `Callback parameter ${parameter} is projected twice`,
          ),
        );
      }
      projectedParameters.add(parameter);
      continue;
    }
    if (
      candidate["kind"] !== "registration-owner" ||
      Object.keys(candidate).join(",") !== "kind"
    ) {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          argumentPath,
          "Callback source arguments must project one callback parameter or the registration owner",
        ),
      );
      continue;
    }
    registrationOwnerCount++;
    if (
      registrationOwnerCount > 1 ||
      contract.lifetime === "call" ||
      contract.registrationOwner === "result"
    ) {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          argumentPath,
          "A managed registration-owner argument requires one receiver-owned callback",
        ),
      );
    }
  }
  for (const name of callbackParameters) {
    if (!projectedParameters.has(name)) {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          `${path}/sourceArguments`,
          `Callback parameter ${name} has no source projection`,
        ),
      );
    }
  }

  if (callbackIsForeign(contract)) {
    if (contract.synchronousReturn || resultType?.kind !== "void") {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          path,
          "Foreign-thread callbacks must have a void ABI return and cannot return synchronously",
        ),
      );
    }
    if (contract.arguments.some(({ transport }) => transport === "borrow")) {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          `${path}/arguments`,
          "Foreign-thread callback arguments cannot be borrowed",
        ),
      );
    }
    if (registrationOwnerCount !== 0) {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          `${path}/sourceArguments`,
          "Foreign-thread callbacks cannot inject a managed registration owner",
        ),
      );
    }
    if (contract.deliveryExecutor.kind !== "runtime-owner") {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          `${path}/deliveryExecutor`,
          "Foreign-thread callbacks must enter through the runtime owner",
        ),
      );
    }
  }
}

function validateCallableBinding(
  manifest: ScabiManifest,
  id: string,
  binding: CallableBinding,
  diagnostics: ScabiDiagnostic[],
): void {
  const dependencies = new Set(binding.dependencies.bindings);
  if (binding.error.kind === "error-handle") {
    // The two entries are ordinary bindings, so they are reachability
    // dependencies like a destructor rather than free-floating symbols.
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
    if (binding.error.message === binding.error.release) {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          `/bindings/${id}/error`,
          "An error handle's message and release bindings must be distinct",
        ),
      );
    }
  }
  const parameterNames = new Set<string>();
  for (const [index, parameter] of binding.signature.parameters.entries()) {
    if (parameterNames.has(parameter.name)) {
      diagnostics.push(
        diagnostic(
          "NTS2021",
          `/bindings/${id}/signature/parameters/${index}/name`,
          `Duplicate parameter ${parameter.name}`,
        ),
      );
    }
    parameterNames.add(parameter.name);
    validatePositionOwnership(
      manifest,
      id,
      dependencies,
      parameter,
      `/bindings/${id}/signature/parameters/${index}`,
      false,
      diagnostics,
    );
    validateMarshalling(manifest, id, binding, parameter, index, diagnostics);
    validateConversion(
      manifest,
      parameter,
      `/bindings/${id}/signature/parameters/${index}`,
      diagnostics,
    );

    const type = manifest.types[parameter.type];
    if (type?.kind === "callback") {
      validateCallback(
        manifest,
        id,
        binding,
        parameter,
        index,
        dependencies,
        type,
        diagnostics,
      );
    } else if (parameter.callback !== undefined) {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          `/bindings/${id}/signature/parameters/${index}/callback`,
          "Callback contracts may appear only on callback types",
        ),
      );
    }
  }

  validatePositionOwnership(
    manifest,
    id,
    dependencies,
    binding.signature.result,
    `/bindings/${id}/signature/result`,
    true,
    diagnostics,
  );

  validateConversion(
    manifest,
    binding.signature.result,
    `/bindings/${id}/signature/result`,
    diagnostics,
  );
  if (
    binding.signature.result.conversion !== undefined &&
    binding.error.kind !== "no-fail"
  ) {
    diagnostics.push(
      diagnostic(
        "NTS2040",
        `/bindings/${id}/signature/result/conversion`,
        "A number-converted result requires a non-failing binding: a failure contract is read from the exact scalar the source never sees",
      ),
    );
  }

  const resultOwnership = binding.signature.result.ownership;
  if (
    resultOwnership.kind === "owned" &&
    resultOwnership.transfer === "to-runtime" &&
    resultOwnership.destructor !== undefined
  ) {
    if (
      !destructorConsumes(
        manifest,
        resultOwnership.destructor,
        binding.signature.result.type,
      )
    ) {
      diagnostics.push(
        diagnostic(
          "NTS2030",
          `/bindings/${id}/signature/result/ownership/destructor`,
          `Destructor ${resultOwnership.destructor} must consume one matching value and return void`,
        ),
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
  validateTypeReferences(manifest, diagnostics);
  validateHandleUpcasts(manifest, diagnostics);
  validateTypes(manifest, diagnostics);
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
