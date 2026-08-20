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
  SCABI_SCHEMA_VERSION,
} from "@native-typescript/scabi";
import type {
  AbiParameter,
  AbiResult,
  MarshallingContract,
  BindingAvailability,
  CallableBinding,
  LinkInput,
  NativeBinding,
  NativePhysicalAbiType,
  NativePhysicalAbiValue,
  NativeType,
  NumberConversion,
  PackageIdentity,
  ScabiManifest,
  Sha256Digest,
  TargetIdentity,
} from "@native-typescript/scabi";
import { ANSWER_FIELD } from "./gobject-adapter.ts";
import {
  generateGirClangAbiProbe,
  reachedForeignTypeNames,
} from "./gir-clang.ts";
import type {
  GirClass,
  GirEnumeration,
  GirParameter,
  GirRecord,
  GirSnapshot,
  GirTypeReference,
GirCallable,
} from "./gir-model.ts";
import {
  borrowedResultClass,
  generateGObjectAdapterSource,
} from "./gobject-adapter.ts";
import type {
  GObjectAdapterSource,
  GObjectValueMethodInputAdapter,
} from "./gobject-adapter.ts";

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
  borrowedStringGirTypes,
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

/**
 * The declaration name for an enumeration member.
 *
 * C enumeration members may begin with a digit — `GTK_LICENSE_0BSD`,
 * `GSK_TRANSFORM_CATEGORY_2D`, `G_SPAWN_ERROR_2BIG` — and GIR keeps the tail
 * verbatim, so upper-camelling one yields `0bsd`, which no TypeScript
 * declaration can name. Ninety-three enumerations across the installed GIRs
 * have at least one such member.
 *
 * A leading underscore is added in exactly that case. It is the smallest rule
 * that makes the name legal without inventing a spelling: every currently
 * legal member keeps the name it already had, so nothing that projects today
 * is renamed, and the collision check below still refuses two members that
 * would land on one name.
 *
 * Dropping the offending member instead would be a silent truncation of the
 * enumeration, and refusing the enumeration — which is what happened before —
 * silently removed every member typed by it from the surface. One unnameable
 * constant is not a reason to withhold the other eighteen.
 */
function enumerationMemberName(value: string): string {
  const camel = upperCamel(value);
  return /^[0-9]/u.test(camel) ? `_${camel}` : camel;
}

/**
 * The manifest's name for a parameter GIR may have escaped.
 *
 * GIR appends an underscore to a name that would collide with a keyword in
 * some binding language: `index_`, `interface_`, `border_`, `virtual_`,
 * `this_`. The manifest's own name rule is canonical lowercase segments, so a
 * trailing underscore is refused there — by a JSON-schema message quoting a
 * regular expression, which told a reader nothing about which parameter or
 * why. It stalled a census of Gio entirely and refused five Gtk members whose
 * types were all inside the slice.
 *
 * The escape is dropped because it carries no information this manifest
 * needs: the name is data here, not an identifier in any language, and the
 * declaration file already drops it when it camel-cases the same name.
 */
function manifestParameterName(value: string): string {
  return value.replace(/_+$/u, "");
}

/**
 * True for a source name TypeScript would read as something other than an
 * ordinary parameter.
 *
 * `this` is the whole list. A leading parameter named `this` in a declaration
 * is a receiver-type annotation rather than an argument, so emitting one would
 * silently change the signature's arity and meaning. GIR's `this_` unescapes
 * straight onto it, which is why unescaping has to be checked rather than
 * assumed safe — and why such a member is refused instead of being given an
 * invented spelling that no header ever used.
 */
function reservedSourceParameterName(value: string): boolean {
  return value === "this";
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
/**
 * Spellings a string the CALLER must free arrives under.
 *
 * Disjoint from the borrowed set on purpose. Which set a spelling is in has
 * to agree with the transfer annotation, and checking that agreement is the
 * point — a `const char *` the SDK claims to transfer is a slot nobody could
 * free, and a `char *` it claims to keep is one the caller could write
 * through into storage it does not own.
 */
const ownedUtf8CTypes: ReadonlySet<string> = new Set([
  "char*",
  "gchar*",
]);

const emittedUtf8CTypes: ReadonlySet<string> = new Set([
  ...borrowedUtf8CTypes,
  "char*",
  "gchar*",
]);

/**
 * Why a callable cannot become a direct native binding, or null when it can.
 *
 * The two causes are reported apart because they mean different things to
 * whoever selected the member: one is metadata that cannot be bound at all,
 * and one is an explicit instruction to skip.
 */
function directEntryRefusal(callable: GirCallable): string | null {
  if (callable.cIdentifier === null) return "has no C identifier";
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
  const expectedAdapter = generateGObjectAdapterSource(
    options.snapshot,
    (options.importedNamespaces ?? []).map(({ snapshot }) => snapshot),
  );
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
    canonicalizeJson(options.gobjectAdapter.notifications) !==
      canonicalizeJson(expectedAdapter.notifications) ||
    canonicalizeJson(options.gobjectAdapter.valueMethods) !==
      canonicalizeJson(expectedAdapter.valueMethods) ||
    canonicalizeJson(options.gobjectAdapter.boxedResultMethods) !==
      canonicalizeJson(expectedAdapter.boxedResultMethods)
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

/**
 * The C spellings a NUL-terminated vector of UTF-8 strings arrives under.
 *
 * Both halves of the spelling vary independently — the SDK writes
 * `const char* const*` for a vector it keeps and `char**` for one it hands
 * over, with `gchar` variants of each — and neither says who frees it. The
 * transfer annotation does. Accepting all four narrows nothing for the same
 * reason the string set accepts two: the Clang probe proves the real type.
 */
const utf8VectorCTypes: ReadonlySet<string> = new Set([
  "char**",
  "gchar**",
  "const char**",
  "const gchar**",
  "const char* const*",
  "const gchar* const*",
]);

/**
 * Whether a GIR type is a vector of UTF-8 strings that ends at a NULL slot.
 *
 * `zero-terminated` is absent on most such declarations, and GIR's own
 * default for an array with neither a length nor a fixed size is that it is
 * terminated. That default is honoured ONLY when both of those are in fact
 * absent; a declaration carrying either is a COUNTED vector, which is a
 * different contract with no implementation, and one carrying an explicit
 * `zero-terminated="0"` says so itself. Everything ambiguous is refused,
 * because a vector walked to the wrong end is a read past the end rather
 * than a wrong answer.
 */
function nulTerminatedUtf8Vector(type: GirTypeReference): boolean {
  return type.kind === "array" &&
    type.element.kind === "named" &&
    borrowedStringGirTypes.has(type.element.name) &&
    type.cType !== null &&
    utf8VectorCTypes.has(type.cType) &&
    type.lengthParameter === null &&
    type.fixedSize === null &&
    type.zeroTerminated !== false;
}

/** The vector contract itself, identical in both directions apart from what
 * frees the vector — which is the whole of the difference, and is why this is
 * one object rather than two. */
function stringVectorMarshal(release?: string): MarshallingContract {
  return Object.freeze({
    kind: "string-vector",
    encoding: "utf-8",
    termination: "nul",
    embeddedNul: "reject",
    ...(release === undefined ? {} : { release }),
  });
}

function stringVectorParameter(
  parameter: GirParameter,
  path: string,
  diagnostics: CBindgenDiagnostic[],
): AbiParameter | null {
  if (
    parameter.kind !== "parameter" ||
    !nulTerminatedUtf8Vector(parameter.type) ||
    parameter.direction !== "in" ||
    /* The vector is built for the call out of a managed array the program
     * keeps, so the callee may not take it and may not keep it. Nullability
     * is allowed and means the source may omit the list, which reaches the
     * callee as NULL — a different thing from an empty vector, and the reason
     * several members take one. */
    parameter.transferOwnership !== "none" ||
    parameter.optional ||
    parameter.callerAllocates ||
    parameter.skip ||
    parameter.scope !== null ||
    parameter.closureParameter !== null ||
    parameter.destroyParameter !== null
  ) {
    diagnostics.push(diagnostic(
      path,
      "Only a required borrowed NUL-terminated vector of UTF-8 strings is implemented",
    ));
    return null;
  }
  return Object.freeze({
    name: manifestParameterName(parameter.name),
    type: parameter.nullable ? "nullable_const_utf8_vector" : "const_utf8_vector",
    passMode: "pointer",
    nullable: parameter.nullable,
    ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
    marshal: stringVectorMarshal(),
  });
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
    !borrowedStringGirTypes.has(parameter.type.name) ||
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
    name: manifestParameterName(parameter.name),
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
    /** Absent for the types whose source view is their own representation:
     * booleans, enumerations, and flags project through their own contracts. */
    readonly conversion?: NumberConversion | null;
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
    name: manifestParameterName(parameter.name),
    type: type.abiType,
    passMode: "value",
    nullable: false,
    ownership: Object.freeze({ kind: "value" }),
    ...(type.conversion === undefined || type.conversion === null
      ? {}
      : { conversion: type.conversion }),
  });
}

