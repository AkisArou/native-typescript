import { createHash } from "node:crypto";
import {
  CBindgenError,
  digestClangAbiEvidence,
  renderCFunctionPointerType,
  renderCType,
} from "@native-typescript/bindgen-c";
import type {
  CBindgenDiagnostic,
  ClangAbiEvidenceSnapshot,
  ClangAbiType,
  ClangAbiValue,
} from "@native-typescript/bindgen-c";
import {
  canonicalizeJson,
  digestScabiManifest,
  parseScabiManifest,
} from "@native-typescript/scabi";
import type {
  AbiParameter,
  AbiResult,
  BindingAvailability,
  CallableBinding,
  LinkInput,
  NativeBinding,
  NativePhysicalAbiType,
  NativePhysicalAbiValue,
  NativeType,
  PackageIdentity,
  ScabiManifest,
  Sha256Digest,
  TargetIdentity,
} from "@native-typescript/scabi";
import {
  generateGirClangAbiProbe,
  reachedForeignTypeNames,
} from "./gir-clang.ts";
import type {
  GirCallable,
  GirClass,
  GirEnumeration,
  GirParameter,
  GirSnapshot,
} from "./gir-model.ts";
import {
  borrowedResultClass,
  generateGObjectAdapterSource,
} from "./gobject-adapter.ts";
import type { GObjectAdapterSource } from "./gobject-adapter.ts";

/**
 * Another namespace's generated package, made available so this package can
 * project a class whose parent lives there.
 *
 * The whole snapshot is supplied rather than a précis of it, so imported type
 * identities are derived by the same function that produced them in the owning
 * package. An import table assembled by hand could disagree; this cannot.
 *
 * Supplying a namespace is opt-in. An external parent with no matching entry
 * stays the deliberate edge of the generated surface, which is how
 * `Gtk.Widget` roots its hierarchy despite extending `GObject.InitiallyUnowned`.
 */
export interface GObjectImportedNamespace {
  readonly snapshot: GirSnapshot;
  readonly package: PackageIdentity;
}

export interface GObjectScabiGenerationOptions {
  readonly snapshot: GirSnapshot;
  readonly evidence: ClangAbiEvidenceSnapshot;
  readonly gobjectAdapter: GObjectAdapterSource;
  readonly importedNamespaces?: readonly GObjectImportedNamespace[];
  readonly package: PackageIdentity;
  readonly target: TargetIdentity;
  readonly sdk: {
    readonly vendor: string;
    readonly name: string;
    readonly version: string;
    readonly deploymentTarget: string;
    readonly modules: readonly string[];
  };
  readonly linkInputs: readonly LinkInput[];
  readonly adapterInput: {
    readonly id: string;
    readonly output: string;
  };
}

export interface GObjectScabiPackage {
  readonly schema: "native-typescript.gobject-scabi-package";
  readonly schemaVersion: 1;
  readonly declarations: string;
  readonly declarationsDigest: Sha256Digest;
  readonly manifest: ScabiManifest;
  readonly manifestSource: string;
  readonly manifestDigest: Sha256Digest;
}

import {
  sourceScalarType,
  sourceScalarTypes,
} from "./gobject-scalars.ts";

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function sha256(value: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function diagnostic(path: string, message: string): CBindgenDiagnostic {
  return Object.freeze({ code: "NTS5001", severity: "error", path, message });
}

function upperCamel(value: string): string {
  return value
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

function lowerCamel(value: string): string {
  const upper = upperCamel(value);
  return `${upper[0]?.toLowerCase() ?? ""}${upper.slice(1)}`;
}

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[-\s]+/gu, "_")
    .toLowerCase();
}

function physicalAbiType(type: ClangAbiType): NativePhysicalAbiType {
  switch (type.kind) {
    case "array":
      return Object.freeze({ ...type, element: physicalAbiType(type.element) });
    case "vector":
      return Object.freeze({ ...type, element: physicalAbiType(type.element) });
    case "struct":
      return Object.freeze({ ...type, fields: Object.freeze(type.fields.map(physicalAbiType)) });
    case "named":
      return Object.freeze({ kind: "aggregate" });
    default:
      return Object.freeze({ ...type });
  }
}

function physicalAbiValue(value: ClangAbiValue): NativePhysicalAbiValue {
  return Object.freeze({
    type: physicalAbiType(value.type),
    alignment: value.alignment,
    stackAlignment: value.stackAlignment,
    extension: value.extension,
    inRegister: value.inRegister,
    byValue: value.byValue !== null,
    structureReturn: value.structureReturn !== null,
  });
}

function handleTypeId(namespace: string, class_: GirClass): string {
  return `${namespace.toLowerCase()}_${class_.cSymbolPrefix}`;
}

/**
 * C spellings GIR uses for a borrowed UTF-8 string.
 *
 * GLib declares `gchar` as a typedef for `char`, and namespaces are not
 * consistent about which they write: Gtk spells `const char*` while Gio spells
 * `const gchar*` for the same parameter. A metadata C spelling is an untrusted
 * candidate either way — the Clang probe proves the real type against the
 * headers — so accepting both here narrows nothing.
 */
const borrowedUtf8CTypes: ReadonlySet<string> = new Set([
  "const char*",
  "const gchar*",
]);

/**
 * Spellings a signal payload may use on top of the const ones.
 *
 * GIR writes an emitted string as `gchar*` even though the handler must not
 * write to it. The unqualified spelling is admitted only here, where the
 * generated code is the callee: a `char*` method parameter can be an output
 * buffer, and treating that as borrowed input would let the callee write
 * through a pointer the caller believes it owns.
 */
const emittedUtf8CTypes: ReadonlySet<string> = new Set([
  ...borrowedUtf8CTypes,
  "char*",
  "gchar*",
]);

/**
 * Why a callable cannot become a direct native binding, or null when it can.
 *
 * The three causes are reported apart because they mean different things to
 * whoever selected the member: one is metadata that cannot be bound at all,
 * one is a known missing contract, and one is an explicit instruction to skip.
 */
function directEntryRefusal(callable: GirCallable): string | null {
  if (callable.cIdentifier === null) return "has no C identifier";
  if (callable.throws) {
    return "reports failure through GError, which is not an implemented error contract";
  }
  if (callable.result.skip) return "has a result marked skip";
  return null;
}

function enumerationTypeId(namespace: string, name: string): string {
  return `${namespace.toLowerCase()}_${snakeCase(name)}`;
}

interface EnumerationProjection {
  /** The spelling a GIR type reference uses, qualified when foreign. */
  readonly girName: string;
  /** The spelling the declaration file uses, aliased when foreign. */
  readonly sourceName: string;
  readonly cType: string;
  readonly typeId: string;
  readonly enumeration: GirEnumeration;
  readonly namespace: string;
  /** Absent for an enumeration this package owns. */
  readonly owner: PackageIdentity | undefined;
}

