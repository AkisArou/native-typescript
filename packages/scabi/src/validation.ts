import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import schema from "./scabi-v1.schema.json" with { type: "json" };
import { canonicalizeJson } from "./canonical-json.ts";
import type {
  AbiParameter,
  AbiResult,
  CallbackContract,
  CallbackType,
  CallableBinding,
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

function validateHandleUpcasts(
  manifest: ScabiManifest,
  diagnostics: ScabiDiagnostic[],
): void {
  for (const [id, type] of Object.entries(manifest.types)) {
    if (type.kind !== "handle") continue;
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
  const declarationIdentities = new Set<string>();
  for (const [typeId, declaration] of Object.entries(
    manifest.declarations.types,
  )) {
    if (manifest.types[typeId] === undefined) {
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

  for (const [id, type] of Object.entries(manifest.types)) {
    for (const reference of typeReferences(type)) {
      if (manifest.types[reference] === undefined) {
        diagnostics.push(
          diagnostic(
            "NTS2010",
            `/types/${id}`,
            `Native type ${reference} does not exist`,
          ),
        );
      }
    }
  }

  for (const [id, binding] of Object.entries(manifest.bindings)) {
    if (binding.kind === "constant") {
      if (manifest.types[binding.type] === undefined) {
        diagnostics.push(
          diagnostic(
            "NTS2010",
            `/bindings/${id}/type`,
            `Native type ${binding.type} does not exist`,
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
      if (manifest.types[position.type] === undefined) {
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
}

function isPowerOfTwo(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && Number.isInteger(Math.log2(value));
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

function ownershipBindings(
  ownership: OwnershipContract,
): readonly NativeBindingId[] {
  switch (ownership.kind) {
    case "owned":
      return ownership.transfer === "to-runtime" ? [ownership.destructor] : [];
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
  const type = manifest.types[position.type];
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
      manifest.types[owner.type]?.kind !== "handle" ||
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
    if (
      contract.lifetime !== "call" ||
      callbackIsForeign(contract) ||
      contract.deliveryExecutor.kind !== "same-as-caller"
    ) {
      diagnostics.push(
        diagnostic(
          "NTS2040",
          `${path}/synchronousReturn`,
          "Synchronous callback returns require call lifetime on the calling executor",
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

  const resultOwnership = binding.signature.result.ownership;
  if (
    resultOwnership.kind === "owned" &&
    resultOwnership.transfer === "to-runtime"
  ) {
    const destructor = manifest.bindings[resultOwnership.destructor];
    const [parameter] =
      destructor === undefined || destructor.kind === "constant"
        ? []
        : destructor.signature.parameters;
    const resultType =
      destructor === undefined || destructor.kind === "constant"
        ? undefined
        : manifest.types[destructor.signature.result.type];
    if (
      destructor === undefined ||
      destructor.kind === "constant" ||
      destructor.signature.parameters.length !== 1 ||
      parameter?.type !== binding.signature.result.type ||
      parameter.ownership.kind !== "owned" ||
      parameter.ownership.transfer !== "to-native" ||
      resultType?.kind !== "void"
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
  validateTypeReferences(manifest, diagnostics);
  validateHandleUpcasts(manifest, diagnostics);
  validateTypes(manifest, diagnostics);
  validateUniqueInputIds(manifest, diagnostics);
  validateDependencies(manifest, diagnostics);
  for (const [id, binding] of Object.entries(manifest.bindings)) {
    if (binding.kind !== "constant") {
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