/**
 * A GObject class a projection may name.
 *
 * `sourceName` is the spelling the declaration file uses — the class's own
 * name locally, its import alias otherwise — and `cType` is what GIR must have
 * spelled to be naming this class at all. Local and imported classes differ in
 * where those come from and in nothing else, so one resolution serves both.
 */
interface HandleProjection {
  readonly typeId: string;
  readonly sourceName: string;
  readonly cType: string;
  /** True for a record projected as a handle. GIR spells such a pointer
   * `const GtkTextIter *` wherever the callee does not write through it, so
   * the receiver and the arguments have two accepted spellings for one
   * pointer. */
  readonly boxed: boolean;
  /** The binding this package must depend on to own one, or null when
   * another package declares the type and carries its destructor. */
  readonly localDestructor: string | null;
}

function handleParameter(
  parameter: GirParameter,
  resolveHandle: (girName: string, path: string) => HandleProjection | undefined,
  path: string,
  diagnostics: CBindgenDiagnostic[],
): { readonly abi: AbiParameter; readonly sourceType: string } | null {
  const className = parameter.type.kind === "named" ? parameter.type.name : null;
  const class_ = className === null ? undefined : resolveHandle(className, path);
  if (class_ === undefined) {
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
          "selected GObject classes — this namespace's or a supplied " +
          "import's — project; nothing else does yet",
    ));
    return null;
  }
  /* GIR states which side owns the object after the call. `none` leaves the
   * reference here and the callee borrows it for the call; `full` moves it,
   * which is what `gtk_widget_add_controller` does and what every event
   * controller needs. A moved handle is spent afterwards — the reference it
   * held is the callee's now — so the two are different contracts rather
   * than a detail of the same one. */
  const transferred = parameter.transferOwnership === "full";
  if (
    parameter.kind !== "parameter" ||
    parameter.type.kind !== "named" ||
    !instancePointerSpelling(parameter.type.cType, class_.cType, class_.boxed) ||
    parameter.direction !== "in" ||
    (parameter.transferOwnership !== "none" && !transferred) ||
    parameter.optional ||
    parameter.callerAllocates ||
    parameter.skip ||
    parameter.scope !== null ||
    parameter.closureParameter !== null ||
    parameter.destroyParameter !== null
  ) {
    diagnostics.push(
      diagnostic(
        path,
        "Only selected GObject handle inputs the callee borrows or takes are implemented",
      ),
    );
    return null;
  }
  return Object.freeze({
    abi: Object.freeze({
      name: manifestParameterName(parameter.name),
      type: class_.typeId,
      passMode: "pointer",
      /* GIR says whether the callee accepts absence, and absence is what
       * clears a child, unsets a transient parent, or declines a
       * cancellable. The ABI slot is one pointer either way; only the
       * source side gains a null arm, and a derived handle widens into it
       * through its declared identity upcast. */
      nullable: parameter.nullable,
      ownership: transferred
        ? Object.freeze({ kind: "owned", transfer: "to-native" })
        : Object.freeze({ kind: "borrowed", scope: "call" }),
    }),
    sourceType: parameter.nullable
      ? `${class_.sourceName} | null`
      : class_.sourceName,
  });
}

/**
 * Every input projection this package implements, in one ladder.
 *
 * The rungs are ordered by how specific the recognizer is: a string vector
 * before a string, a boolean before the enumeration that shares its storage,
 * and a handle last because it is the only rung that refuses by naming what
 * the type was not. That order is a property of the projections rather than
 * of any one call site, which is why it lives here.
 *
 * It exists as a function because it previously did not. Three call sites
 * projected parameters, and only the ordinary method path had all six rungs —
 * the borrowed-result and signal paths jumped straight to the handle rung, so
 * a `gint` argument on a method returning a borrowed object was refused as
 * "not a selected class". The type was always in the slice; the call site had
 * simply never been taught to ask. Sharing the ladder makes that class of gap
 * unrepresentable: a projection added here reaches every caller at once.
 */
function inputParameter(
  parameter: GirParameter,
  enumerations: ReadonlyMap<string, EnumerationProjection>,
  resolveHandle: (girName: string, path: string) => HandleProjection | undefined,
  path: string,
  diagnostics: CBindgenDiagnostic[],
): { readonly abi: AbiParameter; readonly sourceType: string } | null {
  /* Checked before any rung, because it is a property of the NAME rather than
   * of the type, and every rung would otherwise have to remember it. */
  if (reservedSourceParameterName(lowerCamel(parameter.name))) {
    diagnostics.push(diagnostic(
      path,
      `Parameter '${parameter.name}' unescapes to 'this', which TypeScript ` +
        "reads as a receiver annotation rather than an argument",
    ));
    return null;
  }
  if (nulTerminatedUtf8Vector(parameter.type)) {
    const abi = stringVectorParameter(parameter, path, diagnostics);
    /* `readonly` because the callee reads the vector and nothing writes back
     * through it. */
    return abi === null ? null : Object.freeze({
      abi,
      sourceType: parameter.nullable
        ? "readonly string[] | null"
        : "readonly string[]",
    });
  }
  if (
    parameter.type.kind === "named" &&
    borrowedStringGirTypes.has(parameter.type.name)
  ) {
    const abi = cStringParameter(
      parameter,
      parameter.nullable ? "nullable_const_utf8" : "const_utf8",
      path,
      diagnostics,
    );
    return abi === null ? null : Object.freeze({
      abi,
      sourceType: parameter.nullable ? "string | null" : "string",
    });
  }
  if (parameter.type.kind === "named" && parameter.type.name === "gboolean") {
    const abi = requiredValueParameter(
      parameter,
      { girName: "gboolean", cTypes: ["gboolean"], abiType: "gboolean" },
      path,
      diagnostics,
    );
    return abi === null ? null : Object.freeze({ abi, sourceType: "boolean" });
  }
  const enumeration = parameter.type.kind === "named"
    ? enumerations.get(parameter.type.name)
    : undefined;
  if (enumeration !== undefined) {
    const abi = requiredValueParameter(
      parameter,
      {
        girName: enumeration.girName,
        cTypes: [enumeration.cType],
        abiType: enumeration.typeId,
      },
      path,
      diagnostics,
    );
    return abi === null
      ? null
      : Object.freeze({ abi, sourceType: enumeration.sourceName });
  }
  const scalar = sourceScalarType(parameter.type);
  if (scalar !== undefined) {
    const abi = requiredValueParameter(parameter, scalar, path, diagnostics);
    return abi === null
      ? null
      : Object.freeze({ abi, sourceType: scalar.girName });
  }
  return handleParameter(parameter, resolveHandle, path, diagnostics);
}