function handleBrand(className: string): string {
  return `nativeResource${upperCamel(className)}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedText(values: readonly string[]): readonly string[] {
  return Object.freeze([...values].sort(compareText));
}

function constructorProjection(
  className: string,
  callableName: string,
): {
  readonly declaration: string;
  readonly kind: "constructor" | "factory";
  readonly member: string;
} {
  if (callableName === "new") {
    return Object.freeze({ declaration: className, kind: "constructor", member: "constructor" });
  }
  const member = lowerCamel(
    callableName.startsWith("new_") ? callableName.slice(4) : callableName,
  );
  return Object.freeze({
    declaration: `${className}.${member}`,
    kind: "factory",
    member,
  });
}

function availability(
  class_: GirClass,
  callable: GirCallable,
): BindingAvailability | undefined {
  const version = callable.version ?? class_.version;
  return version === null
    ? undefined
    : Object.freeze({
        minimumPlatformVersion: version,
        unavailableFeatures: Object.freeze([]),
      });
}

/**
 * The JSDoc lines that carry a member's deprecation to whoever calls it.
 *
 * A deprecated member still binds: its ABI is a fact like any other, and an
 * application migrating off one has to be able to call it meanwhile. What it
 * must not do is bind silently, because then the only place the deprecation
 * exists is a header the caller never reads. TypeScript renders `@deprecated`
 * as a strikethrough at the call site, so this is the notice arriving where
 * the decision is made.
 */
function deprecationDoc(
  callable: { readonly deprecated: boolean; readonly deprecatedVersion: string | null },
  indent: string,
): readonly string[] {
  if (!callable.deprecated) return [];
  const since = callable.deprecatedVersion === null
    ? ""
    : ` since version ${callable.deprecatedVersion}`;
  return [`${indent}/** @deprecated Deprecated by the library${since}. */`];
}

function dependencies(input: {
  readonly bindings?: readonly string[];
  readonly links: readonly string[];
  readonly adapter?: string;
}) {
  return Object.freeze({
    bindings: Object.freeze([...(input.bindings ?? [])]),
    linkInputs: Object.freeze([...input.links]),
    adapterInputs: Object.freeze(input.adapter === undefined ? [] : [input.adapter]),
    permissions: Object.freeze([]),
  });
}

function validateInputs(
  options: GObjectScabiGenerationOptions,
  diagnostics: CBindgenDiagnostic[],
): void {
  // Regenerated with the same imported namespaces, so the verification probe
  // covers the identical candidate set the evidence was produced from.
  const probe = generateGirClangAbiProbe(
    options.snapshot,
    options.gobjectAdapter,
    (options.importedNamespaces ?? []).map(({ snapshot }) => snapshot),
  );
  if (
    options.evidence.schema !== "native-typescript.clang-abi-evidence" ||
    options.evidence.schemaVersion !== 3
  ) {
    diagnostics.push(
      diagnostic("evidence/schemaVersion", "Unsupported Clang ABI evidence schema"),
    );
  }
  if (options.evidence.probeDigest !== probe.sourceDigest) {
    diagnostics.push(
      diagnostic(
        "evidence/probeDigest",
        "Clang evidence does not belong to the selected GIR ABI probe",
      ),
    );
  }
  if (options.evidence.clang.target !== options.target.triple) {
    diagnostics.push(
      diagnostic(
        "evidence/clang/target",
        "Clang evidence target does not match the SCABI target triple",
      ),
    );
  }
  if (
    !digestPattern.test(options.evidence.semanticDigest) ||
    digestClangAbiEvidence(options.evidence) !== options.evidence.semanticDigest
  ) {
    diagnostics.push(
      diagnostic("evidence/semanticDigest", "Clang semantic evidence digest is invalid"),
    );
  }
  if (options.evidence.functions.length !== probe.functions.length) {
    diagnostics.push(
      diagnostic("evidence/functions", "Clang evidence has the wrong selected function count"),
    );
  }
  if (options.evidence.records.length !== probe.records.length) {
    diagnostics.push(
      diagnostic("evidence/records", "Clang evidence has the wrong selected record count"),
    );
  }
  if (options.evidence.enums.length !== probe.enums.length) {
    diagnostics.push(
      diagnostic("evidence/enums", "Clang evidence has the wrong selected enum count"),
    );
  }
  for (const [enumIndex, enum_] of probe.enums.entries()) {
    const enumEvidence = options.evidence.enums[enumIndex];
    if (
      enumEvidence?.id !== enum_.id ||
      enumEvidence.typeName !== enum_.typeName ||
      enumEvidence.members.length !== enum_.members.length
    ) {
      diagnostics.push(diagnostic(
        `evidence/enums/${enumIndex}`,
        `Clang evidence does not match selected enum '${enum_.id}'`,
      ));
      continue;
    }
    for (const [memberIndex, member] of enum_.members.entries()) {
      const memberEvidence = enumEvidence.members[memberIndex];
      if (
        memberEvidence?.name !== member.name ||
        memberEvidence.cIdentifier !== member.cIdentifier ||
        memberEvidence.value !== member.value
      ) {
        diagnostics.push(diagnostic(
          `evidence/enums/${enumIndex}/members/${memberIndex}`,
          `Clang evidence does not match selected enum member '${enum_.id}.${member.name}'`,
        ));
      }
    }
  }
  for (const [recordIndex, record] of probe.records.entries()) {
    const recordEvidence = options.evidence.records[recordIndex];
    if (
      recordEvidence?.id !== record.id ||
      recordEvidence.typeName !== record.typeName ||
      recordEvidence.fields.length !== record.fields.length
    ) {
      diagnostics.push(
        diagnostic(
          `evidence/records/${recordIndex}`,
          `Clang evidence does not match selected record '${record.id}'`,
        ),
      );
      continue;
    }
    for (const [fieldIndex, field] of record.fields.entries()) {
      const fieldEvidence = recordEvidence.fields[fieldIndex];
      if (
        fieldEvidence?.name !== field.name ||
        fieldEvidence.expectedType !== renderCType(field.type)
      ) {
        diagnostics.push(
          diagnostic(
            `evidence/records/${recordIndex}/fields/${fieldIndex}`,
            `Clang evidence does not match selected field '${record.id}.${field.name}'`,
          ),
        );
      }
    }
  }
  for (const [index, function_] of probe.functions.entries()) {
    const evidence = options.evidence.functions[index];
    if (
      evidence?.id !== function_.id ||
      evidence.symbol !== function_.symbol ||
      evidence.expectedType !== renderCFunctionPointerType(function_, "")
    ) {
      diagnostics.push(
        diagnostic(
          `evidence/functions/${index}`,
          `Clang evidence does not match selected function '${function_.id}'`,
        ),
      );
    }
  }
  if (
    !digestPattern.test(options.gobjectAdapter.sourceDigest) ||
    sha256(options.gobjectAdapter.source) !== options.gobjectAdapter.sourceDigest
  ) {
    diagnostics.push(
      diagnostic("gobjectAdapter/sourceDigest", "GObject adapter source digest is invalid"),
    );
  }
  const expectedAdapter = generateGObjectAdapterSource(options.snapshot);
  if (
    options.gobjectAdapter.schema !== expectedAdapter.schema ||
    options.gobjectAdapter.schemaVersion !== expectedAdapter.schemaVersion ||
    options.gobjectAdapter.source !== expectedAdapter.source ||
    canonicalizeJson(options.gobjectAdapter.constructors) !==
      canonicalizeJson(expectedAdapter.constructors) ||
    canonicalizeJson(options.gobjectAdapter.signalConnection) !==
      canonicalizeJson(expectedAdapter.signalConnection) ||
    canonicalizeJson(options.gobjectAdapter.signals) !==
      canonicalizeJson(expectedAdapter.signals) ||
    canonicalizeJson(options.gobjectAdapter.valueMethods) !==
      canonicalizeJson(expectedAdapter.valueMethods)
  ) {
    diagnostics.push(
      diagnostic(
        "gobjectAdapter",
        "GObject adapter does not belong to the selected GIR snapshot",
      ),
    );
  }
  for (const module of options.snapshot.packages) {
    if (!options.sdk.modules.includes(module)) {
      diagnostics.push(
        diagnostic("sdk/modules", `SDK modules do not include GIR package '${module}'`),
      );
    }
  }
}

function cStringParameter(
  parameter: GirParameter,
  typeId: string,
  path: string,
  diagnostics: CBindgenDiagnostic[],
  spellings: ReadonlySet<string> = borrowedUtf8CTypes,
): AbiParameter | null {
  if (
    parameter.kind !== "parameter" ||
    parameter.type.kind !== "named" ||
    parameter.type.name !== "utf8" ||
    parameter.type.cType === null ||
    !spellings.has(parameter.type.cType) ||
    parameter.direction !== "in" ||
    parameter.transferOwnership !== "none" ||
    parameter.optional ||
    parameter.callerAllocates ||
    parameter.skip ||
    parameter.scope !== null ||
    parameter.closureParameter !== null ||
    parameter.destroyParameter !== null
  ) {
    diagnostics.push(
      diagnostic(path, "Only required borrowed const UTF-8 input is implemented"),
    );
    return null;
  }
  return Object.freeze({
    name: parameter.name,
    type: typeId,
    passMode: "pointer",
    nullable: parameter.nullable,
    ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
    marshal: Object.freeze({
      kind: "string",
      encoding: "utf-8",
      length: Object.freeze({ kind: "nul" }),
      termination: "nul",
      embeddedNul: "reject",
    }),
  });
}

function requiredValueParameter(
  parameter: GirParameter,
  type: {
    readonly girName: string;
    readonly cTypes: readonly string[];
    readonly abiType: string;
    /**
     * GIR spells an enumeration signal payload with no c:type of its own — the
     * spelling is on the enumeration's declaration. Set only there: a
     * primitive payload does carry one, and accepting its absence would let an
     * unspelled parameter through on a guess.
     */
    readonly cTypeOnDeclaration?: boolean;
  },
  path: string,
  diagnostics: CBindgenDiagnostic[],
): AbiParameter | null {
  if (
    parameter.kind !== "parameter" ||
    parameter.type.kind !== "named" ||
    parameter.type.name !== type.girName ||
    (parameter.type.cType === null
      ? type.cTypeOnDeclaration !== true
      : !type.cTypes.includes(parameter.type.cType)) ||
    parameter.direction !== "in" ||
    parameter.transferOwnership !== "none" ||
    parameter.nullable ||
    parameter.optional ||
    parameter.callerAllocates ||
    parameter.skip ||
    parameter.scope !== null ||
    parameter.closureParameter !== null ||
    parameter.destroyParameter !== null
  ) {
    diagnostics.push(
      diagnostic(path, `Only required non-null ${type.girName} input is implemented`),
    );
    return null;
  }
  return Object.freeze({
    name: parameter.name,
    type: type.abiType,
    passMode: "value",
    nullable: false,
    ownership: Object.freeze({ kind: "value" }),
  });
}

function handleParameter(
  parameter: GirParameter,
  classByName: ReadonlyMap<string, GirClass>,
  typeIdByClass: ReadonlyMap<string, string>,
  path: string,
  diagnostics: CBindgenDiagnostic[],
): { readonly abi: AbiParameter; readonly sourceType: string } | null {
  const className = parameter.type.kind === "named" ? parameter.type.name : null;
  const class_ = className === null ? undefined : classByName.get(className);
  const typeId = className === null ? undefined : typeIdByClass.get(className);
  if (class_ === undefined || typeId === undefined) {
    /* This is the last projection attempted, so anything that reaches it and
     * is not a selected class is simply outside the implemented slice. Saying
     * "handle inputs are implemented" of a guint sends the reader looking for
     * a class that was never involved. */
    diagnostics.push(diagnostic(
      path,
      className === null
        ? "Parameter type is outside the implemented slice"
        : `Parameter type '${className}' is outside the implemented slice: ` +
          "exact scalars, booleans, enumerations, borrowed UTF-8, and " +
          "selected GObject classes project; nothing else does yet",
    ));
    return null;
  }
  if (
    parameter.kind !== "parameter" ||
    parameter.type.kind !== "named" ||
    parameter.type.cType !== `${class_.cType}*` ||
    parameter.direction !== "in" ||
    parameter.transferOwnership !== "none" ||
    parameter.optional ||
    parameter.callerAllocates ||
    parameter.skip ||
    parameter.scope !== null ||
    parameter.closureParameter !== null ||
    parameter.destroyParameter !== null
  ) {
    diagnostics.push(
      diagnostic(path, "Only selected borrowed GObject handle inputs are implemented"),
    );
    return null;
  }
  return Object.freeze({
    abi: Object.freeze({
      name: parameter.name,
      type: typeId,
      passMode: "pointer",
      // Native IR supports an optional handle input, but a derived handle
      // does not upcast through a nullable union, and GTK passes derived
      // widgets constantly — `overlay.setChild(drawingArea)`. Until union
      // re-tagging consults identity upcasts, this projects the non-null
      // subset rather than an API that rejects ordinary calls.
      nullable: false,
      ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
    }),
    sourceType: class_.name,
  });
}

function methodResult(
  callable: GirCallable,
  receiverName: string,
  nullableUtf8Type: string,
  enumerations: ReadonlyMap<string, EnumerationProjection>,
  diagnostics: CBindgenDiagnostic[],
  path: string,
): AbiResult | null {
  const result = callable.result;
  if (result.type.kind === "named" && result.type.cType === "void") {
    if (
      result.transferOwnership !== "none" ||
      result.nullable ||
      result.scope !== null ||
      result.closureParameter !== null ||
      result.destroyParameter !== null
    ) {
      diagnostics.push(diagnostic(path, "Void results must be non-null value results"));
      return null;
    }
    return Object.freeze({
      type: "void",
      passMode: "value",
      nullable: false,
      ownership: Object.freeze({ kind: "value" }),
    });
  }
  if (
    result.type.kind === "named" &&
    result.type.name === "gboolean" &&
    result.type.cType === "gboolean" &&
    result.transferOwnership === "none" &&
    !result.nullable &&
    result.scope === null &&
    result.closureParameter === null &&
    result.destroyParameter === null
  ) {
    return Object.freeze({
      type: "gboolean",
      passMode: "value",
      nullable: false,
      ownership: Object.freeze({ kind: "value" }),
    });
  }
  const scalarType = sourceScalarType(result.type);
  if (
    scalarType !== undefined &&
    result.transferOwnership === "none" &&
    !result.nullable &&
    result.scope === null &&
    result.closureParameter === null &&
    result.destroyParameter === null
  ) {
    return Object.freeze({
      type: scalarType.abiType,
      passMode: "value",
      nullable: false,
      ownership: Object.freeze({ kind: "value" }),
    });
  }
  const enumeration = result.type.kind === "named"
    ? enumerations.get(result.type.name)
    : undefined;
  if (
    enumeration !== undefined &&
    result.type.cType === enumeration.cType &&
    result.transferOwnership === "none" &&
    !result.nullable &&
    result.scope === null &&
    result.closureParameter === null &&
    result.destroyParameter === null
  ) {
    return Object.freeze({
      type: enumeration.typeId,
      passMode: "value",
      nullable: false,
      ownership: Object.freeze({ kind: "value" }),
    });
  }
  if (
    result.type.kind === "named" &&
    result.type.name === "utf8" &&
    result.type.cType !== null &&
    borrowedUtf8CTypes.has(result.type.cType) &&
    result.transferOwnership === "none" &&
    result.scope === null &&
    result.closureParameter === null &&
    result.destroyParameter === null
  ) {
    return Object.freeze({
      type: nullableUtf8Type,
      passMode: "pointer",
      nullable: result.nullable,
      ownership: Object.freeze({
        kind: "borrowed",
        scope: "receiver",
        anchor: receiverName,
      }),
      marshal: Object.freeze({
        kind: "string",
        encoding: "utf-8",
        length: Object.freeze({ kind: "nul" }),
        termination: "nul",
        embeddedNul: "reject",
      }),
    });
  }
  diagnostics.push(diagnostic(
    path,
    "Method result is outside the void/boolean/exact-scalar/borrowed-UTF-8 slice",
  ));
  return null;
}

function isExactInstanceReceiver(
  parameter: GirParameter | undefined,
  class_: GirClass,
): parameter is GirParameter {
  return parameter?.kind === "instance" &&
    parameter.type.kind === "named" &&
    parameter.type.cType === `${class_.cType}*` &&
    parameter.direction === "in" &&
    parameter.transferOwnership === "none" &&
    !parameter.nullable &&
    !parameter.optional &&
    !parameter.callerAllocates &&
    !parameter.skip &&
    parameter.scope === null &&
    parameter.closureParameter === null &&
    parameter.destroyParameter === null;
}

function callableBase(input: {
  readonly declaration: string;
  readonly kind: CallableBinding["kind"];
  readonly entryKind: CallableBinding["entry"]["kind"];
  readonly symbol: string;
  readonly parameters: readonly AbiParameter[];
  readonly result: AbiResult;
  readonly dependencies: CallableBinding["dependencies"];
  readonly availability?: BindingAvailability;
  readonly error?: CallableBinding["error"];
}): CallableBinding {
  return Object.freeze({
    kind: input.kind,
    declaration: Object.freeze({ module: ".", name: input.declaration }),
    entry: Object.freeze({ kind: input.entryKind, symbol: input.symbol }),
    signature: Object.freeze({
      callingConvention: "c",
      variadic: false,
      parameters: Object.freeze([...input.parameters]),
      result: input.result,
    }),
    thread: Object.freeze({
      executor: Object.freeze({ kind: "runtime-owner" }),
      behavior: "require",
      blocking: false,
    }),
    error: input.error ?? Object.freeze({ kind: "no-fail" }),
    dependencies: input.dependencies,
    ...(input.availability === undefined ? {} : { availability: input.availability }),
  });
}

export function generateGObjectScabiPackage(
  options: GObjectScabiGenerationOptions,
): GObjectScabiPackage {
  const diagnostics: CBindgenDiagnostic[] = [];
  validateInputs(options, diagnostics);
  const types: Record<string, NativeType> = {
    const_utf8: Object.freeze({
      kind: "pointer",
      pointee: "i8",
      mutability: "const",
      nullable: false,
      addressSpace: 0,
    }),
    gdouble: Object.freeze({ kind: "float", bits: 64 }),
    i8: Object.freeze({ kind: "integer", signed: true, bits: 8 }),
    gint: Object.freeze({ kind: "integer", signed: true, bits: 32 }),
    gboolean: Object.freeze({
      kind: "boolean",
      storage: "gint",
      falseValue: "0",
      trueValue: "1",
    }),
    nullable_const_utf8: Object.freeze({
      kind: "pointer",
      pointee: "i8",
      mutability: "const",
      nullable: true,
      addressSpace: 0,
    }),
    void: Object.freeze({ kind: "void" }),
  };
  const bindings: Record<string, NativeBinding> = {};
  // `module` is "." for a type this package defines and the owning package's
  // name for an imported one.
  const declarationTypes: Record<
    string,
    { readonly module: string; readonly name: string }
  > = {};
  const usedSourceScalars = sourceScalarTypes.filter((scalar) =>
    options.snapshot.classes.some((class_) =>
      class_.constructors.some((constructor) =>
        constructor.parameters.some((parameter) =>
          sourceScalarType(parameter.type)?.abiType === scalar.abiType
        )
      ) || class_.methods.some((method) =>
        sourceScalarType(method.result.type)?.abiType === scalar.abiType ||
        method.parameters.some((parameter) =>
          sourceScalarType(parameter.type)?.abiType === scalar.abiType
        )
      ) ||
      class_.signals.some((signal) =>
        signal.parameters.some((parameter) =>
          sourceScalarType(parameter.type)?.abiType === scalar.abiType
        )
      )
    ) || options.snapshot.records.some((record) =>
      record.fields.some((field) => sourceScalarType(field.type)?.abiType === scalar.abiType)
    )
  );
  for (const scalar of usedSourceScalars) {
    declarationTypes[scalar.abiType] = Object.freeze({
      module: ".",
      name: scalar.girName,
    });
    /* gint and gdouble are always defined above: gboolean's storage names gint
     * whether or not a member uses one. Every other scalar enters the manifest
     * only where something reached it. */
    types[scalar.abiType] ??= scalar.nativeType;
  }
  // Classes reachable in another package, keyed by their qualified GIR name.
  // Type identities use handleTypeId(), the same derivation the owning
  // package's generation used, so the two agree by construction.
  const importedClasses = new Map<string, {
    readonly typeId: string;
    readonly package: PackageIdentity;
    readonly name: string;
    readonly alias: string;
  }>();
  for (const imported of options.importedNamespaces ?? []) {
    const namespace = imported.snapshot.namespace.name;
    if (namespace === options.snapshot.namespace.name) {
      diagnostics.push(diagnostic(
        namespace,
        "An imported namespace cannot be the namespace being generated",
      ));
      continue;
    }
    for (const class_ of imported.snapshot.classes) {
      importedClasses.set(`${namespace}.${class_.name}`, Object.freeze({
        typeId: handleTypeId(namespace, class_),
        package: imported.package,
        name: class_.name,
        alias: `${namespace}${class_.name}`,
      }));
    }
  }
  const typeImports: Record<string, {
    readonly package: PackageIdentity;
    readonly type: string;
  }> = {};
  const importedDeclarationLines: string[] = [];

  const classByName = new Map(options.snapshot.classes.map((class_) => [class_.name, class_]));
  const typeIdByClass = new Map(options.snapshot.classes.map((class_) => [
    class_.name,
    handleTypeId(options.snapshot.namespace.name, class_),
  ]));
  /**
   * Resolves a class's cross-namespace parent to an imported type, recording
   * the manifest import and the declaration-file import the first time it is
   * reached. Returns undefined when the parent's namespace was not supplied,
   * which leaves the hierarchy deliberately rooted here.
   */
  function resolveImportedParent(
    class_: GirClass,
    path: string,
  ): { readonly typeId: string; readonly alias: string } | undefined {
    if (class_.parent?.kind !== "external") return undefined;
    const key = `${class_.parent.namespace}.${class_.parent.name}`;
    const imported = importedClasses.get(key);
    if (imported === undefined) return undefined;
    if (classByName.has(imported.alias) || declarations.has(imported.alias)) {
      diagnostics.push(diagnostic(
        path,
        `Imported class ${key} aliases as ${imported.alias}, which collides with a generated declaration`,
      ));
      return undefined;
    }
    if (typeImports[imported.typeId] === undefined) {
      typeImports[imported.typeId] = Object.freeze({
        package: imported.package,
        type: imported.typeId,
      });
      declarationTypes[imported.typeId] = Object.freeze({
        module: imported.package.name,
        name: imported.name,
      });
      importedDeclarationLines.push(
        `import type { ${imported.name} as ${imported.alias} } from "${imported.package.name}";`,
      );
    }
    return Object.freeze({ typeId: imported.typeId, alias: imported.alias });
  }

  /**
   * Every enumeration this package projects, keyed by the GIR name a type
   * reference uses. A same-namespace reference is bare (`Orientation`) and a
   * cross-namespace one is qualified (`Gio.ApplicationFlags`), so one map
   * keyed that way resolves both without a second lookup path.
   *
   * `sourceName` is what the declaration file writes, which differs from the
   * GIR name for a foreign enumeration because it is imported under a
   * namespace-qualified alias.
   */
  const enumerations = new Map<string, EnumerationProjection>();
  for (const enum_ of options.snapshot.enumerations) {
    const projection = Object.freeze({
      girName: enum_.name,
      sourceName: enum_.name,
      cType: enum_.cType,
      typeId: enumerationTypeId(options.snapshot.namespace.name, enum_.name),
      enumeration: enum_,
      namespace: options.snapshot.namespace.name,
      owner: undefined,
    });
    enumerations.set(enum_.name, projection);
    // GIR normally spells a same-namespace reference bare, but a
    // self-qualified spelling names the same declaration and resolves here
    // rather than being mistaken for another namespace's type.
    enumerations.set(`${options.snapshot.namespace.name}.${enum_.name}`, {
      ...projection,
      girName: `${options.snapshot.namespace.name}.${enum_.name}`,
    });
  }
  // An enumeration another namespace owns joins the same lookup under its
  // qualified GIR name. Only reached ones are projected, matching the probe
  // exactly, so evidence and declarations cover the same set.
  const reachedForeign = reachedForeignTypeNames(options.snapshot);
  const foreignEnumerations: EnumerationProjection[] = [];
  for (const imported of options.importedNamespaces ?? []) {
    const namespace = imported.snapshot.namespace.name;
    for (const enum_ of imported.snapshot.enumerations) {
      const girName = `${namespace}.${enum_.name}`;
      if (!reachedForeign.has(girName)) continue;
      const projection = Object.freeze({
        girName,
        sourceName: `${namespace}${enum_.name}`,
        cType: enum_.cType,
        typeId: enumerationTypeId(namespace, enum_.name),
        enumeration: enum_,
        namespace,
        owner: imported.package,
      });
      enumerations.set(girName, projection);
      foreignEnumerations.push(projection);
    }
  }

  const hasSignals = options.snapshot.classes.some((class_) => class_.signals.length > 0);
  const namespacePrefix = options.snapshot.namespace.name.toLowerCase();
  const releaseByClass = new Map(
    options.gobjectAdapter.classReleases.map((release) => [
      release.className,
      release,
    ]),
  );
  const adapterByRetainedResult = new Map(
    options.gobjectAdapter.retainedResultMethods.map((method) => [
      method.id,
      method,
    ]),
  );
  const adapterByThrowingMethod = new Map(
    options.gobjectAdapter.throwingMethods.map((method) => [method.id, method]),
  );
  // One opaque error type and one accessor pair per namespace, emitted only
  // when a selected member reports failure through a GError. They are bindings
  // so they carry provenance, but they are never callable from TypeScript.
  const errorObjectTypeId = `${namespacePrefix}_error_object`;
  const errorMessageBindingId = `${namespacePrefix}_error_message`;
  const errorReleaseBindingId = `${namespacePrefix}_error_free`;
  const signalConnectionTypeId = `${namespacePrefix}_signal_connection`;
  const signalDisconnectId = `${namespacePrefix}_signal_connection_disconnect`;
  const signalConnectedId = `${namespacePrefix}_signal_connection_connected`;
  const signalReleaseId = `${namespacePrefix}_signal_connection_release`;
  const signalDisconnectDeclaration = "SignalConnection.disconnect";
  const signalConnectedDeclaration = "SignalConnection.connected";
  const signalReleaseDeclaration = "SignalConnection.__release";
  const declarations = new Set<string>();
  const hasExactSourceTypes = usedSourceScalars.length > 0 ||
    options.snapshot.enumerations.length > 0;
  const declarationLines = [
    ...(hasExactSourceTypes
      ? ["declare const nativeScalar: unique symbol;"]
      : []),
    ...options.snapshot.classes.map((class_) =>
      `declare const ${handleBrand(class_.name)}: unique symbol;`
    ),
    ...(hasSignals ? ["declare const nativeResourceSignalConnection: unique symbol;"] : []),
    "",
    ...(usedSourceScalars.length > 0
      ? [
          ...usedSourceScalars.map((scalar) =>
            `export type ${scalar.girName} = ${scalar.carrier} & { readonly [nativeScalar]: "${scalar.girName}" };`
          ),
          "",
        ]
      : []),
  ];
  const adapterBindings: string[] = [];
  const orderedLinkInputs = [...options.linkInputs].sort(
    (left, right) => left.order - right.order || compareText(left.id, right.id),
  );
  const linkIds = orderedLinkInputs.map(({ id }) => id);
  const adapterByConstructor = new Map(
    options.gobjectAdapter.constructors.map((constructor) => [constructor.id, constructor]),
  );
  const adapterBySignal = new Map(
    options.gobjectAdapter.signals.map((signal) => [signal.id, signal]),
  );
  const adapterByValueMethod = new Map(
    options.gobjectAdapter.valueMethods.map((method) => [method.id, method]),
  );
  const typeIdByRecord = new Map<string, string>();
  /* A scalar's SCABI identity is its own abiType, so a scalar output resolves
   * without the record table. Every scalar a method reaches is already
   * registered above, out-parameters included. */
  const scalarAbiTypeByGirName = new Map(
    sourceScalarTypes.map((scalar) => [scalar.girName, scalar.abiType]),
  );
  // The probe carries candidates from more than this snapshot once a foreign
  // enum is reached, so evidence is matched by probe identity. Matching by
  // array position silently pairs a type with another type's layout.
  const enumEvidenceById = new Map(
    options.evidence.enums.map((entry) => [entry.id, entry]),
  );
  const recordEvidenceById = new Map(
    options.evidence.records.map((entry) => [entry.id, entry]),
  );
  for (const enum_ of options.snapshot.enumerations) {
    const path = `${options.snapshot.namespace.name}/${enum_.kind}/${enum_.name}`;
    const evidence = enumEvidenceById.get(
      `${options.snapshot.namespace.name}.${enum_.name}.${enum_.kind}`,
    );
    const typeId = enumerationTypeId(options.snapshot.namespace.name, enum_.name);
    const storageId = `${typeId}_storage`;
    const bits = evidence === undefined ? 0 : evidence.size * 8;
    if (
      evidence === undefined ||
      (bits !== 8 && bits !== 16 && bits !== 32 && bits !== 64)
    ) {
      diagnostics.push(diagnostic(
        path,
        evidence === undefined
          ? "Selected enumeration lacks Clang ABI evidence"
          : `Selected enumeration has unsupported ${bits}-bit C storage`,
      ));
      continue;
    }
    if (
      types[typeId] !== undefined ||
      types[storageId] !== undefined ||
      declarationTypes[typeId] !== undefined
    ) {
      diagnostics.push(diagnostic(path, "Generated enumeration identity collides"));
      continue;
    }
    const members: Record<string, string> = {};
    const memberLines: string[] = [];
    let valid = true;
    for (const member of enum_.members) {
      const memberName = upperCamel(member.name);
      const declaration = `${enum_.name}.${memberName}`;
      const bindingId = `${namespacePrefix}_${snakeCase(enum_.name)}_${snakeCase(member.name)}`;
      if (
        !identifierPattern.test(memberName) ||
        declarations.has(declaration) ||
        bindings[bindingId] !== undefined ||
        members[memberName] !== undefined
      ) {
        diagnostics.push(diagnostic(
          `${path}/member/${member.name}`,
          "Generated enumeration member identity collides",
        ));
        valid = false;
        continue;
      }
      members[memberName] = member.value;
      declarations.add(declaration);
      const version = member.version ?? enum_.version;
      bindings[bindingId] = Object.freeze({
        kind: "constant",
        declaration: Object.freeze({ module: ".", name: declaration }),
        type: typeId,
        value: member.value,
        dependencies: dependencies({ links: [] }),
        ...(version === null
          ? {}
          : {
              availability: Object.freeze({
                minimumPlatformVersion: version,
                unavailableFeatures: Object.freeze([]),
              }),
            }),
      });
      memberLines.push(`  const ${memberName}: ${enum_.name};`);
    }
    if (!valid) continue;
    types[storageId] = Object.freeze({
      kind: "integer",
      signed: evidence.signed,
      bits,
    });
    types[typeId] = Object.freeze({
      kind: enum_.kind === "bitfield" ? "flags" : "enum",
      underlying: storageId,
      members: Object.freeze(members),
    });
    declarationTypes[typeId] = Object.freeze({ module: ".", name: enum_.name });
    declarationLines.push(
      `export type ${enum_.name} = number & { readonly [nativeScalar]: "${enum_.name}" };`,
      `export declare namespace ${enum_.name} {`,
      ...memberLines,
      ...(enum_.kind === "bitfield"
        ? [`  function combine(first: ${enum_.name}, ...rest: readonly ${enum_.name}[]): ${enum_.name};`]
        : []),
      "}",
      "",
    );
  }
  // A foreign enumeration is defined here for its ABI and declared as the
  // owning package's for its identity. Its representation is a bare scalar
  // with no cross-package identity, so nothing needs importing at the SCABI
  // type level; only the TypeScript name is foreign. Member constants belong
  // to the owning package and are not re-emitted.
  for (const projection of foreignEnumerations) {
    const enum_ = projection.enumeration;
    const path = `${projection.girName}`;
    const evidence = enumEvidenceById.get(
      `${projection.namespace}.${enum_.name}.${enum_.kind}`,
    );
    const storageId = `${projection.typeId}_storage`;
    const bits = evidence === undefined ? 0 : evidence.size * 8;
    if (
      evidence === undefined ||
      (bits !== 8 && bits !== 16 && bits !== 32 && bits !== 64)
    ) {
      diagnostics.push(diagnostic(
        path,
        evidence === undefined
          ? "Reached foreign enumeration lacks Clang ABI evidence"
          : `Reached foreign enumeration has unsupported ${bits}-bit C storage`,
      ));
      continue;
    }
    if (
      types[projection.typeId] !== undefined ||
      types[storageId] !== undefined ||
      declarationTypes[projection.typeId] !== undefined ||
      enumerations.get(projection.sourceName) !== undefined ||
      classByName.has(projection.sourceName)
    ) {
      diagnostics.push(diagnostic(
        path,
        `Imported enumeration aliases as ${projection.sourceName}, which collides with a generated declaration`,
      ));
      continue;
    }
    const members: Record<string, string> = {};
    for (const member of enum_.members) {
      members[upperCamel(member.name)] = member.value;
    }
    types[storageId] = Object.freeze({
      kind: "integer",
      signed: evidence.signed,
      bits,
    });
    types[projection.typeId] = Object.freeze({
      kind: enum_.kind === "bitfield" ? "flags" : "enum",
      underlying: storageId,
      members: Object.freeze(members),
    });
    declarationTypes[projection.typeId] = Object.freeze({
      module: projection.owner!.name,
      name: enum_.name,
    });
    importedDeclarationLines.push(
      `import type { ${enum_.name} as ${projection.sourceName} } from "${projection.owner!.name}";`,
    );
  }

  for (const record of options.snapshot.records) {
    const path = `${options.snapshot.namespace.name}/${record.name}`;
    const evidence = recordEvidenceById.get(
      `${options.snapshot.namespace.name}.${record.name}.record`,
    );
    const typeId = `${namespacePrefix}_${record.cSymbolPrefix ?? snakeCase(record.name)}`;
    const fields = record.fields.map((field, fieldIndex) => {
      const scalar = sourceScalarType(field.type);
      if (scalar === undefined) {
        diagnostics.push(diagnostic(
          `${path}/fields/${fieldIndex}`,
          "Selected record field is outside the exact scalar projection",
        ));
        return null;
      }
      const fieldEvidence = evidence?.fields[fieldIndex];
      if (fieldEvidence === undefined) return null;
      return Object.freeze({
        name: field.name,
        type: scalar.abiType,
        offset: fieldEvidence.offset,
      });
    });
    if (
      evidence === undefined ||
      fields.some((field) => field === null) ||
      types[typeId] !== undefined ||
      declarationTypes[typeId] !== undefined
    ) {
      if (evidence !== undefined && fields.every((field) => field !== null)) {
        diagnostics.push(diagnostic(path, "Generated record identity collides"));
      }
      continue;
    }
    types[typeId] = Object.freeze({
      kind: "struct",
      size: evidence.size,
      alignment: evidence.alignment,
      packing: "default",
      triviallyCopyable: true,
      destruction: "trivial",
      abiPassing: Object.freeze({
        result: physicalAbiValue(evidence.callingConvention.result),
        parameters: Object.freeze(
          evidence.callingConvention.parameters.map(physicalAbiValue),
        ),
      }),
      fields: Object.freeze(fields.filter((field) => field !== null)),
    });
    declarationTypes[typeId] = Object.freeze({ module: ".", name: record.name });
    typeIdByRecord.set(record.name, typeId);
    declarationLines.push(
      `export interface ${record.name} {`,
      ...record.fields.map((field) => {
        const scalar = sourceScalarType(field.type);
        return `  readonly ${lowerCamel(field.name)}: ${scalar?.girName ?? "never"};`;
      }),
      "}",
      "",
    );
  }
  for (const method of options.gobjectAdapter.valueMethods) {
    const path = `${options.snapshot.namespace.name}/${method.className}/method/${method.sourceSymbol}/result`;
    const evidenceId = `${options.snapshot.namespace.name}.${method.id}.result`;
    const evidence = options.evidence.records.find((record) => record.id === evidenceId);
    const typeId = `${namespacePrefix}_${snakeCase(method.resultName)}`;
    const fields = method.outputs.map((output, index) => {
      const fieldEvidence = evidence?.fields[index];
      const fieldType = output.kind === "record"
        ? typeIdByRecord.get(output.sourceName)
        : scalarAbiTypeByGirName.get(output.sourceName);
      if (fieldEvidence === undefined || fieldType === undefined) {
        diagnostics.push(diagnostic(
          `${path}/fields/${index}`,
          "Value-return adapter output lacks selected record ABI evidence",
        ));
        return null;
      }
      return Object.freeze({
        name: output.fieldName,
        type: fieldType,
        offset: fieldEvidence.offset,
      });
    });
    if (
      evidence === undefined ||
      fields.some((field) => field === null) ||
      types[typeId] !== undefined ||
      declarationTypes[typeId] !== undefined
    ) {
      if (evidence !== undefined && fields.every((field) => field !== null)) {
        diagnostics.push(diagnostic(path, "Generated value-return record identity collides"));
      }
      continue;
    }
    types[typeId] = Object.freeze({
      kind: "struct",
      size: evidence.size,
      alignment: evidence.alignment,
      packing: "default",
      triviallyCopyable: true,
      destruction: "trivial",
      abiPassing: Object.freeze({
        result: physicalAbiValue(evidence.callingConvention.result),
        parameters: Object.freeze(
          evidence.callingConvention.parameters.map(physicalAbiValue),
        ),
      }),
      fields: Object.freeze(fields.filter((field) => field !== null)),
    });
    declarationTypes[typeId] = Object.freeze({ module: ".", name: method.resultName });
    declarationLines.push(
      `export interface ${method.resultName} {`,
      ...method.outputs.map((output) =>
        `  readonly ${output.fieldName}: ${output.sourceName};`
      ),
      "}",
      "",
    );
  }
  let signalConnectionReady = !hasSignals;
  if (hasSignals) {
    const connection = options.gobjectAdapter.signalConnection;
    const path = `${options.snapshot.namespace.name}/SignalConnection`;
    if (connection === null) {
      diagnostics.push(diagnostic(path, "GObject signal connection adapter is missing"));
    } else if (
      types[signalConnectionTypeId] !== undefined ||
      declarationTypes[signalConnectionTypeId] !== undefined ||
      bindings[signalDisconnectId] !== undefined ||
      bindings[signalConnectedId] !== undefined ||
      bindings[signalReleaseId] !== undefined ||
      declarations.has(signalDisconnectDeclaration) ||
      declarations.has(signalConnectedDeclaration) ||
      declarations.has(signalReleaseDeclaration)
    ) {
      diagnostics.push(diagnostic(path, "Generated signal connection identity collides"));
    } else {
      types[signalConnectionTypeId] = Object.freeze({
        kind: "handle",
        nativeName: connection.nativeType,
        threadSafety: "confined",
        identity: "none",
        upcasts: Object.freeze([]),
      });
      declarationTypes[signalConnectionTypeId] = Object.freeze({
        module: ".",
        name: "SignalConnection",
      });
      bindings[signalDisconnectId] = callableBase({
        declaration: signalDisconnectDeclaration,
        kind: "method",
        entryKind: "adapter-symbol",
        symbol: connection.disconnectSymbol,
        parameters: [Object.freeze({
          name: "connection",
          type: signalConnectionTypeId,
          passMode: "pointer",
          nullable: false,
          ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
        })],
        result: Object.freeze({
          type: "void",
          passMode: "value",
          nullable: false,
          ownership: Object.freeze({ kind: "value" }),
        }),
        dependencies: dependencies({ links: linkIds, adapter: options.adapterInput.id }),
      });
      bindings[signalConnectedId] = callableBase({
        declaration: signalConnectedDeclaration,
        kind: "getter",
        entryKind: "adapter-symbol",
        symbol: connection.connectedSymbol,
        parameters: [Object.freeze({
          name: "connection",
          type: signalConnectionTypeId,
          passMode: "pointer",
          nullable: false,
          ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
        })],
        result: Object.freeze({
          type: "gboolean",
          passMode: "value",
          nullable: false,
          ownership: Object.freeze({ kind: "value" }),
        }),
        dependencies: dependencies({ links: linkIds, adapter: options.adapterInput.id }),
      });
      bindings[signalReleaseId] = callableBase({
        declaration: signalReleaseDeclaration,
        kind: "method",
        entryKind: "adapter-symbol",
        symbol: connection.releaseSymbol,
        parameters: [Object.freeze({
          name: "connection",
          type: signalConnectionTypeId,
          passMode: "pointer",
          nullable: true,
          ownership: Object.freeze({ kind: "owned", transfer: "to-native" }),
        })],
        result: Object.freeze({
          type: "void",
          passMode: "value",
          nullable: false,
          ownership: Object.freeze({ kind: "value" }),
        }),
        dependencies: dependencies({ links: linkIds, adapter: options.adapterInput.id }),
      });
      declarations.add(signalDisconnectDeclaration);
      declarations.add(signalConnectedDeclaration);
      declarations.add(signalReleaseDeclaration);
      adapterBindings.push(signalDisconnectId, signalConnectedId, signalReleaseId);
      declarationLines.push(
        "export interface SignalConnection {",
        "  readonly [nativeResourceSignalConnection]: true;",
        "  readonly connected: boolean;",
        "  disconnect(): void;",
        "}",
        "",
      );
      signalConnectionReady = true;
    }
  }

  if (options.gobjectAdapter.errorSupport !== null) {
    const support = options.gobjectAdapter.errorSupport;
    types[errorObjectTypeId] = Object.freeze({
      kind: "pointer",
      pointee: "i8",
      mutability: "mutable",
      nullable: true,
      addressSpace: 0,
    });
    const errorParameter: AbiParameter = Object.freeze({
      name: "error",
      type: errorObjectTypeId,
      passMode: "pointer",
      nullable: false,
      ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
    });
    bindings[errorMessageBindingId] = callableBase({
      declaration: "NativeError.message",
      kind: "getter",
      entryKind: "adapter-symbol",
      symbol: support.messageSymbol,
      parameters: [errorParameter],
      result: Object.freeze({
        type: "const_utf8",
        passMode: "pointer",
        nullable: false,
        ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
      }),
      dependencies: dependencies({ links: linkIds, adapter: options.adapterInput.id }),
    });
    bindings[errorReleaseBindingId] = callableBase({
      declaration: "NativeError.__release",
      kind: "method",
      entryKind: "adapter-symbol",
      symbol: support.releaseSymbol,
      parameters: [errorParameter],
      result: Object.freeze({
        type: "void",
        passMode: "value",
        nullable: false,
        ownership: Object.freeze({ kind: "value" }),
      }),
      dependencies: dependencies({ links: linkIds, adapter: options.adapterInput.id }),
    });
    declarations.add("NativeError.message");
    declarations.add("NativeError.__release");
    adapterBindings.push(errorMessageBindingId, errorReleaseBindingId);
  }

  for (const class_ of options.snapshot.classes) {
    const classPath = `${options.snapshot.namespace.name}/${class_.name}`;
    const typeId = typeIdByClass.get(class_.name)!;
    const releaseId = `${options.snapshot.namespace.name.toLowerCase()}_${class_.cSymbolPrefix}_release`;
    const releaseDeclaration = `${class_.name}.dispose`;
    if (
      types[typeId] !== undefined ||
      declarationTypes[typeId] !== undefined ||
      (releaseByClass.has(class_.name) &&
        (bindings[releaseId] !== undefined || declarations.has(releaseDeclaration)))
    ) {
      diagnostics.push(diagnostic(classPath, "Generated GObject class identity collides"));
      continue;
    }
    // Resolved after the collision guard so a rejected class cannot leave an
    // import behind it.
    const importedParent = resolveImportedParent(class_, classPath);
    types[typeId] = Object.freeze({
      kind: "handle",
      nativeName: class_.cType,
      threadSafety: "confined",
      /* A GObject's identity is its pointer for as long as a reference is
       * held, which is what ownership.md means by identity following the
       * underlying object reference. Declaring it lets the runtime intern the
       * handle, so two projections of one widget are one managed cell and
       * equality answers about the widget rather than about which call
       * produced the reference. */
      identity: "pointer",
      upcasts: Object.freeze(
        class_.parent?.kind === "internal"
          ? [Object.freeze({
              kind: "identity" as const,
              target: typeIdByClass.get(class_.parent.name)!,
            })]
          : importedParent === undefined
            ? []
            : [Object.freeze({
                kind: "identity" as const,
                target: importedParent.typeId,
              })],
      ),
    });
    declarationTypes[typeId] = Object.freeze({ module: ".", name: class_.name });
    /* Exactly the classes something destroys: constructed here, or handed back
     * without a reference by a method whose adapter takes one. A release
     * nothing names is refused as an ownership-consuming call outside the
     * destructor slice, so the adapter computes the set and this follows it. */
    const classRelease = releaseByClass.get(class_.name);
    if (classRelease !== undefined) {
      bindings[releaseId] = callableBase({
        declaration: releaseDeclaration,
        kind: "method",
        entryKind: "adapter-symbol",
        symbol: classRelease.releaseSymbol,
        parameters: [Object.freeze({
          name: class_.cSymbolPrefix,
          type: typeId,
          passMode: "pointer",
          nullable: true,
          ownership: Object.freeze({ kind: "owned", transfer: "to-native" }),
        })],
        result: Object.freeze({
          type: "void",
          passMode: "value",
          nullable: false,
          ownership: Object.freeze({ kind: "value" }),
        }),
        dependencies: dependencies({ links: linkIds, adapter: options.adapterInput.id }),
      });
      declarations.add(releaseDeclaration);
      adapterBindings.push(releaseId);
    }

    // Ingestion guarantees an internal parent is selected; an external parent
    // is the deliberate edge of this namespace's generated surface.
    const parent =
      class_.parent?.kind === "internal"
        ? classByName.get(class_.parent.name)
        : undefined;
    const extendsName = parent?.name ?? importedParent?.alias;
    const classLines = [
      `export declare ${class_.abstract ? "abstract " : ""}class ${class_.name}${extendsName === undefined ? "" : ` extends ${extendsName}`} {`,
      `  readonly [${handleBrand(class_.name)}]: true;`,
    ];
    const constructorLines: string[] = [];
    const propertyAccessors = new Map<string, {
      getter?: GirCallable;
      setter?: GirCallable;
    }>();
    const invalidPropertyMethods = new Set<GirCallable>();
    const projectedPropertyMethods = new Set<GirCallable>();
    for (const callable of class_.methods) {
      const getterName = callable.glibGetProperty;
      const setterName = callable.glibSetProperty;
      if (getterName !== null && setterName !== null) {
        diagnostics.push(
          diagnostic(
            `${classPath}/method/${callable.name}`,
            "A GIR method cannot be both a property getter and setter",
          ),
        );
        invalidPropertyMethods.add(callable);
        continue;
      }
      const propertyName = getterName ?? setterName;
      if (propertyName === null) continue;
      const accessors = propertyAccessors.get(propertyName) ?? {};
      const slot = getterName === null ? "setter" : "getter";
      if (accessors[slot] !== undefined) {
        diagnostics.push(
          diagnostic(
            `${classPath}/property/${propertyName}`,
            `Selected GIR methods contain duplicate ${slot}s`,
          ),
        );
        invalidPropertyMethods.add(callable);
        invalidPropertyMethods.add(accessors[slot]!);
      } else {
        accessors[slot] = callable;
      }
      propertyAccessors.set(propertyName, accessors);
    }
    /**
     * Whether a getter returns a string it may report as absent.
     *
     * Such a pair projects as methods rather than as a property. A property
     * claims field-like stability, and a native getter has none: it calls into
     * the library on every read and may answer differently each time. That is
     * exactly why a narrowed read of one is refused — the callee still returns
     * what its declaration allows — so `if (w.title !== null) use(w.title)`,
     * the first thing anyone writes against a nullable value, does not compile
     * when `title` is a property. As a method the narrowing never arises, and
     * the shape says what is true: each call is a fresh read that can be
     * absent.
     *
     * Only nullable strings need this. Every other projected type survives a
     * narrowing, because none of them has to match an exact two-arm union.
     */
    function reportsAbsentString(getter: GirCallable): boolean {
      return getter.result.nullable &&
        getter.result.type.kind === "named" &&
        getter.result.type.name === "utf8";
    }

    for (const [propertyName, accessors] of propertyAccessors) {
      if (accessors.getter === undefined || accessors.setter === undefined) {
        continue;
      }
      const setterValue = accessors.setter.parameters[1];
      if (
        accessors.getter.parameters.length !== 1 ||
        accessors.setter.parameters.length !== 2 ||
        accessors.setter.result.type.cType !== "void" ||
        setterValue === undefined ||
        canonicalizeJson(accessors.getter.result.type) !== canonicalizeJson(setterValue.type)
      ) {
        diagnostics.push(
          diagnostic(
            `${classPath}/property/${propertyName}`,
            "GIR getter and setter do not form one coherent property type contract",
          ),
        );
        invalidPropertyMethods.add(accessors.getter);
        invalidPropertyMethods.add(accessors.setter);
      } else if (
        !reportsAbsentString(accessors.getter) &&
        borrowedResultClass(accessors.getter, classByName) === undefined
      ) {
        /* A getter handing back an object is a call whose answer can change,
         * and the object it names has a lifetime of its own. Both are reasons
         * a property is the wrong shape, the same reason a nullable string
         * getter is one. */
        projectedPropertyMethods.add(accessors.getter);
        projectedPropertyMethods.add(accessors.setter);
      }
    }
    const projectedPropertyKinds = new Map<string, Set<"getter" | "setter">>();
    for (const callable of class_.methods) {
      const path = `${classPath}/method/${callable.name}`;
      if (invalidPropertyMethods.has(callable)) continue;
      const propertyKind = projectedPropertyMethods.has(callable)
        ? callable.glibGetProperty !== null
          ? "getter" as const
          : "setter" as const
        : null;
      const propertyName = propertyKind === null
        ? null
        : callable.glibGetProperty ?? callable.glibSetProperty;
      /* A method handing back an object it keeps owning reaches the boundary
       * through an adapter that took a reference, which makes the result an
       * ordinary owned handle. The runtime's identity map decides whether that
       * reference is surplus: two projections of one object are one cell, so
       * equality answers about the object rather than about the call. */
      const borrowedResult = borrowedResultClass(callable, classByName);
      if (borrowedResult !== undefined) {
        const retained = adapterByRetainedResult.get(
          `${class_.name}.method.${callable.name}`,
        );
        const resultTypeId = typeIdByClass.get(borrowedResult.name);
        const resultRelease = releaseByClass.get(borrowedResult.name);
        if (
          retained === undefined ||
          resultTypeId === undefined ||
          resultRelease === undefined
        ) {
          diagnostics.push(diagnostic(
            path,
            "GObject adapter is missing this borrowed object result",
          ));
          continue;
        }
        const receiver = callable.parameters[0];
        if (!isExactInstanceReceiver(receiver, class_)) {
          diagnostics.push(diagnostic(
            `${path}/receiver`,
            "Method receiver does not match its GObject class",
          ));
          continue;
        }
        const retainedParameters: AbiParameter[] = [Object.freeze({
          name: "instance",
          type: typeId,
          passMode: "pointer",
          nullable: false,
          ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
        })];
        const retainedSourceParameters: string[] = [];
        let retainedValid = true;
        for (const [index, parameter] of callable.parameters.slice(1).entries()) {
          const handle = handleParameter(
            parameter,
            classByName,
            typeIdByClass,
            `${path}/parameters/${index}`,
            diagnostics,
          );
          if (handle === null) {
            retainedValid = false;
            continue;
          }
          retainedParameters.push(handle.abi);
          retainedSourceParameters.push(
            `${lowerCamel(parameter.name)}: ${handle.sourceType}`,
          );
        }
        if (!retainedValid) continue;
        const sourceMember = lowerCamel(callable.name);
        const declaration = `${class_.name}.${sourceMember}`;
        const bindingId =
          `${namespacePrefix}_${class_.cSymbolPrefix}_${snakeCase(callable.name)}`;
        const resultReleaseId =
          `${namespacePrefix}_${borrowedResult.cSymbolPrefix}_release`;
        if (bindings[bindingId] !== undefined || declarations.has(declaration)) {
          diagnostics.push(diagnostic(path, "Generated method identity collides"));
          continue;
        }
        bindings[bindingId] = callableBase({
          declaration,
          kind: "method",
          entryKind: "adapter-symbol",
          symbol: retained.adapterSymbol,
          parameters: retainedParameters,
          result: Object.freeze({
            type: resultTypeId,
            passMode: "pointer",
            nullable: callable.result.nullable,
            ownership: Object.freeze({
              kind: "owned",
              transfer: "to-runtime",
              destructor: resultReleaseId,
            }),
          }),
          /* Never the nullable error contract: that one says NULL means the
           * call failed, and a reader's NULL does not. GIR decides which shape
           * the result takes instead — `T | null` when the object can be
           * absent, and a plain `T` when it cannot, where a NULL would mean
           * the library broke its own contract and traps on commit. */
          error: Object.freeze({ kind: "no-fail" }),
          dependencies: dependencies({
            bindings: [resultReleaseId],
            links: linkIds,
            adapter: options.adapterInput.id,
          }),
          availability: availability(class_, callable),
        });
        declarations.add(declaration);
        adapterBindings.push(bindingId);
        classLines.push(
          ...deprecationDoc(callable, "  "),
          `  ${sourceMember}(${retainedSourceParameters.join(", ")}): ${
            borrowedResult.name
          }${callable.result.nullable ? " | null" : ""};`,
        );
        continue;
      }
      if (callable.throws) {
        // A GError-reporting member reaches the boundary through the adapter
        // that absorbed its out-parameter, so it binds an adapter symbol whose
        // pointer result is the error channel rather than a source value.
        const throwing = adapterByThrowingMethod.get(
          `${class_.name}.method.${callable.name}`,
        );
        const support = options.gobjectAdapter.errorSupport;
        if (throwing === undefined || support === null) {
          diagnostics.push(diagnostic(path, "GObject adapter is missing this throwing method"));
          continue;
        }
        const receiver = callable.parameters[0];
        if (!isExactInstanceReceiver(receiver, class_)) {
          diagnostics.push(diagnostic(`${path}/receiver`, "Method receiver does not match its GObject class"));
          continue;
        }
        const throwingParameters: AbiParameter[] = [Object.freeze({
          name: "instance",
          type: typeId,
          passMode: "pointer",
          nullable: false,
          ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
        })];
        const throwingSourceParameters: string[] = [];
        let throwingValid = true;
        for (const [index, parameter] of callable.parameters.slice(1).entries()) {
          const handle = handleParameter(
            parameter,
            classByName,
            typeIdByClass,
            `${path}/parameters/${index}`,
            diagnostics,
          );
          if (handle === null) {
            throwingValid = false;
            continue;
          }
          throwingParameters.push(handle.abi);
          throwingSourceParameters.push(
            `${lowerCamel(parameter.name)}: ${handle.sourceType}`,
          );
        }
        if (!throwingValid) continue;
        const sourceMember = lowerCamel(callable.name);
        const declaration = `${class_.name}.${sourceMember}`;
        const bindingId = `${namespacePrefix}_${class_.cSymbolPrefix}_${snakeCase(callable.name)}`;
        if (bindings[bindingId] !== undefined || declarations.has(declaration)) {
          diagnostics.push(diagnostic(path, "Generated method identity collides"));
          continue;
        }
        bindings[bindingId] = callableBase({
          declaration,
          kind: "method",
          entryKind: "adapter-symbol",
          symbol: throwing.adapterSymbol,
          parameters: throwingParameters,
          result: Object.freeze({
            type: errorObjectTypeId,
            passMode: "pointer",
            nullable: true,
            ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
          }),
          error: Object.freeze({
            kind: "error-handle",
            message: errorMessageBindingId,
            release: errorReleaseBindingId,
          }),
          dependencies: dependencies({
            links: linkIds,
            adapter: options.adapterInput.id,
            bindings: [errorMessageBindingId, errorReleaseBindingId],
          }),
          availability: availability(class_, callable),
        });
        declarations.add(declaration);
        adapterBindings.push(bindingId);
        classLines.push(
          ...deprecationDoc(callable, "  "),
          `  ${sourceMember}(${throwingSourceParameters.join(", ")}): void;`,
        );
        continue;
      }
      const methodRefusal = directEntryRefusal(callable);
      if (methodRefusal !== null || callable.cIdentifier === null) {
        diagnostics.push(
          diagnostic(path, `Method ${methodRefusal ?? "has no C identifier"}`),
        );
        continue;
      }
      const receiver = callable.parameters[0];
      if (!isExactInstanceReceiver(receiver, class_)) {
        diagnostics.push(diagnostic(`${path}/receiver`, "Method receiver does not match its GObject class"));
        continue;
      }
      const valueMethod = adapterByValueMethod.get(
        `${class_.name}.method.${callable.name}`,
      );
      if (valueMethod !== undefined) {
        const sourceMember = lowerCamel(callable.name);
        const declaration = `${class_.name}.${sourceMember}`;
        const bindingId = valueMethod.adapterSymbol;
        const resultTypeId = `${namespacePrefix}_${snakeCase(valueMethod.resultName)}`;
        const inputTypes = valueMethod.inputs.map((input) =>
          scalarAbiTypeByGirName.get(input.sourceName)
        );
        if (
          callable.parameters.length !==
            valueMethod.outputs.length + valueMethod.inputs.length + 1 ||
          types[resultTypeId]?.kind !== "struct" ||
          inputTypes.some((type) => type === undefined || types[type] === undefined)
        ) {
          diagnostics.push(diagnostic(path, "Value-return adapter result is incomplete"));
          continue;
        }
        if (bindings[bindingId] !== undefined || declarations.has(declaration)) {
          diagnostics.push(diagnostic(path, "Generated value method identity collides"));
          continue;
        }
        declarations.add(declaration);
        bindings[bindingId] = callableBase({
          declaration,
          kind: "method",
          entryKind: "adapter-symbol",
          symbol: valueMethod.adapterSymbol,
          parameters: [
            Object.freeze({
              name: receiver.name,
              type: typeId,
              passMode: "pointer",
              nullable: false,
              ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
            }),
            ...valueMethod.inputs.map((input, index) => Object.freeze({
              name: input.parameterName,
              type: inputTypes[index]!,
              passMode: "value" as const,
              nullable: false,
              ownership: Object.freeze({ kind: "value" as const }),
            })),
          ],
          result: Object.freeze({
            type: resultTypeId,
            passMode: "value",
            nullable: false,
            ownership: Object.freeze({ kind: "value" }),
          }),
          dependencies: dependencies({
            links: linkIds,
            adapter: options.adapterInput.id,
          }),
          availability: availability(class_, callable),
        });
        adapterBindings.push(bindingId);
        classLines.push(
          ...deprecationDoc(callable, "  "),
          `  ${sourceMember}(${valueMethod.inputs.map((input) =>
            `${lowerCamel(input.parameterName)}: ${input.sourceName}`
          ).join(", ")}): ${valueMethod.resultName};`,
        );
        continue;
      }
      const sourceParameters: string[] = [];
      const sourceParameterTypes: string[] = [];
      const abiParameters: AbiParameter[] = [Object.freeze({
        name: receiver.name,
        type: typeId,
        passMode: "pointer",
        nullable: false,
        ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
      })];
      let valid = true;
      for (const [index, parameter] of callable.parameters.slice(1).entries()) {
        const parameterPath = `${path}/parameters/${index + 1}`;
        const scalar = sourceScalarType(parameter.type);
        const enumeration = parameter.type.kind === "named"
          ? enumerations.get(parameter.type.name)
          : undefined;
        if (
          parameter.type.kind === "named" &&
          parameter.type.name === "utf8"
        ) {
          const abi = cStringParameter(
            parameter,
            parameter.nullable ? "nullable_const_utf8" : "const_utf8",
            parameterPath,
            diagnostics,
          );
          if (abi === null) {
            valid = false;
          } else {
            abiParameters.push(abi);
            const sourceType = parameter.nullable ? "string | null" : "string";
            sourceParameters.push(`${lowerCamel(parameter.name)}: ${sourceType}`);
            sourceParameterTypes.push(sourceType);
          }
        } else if (
          parameter.type.kind === "named" &&
          parameter.type.name === "gboolean"
        ) {
          const abi = requiredValueParameter(
            parameter,
            { girName: "gboolean", cTypes: ["gboolean"], abiType: "gboolean" },
            parameterPath,
            diagnostics,
          );
          if (abi === null) {
            valid = false;
          } else {
            abiParameters.push(abi);
            sourceParameters.push(`${lowerCamel(parameter.name)}: boolean`);
            sourceParameterTypes.push("boolean");
          }
        } else if (enumeration !== undefined) {
          const enumerationTypeId = enumeration.typeId;
          const abi = requiredValueParameter(
            parameter,
            {
              girName: enumeration.girName,
              cTypes: [enumeration.cType],
              abiType: enumerationTypeId,
            },
            parameterPath,
            diagnostics,
          );
          if (abi === null) {
            valid = false;
          } else {
            abiParameters.push(abi);
            sourceParameters.push(
              `${lowerCamel(parameter.name)}: ${enumeration.sourceName}`,
            );
            sourceParameterTypes.push(enumeration.sourceName);
          }
        } else if (scalar !== undefined) {
          const abi = requiredValueParameter(
            parameter,
            scalar,
            parameterPath,
            diagnostics,
          );
          if (abi === null) {
            valid = false;
          } else {
            abiParameters.push(abi);
            sourceParameters.push(
              `${lowerCamel(parameter.name)}: ${scalar.girName}`,
            );
            sourceParameterTypes.push(scalar.girName);
          }
        } else {
          const handle = handleParameter(
            parameter,
            classByName,
            typeIdByClass,
            parameterPath,
            diagnostics,
          );
          if (handle === null) {
            valid = false;
          } else {
            abiParameters.push(handle.abi);
            sourceParameters.push(
              `${lowerCamel(parameter.name)}: ${handle.sourceType}`,
            );
            sourceParameterTypes.push(handle.sourceType);
          }
        }
      }
      const result = methodResult(
        callable,
        receiver.name,
        callable.result.nullable ? "nullable_const_utf8" : "const_utf8",
        enumerations,
        diagnostics,
        `${path}/result`,
      );
      if (!valid || result === null) continue;
      const sourceMember = propertyName === null
        ? lowerCamel(callable.name)
        : lowerCamel(propertyName);
      const declaration = `${class_.name}.${sourceMember}`;
      const bindingId = callable.cIdentifier;
      const projectedKinds = projectedPropertyKinds.get(declaration);
      if (
        bindings[bindingId] !== undefined ||
        (declarations.has(declaration) &&
          (propertyKind === null || projectedKinds === undefined || projectedKinds.has(propertyKind)))
      ) {
        diagnostics.push(diagnostic(path, "Generated method identity collides"));
        continue;
      }
      declarations.add(declaration);
      if (propertyKind !== null) {
        const kinds = projectedKinds ?? new Set<"getter" | "setter">();
        kinds.add(propertyKind);
        projectedPropertyKinds.set(declaration, kinds);
      }
      bindings[bindingId] = callableBase({
        declaration,
        kind: propertyKind ?? "method",
        entryKind: "c-symbol",
        symbol: callable.cIdentifier,
        parameters: abiParameters,
        result,
        dependencies: dependencies({ links: linkIds }),
        availability: availability(class_, callable),
      });
      const scalarResult = sourceScalarType(callable.result.type);
      const enumerationResult = callable.result.type.kind === "named"
        ? enumerations.get(callable.result.type.name)
        : undefined;
      const sourceResult = callable.result.type.cType === "void"
        ? "void"
        : callable.result.type.kind === "named" &&
            callable.result.type.name === "gboolean"
          ? "boolean"
          : scalarResult !== undefined
            ? scalarResult.girName
            : enumerationResult !== undefined
              ? enumerationResult.sourceName
            : callable.result.nullable
              ? "string | null"
              : "string";
      if (propertyKind === "getter") {
        classLines.push(
          ...deprecationDoc(callable, "  "),
          `  get ${sourceMember}(): ${sourceResult};`,
        );
      } else if (propertyKind === "setter") {
        const valueType = sourceParameterTypes[0];
        if (valueType === undefined || valueType.length === 0) {
          diagnostics.push(diagnostic(path, "Generated property setter has no source value"));
          continue;
        }
        classLines.push(
          ...deprecationDoc(callable, "  "),
          `  set ${sourceMember}(value: ${valueType});`,
        );
      } else {
        classLines.push(
          ...deprecationDoc(callable, "  "),
          `  ${sourceMember}(${sourceParameters.join(", ")}): ${sourceResult};`,
        );
      }
    }
    for (const callable of class_.signals) {
      const path = `${classPath}/signal/${callable.name}`;
      const adapter = adapterBySignal.get(`${class_.name}.signal.${callable.name}`);
      const signalPart = callable.name.replaceAll("-", "_");
      const callbackTypeId = `${namespacePrefix}_${class_.cSymbolPrefix}_${signalPart}_callback`;
      const connectId = `${namespacePrefix}_${class_.cSymbolPrefix}_connect_${signalPart}`;
      const declaration = `${class_.name}.on${upperCamel(callable.name)}`;
      if (adapter === undefined) {
        diagnostics.push(diagnostic(path, "GObject signal adapter is missing this signal"));
        continue;
      }
      if (!signalConnectionReady) continue;
      const signalParameters: AbiParameter[] = [];
      const sourceSignalParameters: string[] = [];
      let signalValid = true;
      for (const [index, parameter] of callable.parameters.entries()) {
        const parameterPath = `${path}/parameters/${index}`;
        const scalar = sourceScalarType(parameter.type);
        const enumeration = parameter.type.kind === "named"
          ? enumerations.get(parameter.type.name)
          : undefined;
        /* A payload is copied into the callback turn, so only types that are
         * values qualify. An enumeration is one: its storage and members are
         * Clang-proven and nothing outlives the call. A handle, a boxed
         * record, or a string would each have to be borrowed for exactly the
         * callback's duration, which is a lifetime nothing implements. */
        const payload = scalar ?? (enumeration === undefined ? undefined : {
          girName: enumeration.girName,
          cTypes: [enumeration.cType],
          abiType: enumeration.typeId,
          sourceName: enumeration.sourceName,
          cTypeOnDeclaration: true,
        });
        const adapterPayload = adapter.parameters[index];
        /* An object payload arrives with a reference the dispatch took, so it
         * is an owned handle whose destructor gives that reference back. The
         * runtime interns it, so a row handed to a handler is the same cell
         * the program already holds for that row. */
        const payloadClass = parameter.type.kind === "named"
          ? classByName.get(parameter.type.name)
          : undefined;
        if (payloadClass !== undefined) {
          const payloadTypeId = typeIdByClass.get(payloadClass.name);
          const payloadRelease = releaseByClass.get(payloadClass.name);
          if (
            payloadTypeId === undefined || payloadRelease === undefined ||
            adapterPayload?.name !== parameter.name ||
            adapterPayload.sourceType !== payloadClass.name ||
            parameter.nullable
          ) {
            diagnostics.push(diagnostic(
              parameterPath,
              "A GObject signal payload must be a selected, non-null class the adapter references",
            ));
            signalValid = false;
            continue;
          }
          signalParameters.push(Object.freeze({
            name: parameter.name,
            type: payloadTypeId,
            passMode: "pointer",
            nullable: false,
            ownership: Object.freeze({
              kind: "owned",
              transfer: "to-runtime",
              destructor:
                `${namespacePrefix}_${payloadClass.cSymbolPrefix}_release`,
            }),
          }));
          sourceSignalParameters.push(
            `${lowerCamel(parameter.name)}: ${payloadClass.name}`,
          );
          continue;
        }
        /* A UTF-8 payload is a borrowed C string the runtime copies when the
         * signal fires. Its ABI is the same pointer a borrowed string
         * parameter uses; what differs is only that delivery is queued, which
         * is the contract's business rather than this projection's. */
        if (parameter.type.kind === "named" && parameter.type.name === "utf8") {
          const abi = cStringParameter(
            parameter,
            parameter.nullable ? "nullable_const_utf8" : "const_utf8",
            parameterPath,
            diagnostics,
            emittedUtf8CTypes,
          );
          if (abi === null || adapterPayload?.name !== parameter.name ||
              adapterPayload.sourceType !== "utf8") {
            if (abi !== null) {
              diagnostics.push(
                diagnostic(parameterPath, "GObject signal adapter payload does not match GIR"),
              );
            }
            signalValid = false;
            continue;
          }
          signalParameters.push(abi);
          sourceSignalParameters.push(
            `${lowerCamel(parameter.name)}: ${parameter.nullable ? "string | null" : "string"}`,
          );
          continue;
        }
        if (payload === undefined) {
          diagnostics.push(diagnostic(
            parameterPath,
            "Only exact scalar, selected enumeration, and UTF-8 signal payloads are implemented",
          ));
          signalValid = false;
          continue;
        }
        const sourceName = "sourceName" in payload
          ? payload.sourceName
          : payload.girName;
        const abi = requiredValueParameter(parameter, payload, parameterPath, diagnostics);
        if (
          abi === null ||
          adapterPayload?.name !== parameter.name ||
          adapterPayload.sourceType !== payload.girName
        ) {
          if (abi !== null) {
            diagnostics.push(
              diagnostic(parameterPath, "GObject signal adapter payload does not match GIR"),
            );
          }
          signalValid = false;
          continue;
        }
        signalParameters.push(abi);
        sourceSignalParameters.push(
          `${lowerCamel(parameter.name)}: ${sourceName}`,
        );
      }
      if (!signalValid || signalParameters.length !== adapter.parameters.length) continue;
      if (
        types[callbackTypeId] !== undefined ||
        bindings[connectId] !== undefined ||
        declarations.has(declaration)
      ) {
        diagnostics.push(diagnostic(path, "Generated GObject signal identity collides"));
        continue;
      }
      if (types.void_ptr === undefined) {
        types.void_ptr = Object.freeze({
          kind: "pointer",
          pointee: "void",
          mutability: "mutable",
          nullable: true,
          addressSpace: 0,
        });
      }
      types[callbackTypeId] = Object.freeze({
        kind: "callback",
        signature: Object.freeze({
          callingConvention: "c",
          variadic: false,
          parameters: Object.freeze(signalParameters),
          result: Object.freeze({
            type: "void",
            passMode: "value",
            nullable: false,
            ownership: Object.freeze({ kind: "value" }),
          }),
        }),
        context: Object.freeze({ placement: "last", type: "void_ptr" }),
      });
      bindings[connectId] = callableBase({
        declaration,
        kind: "method",
        entryKind: "adapter-symbol",
        symbol: adapter.connectSymbol,
        parameters: [
          Object.freeze({
            name: class_.cSymbolPrefix,
            type: typeId,
            passMode: "pointer",
            nullable: false,
            ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
          }),
          Object.freeze({
            name: "callback",
            type: callbackTypeId,
            passMode: "pointer",
            nullable: false,
            ownership: Object.freeze({
              kind: "borrowed",
              scope: "registration",
              anchor: class_.cSymbolPrefix,
            }),
            callback: Object.freeze({
              lifetime: "until-cancelled",
              registrationOwner: class_.cSymbolPrefix,
              cancellationBinding: signalDisconnectId,
              contextParameter: "context",
              allowedInvocationExecutors: Object.freeze([
                Object.freeze({ kind: "same-as-caller" as const }),
              ]),
              deliveryExecutor: Object.freeze({ kind: "runtime-owner" }),
              synchronousReturn: false,
              arguments: Object.freeze(signalParameters.map((parameter) =>
                Object.freeze({
                  parameter: parameter.name,
                  transport: "copy" as const,
                })
              )),
              sourceArguments: Object.freeze([
                Object.freeze({ kind: "registration-owner" as const }),
                ...signalParameters.map((parameter) =>
                  Object.freeze({
                    kind: "callback-parameter" as const,
                    parameter: parameter.name,
                  })
                ),
              ]),
              reentrancy: "allowed",
              postDisposal: "not-invoked",
              shutdown: "drain",
            }),
          }),
          Object.freeze({
            name: "context",
            type: "void_ptr",
            passMode: "pointer",
            nullable: false,
            ownership: Object.freeze({
              kind: "borrowed",
              scope: "registration",
              anchor: "callback",
            }),
          }),
        ],
        result: Object.freeze({
          type: signalConnectionTypeId,
          passMode: "pointer",
          nullable: true,
          ownership: Object.freeze({
            kind: "owned",
            transfer: "to-runtime",
            destructor: signalReleaseId,
          }),
        }),
        error: Object.freeze({ kind: "nullable" }),
        dependencies: dependencies({
          bindings: [signalDisconnectId, signalReleaseId],
          links: linkIds,
          adapter: options.adapterInput.id,
        }),
        availability: availability(class_, callable),
      });
      declarations.add(declaration);
      adapterBindings.push(connectId);
      classLines.push(
        ...deprecationDoc(callable, "  "),
        `  on${upperCamel(callable.name)}(callback: (${[
          `${lowerCamel(class_.name)}: ${class_.name}`,
          ...sourceSignalParameters,
        ].join(", ")}) => void): SignalConnection;`,
      );
    }
    let hasCanonicalConstructor = false;
    for (const callable of class_.constructors) {
      const path = `${classPath}/constructor/${callable.name}`;
      const constructorRefusal = directEntryRefusal(callable);
      if (constructorRefusal !== null || callable.cIdentifier === null) {
        diagnostics.push(
          diagnostic(
            path,
            `Constructor ${constructorRefusal ?? "has no C identifier"}`,
          ),
        );
        continue;
      }
      if (
        callable.result.scope !== null ||
        callable.result.closureParameter !== null ||
        callable.result.destroyParameter !== null
      ) {
        diagnostics.push(
          diagnostic(`${path}/result`, "Constructor result callback metadata is unsupported"),
        );
        continue;
      }
      const adapter = adapterByConstructor.get(`${class_.name}.constructor.${callable.name}`);
      if (adapter === undefined) {
        diagnostics.push(diagnostic(path, "GObject ownership adapter is missing this constructor"));
        continue;
      }
      const parameters: AbiParameter[] = [];
      const sourceParameters: string[] = [];
      let valid = true;
      for (const [index, parameter] of callable.parameters.entries()) {
        const parameterPath = `${path}/parameters/${index}`;
        const scalar = sourceScalarType(parameter.type);
        const enumeration = parameter.type.kind === "named"
          ? enumerations.get(parameter.type.name)
          : undefined;
        let abi: AbiParameter | null;
        let sourceType: string;
        if (parameter.type.kind === "named" && parameter.type.name === "utf8") {
          abi = cStringParameter(
            parameter,
            parameter.nullable ? "nullable_const_utf8" : "const_utf8",
            parameterPath,
            diagnostics,
          );
          sourceType = parameter.nullable ? "string | null" : "string";
        } else if (parameter.type.kind === "named" && parameter.type.name === "gboolean") {
          abi = requiredValueParameter(
            parameter,
            { girName: "gboolean", cTypes: ["gboolean"], abiType: "gboolean" },
            parameterPath,
            diagnostics,
          );
          sourceType = "boolean";
        } else if (enumeration !== undefined) {
          abi = requiredValueParameter(
            parameter,
            {
              girName: enumeration.girName,
              cTypes: [enumeration.cType],
              abiType: enumeration.typeId,
            },
            parameterPath,
            diagnostics,
          );
          sourceType = enumeration.sourceName;
        } else if (scalar !== undefined) {
          abi = requiredValueParameter(parameter, scalar, parameterPath, diagnostics);
          sourceType = scalar.girName;
        } else {
          const handle = handleParameter(
            parameter,
            classByName,
            typeIdByClass,
            parameterPath,
            diagnostics,
          );
          abi = handle?.abi ?? null;
          sourceType = handle?.sourceType ?? "never";
        }
        if (abi === null) {
          valid = false;
        } else {
          parameters.push(abi);
          sourceParameters.push(`${lowerCamel(parameter.name)}: ${sourceType}`);
        }
      }
      const projection = constructorProjection(class_.name, callable.name);
      if (!identifierPattern.test(projection.member) || declarations.has(projection.declaration)) {
        diagnostics.push(diagnostic(path, "Generated constructor declaration identity collides"));
        valid = false;
      }
      if (!valid) continue;
      declarations.add(projection.declaration);
      const bindingId = callable.cIdentifier;
      if (bindings[bindingId] !== undefined) {
        diagnostics.push(diagnostic(path, "Generated constructor binding identity collides"));
        continue;
      }
      bindings[bindingId] = callableBase({
        declaration: projection.declaration,
        kind: projection.kind,
        entryKind: "adapter-symbol",
        symbol: adapter.adapterSymbol,
        parameters,
        result: Object.freeze({
          type: typeId,
          passMode: "pointer",
          nullable: callable.result.nullable,
          ownership: Object.freeze({
            kind: "owned",
            transfer: "to-runtime",
            destructor: releaseId,
          }),
        }),
        error: callable.result.nullable
          ? Object.freeze({ kind: "nullable" })
          : Object.freeze({ kind: "no-fail" }),
        dependencies: dependencies({
          bindings: [releaseId],
          links: linkIds,
          adapter: options.adapterInput.id,
        }),
        availability: availability(class_, callable),
      });
      adapterBindings.push(bindingId);
      if (projection.kind === "constructor") {
        hasCanonicalConstructor = true;
        constructorLines.push(
          ...deprecationDoc(callable, "  "),
          `  constructor(${sourceParameters.join(", ")});`,
        );
      } else {
        constructorLines.push(
          ...deprecationDoc(callable, "  "),
          `  static ${projection.member}(${sourceParameters.join(", ")}): ${class_.name};`,
        );
      }
    }
    if (!hasCanonicalConstructor) {
      constructorLines.unshift(
        `  ${class_.final ? "private" : "protected"} constructor();`,
      );
    }
    classLines.splice(2, 0, ...constructorLines);
    classLines.push("}", "");
    declarationLines.push(...classLines);
  }
  if (diagnostics.length > 0) throw new CBindgenError(diagnostics);

  const declarationSource = `${[
    ...[...importedDeclarationLines].sort(compareText),
    ...(importedDeclarationLines.length > 0 ? [""] : []),
    ...declarationLines,
  ].join("\n").trimEnd()}\n`;
  const declarationsDigest = sha256(declarationSource);
  const metadataDigest = sha256(canonicalizeJson({
    gir: options.snapshot.source.digest,
    clang: options.evidence.semanticDigest,
  }));
  const manifestValue: ScabiManifest = {
    schema: "native-typescript.scabi",
    schemaVersion: 1,
    package: options.package,
    target: {
      ...options.target,
      features: orderedText(options.target.features),
    },
    sdk: {
      ...options.sdk,
      modules: orderedText(options.sdk.modules),
      metadataDigest,
      toolchain: options.evidence.clang.toolId,
      toolchainVersion: options.evidence.clang.version,
      toolchainAbi: options.target.abi,
    },
    generator: {
      name: "native-typescript.gobject-gir",
      version: "1",
      revision: "gobject-scabi-v4",
      arguments: [
        ...options.snapshot.classes.flatMap((class_) => [
          `--class=${class_.name}`,
          ...class_.constructors.map(({ name }) => `--constructor=${class_.name}.${name}`),
          ...class_.methods.map(({ name }) => `--method=${class_.name}.${name}`),
          ...class_.signals.map(({ name }) => `--signal=${class_.name}.${name}`),
        ]),
        ...options.snapshot.enumerations.flatMap((enum_) => [
          `--${enum_.kind}=${enum_.name}`,
          ...enum_.members.map(({ name }) => `--member=${enum_.name}.${name}`),
        ]),
      ],
      inputDigests: [
        options.snapshot.source.digest as Sha256Digest,
        options.evidence.semanticDigest as Sha256Digest,
        options.gobjectAdapter.sourceDigest as Sha256Digest,
      ],
    },
    declarations: {
      digest: declarationsDigest,
      types: declarationTypes,
    },
    // Omitted entirely when nothing is imported, so an ordinary single-package
    // manifest keeps its existing canonical form and digest.
    ...(Object.keys(typeImports).length > 0 ? { imports: typeImports } : {}),
    types,
    bindings,
    linkInputs: orderedLinkInputs,
    adapterInputs: [{
      id: options.adapterInput.id,
      family: "gobject-adapters",
      language: "c",
      bindings: [...new Set(adapterBindings)].sort(),
      outputs: [options.adapterInput.output],
      options: {
        sourceDigest: options.gobjectAdapter.sourceDigest,
        schemaVersion: options.gobjectAdapter.schemaVersion,
      },
    }],
    permissions: [],
    platform: {
      family: "gobject",
      namespace: options.snapshot.namespace.name,
      namespaceVersion: options.snapshot.namespace.version,
    },
  };
  const manifestSource = canonicalizeJson(manifestValue);
  const manifest = parseScabiManifest(manifestSource);
  return Object.freeze({
    schema: "native-typescript.gobject-scabi-package",
    schemaVersion: 1,
    declarations: declarationSource,
    declarationsDigest,
    manifest,
    manifestSource,
    manifestDigest: digestScabiManifest(manifest),
  });
}