function methodResult(
  callable: GirCallable,
  receiverName: string,
  nullableUtf8Type: string,
  enumerations: ReadonlyMap<string, EnumerationProjection>,
  resolveHandle: (girName: string, path: string) => HandleProjection | undefined,
  diagnostics: CBindgenDiagnostic[],
  path: string,
): AbiResult | null {
  const result = callable.result;
  /* A result the callee has already transferred. It handed back a reference
   * this side owns, so nothing has to take one: the call is direct, and what
   * releases the value is what its handle type names. A transfer of `none` is
   * the other shape, and goes through the adapter that references it.
   *
   * A failable member reaches here too. Its result is projected only after the
   * error slot has been read and found empty, so what arrives is a value the
   * callee produced on a path it called successful. */
  if (result.type.kind === "named" && result.transferOwnership === "full") {
    const handle = resolveHandle(result.type.name, path);
    if (handle !== undefined && result.type.cType === `${handle.cType}*`) {
      return Object.freeze({
        type: handle.typeId,
        passMode: "pointer",
        nullable: result.nullable,
        ownership: Object.freeze({ kind: "owned", transfer: "to-runtime" }),
      });
    }
  }
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
      ...(scalarType.conversion === null
        ? {}
        : { conversion: scalarType.conversion }),
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
    nulTerminatedUtf8Vector(result.type) &&
    result.scope === null &&
    result.closureParameter === null &&
    result.destroyParameter === null
  ) {
    /* Which symbol frees the vector is the whole of what the transfer says.
     * `full` hands over the elements too, so freeing the vector alone would
     * leak every string in it; `container` hands over only the vector, so
     * freeing the elements would free strings the SDK still owns. Two
     * symbols, one contract — and `none` frees nothing, which is a borrow
     * anchored to the receiver instead. */
    const release = result.transferOwnership === "full"
      ? "g_strfreev"
      : result.transferOwnership === "container"
        ? "g_free"
        : null;
    if (release === null) {
      return Object.freeze({
        type: result.nullable ? "nullable_const_utf8_vector" : "const_utf8_vector",
        passMode: "pointer",
        nullable: result.nullable,
        ownership: Object.freeze({
          kind: "borrowed",
          scope: "receiver",
          anchor: receiverName,
        }),
        marshal: stringVectorMarshal(),
      });
    }
    return Object.freeze({
      type: result.nullable ? "nullable_utf8_vector" : "utf8_vector",
      passMode: "pointer",
      nullable: result.nullable,
      /* The projection copies the elements and then frees the vector, so
       * nothing the program holds outlives this call because of it. */
      ownership: Object.freeze({ kind: "value" }),
      marshal: stringVectorMarshal(release),
    });
  }
  if (
    result.type.kind === "named" &&
    borrowedStringGirTypes.has(result.type.name) &&
    result.type.cType !== null &&
    (borrowedUtf8CTypes.has(result.type.cType) ||
      ownedUtf8CTypes.has(result.type.cType)) &&
    (result.transferOwnership === "none" || result.transferOwnership === "full") &&
    result.scope === null &&
    result.closureParameter === null &&
    result.destroyParameter === null
  ) {
    /* `full` means the caller frees the string once its bytes are copied, and
     * `g_free` is what frees it — a symbol rather than a policy, exactly as
     * for a vector, so an SDK with a different allocator changes the symbol
     * and nothing else. `none` frees nothing and anchors to the receiver
     * that keeps the storage. */
    const owned = result.transferOwnership === "full";
    /* The spelling must agree with who owns it. A string the callee keeps is
     * const; one it hands over is not, and admitting a const spelling there
     * would describe a slot nobody could free. */
    if (owned !== ownedUtf8CTypes.has(result.type.cType)) {
      diagnostics.push(diagnostic(
        path,
        "A UTF-8 result's C spelling must agree with its transfer: " +
          "a kept string is const and a transferred one is not",
      ));
      return null;
    }
    return Object.freeze({
      type: owned
        ? (result.nullable ? "nullable_utf8" : "utf8")
        : nullableUtf8Type,
      passMode: "pointer",
      nullable: result.nullable,
      ownership: owned
        ? Object.freeze({ kind: "value" })
        : Object.freeze({
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
        ...(owned ? { release: "g_free" } : {}),
      }),
    });
  }
  diagnostics.push(diagnostic(
    path,
    "Method result is outside the void/boolean/exact-scalar/borrowed-UTF-8 slice",
  ));
  return null;
}

/** The pointer spellings that name one instance: a bare pointer, and for a
 * boxed record the const one GIR uses wherever the callee only reads. */
function instancePointerSpelling(
  cType: string | null,
  nativeName: string,
  boxed: boolean,
): boolean {
  return cType === `${nativeName}*` ||
    (boxed && cType === `const ${nativeName}*`);
}

function isExactInstanceReceiver(
  parameter: GirParameter | undefined,
  class_: GirClass,
): parameter is GirParameter {
  return parameter?.kind === "instance" &&
    parameter.type.kind === "named" &&
    instancePointerSpelling(
      parameter.type.cType,
      class_.cType,
      class_.kind === "record",
    ) &&
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
    entry: Object.freeze({ symbol: input.symbol }),
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
    /* A string the caller must free. Not const, and that is the whole
     * difference from `const_utf8`: the spelling has to agree with the
     * transfer, so a slot nobody could free and a slot the caller could write
     * through are both refused rather than described. */
    utf8: Object.freeze({
      kind: "pointer",
      pointee: "i8",
      mutability: "mutable",
      nullable: false,
      addressSpace: 0,
    }),
    nullable_utf8: Object.freeze({
      kind: "pointer",
      pointee: "i8",
      mutability: "mutable",
      nullable: true,
      addressSpace: 0,
    }),
    /* `char **` and its spellings. The element is `const_utf8` in every case:
     * a vector whose elements the caller must free is spelled without the
     * inner `const` in C, but which pointer is const says nothing about who
     * frees it — the marshalling contract's `release` does, and reading a
     * lifetime out of a spelling is the inference this project forbids. The
     * OUTER const and nullability do have to match the position, because the
     * validator checks the slot against what the manifest declares. */
    const_utf8_vector: Object.freeze({
      kind: "pointer",
      pointee: "const_utf8",
      mutability: "const",
      nullable: false,
      addressSpace: 0,
    }),
    nullable_const_utf8_vector: Object.freeze({
      kind: "pointer",
      pointee: "const_utf8",
      mutability: "const",
      nullable: true,
      addressSpace: 0,
    }),
    utf8_vector: Object.freeze({
      kind: "pointer",
      pointee: "const_utf8",
      mutability: "mutable",
      nullable: false,
      addressSpace: 0,
    }),
    nullable_utf8_vector: Object.freeze({
      kind: "pointer",
      pointee: "const_utf8",
      mutability: "mutable",
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
    [...options.snapshot.classes, ...options.snapshot.interfaces].some((class_) =>
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
    readonly boxed: boolean;
    readonly releaseId: string;
    readonly package: PackageIdentity;
    readonly name: string;
    readonly alias: string;
    readonly cType: string;
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
    for (
      const class_ of [
        ...imported.snapshot.classes,
        ...imported.snapshot.interfaces,
        ...imported.snapshot.boxedRecords,
      ]
    ) {
      importedClasses.set(`${namespace}.${class_.name}`, Object.freeze({
        typeId: handleTypeId(namespace, class_),
        boxed: class_.kind === "record",
        releaseId: class_.kind === "record"
          ? `${namespace.toLowerCase()}_${class_.cSymbolPrefix}_free`
          : `${namespace.toLowerCase()}_${class_.cSymbolPrefix}_release`,
        package: imported.package,
        name: class_.name,
        alias: `${namespace}${class_.name}`,
        cType: class_.cType,
      }));
    }
  }
  const typeImports: Record<string, {
    readonly package: PackageIdentity;
    readonly type: string;
  }> = {};
  const importedDeclarationLines: string[] = [];

  /* A GObject interface is a handle with members, so every resolution that
   * asks "what class does this name?" answers for one too: a parameter typed
   * by an interface is as much a handle input as one typed by a class. */
  const declaredClasses = [
    ...options.snapshot.classes,
    ...options.snapshot.interfaces,
    ...options.snapshot.boxedRecords,
  ];
  /* Keyed as GIR spells the reference — bare for this namespace's own,
   * qualified for an imported one — so a result naming another namespace's
   * object resolves to the class that describes it. Which package owns it
   * decides the identity, not the shape rule. */
  const classByName = new Map([
    ...declaredClasses.map((class_) => [class_.name, class_] as const),
    ...(options.importedNamespaces ?? []).flatMap((imported) =>
      [
        ...imported.snapshot.classes,
        ...imported.snapshot.interfaces,
        ...imported.snapshot.boxedRecords,
      ].map((class_) =>
        [`${imported.snapshot.namespace.name}.${class_.name}`, class_] as const
      )
    ),
  ]);
  const interfaceNames = new Set(
    options.snapshot.interfaces.map((interface_) => interface_.name),
  );
  const typeIdByClass = new Map(declaredClasses.map((class_) => [
    class_.name,
    handleTypeId(options.snapshot.namespace.name, class_),
  ]));
  /**
   * Resolves a class another namespace declares, recording the manifest import
   * and the declaration-file import the first time it is reached. Returns
   * undefined when that namespace was not supplied to this generation.
   */
  function resolveImportedClass(
    key: string,
    path: string,
  ): HandleProjection | undefined {
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
        /* Owning one of these means releasing it through the owner's binding,
         * whose ID is derived by the same function that produced it there —
         * so the two agree by construction, and composition proves it. */
        destructor: imported.releaseId,
      });
      declarationTypes[imported.typeId] = Object.freeze({
        module: imported.package.name,
        name: imported.name,
      });
      importedDeclarationLines.push(
        `import type { ${imported.name} as ${imported.alias} } from "${imported.package.name}";`,
      );
    }
    return Object.freeze({
      typeId: imported.typeId,
      sourceName: imported.alias,
      cType: imported.cType,
      boxed: imported.boxed,
      localDestructor: null,
    });
  }

  /**
   * Resolves a class's cross-namespace parent. Returns undefined when the
   * parent's namespace was not supplied, which leaves the hierarchy
   * deliberately rooted here.
   */
  function resolveImportedParent(
    class_: GirClass,
    path: string,
  ): { readonly typeId: string; readonly alias: string } | undefined {
    if (class_.parent?.kind !== "external") return undefined;
    const imported = resolveImportedClass(
      `${class_.parent.namespace}.${class_.parent.name}`,
      path,
    );
    return imported === undefined
      ? undefined
      : Object.freeze({ typeId: imported.typeId, alias: imported.sourceName });
  }

  /**
   * The class a GIR type name denotes, wherever it is declared.
   *
   * A bare name is this namespace's; a qualified one is an import's, and
   * reaching it records the type import and the declaration-file import the
   * first time. An import that was not supplied resolves to nothing, so the
   * member naming it is refused with the same diagnostic an unselected local
   * class gets — the projection has no class either way.
   */
  function resolveHandle(
    girName: string,
    path: string,
  ): HandleProjection | undefined {
    /* A qualified name is another namespace's however `classByName` spells
     * it: that map answers "which class is this" for both, and only this
     * namespace's own classes have a local identity. */
    const local = girName.includes(".") ? undefined : classByName.get(girName);
    if (local !== undefined) {
      const typeId = typeIdByClass.get(local.name);
      return typeId === undefined ? undefined : Object.freeze({
        typeId,
        sourceName: local.name,
        cType: local.cType,
        boxed: local.kind === "record",
        localDestructor: localReleaseId(local),
      });
    }
    return girName.includes(".")
      ? resolveImportedClass(girName, path)
      : undefined;
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

  /* A `notify::` registration is a signal connection like any other, so it
   * needs the shared connection type even when no GIR signal is selected. */
  const hasSignals = [
    ...options.snapshot.classes,
    ...options.snapshot.interfaces,
  ].some((class_) => class_.signals.length > 0 || class_.notify.length > 0);
  const namespacePrefix = options.snapshot.namespace.name.toLowerCase();
  const releaseByClass = new Map(
    options.gobjectAdapter.classReleases.map((release) => [
      release.className,
      release,
    ]),
  );
  /* Where each class's release lives, taken from the adapter rather than
   * recomputed: one decision, read twice. */
  const releaseHostByClass = new Map(
    options.gobjectAdapter.classReleases.map((release) => [
      release.className,
      release.hostClassName,
    ]),
  );
  /**
   * The binding that releases one instance of a class this namespace declares.
   *
   * One `g_object_unref` ends this program's claim on a GObject whatever
   * produced the reference, so a whole upcast chain shares ONE release, named
   * for the topmost class this package can reach. Which class hosts it is the
   * adapter's decision, read here rather than recomputed.
   *
   * This exists as a function because the formula was written twice and only
   * one copy consulted the host. The other — the one that answers "what
   * releases this handle?" for a member's result — spelled the id from the
   * class's OWN symbol prefix, so every class that had collapsed onto an
   * ancestor produced a dependency on a release binding that no longer
   * existed. Gtk never saw it because its chains collapse onto classes it
   * declares itself; generating Gio failed on the first member returning a
   * FileOutputStream, whose release lives on an ancestor.
   *
   * A boxed record is the other shape: its free is a destructor of its own
   * and belongs to that record alone, so it never collapses.
   */
  function localReleaseId(class_: GirClass): string {
    const boxed = class_.kind === "record";
    const host = boxed
      ? class_.name
      : releaseHostByClass.get(class_.name) ?? class_.name;
    const hostPrefix = boxed
      ? class_.cSymbolPrefix
      : classByName.get(host)?.cSymbolPrefix ?? class_.cSymbolPrefix;
    return `${namespacePrefix}_${hostPrefix}_${boxed ? "free" : "release"}`;
  }

  const adapterByRetainedResult = new Map(
    options.gobjectAdapter.retainedResultMethods.map((method) => [
      method.id,
      method,
    ]),
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
  /* A converted scalar's declaration is a transparent alias, so it needs no
   * brand. The brand symbol is emitted only for what still carries an exact
   * representation: gdouble, the 64-bit integers, and every enumeration. */
  const brandedSourceScalars = usedSourceScalars.filter(
    (scalar) => scalar.conversion === null,
  );
  const convertedSourceScalars = usedSourceScalars.filter(
    (scalar) => scalar.conversion !== null,
  );
  const hasExactSourceTypes = brandedSourceScalars.length > 0 ||
    options.snapshot.enumerations.length > 0;
  const declarationLines = [
    ...(hasExactSourceTypes
      ? ["declare const nativeScalar: unique symbol;"]
      : []),
    ...[...options.snapshot.classes, ...options.snapshot.interfaces].map((class_) =>
      `declare const ${handleBrand(class_.name)}: unique symbol;`
    ),
    ...(hasSignals ? ["declare const nativeResourceSignalConnection: unique symbol;"] : []),
    "",
    ...(usedSourceScalars.length > 0
      ? [
          /* The GLib spelling stays in every signature because it says what
           * the value means; the alias is transparent so the value behaves
           * like the number it is. */
          ...convertedSourceScalars.map((scalar) =>
            `export type ${scalar.girName} = number;`
          ),
          ...brandedSourceScalars.map((scalar) =>
            `export type ${scalar.girName} = ${scalar.carrier} & { readonly [nativeScalar]: "${scalar.girName}" };`
          ),
          "",
          /* A branded scalar keeps its exact representation, so its value
           * cannot be printed or measured without saying so. Its arithmetic
           * needs no declaration — `(a / b) as gint64` is an ordinary
           * operator expression inside the construction that names the exact
           * type — but a conversion has no operator to be, and cannot borrow
           * `Number(v)`, which rounds silently where this one refuses. The
           * compiler lowers these to one Native IR node each: no symbol, no
           * runtime object. */
          ...brandedSourceScalars.flatMap((scalar) => [
            `export declare namespace ${scalar.girName} {`,
            `  function toNumber(value: ${scalar.girName}): number;`,
            `  function fromNumber(value: number): ${scalar.girName};`,
            "}",
            "",
          ]),
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
  const adapterByNotify = new Map(
    options.gobjectAdapter.notifications.map((notify) => [notify.id, notify]),
  );
  const adapterByValueMethod = new Map(
    options.gobjectAdapter.valueMethods.map((method) => [method.id, method]),
  );
  const adapterByBoxedResult = new Map(
    options.gobjectAdapter.boxedResultMethods.map((method) => [method.id, method]),
  );
  const typeIdByRecord = new Map<string, string>();
  /* What the declaration file calls each projected record: its own name
   * locally, its import alias for a foreign one. */
  const recordSourceNameByTypeId = new Map<string, string>();
  /* A scalar's SCABI identity is its own abiType, so a scalar output resolves
   * without the record table. Every scalar a method reaches is already
   * registered above, out-parameters included. The whole entry is kept rather
   * than just the ID: a scalar's source-visible carrier travels with it. */
  const scalarByGirName = new Map(
    sourceScalarTypes.map((scalar) => [scalar.girName, scalar]),
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
      const memberName = enumerationMemberName(member.name);
      const declaration = `${enum_.name}.${memberName}`;
      const bindingId = `${namespacePrefix}_${snakeCase(enum_.name)}_${snakeCase(member.name)}`;
      /* Separated because they are different failures with different fixes: a
       * name TypeScript cannot spell is a gap in the naming rule above, while
       * two members landing on one name is a genuine ambiguity in the source
       * that no rule here may paper over. */
      if (!identifierPattern.test(memberName)) {
        diagnostics.push(diagnostic(
          `${path}/member/${member.name}`,
          `Enumeration member projects to '${memberName}', which is not a ` +
            "TypeScript identifier",
        ));
        valid = false;
        continue;
      }
      if (
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
      members[enumerationMemberName(member.name)] = member.value;
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

  /**
   * Projects a layout record, whichever namespace declares it.
   *
   * A layout record is a VALUE, and that is what makes a foreign one
   * projectable at all. It reaches TypeScript as a plain object and reaches C
   * as bytes this package lays out itself; no pointer into another package's
   * memory ever crosses, so the two packages have nothing to agree about at
   * runtime and there is no identity to import. What a consumer needs is the
   * size and the field offsets, and it can prove those against its own
   * headers — `gtk/gtk.h` includes `gdk/gdk.h`.
   *
   * So a foreign record is DEFINED HERE FOR ITS ABI and DECLARED AS THE
   * OWNING PACKAGE'S FOR ITS IDENTITY, which is exactly what a foreign
   * enumeration already does. The type id is the owner's, because that is
   * what the record is; the layout under it is this package's own proof.
   * Independent proof is the point rather than duplicated work: two packages
   * built from different SDK headers disagree here rather than at a call.
   *
   * The declaration BODY belongs to the owner. This package imports the
   * interface under a namespace-qualified alias rather than restating the
   * fields, so a `Gdk.Rectangle` handed to a Gtk member is the same
   * TypeScript type the Gdk package exports.
   */
  function projectRecord(
    namespaceName: string,
    record: GirRecord,
    owner: PackageIdentity | undefined,
  ): void {
    const path = `${namespaceName}/${record.name}`;
    const evidence = recordEvidenceById.get(`${namespaceName}.${record.name}.record`);
    const recordPrefix = namespaceName.toLowerCase();
    const sourceName = owner === undefined
      ? record.name
      : `${namespaceName}${record.name}`;
    const typeId = `${recordPrefix}_${record.cSymbolPrefix ?? snakeCase(record.name)}`;
    const fields = record.fields.map((field, fieldIndex) => {
      const scalar = sourceScalarType(field.type);
      if (scalar === undefined) {
        /* A SELECTED record must project or say why. A foreign one was only
         * REACHED, so this package declines to project it and the member
         * naming it is refused where the reference is — which names the
         * member and the type, as a field path cannot. */
        if (owner === undefined) {
          diagnostics.push(diagnostic(
            `${path}/fields/${fieldIndex}`,
            "Selected record field is outside the exact scalar projection",
          ));
        }
        return null;
      }
      const fieldEvidence = evidence?.fields[fieldIndex];
      if (fieldEvidence === undefined) return null;
      return Object.freeze({
        name: field.name,
        type: scalar.abiType,
        offset: fieldEvidence.offset,
        ...(scalar.conversion === null ? {} : { conversion: scalar.conversion }),
      });
    });
    if (
      evidence === undefined ||
      fields.some((field) => field === null) ||
      types[typeId] !== undefined ||
      declarationTypes[typeId] !== undefined ||
      (owner !== undefined &&
        (classByName.has(sourceName) || declarations.has(sourceName)))
    ) {
      if (
        owner === undefined && evidence !== undefined &&
        fields.every((field) => field !== null)
      ) {
        diagnostics.push(diagnostic(path, "Generated record identity collides"));
      }
      return;
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
    declarationTypes[typeId] = Object.freeze({
      module: owner === undefined ? "." : owner.name,
      name: record.name,
    });
    /* Keyed as GIR spells the reference: bare for this namespace's own,
     * qualified for a foreign one, so one lookup answers both. */
    typeIdByRecord.set(
      owner === undefined ? record.name : `${namespaceName}.${record.name}`,
      typeId,
    );
    recordSourceNameByTypeId.set(typeId, sourceName);
    if (owner === undefined) {
      declarationLines.push(
        `export interface ${record.name} {`,
        ...record.fields.map((field) => {
          const scalar = sourceScalarType(field.type);
          return `  readonly ${lowerCamel(field.name)}: ${scalar?.girName ?? "never"};`;
        }),
        "}",
        "",
      );
      return;
    }
    importedDeclarationLines.push(
      `import type { ${record.name} as ${sourceName} } from "${owner.name}";`,
    );
  }

  for (const record of options.snapshot.records) {
    projectRecord(options.snapshot.namespace.name, record, undefined);
  }
  // Only records this package REACHES are projected, matching the probe
  // exactly, so evidence and declarations cover the same set.
  for (const imported of options.importedNamespaces ?? []) {
    const namespace = imported.snapshot.namespace.name;
    for (const record of imported.snapshot.records) {
      if (!reachedForeign.has(`${namespace}.${record.name}`)) continue;
      projectRecord(namespace, record, imported.package);
    }
  }
  for (const method of options.gobjectAdapter.valueMethods) {
    const path = `${options.snapshot.namespace.name}/${method.className}/method/${method.sourceSymbol}/result`;
    const evidenceId = `${options.snapshot.namespace.name}.${method.id}.result`;
    const evidence = options.evidence.records.find((record) => record.id === evidenceId);
    const typeId = `${namespacePrefix}_${snakeCase(method.resultName)}`;
    /* The answer leads the record, so an output's evidence sits one field
     * later. Its declared TYPE is the namespace's boolean — that is how the
     * manifest says "read this as a boolean", and the translator turns the
     * type into the projection rather than a second marker doing it. */
    const answerOffset = method.answers ? 1 : 0;
    const answerField = method.answers
      ? [Object.freeze({
          name: ANSWER_FIELD,
          type: "gboolean",
          offset: evidence?.fields[0]?.offset ?? 0,
        })]
      : [];
    const fields = [...answerField, ...method.outputs.map((output, index) => {
      const fieldEvidence = evidence?.fields[index + answerOffset];
      const scalar = output.kind === "record"
        ? undefined
        : scalarByGirName.get(output.sourceName);
      const fieldType = output.kind === "record"
        ? typeIdByRecord.get(output.sourceName)
        : scalar?.abiType;
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
        ...(scalar?.conversion == null ? {} : { conversion: scalar.conversion }),
      });
    })];
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
      ...(method.answers ? [`  readonly ${ANSWER_FIELD}: boolean;`] : []),
      ...method.outputs.map((output) => {
        /* A record output's GIR spelling is not its TypeScript name: a
         * foreign one is declared under the import alias, and `Gdk.Rectangle`
         * is not an identifier. */
        const declared = output.kind === "record"
          ? recordSourceNameByTypeId.get(
              typeIdByRecord.get(output.sourceName) ?? "",
            ) ?? output.sourceName
          : output.sourceName;
        return `  readonly ${output.fieldName}: ${declared};`;
      }),
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
        destructor: signalReleaseId,
      });
      declarationTypes[signalConnectionTypeId] = Object.freeze({
        module: ".",
        name: "SignalConnection",
      });
      bindings[signalDisconnectId] = callableBase({
        declaration: signalDisconnectDeclaration,
        kind: "method",
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

  /* The SCABI position for one argument an adapter forwards untouched. Each
   * family names its type by its own route, and each is already registered by
   * whatever else in this package reached it — so this is a lookup rather than
   * a projection, shared by every adapter that forwards rather than replaces. */
  function forwardedInputProjection(
    input: GObjectValueMethodInputAdapter,
  ): { readonly abi: AbiParameter; readonly sourceName: string } | null {
    const value = (type: string, sourceName: string, conversion: NumberConversion | null) =>
      Object.freeze({
        abi: Object.freeze({
          name: manifestParameterName(input.parameterName),
          type,
          passMode: "value" as const,
          nullable: false,
          ownership: Object.freeze({ kind: "value" as const }),
          ...(conversion === null ? {} : { conversion }),
        }),
        sourceName,
      });
    if (input.kind === "scalar") {
      const scalar = scalarByGirName.get(input.sourceName);
      return scalar === undefined
        ? null
        : value(scalar.abiType, scalar.girName, scalar.conversion);
    }
    if (input.kind === "enumeration") {
      const enumeration = enumerations.get(input.sourceName);
      return enumeration === undefined
        ? null
        : value(enumeration.typeId, enumeration.sourceName, null);
    }
    const handle = typeIdByClass.get(input.sourceName);
    /* An absent object is spelled by the pointer itself, so the source type
     * carries the union and the ABI slot carries the nullability — the same
     * pair an ordinary handle parameter uses. */
    return handle === undefined ? null : Object.freeze({
      abi: Object.freeze({
        name: manifestParameterName(input.parameterName),
        type: handle,
        passMode: "pointer" as const,
        nullable: input.nullable === true,
        ownership: Object.freeze({ kind: "borrowed" as const, scope: "call" as const }),
      }),
      sourceName: input.nullable === true
        ? `${input.sourceName} | null`
        : input.sourceName,
    });
  }

  for (const class_ of declaredClasses) {
    const classPath = `${options.snapshot.namespace.name}/${class_.name}`;
    const typeId = typeIdByClass.get(class_.name)!;
    /* A GObject is released by dropping a reference, which does not vary by
     * class — one `g_object_unref` ends this program's claim on it, whatever
     * produced the reference. So one release serves an upcast chain, named
     * for the topmost class this package can REACH, and every class beneath
     * it names that one. A boxed record is released by the free it declares,
     * which is already a destructor and belongs to that record alone.
     *
     * Which class hosts the release is the adapter's decision, made once and
     * read here, so the generated C and the manifest cannot disagree about
     * where the symbol lives. */
    const boxed = class_.kind === "record";
    const releaseHost = boxed
      ? class_.name
      : releaseHostByClass.get(class_.name) ?? class_.name;
    const releaseId = localReleaseId(class_);
    const releaseDeclaration = `${releaseHost}.dispose`;
    /* Only the host reserves the release's identity. Every class beneath it
     * NAMES the same binding — that is the point — so a subclass finding it
     * already there is the design working rather than a collision. */
    const hostsRelease = releaseHost === class_.name;
    if (
      types[typeId] !== undefined ||
      declarationTypes[typeId] !== undefined ||
      (hostsRelease && (boxed || releaseByClass.has(class_.name)) &&
        (bindings[releaseId] !== undefined || declarations.has(releaseDeclaration)))
    ) {
      diagnostics.push(diagnostic(classPath, "Generated GObject class identity collides"));
      continue;
    }
    // Resolved after the collision guard so a rejected class cannot leave an
    // import behind it.
    const importedParent = resolveImportedParent(class_, classPath);
    /* GIR lists every interface a class implements, inherited ones included,
     * so the edges an ancestor already carries are dropped: the upcast graph
     * states each relationship once, and the merged declarations do too. */
    const inheritedInterfaces = new Set<string>();
    for (
      let ancestor = class_.parent?.kind === "internal"
        ? classByName.get(class_.parent.name)
        : undefined;
      ancestor !== undefined;
      ancestor = ancestor.parent?.kind === "internal"
        ? classByName.get(ancestor.parent.name)
        : undefined
    ) {
      for (const implemented of ancestor.interfaces) {
        if (implemented.kind === "internal") inheritedInterfaces.add(implemented.name);
      }
    }
    const implementedInterfaces = class_.interfaces
      .filter((implemented) =>
        implemented.kind === "internal" &&
        !inheritedInterfaces.has(implemented.name) &&
        interfaceNames.has(implemented.name)
      )
      .map((implemented) => implemented.name);
    types[typeId] = Object.freeze({
      kind: "handle",
      nativeName: class_.cType,
      threadSafety: "confined",
      /* How a value is released follows what it names rather than the call
       * that produced one, so the type names it. That is what lets a package
       * that imports this type own one. */
      destructor: releaseId,
      /* A GObject's identity is its pointer, so two projections of one widget
       * intern to one cell. A boxed record's is not: `copy` makes a second
       * object with its own address and the same contents, and `equal` is
       * how GTK asks whether two of them mean the same thing. */
      identity: boxed ? "none" : "pointer",
      // Canonically ordered, because more than one edge is now ordinary: a
      // class upcasts to its parent and to each interface it adds.
      upcasts: Object.freeze([
        ...(class_.parent?.kind === "internal"
          ? [Object.freeze({
              kind: "identity" as const,
              target: typeIdByClass.get(class_.parent.name)!,
            })]
          : importedParent === undefined
            ? []
            : [Object.freeze({
                kind: "identity" as const,
                target: importedParent.typeId,
              })]),
        /* An implemented interface is the same pointer under another
         * nominal type, which is exactly what an identity upcast says. */
        ...implementedInterfaces.map((name) =>
          Object.freeze({
            kind: "identity" as const,
            target: typeIdByClass.get(name)!,
          })
        ),
      ].sort((left, right) => compareText(left.target, right.target))),
    });
    declarationTypes[typeId] = Object.freeze({ module: ".", name: class_.name });
    /* A boxed record's destructor is the free it declares: an ordinary direct
     * call that takes the pointer and returns nothing, which is what a
     * destructor is, so there is no adapter and no dependency on one. */
    if (boxed) {
      const free = class_.boxed?.free;
      /* A release takes the value and answers nothing. Its receiver may be
       * nullable — `g_bytes_unref` accepts null — which changes nothing here:
       * the runtime calls a destructor only with a live pointer, so the
       * binding declares the narrower contract it actually uses. */
      const releaseReceiver = free?.parameters[0];
      const releasesOne = free !== undefined &&
        free.cIdentifier !== null &&
        free.parameters.length === 1 &&
        releaseReceiver?.kind === "instance" &&
        releaseReceiver.type.kind === "named" &&
        instancePointerSpelling(releaseReceiver.type.cType, class_.cType, true) &&
        releaseReceiver.direction === "in" &&
        !releaseReceiver.optional &&
        !releaseReceiver.skip &&
        free.result.type.kind === "named" &&
        free.result.type.cType === "void" &&
        !free.throws;
      /* GIR annotates the instance parameter of every GLib free function as
       * `transfer-ownership="none"`, which is wrong of it and uniformly so,
       * so what the contract rests on is the pairing GIR does state — a copy
       * that hands back a full transfer — and the shapes of the two. */
      const duplicatesOne = class_.boxed !== null &&
        class_.boxed.copy.cIdentifier !== null &&
        class_.boxed.copy.parameters.length === 1 &&
        isExactInstanceReceiver(class_.boxed.copy.parameters[0], class_) &&
        class_.boxed.copy.result.transferOwnership === "full" &&
        class_.boxed.copy.result.type.kind === "named" &&
        class_.boxed.copy.result.type.name === class_.name &&
        !class_.boxed.copy.result.nullable;
      if (!releasesOne || !duplicatesOne) {
        diagnostics.push(diagnostic(
          classPath,
          "A boxed record projects through a copy that hands back a full " +
            "transfer of itself and a free that takes one and returns nothing",
        ));
        continue;
      }
      bindings[releaseId] = callableBase({
        declaration: releaseDeclaration,
        kind: "method",
        symbol: free.cIdentifier!,
        parameters: [Object.freeze({
          name: class_.cSymbolPrefix,
          type: typeId,
          passMode: "pointer",
          /* Unlike a reference drop, a free is not defined on a null pointer,
           * and the runtime never calls a destructor without a live one. */
          nullable: false,
          ownership: Object.freeze({ kind: "owned", transfer: "to-native" }),
        })],
        result: Object.freeze({
          type: "void",
          passMode: "value",
          nullable: false,
          ownership: Object.freeze({ kind: "value" }),
        }),
        dependencies: dependencies({ links: linkIds }),
      });
      declarations.add(releaseDeclaration);
    }
    /* Exactly the classes something destroys: constructed here, or handed back
     * without a reference by a method whose adapter takes one. A release
     * nothing names is refused as an ownership-consuming call outside the
     * destructor slice, so the adapter computes the set and this follows it. */
    const classRelease = releaseByClass.get(class_.name);
    if (classRelease !== undefined && hostsRelease) {
      bindings[releaseId] = callableBase({
        declaration: releaseDeclaration,
        kind: "method",
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
    /* An interface has no construction and no parent, so it is declared as
     * what it is. A class that implements one merges with it below rather
     * than redeclaring its members: the member keeps one declaration, so one
     * binding serves every implementer, exactly as an inherited method does. */
    const classLines = [
      class_.kind === "class"
        ? `export declare ${class_.abstract ? "abstract " : ""}class ${class_.name}${extendsName === undefined ? "" : ` extends ${extendsName}`} {`
        : `export interface ${class_.name} {`,
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
        borrowedStringGirTypes.has(getter.result.type.name);
    }

    /* What a property's two accessors have to agree about: the TYPE, not the
     * SDK's spelling of the pointer to it.
     *
     * A getter that hands over storage writes `char **` where the setter that
     * borrows it writes `const char *const *`; a setter accepting a subclass
     * receiver writes `GtkWidget *` where the getter writes `GtkPopover *`.
     * GIR names the same type in both, and what differs is per-position —
     * ownership and constness, which this generator already projects
     * separately and which do not make one property into two.
     *
     * Comparing the raw reference compared the spelling too, and refused
     * fifteen of GTK's eighteen accessor pairs for saying the same thing
     * twice in C. */
    const logicalType = (type: GirTypeReference): unknown =>
      type.kind === "array"
        ? {
            kind: type.kind,
            lengthParameter: type.lengthParameter,
            fixedSize: type.fixedSize,
            zeroTerminated: type.zeroTerminated,
            element: logicalType(type.element),
          }
        : {
            kind: type.kind,
            name: type.name,
            arguments: type.arguments.map(logicalType),
          };
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
        canonicalizeJson(logicalType(accessors.getter.result.type)) !==
          canonicalizeJson(logicalType(setterValue.type))
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
        /* Local or imported, one resolution: the type is whichever package
         * declares the class, and the release is that package's. */
        const resultHandle = callable.result.type.kind === "named"
          ? resolveHandle(callable.result.type.name, path)
          : undefined;
        const resultTypeId = resultHandle?.typeId;
        const resultLocal = typeIdByClass.has(borrowedResult.name) &&
          typeIdByClass.get(borrowedResult.name) === resultTypeId;
        if (
          retained === undefined ||
          resultTypeId === undefined ||
          resultHandle === undefined ||
          (resultLocal && !releaseByClass.has(borrowedResult.name))
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
          const input = inputParameter(
            parameter,
            enumerations,
            resolveHandle,
            `${path}/parameters/${index}`,
            diagnostics,
          );
          if (input === null) {
            retainedValid = false;
            continue;
          }
          retainedParameters.push(input.abi);
          retainedSourceParameters.push(
            `${lowerCamel(parameter.name)}: ${input.sourceType}`,
          );
        }
        if (!retainedValid) continue;
        const sourceMember = lowerCamel(callable.name);
        const declaration = `${class_.name}.${sourceMember}`;
        const bindingId =
          `${namespacePrefix}_${class_.cSymbolPrefix}_${snakeCase(callable.name)}`;
        /* An imported class's release is the owner's binding, carried by the
         * import rather than declared here, so this package depends on
         * nothing for it. */
        const resultReleaseId = resultLocal
          ? `${namespacePrefix}_${borrowedResult.cSymbolPrefix}_release`
          : null;
        if (bindings[bindingId] !== undefined || declarations.has(declaration)) {
          diagnostics.push(diagnostic(path, "Generated method identity collides"));
          continue;
        }
        bindings[bindingId] = callableBase({
          declaration,
          kind: "method",
          symbol: retained.adapterSymbol,
          parameters: retainedParameters,
          result: Object.freeze({
            type: resultTypeId,
            passMode: "pointer",
            nullable: callable.result.nullable,
            ownership: Object.freeze({ kind: "owned", transfer: "to-runtime" }),
          }),
          /* Never the nullable error contract: that one says NULL means the
           * call failed, and a reader's NULL does not. GIR decides which shape
           * the result takes instead — `T | null` when the object can be
           * absent, and a plain `T` when it cannot, where a NULL would mean
           * the library broke its own contract and traps on commit. */
          error: Object.freeze({ kind: "no-fail" }),
          dependencies: dependencies({
            bindings: resultReleaseId === null ? [] : [resultReleaseId],
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
            resultHandle.sourceName
          }${callable.result.nullable ? " | null" : ""};`,
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
      /* A method that fills caller-allocated storage with a boxed record: the
       * adapter reserved the storage and handed back a copy, so what reaches
       * here is an ordinary owned handle whose type names what frees it. */
      const boxedResult = adapterByBoxedResult.get(
        `${class_.name}.method.${callable.name}`,
      );
      if (boxedResult !== undefined) {
        const resultHandle = resolveHandle(boxedResult.resultName, path);
        const inputs = boxedResult.inputs.map(forwardedInputProjection);
        if (
          resultHandle === undefined ||
          resultHandle.localDestructor === null ||
          inputs.some((input) => input === null)
        ) {
          diagnostics.push(diagnostic(
            path,
            "A boxed record result must name a record this package projects",
          ));
          continue;
        }
        const sourceMember = lowerCamel(callable.name);
        const declaration = `${class_.name}.${sourceMember}`;
        const bindingId = boxedResult.adapterSymbol;
        if (bindings[bindingId] !== undefined || declarations.has(declaration)) {
          diagnostics.push(diagnostic(path, "Generated boxed result identity collides"));
          continue;
        }
        declarations.add(declaration);
        bindings[bindingId] = callableBase({
          declaration,
          kind: "method",
          symbol: boxedResult.adapterSymbol,
          parameters: [
            Object.freeze({
              name: manifestParameterName(receiver.name),
              type: typeId,
              passMode: "pointer",
              nullable: false,
              ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
            }),
            ...inputs.map((input) => input!.abi),
          ],
          /* An answering member reports absence with NULL, which is an
           * answer rather than a failure — no error contract is declared,
           * so the projection is a plain nullable handle. */
          result: Object.freeze({
            type: resultHandle.typeId,
            passMode: "pointer",
            nullable: boxedResult.answers,
            ownership: Object.freeze({ kind: "owned", transfer: "to-runtime" }),
          }),
          dependencies: dependencies({
            bindings: [resultHandle.localDestructor],
            links: linkIds,
            adapter: options.adapterInput.id,
          }),
          availability: availability(class_, callable),
        });
        adapterBindings.push(bindingId);
        classLines.push(
          ...deprecationDoc(callable, "  "),
          `  ${sourceMember}(${inputs.map((input, index) =>
            `${lowerCamel(boxedResult.inputs[index]!.parameterName)}: ${input!.sourceName}`
          ).join(", ")}): ${
            boxedResult.answers
              ? `${resultHandle.sourceName} | null`
              : resultHandle.sourceName
          };`,
        );
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
        const inputProjections = valueMethod.inputs.map(forwardedInputProjection);
        if (
          callable.parameters.length !==
            valueMethod.outputs.length + valueMethod.inputs.length + 1 ||
          types[resultTypeId]?.kind !== "struct" ||
          /* Membership in the projection tables is the test, not presence in
           * `types`: a class's handle type is registered by this same loop, so
           * a class declared later than its user is absent here and present by
           * the end. A class that fails to register at all fails the whole
           * package on its own collision diagnostic. */
          inputProjections.some((input) => input === null)
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
          symbol: valueMethod.adapterSymbol,
          parameters: [
            Object.freeze({
              name: manifestParameterName(receiver.name),
              type: typeId,
              passMode: "pointer",
              nullable: false,
              ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
            }),
            ...inputProjections.map((input) => input!.abi),
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
          `  ${sourceMember}(${inputProjections.map((input, index) =>
            `${lowerCamel(valueMethod.inputs[index]!.parameterName)}: ${input!.sourceName}`
          ).join(", ")}): ${valueMethod.resultName};`,
        );
        continue;
      }
      const sourceParameters: string[] = [];
      const sourceParameterTypes: string[] = [];
      const abiParameters: AbiParameter[] = [Object.freeze({
        name: manifestParameterName(receiver.name),
        type: typeId,
        passMode: "pointer",
        nullable: false,
        ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
      })];
      let valid = true;
      for (const [index, parameter] of callable.parameters.slice(1).entries()) {
        const parameterPath = `${path}/parameters/${index + 1}`;
        const input = inputParameter(
          parameter,
          enumerations,
          resolveHandle,
          parameterPath,
          diagnostics,
        );
        if (input === null) {
          valid = false;
        } else {
          abiParameters.push(input.abi);
          sourceParameters.push(
            `${lowerCamel(parameter.name)}: ${input.sourceType}`,
          );
          sourceParameterTypes.push(input.sourceType);
        }
      }
      const result = methodResult(
        callable,
        manifestParameterName(receiver.name),
        callable.result.nullable ? "nullable_const_utf8" : "const_utf8",
        enumerations,
        resolveHandle,
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
      /* Owning the result means depending on whatever releases it, which is
       * this package's binding for a type it declares and nothing at all for
       * one it imports. */
      const resultDestructor = result.ownership.kind === "owned" &&
          callable.result.type.kind === "named"
        ? resolveHandle(callable.result.type.name, `${path}/result`)?.localDestructor
        : undefined;
      /* A member that reports failure through a GError binds its own symbol
       * and says so in its contract. GIR omits the trailing `GError **` from
       * the parameter list because it is not the caller's to supply — the
       * compiler allocates the slot, passes its address, and reads it back —
       * so the parameters here are the visible ones and nothing else. */
      if (callable.throws && options.gobjectAdapter.errorSupport === null) {
        diagnostics.push(diagnostic(
          `${path}/error`,
          "GObject adapter is missing this namespace's error accessors",
        ));
        continue;
      }
      const errorContract = callable.throws
        ? Object.freeze({
            kind: "error-out" as const,
            message: errorMessageBindingId,
            release: errorReleaseBindingId,
          })
        : undefined;
      bindings[bindingId] = callableBase({
        declaration,
        kind: propertyKind ?? "method",
        symbol: callable.cIdentifier,
        parameters: abiParameters,
        result,
        ...(errorContract === undefined ? {} : { error: errorContract }),
        dependencies: dependencies({
          bindings: [
            ...(resultDestructor == null ? [] : [resultDestructor]),
            ...(errorContract === undefined
              ? []
              : [errorMessageBindingId, errorReleaseBindingId]),
          ],
          links: linkIds,
        }),
        availability: availability(class_, callable),
      });
      const scalarResult = sourceScalarType(callable.result.type);
      const enumerationResult = callable.result.type.kind === "named"
        ? enumerations.get(callable.result.type.name)
        : undefined;
      const handleResult = result.ownership.kind === "owned" &&
          callable.result.type.kind === "named"
        ? resolveHandle(callable.result.type.name, `${path}/result`)
        : undefined;
      const sourceResult = callable.result.type.cType === "void"
        ? "void"
        : handleResult !== undefined
          ? `${handleResult.sourceName}${callable.result.nullable ? " | null" : ""}`
        : callable.result.type.kind === "named" &&
            callable.result.type.name === "gboolean"
          ? "boolean"
          : scalarResult !== undefined
            ? scalarResult.girName
            : enumerationResult !== undefined
              ? enumerationResult.sourceName
            /* A vector reads as a plain array the program owns: the elements
             * were copied out of the callee's storage, so nothing here is a
             * view of anything. */
            : nulTerminatedUtf8Vector(callable.result.type)
              ? callable.result.nullable ? "string[] | null" : "string[]"
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
    /* One connect binding, shared by GIR signals and `notify::` registrations.
     * Both hand the runtime a callback anchored to the instance and get back a
     * cancellable connection; they differ only in what the emission carries,
     * which is settled before this runs. */
    function emitSignalRegistration(registration: {
      readonly path: string;
      /** The GIR member this registration inherits availability and
       * deprecation from: the signal itself, or a property's getter. */
      readonly callable: GirCallable;
      readonly callbackTypeId: string;
      readonly connectId: string;
      readonly declaration: string;
      readonly member: string;
      readonly connectSymbol: string;
      readonly parameters: readonly AbiParameter[];
      readonly sourceParameters: readonly string[];
      readonly answersBoolean: boolean;
    }): void {
      if (
        types[registration.callbackTypeId] !== undefined ||
        bindings[registration.connectId] !== undefined ||
        declarations.has(registration.declaration)
      ) {
        diagnostics.push(diagnostic(registration.path, "Generated GObject signal identity collides"));
        return;
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
      types[registration.callbackTypeId] = Object.freeze({
        kind: "callback",
        signature: Object.freeze({
          callingConvention: "c",
          variadic: false,
          parameters: Object.freeze(registration.parameters),
          result: Object.freeze({
            type: registration.answersBoolean ? "gboolean" : "void",
            passMode: "value",
            nullable: false,
            ownership: Object.freeze({ kind: "value" }),
          }),
        }),
        context: Object.freeze({ placement: "last", type: "void_ptr" }),
      });
      bindings[registration.connectId] = callableBase({
        declaration: registration.declaration,
        kind: "method",
        symbol: registration.connectSymbol,
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
            type: registration.callbackTypeId,
            passMode: "pointer",
            nullable: false,
            ownership: Object.freeze({
              kind: "borrowed",
              scope: "registration",
              anchor: class_.cSymbolPrefix,
            }),
            callback: Object.freeze({
              /* The receiver owns the registration, which is the whole
               * lifetime story: the connection dies with the object. */
              registrationOwner: class_.cSymbolPrefix,
              cancellationBinding: signalDisconnectId,
              contextParameter: "context",
              allowedInvocationExecutors: Object.freeze([
                Object.freeze({ kind: "same-as-caller" as const }),
              ]),
              synchronousReturn: registration.answersBoolean,
              arguments: Object.freeze(registration.parameters.map((parameter) =>
                Object.freeze({
                  parameter: parameter.name,
                  transport: registration.answersBoolean ? "borrow" as const : "copy" as const,
                })
              )),
              sourceArguments: Object.freeze([
                /* An answering handler receives no sender: injecting one
                 * would mean a managed handle for the length of the call,
                 * and a borrowed payload is exactly what this delivery does
                 * not have. */
                ...(registration.answersBoolean
                  ? []
                  : [Object.freeze({ kind: "registration-owner" as const })]),
                ...registration.parameters.map((parameter) =>
                  Object.freeze({
                    kind: "callback-parameter" as const,
                    parameter: parameter.name,
                  })
                ),
              ]),
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
          ownership: Object.freeze({ kind: "owned", transfer: "to-runtime" }),
        }),
        error: Object.freeze({ kind: "nullable" }),
        dependencies: dependencies({
          bindings: [signalDisconnectId, signalReleaseId],
          links: linkIds,
          adapter: options.adapterInput.id,
        }),
        availability: availability(class_, registration.callable),
      });
      declarations.add(registration.declaration);
      adapterBindings.push(registration.connectId);
      classLines.push(
        ...deprecationDoc(registration.callable, "  "),
        `  ${registration.member}(callback: (${[
          ...(registration.answersBoolean ? [] : [`${lowerCamel(class_.name)}: ${class_.name}`]),
          ...registration.sourceParameters,
        ].join(", ")}) => ${registration.answersBoolean ? "boolean" : "void"}): SignalConnection;`,
      );
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
          /* What ends this program's claim on the payload is a property of
           * the payload's TYPE, and the two families spell it differently: a
           * GObject unrefs through the adapter's release, a boxed record
           * calls its own free. Requiring the adapter's release refused every
           * boxed payload — which is why the dispatch's `g_object_ref` on one
           * never shipped, and is not a reason to keep refusing them. */
          /* Asked of the class rather than of the types being built, because a
           * class is projected before a boxed record is and the payload's type
           * may not be registered yet. What releases one is a property of the
           * declaration either way. */
          const releasable = payloadClass.kind === "record"
            ? payloadClass.boxed !== null
            : releaseByClass.has(payloadClass.name);
          if (
            payloadTypeId === undefined || !releasable ||
            adapterPayload?.name !== parameter.name ||
            adapterPayload.sourceType !== payloadClass.name ||
            parameter.nullable
          ) {
            diagnostics.push(diagnostic(
              parameterPath,
              "A GObject signal payload must be a selected, non-null class or " +
                "boxed record whose type names what releases one",
            ));
            signalValid = false;
            continue;
          }
          signalParameters.push(Object.freeze({
            name: manifestParameterName(parameter.name),
            type: payloadTypeId,
            passMode: "pointer",
            nullable: false,
            ownership: Object.freeze({ kind: "owned", transfer: "to-runtime" }),
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
        if (
          parameter.type.kind === "named" &&
          borrowedStringGirTypes.has(parameter.type.name)
        ) {
          const abi = cStringParameter(
            parameter,
            parameter.nullable ? "nullable_const_utf8" : "const_utf8",
            parameterPath,
            diagnostics,
            emittedUtf8CTypes,
          );
          /* The adapter must agree with GIR about which string type this
           * is, not merely that it is a string. */
          if (abi === null || adapterPayload?.name !== parameter.name ||
              adapterPayload.sourceType !== parameter.type.name) {
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
      /* A signal that answers gboolean is asking whether the handler consumed
       * the event, so its handler runs during the emission rather than in a
       * later turn — the answer has to exist before the emitting call
       * returns. Only values can cross that way: nothing here outlives the
       * call, so a copied string or a referenced object payload would have
       * no owner. */
      const answersBoolean = callable.result.type.kind === "named" &&
        callable.result.type.name === "gboolean";
      if (
        answersBoolean &&
        signalParameters.some((parameter) => {
          const type = types[parameter.type];
          return type === undefined ||
            (type.kind !== "integer" && type.kind !== "float" &&
              type.kind !== "enum" && type.kind !== "flags" &&
              type.kind !== "boolean");
        })
      ) {
        diagnostics.push(diagnostic(
          path,
          "A signal answering gboolean is delivered during its emission, so its payloads must be values",
        ));
        continue;
      }
      if (!signalValid || signalParameters.length !== adapter.parameters.length) continue;
      emitSignalRegistration({
        path,
        callable,
        callbackTypeId,
        connectId,
        declaration,
        member: `on${upperCamel(callable.name)}`,
        connectSymbol: adapter.connectSymbol,
        parameters: signalParameters,
        sourceParameters: sourceSignalParameters,
        answersBoolean,
      });
    }
    for (const propertyName of class_.notify) {
      const path = `${classPath}/notify/${propertyName}`;
      const adapter = adapterByNotify.get(`${class_.name}.notify.${propertyName}`);
      /* Observing a property you cannot read is a subscription to nothing:
       * the notification carries no value, so the handler learns what changed
       * only by calling the getter. Requiring the getter to be selected also
       * gives the property name one authority — GIR's own annotation on that
       * method — rather than a second spelling to keep in step. */
      const getter = propertyAccessors.get(propertyName)?.getter;
      if (getter === undefined || invalidPropertyMethods.has(getter)) {
        diagnostics.push(diagnostic(
          path,
          "An observed GObject property must have a selected getter on this class",
        ));
        continue;
      }
      if (adapter === undefined) {
        diagnostics.push(diagnostic(path, "GObject adapter is missing this property observer"));
        continue;
      }
      if (!signalConnectionReady) continue;
      const propertyPart = propertyName.replaceAll("-", "_");
      emitSignalRegistration({
        path,
        callable: getter,
        callbackTypeId:
          `${namespacePrefix}_${class_.cSymbolPrefix}_notify_${propertyPart}_callback`,
        connectId:
          `${namespacePrefix}_${class_.cSymbolPrefix}_connect_notify_${propertyPart}`,
        declaration: `${class_.name}.onNotify${upperCamel(propertyName)}`,
        member: `onNotify${upperCamel(propertyName)}`,
        connectSymbol: adapter.connectSymbol,
        parameters: [],
        sourceParameters: [],
        answersBoolean: false,
      });
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
        const input = inputParameter(
          parameter,
          enumerations,
          resolveHandle,
          parameterPath,
          diagnostics,
        );
        const abi = input?.abi ?? null;
        const sourceType = input?.sourceType ?? "never";
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
        symbol: adapter.adapterSymbol,
        parameters,
        result: Object.freeze({
          type: typeId,
          passMode: "pointer",
          nullable: callable.result.nullable,
          ownership: Object.freeze({ kind: "owned", transfer: "to-runtime" }),
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
    if (!hasCanonicalConstructor && class_.kind === "class") {
      constructorLines.unshift(
        `  ${class_.final ? "private" : "protected"} constructor();`,
      );
    }
    classLines.splice(2, 0, ...constructorLines);
    classLines.push("}", "");
    /* Declaration merging is what makes an implemented interface's members
     * reachable on the class without a second declaration of each: the
     * member resolves to the interface that declares it, which is the
     * binding's declaration, so the class needs no bindings of its own. */
    for (const name of implementedInterfaces) {
      classLines.push(`export interface ${class_.name} extends ${name} {}`, "");
    }
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
    schemaVersion: SCABI_SCHEMA_VERSION,
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
      revision: "gobject-scabi-v5",
      arguments: [
        ...[
          ...options.snapshot.classes,
          ...options.snapshot.interfaces,
        ].flatMap((class_) => [
          `--${class_.kind}=${class_.name}`,
          ...class_.constructors.map(({ name }) => `--constructor=${class_.name}.${name}`),
          ...class_.methods.map(({ name }) => `--method=${class_.name}.${name}`),
          ...class_.signals.map(({ name }) => `--signal=${class_.name}.${name}`),
          ...class_.notify.map((property) => `--notify=${class_.name}.${property}`),
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
