import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { SaxesParser } from "saxes";
import type { SaxesTagNS } from "saxes";
import { GirIngestionError } from "./gir-model.ts";
import type {
  GirAnnotation,
  GirCallbackScope,
  GirCallable,
  GirClass,
  GirClassSelection,
  GirDeclarationReference,
  GirDiagnostic,
  GirDiagnosticCode,
  GirEnumeration,
  GirEnumerationMember,
  GirEnumerationSelection,
  GirInclude,
  GirIngestionOptions,
  GirParameter,
  GirParameterDirection,
  GirRecord,
  GirRecordField,
  GirRecordSelection,
  GirReturnValue,
  GirSignalWhen,
  GirSnapshot,
  GirTransferOwnership,
  GirTypeReference,
} from "./gir-model.ts";

const coreNamespace = "http://www.gtk.org/introspection/core/1.0";
const cNamespace = "http://www.gtk.org/introspection/c/1.0";
const glibNamespace = "http://www.gtk.org/introspection/glib/1.0";
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const selectionNamePattern = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

interface NormalizedClassSelection {
  readonly name: string;
  readonly constructors: ReadonlySet<string>;
  readonly methods: ReadonlySet<string>;
  readonly signals: ReadonlySet<string>;
  /** GObject property names to observe. Unlike the others these name no GIR
   * member of their own: a `notify::` registration is a detail of the class's
   * inherited `notify` signal, and the projection checks the name against the
   * properties this class actually projects. */
  readonly notify: ReadonlySet<string>;
}

interface NormalizedRecordSelection {
  readonly name: string;
  readonly fields: ReadonlySet<string>;
  /** True when the selection asked for methods: the record projects as a
   * handle, and `fields` is empty. */
  readonly boxed: boolean;
  readonly methods: ReadonlySet<string>;
}

interface NormalizedEnumerationSelection {
  readonly name: string;
  readonly members: ReadonlySet<string>;
}

interface MutableTypeReference {
  readonly kind: "named" | "array";
  readonly depth: number;
  readonly cType: string | null;
  readonly name: string | null;
  readonly lengthParameter: number | null;
  readonly fixedSize: number | null;
  readonly zeroTerminated: boolean | null;
  readonly children: MutableTypeReference[];
}

interface MutableValue {
  readonly kind: "result" | "instance" | "parameter";
  readonly depth: number;
  readonly path: string;
  readonly name: string | null;
  readonly direction: GirParameterDirection;
  readonly transferOwnership: GirTransferOwnership;
  readonly nullable: boolean;
  readonly optional: boolean;
  readonly callerAllocates: boolean;
  readonly skip: boolean;
  readonly scope: GirCallbackScope | null;
  readonly closureParameter: number | null;
  readonly destroyParameter: number | null;
  readonly annotations: GirAnnotation[];
  unsupportedType: boolean;
  type: MutableTypeReference | null;
}

interface MutableCallable {
  readonly depth: number;
  readonly path: string;
  readonly kind: GirCallable["kind"];
  readonly name: string;
  readonly cIdentifier: string | null;
  readonly version: string | null;
  readonly deprecated: boolean;
  readonly deprecatedVersion: string | null;
  readonly stability: string | null;
  readonly throws: boolean;
  readonly shadowedBy: string | null;
  readonly shadows: string | null;
  readonly movedTo: string | null;
  readonly glibAsyncFunction: string | null;
  readonly glibSyncFunction: string | null;
  readonly glibFinishFunction: string | null;
  readonly glibSetProperty: string | null;
  readonly glibGetProperty: string | null;
  readonly signalWhen: GirSignalWhen | null;
  readonly signalAction: boolean;
  readonly signalDetailed: boolean;
  readonly signalNoHooks: boolean;
  readonly signalNoRecurse: boolean;
  readonly signalEmitter: string | null;
  readonly annotations: GirAnnotation[];
  result: GirReturnValue | null;
  readonly parameters: GirParameter[];
  readonly parameterNames: Set<string>;
  parameterOrdinal: number;
  instanceParameterCount: number;
}

interface MutableClass {
  readonly depth: number;
  readonly path: string;
  readonly selection: NormalizedClassSelection;
  readonly kind: "class" | "interface" | "record";
  readonly name: string;
  /** The C identifiers GIR names as this record's duplicate and release, when
   * it names them. `GVariant` says `g_variant_ref_sink` and `g_variant_unref`,
   * which are neither called `copy` nor `free`. */
  readonly boxedCopySymbol: string | null;
  readonly boxedFreeSymbol: string | null;
  boxedCopy: GirCallable | null;
  boxedFree: GirCallable | null;
  readonly cType: string;
  readonly cSymbolPrefix: string;
  readonly parent: GirDeclarationReference | null;
  readonly abstract: boolean;
  readonly final: boolean;
  readonly fundamental: boolean;
  readonly version: string | null;
  readonly deprecated: boolean;
  readonly deprecatedVersion: string | null;
  readonly stability: string | null;
  readonly glibTypeName: string;
  readonly glibGetType: string;
  readonly glibTypeStruct: string | null;
  readonly glibRefFunction: string | null;
  readonly glibUnrefFunction: string | null;
  readonly glibSetValueFunction: string | null;
  readonly glibGetValueFunction: string | null;
  readonly annotations: GirAnnotation[];
  readonly interfaces: GirDeclarationReference[];
  readonly constructors: GirCallable[];
  readonly methods: GirCallable[];
  readonly signals: GirCallable[];
  readonly foundConstructors: Set<string>;
  readonly foundMethods: Set<string>;
  readonly foundSignals: Set<string>;
}

interface MutableRecordField {
  readonly depth: number;
  readonly path: string;
  readonly name: string;
  readonly readable: boolean;
  readonly writable: boolean;
  readonly bits: number | null;
  readonly annotations: GirAnnotation[];
  unsupportedType: boolean;
  type: MutableTypeReference | null;
}

interface MutableRecord {
  readonly depth: number;
  readonly path: string;
  readonly selection: NormalizedRecordSelection;
  readonly name: string;
  readonly cType: string;
  readonly disguised: boolean;
  readonly foreign: boolean;
  readonly opaque: boolean;
  readonly pointer: boolean;
  readonly version: string | null;
  readonly deprecated: boolean;
  readonly deprecatedVersion: string | null;
  readonly stability: string | null;
  readonly glibTypeName: string | null;
  readonly glibGetType: string | null;
  readonly cSymbolPrefix: string | null;
  readonly annotations: GirAnnotation[];
  readonly fields: GirRecordField[];
  readonly foundFields: Set<string>;
}

interface MutableEnumeration {
  readonly depth: number;
  readonly path: string;
  readonly selection: NormalizedEnumerationSelection;
  readonly kind: GirEnumeration["kind"];
  readonly name: string;
  readonly cType: string;
  readonly glibTypeName: string | null;
  readonly glibGetType: string | null;
  readonly version: string | null;
  readonly deprecated: boolean;
  readonly deprecatedVersion: string | null;
  readonly stability: string | null;
  readonly annotations: GirAnnotation[];
  readonly members: GirEnumerationMember[];
  readonly foundMembers: Set<string>;
}

interface MutableEnumerationMember {
  readonly depth: number;
  readonly path: string;
  readonly name: string;
  readonly value: string;
  readonly cIdentifier: string;
  readonly glibNick: string | null;
  readonly glibName: string | null;
  readonly version: string | null;
  readonly deprecated: boolean;
  readonly deprecatedVersion: string | null;
  readonly stability: string | null;
  readonly annotations: GirAnnotation[];
}

function diagnostic(
  code: GirDiagnosticCode,
  path: string,
  message: string,
): GirDiagnostic {
  return { code, severity: "error", path, message };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Resolves a GIR declaration reference against the namespace being ingested.
 *
 * GIR qualifies a cross-namespace referent (`Gio.Application`) and leaves a
 * same-namespace one bare (`Widget`). A reference qualified with the current
 * namespace is normalized to `internal` so one referent has one spelling in
 * the snapshot.
 */
function parseDeclarationReference(
  raw: string,
  currentNamespace: string,
  path: string,
  diagnostics: GirDiagnostic[],
): GirDeclarationReference | null {
  const separator = raw.indexOf(".");
  if (separator < 0) {
    if (!selectionNamePattern.test(raw)) {
      diagnostics.push(
        diagnostic("NTS4002", path, `Malformed GIR declaration reference '${raw}'`),
      );
      return null;
    }
    return Object.freeze({ kind: "internal", name: raw });
  }
  const namespace = raw.slice(0, separator);
  const name = raw.slice(separator + 1);
  if (
    !selectionNamePattern.test(namespace) ||
    !selectionNamePattern.test(name) ||
    name.includes(".")
  ) {
    diagnostics.push(
      diagnostic("NTS4002", path, `Malformed GIR declaration reference '${raw}'`),
    );
    return null;
  }
  if (namespace === currentNamespace) {
    return Object.freeze({ kind: "internal", name });
  }
  return Object.freeze({ kind: "external", namespace, name });
}

function compareDeclarationReference(
  left: GirDeclarationReference,
  right: GirDeclarationReference,
): number {
  const leftNamespace = left.kind === "external" ? left.namespace : "";
  const rightNamespace = right.kind === "external" ? right.namespace : "";
  return (
    compareText(leftNamespace, rightNamespace) || compareText(left.name, right.name)
  );
}

function attribute(
  tag: SaxesTagNS,
  local: string,
  uri = "",
): string | undefined {
  for (const value of Object.values(tag.attributes)) {
    if (value.local === local && value.uri === uri) return value.value;
  }
  return undefined;
}

function requiredAttribute(
  tag: SaxesTagNS,
  local: string,
  uri: string,
  path: string,
  diagnostics: GirDiagnostic[],
): string {
  const value = attribute(tag, local, uri);
  if (value !== undefined && value.length > 0) return value;
  diagnostics.push(
    diagnostic("NTS4005", `${path}/@${local}`, "Required GIR attribute is missing"),
  );
  return "<invalid>";
}

function booleanAttribute(
  tag: SaxesTagNS,
  local: string,
  path: string,
  diagnostics: GirDiagnostic[],
  defaultValue: boolean,
  uri = "",
): boolean {
  const value = attribute(tag, local, uri);
  if (value === undefined) return defaultValue;
  if (value === "0") return false;
  if (value === "1") return true;
  diagnostics.push(
    diagnostic("NTS4005", `${path}/@${local}`, `Expected 0 or 1, received '${value}'`),
  );
  return defaultValue;
}

function requireIntrospectable(
  tag: SaxesTagNS,
  path: string,
  diagnostics: GirDiagnostic[],
  description: string,
): void {
  if (!booleanAttribute(tag, "introspectable", path, diagnostics, true)) {
    diagnostics.push(
      diagnostic("NTS4004", path, `${description} is not introspectable`),
    );
  }
}

function nullableAttribute(
  tag: SaxesTagNS,
  path: string,
  diagnostics: GirDiagnostic[],
): boolean {
  const nullable = attribute(tag, "nullable");
  const allowNone = attribute(tag, "allow-none");
  for (const [name, value] of [["nullable", nullable], ["allow-none", allowNone]] as const) {
    if (value !== undefined && value !== "0" && value !== "1") {
      diagnostics.push(
        diagnostic("NTS4005", `${path}/@${name}`, `Expected 0 or 1, received '${value}'`),
      );
    }
  }
  if (
    nullable !== undefined &&
    allowNone !== undefined &&
    nullable !== allowNone
  ) {
    diagnostics.push(
      diagnostic(
        "NTS4005",
        path,
        "nullable and allow-none annotations disagree",
      ),
    );
  }
  return nullable === "1" || allowNone === "1";
}

function integerAttribute(
  tag: SaxesTagNS,
  local: string,
  path: string,
  diagnostics: GirDiagnostic[],
): number | null {
  const value = attribute(tag, local);
  if (value === undefined) return null;
  const parsed = Number(value);
  if (/^(0|[1-9][0-9]*)$/u.test(value) && Number.isSafeInteger(parsed)) {
    return parsed;
  }
  diagnostics.push(
    diagnostic(
      "NTS4005",
      `${path}/@${local}`,
      `Expected a non-negative integer, received '${value}'`,
    ),
  );
  return null;
}

function signedIntegerAttribute(
  tag: SaxesTagNS,
  local: string,
  path: string,
  diagnostics: GirDiagnostic[],
): string {
  const value = requiredAttribute(tag, local, "", path, diagnostics);
  if (/^-?(?:0|[1-9][0-9]*)$/u.test(value) && value !== "-0") return value;
  diagnostics.push(diagnostic(
    "NTS4005",
    `${path}/@${local}`,
    `Expected a canonical signed integer, received '${value}'`,
  ));
  return "0";
}

function transferAttribute(
  tag: SaxesTagNS,
  path: string,
  diagnostics: GirDiagnostic[],
): GirTransferOwnership {
  const value = attribute(tag, "transfer-ownership");
  if (value === "none" || value === "container" || value === "full") return value;
  diagnostics.push(
    diagnostic(
      "NTS4005",
      `${path}/@transfer-ownership`,
      value === undefined
        ? "Required GIR ownership annotation is missing"
        : `Unknown GIR ownership '${value}'`,
    ),
  );
  return "none";
}

function directionAttribute(
  tag: SaxesTagNS,
  path: string,
  diagnostics: GirDiagnostic[],
): GirParameterDirection {
  const value = attribute(tag, "direction");
  if (value === undefined || value === "in") return "in";
  if (value === "out" || value === "inout") return value;
  diagnostics.push(
    diagnostic("NTS4005", `${path}/@direction`, `Unknown GIR direction '${value}'`),
  );
  return "in";
}

function scopeAttribute(
  tag: SaxesTagNS,
  path: string,
  diagnostics: GirDiagnostic[],
): GirCallbackScope | null {
  const value = attribute(tag, "scope");
  if (value === undefined) return null;
  if (value === "call" || value === "async" || value === "notified" || value === "forever") {
    return value;
  }
  diagnostics.push(
    diagnostic("NTS4005", `${path}/@scope`, `Unknown GIR callback scope '${value}'`),
  );
  return null;
}

function signalWhenAttribute(
  tag: SaxesTagNS,
  path: string,
  diagnostics: GirDiagnostic[],
): GirSignalWhen | null {
  const value = attribute(tag, "when");
  if (value === undefined) return null;
  if (value === "first" || value === "last" || value === "cleanup") return value;
  diagnostics.push(
    diagnostic("NTS4005", `${path}/@when`, `Unknown GIR signal phase '${value}'`),
  );
  return null;
}

function normalizeSelections(
  selections: readonly GirClassSelection[],
  diagnostics: GirDiagnostic[],
): ReadonlyMap<string, NormalizedClassSelection> {
  const result = new Map<string, NormalizedClassSelection>();
  for (const [index, selection] of selections.entries()) {
    const path = `classes/${index}`;
    if (!selectionNamePattern.test(selection.name)) {
      diagnostics.push(
        diagnostic("NTS4001", `${path}/name`, `Invalid GIR class selection '${selection.name}'`),
      );
      continue;
    }
    if (result.has(selection.name)) {
      diagnostics.push(
        diagnostic("NTS4001", `${path}/name`, `Duplicate GIR class selection '${selection.name}'`),
      );
      continue;
    }
    const normalizeMembers = (
      kind: "constructors" | "methods" | "signals" | "notify",
      values: readonly string[] | undefined,
    ): ReadonlySet<string> => {
      const names = new Set<string>();
      for (const [memberIndex, name] of (values ?? []).entries()) {
        if (!selectionNamePattern.test(name)) {
          diagnostics.push(
            diagnostic(
              "NTS4001",
              `${path}/${kind}/${memberIndex}`,
              `Invalid GIR member selection '${name}'`,
            ),
          );
        } else if (names.has(name)) {
          diagnostics.push(
            diagnostic(
              "NTS4001",
              `${path}/${kind}/${memberIndex}`,
              `Duplicate GIR member selection '${name}'`,
            ),
          );
        }
        names.add(name);
      }
      return names;
    };
    result.set(selection.name, {
      name: selection.name,
      constructors: normalizeMembers("constructors", selection.constructors),
      methods: normalizeMembers("methods", selection.methods),
      signals: normalizeMembers("signals", selection.signals),
      notify: normalizeMembers("notify", selection.notify),
    });
  }
  return result;
}

function normalizeRecordSelections(
  selections: readonly GirRecordSelection[],
  diagnostics: GirDiagnostic[],
): ReadonlyMap<string, NormalizedRecordSelection> {
  const result = new Map<string, NormalizedRecordSelection>();
  for (const [index, selection] of selections.entries()) {
    const path = `records/${index}`;
    if (!selectionNamePattern.test(selection.name)) {
      diagnostics.push(
        diagnostic("NTS4001", `${path}/name`, `Invalid GIR record selection '${selection.name}'`),
      );
      continue;
    }
    if (result.has(selection.name)) {
      diagnostics.push(
        diagnostic("NTS4001", `${path}/name`, `Duplicate GIR record selection '${selection.name}'`),
      );
      continue;
    }
    /* The two projections are exclusive: a record crosses as a layout whose
     * fields are readable, or as a handle whose contents are not. Asking for
     * both, or for neither, names no projection at all. */
    if ((selection.fields === undefined) === (selection.methods === undefined)) {
      diagnostics.push(diagnostic(
        "NTS4001",
        path,
        `GIR record selection '${selection.name}' must select either fields or methods`,
      ));
      continue;
    }
    const fields = new Set<string>();
    for (const [fieldIndex, name] of (selection.fields ?? []).entries()) {
      if (!selectionNamePattern.test(name)) {
        diagnostics.push(
          diagnostic("NTS4001", `${path}/fields/${fieldIndex}`, `Invalid GIR field selection '${name}'`),
        );
      } else if (fields.has(name)) {
        diagnostics.push(
          diagnostic("NTS4001", `${path}/fields/${fieldIndex}`, `Duplicate GIR field selection '${name}'`),
        );
      }
      fields.add(name);
    }
    const methods = new Set<string>();
    for (const [methodIndex, name] of (selection.methods ?? []).entries()) {
      if (!selectionNamePattern.test(name)) {
        diagnostics.push(
          diagnostic("NTS4001", `${path}/methods/${methodIndex}`, `Invalid GIR method selection '${name}'`),
        );
      } else if (methods.has(name)) {
        diagnostics.push(
          diagnostic("NTS4001", `${path}/methods/${methodIndex}`, `Duplicate GIR method selection '${name}'`),
        );
      }
      methods.add(name);
    }
    result.set(selection.name, {
      name: selection.name,
      fields,
      boxed: selection.methods !== undefined,
      methods,
    });
  }
  return result;
}

function normalizeEnumerationSelections(
  selections: readonly GirEnumerationSelection[],
  diagnostics: GirDiagnostic[],
): ReadonlyMap<string, NormalizedEnumerationSelection> {
  const result = new Map<string, NormalizedEnumerationSelection>();
  for (const [index, selection] of selections.entries()) {
    const path = `enumerations/${index}`;
    if (!selectionNamePattern.test(selection.name)) {
      diagnostics.push(diagnostic(
        "NTS4001",
        `${path}/name`,
        `Invalid GIR enumeration selection '${selection.name}'`,
      ));
      continue;
    }
    if (result.has(selection.name)) {
      diagnostics.push(diagnostic(
        "NTS4001",
        `${path}/name`,
        `Duplicate GIR enumeration selection '${selection.name}'`,
      ));
      continue;
    }
    const members = new Set<string>();
    for (const [memberIndex, name] of selection.members.entries()) {
      if (!selectionNamePattern.test(name)) {
        diagnostics.push(diagnostic(
          "NTS4001",
          `${path}/members/${memberIndex}`,
          `Invalid GIR enumeration member selection '${name}'`,
        ));
      } else if (members.has(name)) {
        diagnostics.push(diagnostic(
          "NTS4001",
          `${path}/members/${memberIndex}`,
          `Duplicate GIR enumeration member selection '${name}'`,
        ));
      }
      members.add(name);
    }
    result.set(selection.name, { name: selection.name, members });
  }
  return result;
}

function freezeAnnotations(
  annotations: readonly GirAnnotation[],
): readonly GirAnnotation[] {
  return Object.freeze(
    [...annotations]
      .sort((left, right) =>
        compareText(left.name, right.name) || compareText(left.value, right.value)
      )
      .map((annotation) => Object.freeze({ ...annotation })),
  );
}

function readAnnotation(
  tag: SaxesTagNS,
  path: string,
  diagnostics: GirDiagnostic[],
): GirAnnotation {
  return {
    name: requiredAttribute(tag, "name", "", path, diagnostics),
    value: requiredAttribute(tag, "value", "", path, diagnostics),
  };
}

function freezeType(type: MutableTypeReference): GirTypeReference {
  if (type.kind === "named") {
    return Object.freeze({
      kind: "named",
      name: type.name ?? "<invalid>",
      cType: type.cType,
      arguments: Object.freeze(type.children.map(freezeType)),
    });
  }
  return Object.freeze({
    kind: "array",
    cType: type.cType,
    lengthParameter: type.lengthParameter,
    fixedSize: type.fixedSize,
    zeroTerminated: type.zeroTerminated,
    element: freezeType(type.children[0] ?? {
      kind: "named",
      depth: type.depth,
      cType: null,
      name: "<invalid>",
      lengthParameter: null,
      fixedSize: null,
      zeroTerminated: null,
      children: [],
    }),
  });
}

function validateTypeShape(
  type: MutableTypeReference,
  path: string,
  diagnostics: GirDiagnostic[],
): void {
  if (type.kind === "array" && type.children.length !== 1) {
    diagnostics.push(
      diagnostic(
        "NTS4005",
        path,
        `GIR array requires exactly one element type, received ${type.children.length}`,
      ),
    );
  }
  for (const [index, child] of type.children.entries()) {
    validateTypeShape(child, `${path}/arguments/${index}`, diagnostics);
  }
}

function freezeCallable(callable: MutableCallable): GirCallable {
  return Object.freeze({
    kind: callable.kind,
    name: callable.name,
    cIdentifier: callable.cIdentifier,
    version: callable.version,
    deprecated: callable.deprecated,
    deprecatedVersion: callable.deprecatedVersion,
    stability: callable.stability,
    throws: callable.throws,
    shadowedBy: callable.shadowedBy,
    shadows: callable.shadows,
    movedTo: callable.movedTo,
    glibAsyncFunction: callable.glibAsyncFunction,
    glibSyncFunction: callable.glibSyncFunction,
    glibFinishFunction: callable.glibFinishFunction,
    glibSetProperty: callable.glibSetProperty,
    glibGetProperty: callable.glibGetProperty,
    signalWhen: callable.signalWhen,
    signalAction: callable.signalAction,
    signalDetailed: callable.signalDetailed,
    signalNoHooks: callable.signalNoHooks,
    signalNoRecurse: callable.signalNoRecurse,
    signalEmitter: callable.signalEmitter,
    annotations: freezeAnnotations(callable.annotations),
    result: callable.result!,
    parameters: Object.freeze([...callable.parameters]),
  });
}

export function ingestGir(
  xml: string,
  options: GirIngestionOptions,
): GirSnapshot {
  const diagnostics: GirDiagnostic[] = [];
  if (
    options.logicalPath.length === 0 ||
    isAbsolute(options.logicalPath) ||
    /^[A-Za-z]:[\\/]/u.test(options.logicalPath) ||
    options.logicalPath.split(/[\\/]/u).includes("..")
  ) {
    diagnostics.push(
      diagnostic(
        "NTS4001",
        "logicalPath",
        "GIR logicalPath must be non-empty, relative, and cannot traverse parents",
      ),
    );
  }
  if (
    !selectionNamePattern.test(options.namespace.name) ||
    options.namespace.version.length === 0
  ) {
    diagnostics.push(
      diagnostic("NTS4001", "namespace", "GIR namespace selection is invalid"),
    );
  }
  const sourceDigest = `sha256:${createHash("sha256").update(xml).digest("hex")}`;
  if (
    options.expectedDigest !== undefined &&
    (!digestPattern.test(options.expectedDigest) || options.expectedDigest !== sourceDigest)
  ) {
    diagnostics.push(
      diagnostic(
        "NTS4001",
        "expectedDigest",
        `GIR source digest mismatch: expected ${options.expectedDigest}, received ${sourceDigest}`,
      ),
    );
  }
  const selections = normalizeSelections(options.classes, diagnostics);
  const interfaceSelections = normalizeSelections(
    options.interfaces ?? [],
    diagnostics,
  );
  const recordSelections = normalizeRecordSelections(options.records ?? [], diagnostics);
  const enumerationSelections = normalizeEnumerationSelections(
    options.enumerations ?? [],
    diagnostics,
  );
  if (diagnostics.length > 0) throw new GirIngestionError(diagnostics);

  const includes: GirInclude[] = [];
  const packages: string[] = [];
  const cIncludes: string[] = [];
  const classes: GirClass[] = [];
  const interfaces: GirClass[] = [];
  const boxedRecords: GirClass[] = [];
  const records: GirRecord[] = [];
  const enumerations: GirEnumeration[] = [];
  const foundClasses = new Set<string>();
  const foundInterfaces = new Set<string>();
  const foundRecords = new Set<string>();
  const foundEnumerations = new Set<string>();
  const stack: SaxesTagNS[] = [];
  const typeStack: MutableTypeReference[] = [];
  let repositoryVersion: string | null = null;
  let namespaceDepth: number | null = null;
  let namespaceMetadata: GirSnapshot["namespace"] | null = null;
  let activeClass: MutableClass | null = null;
  let activeRecord: MutableRecord | null = null;
  let activeRecordField: MutableRecordField | null = null;
  let activeEnumeration: MutableEnumeration | null = null;
  let activeEnumerationMember: MutableEnumerationMember | null = null;
  let activeCallable: MutableCallable | null = null;
  let activeValue: MutableValue | null = null;
  let syntaxError: string | null = null;

  const parser = new SaxesParser({
    xmlns: true,
    position: true,
    fileName: options.logicalPath,
  });
  parser.on("error", (error) => {
    syntaxError ??= error.message;
  });
  parser.on("doctype", () => {
    diagnostics.push(
      diagnostic("NTS4002", "repository", "GIR documents cannot contain a DOCTYPE"),
    );
  });
  parser.on("opentag", (tag) => {
    const parent = stack.at(-1);
    const grandparent = stack.at(-2);
    const depth = stack.length;
    const isCore = tag.uri === coreNamespace;

    if (depth === 0) {
      if (!isCore || tag.local !== "repository") {
        diagnostics.push(
          diagnostic("NTS4002", "repository", "Root element must be a GIR repository"),
        );
      } else {
        repositoryVersion = attribute(tag, "version") ?? null;
        if (repositoryVersion !== "1.2") {
          diagnostics.push(
            diagnostic(
              "NTS4004",
              "repository/@version",
              `Unsupported GIR repository version '${repositoryVersion ?? "<missing>"}'`,
            ),
          );
        }
      }
    } else if (
      parent?.uri === coreNamespace &&
      parent.local === "repository" &&
      isCore &&
      tag.local === "include"
    ) {
      const path = `repository/include/${includes.length}`;
      includes.push({
        name: requiredAttribute(tag, "name", "", path, diagnostics),
        version: requiredAttribute(tag, "version", "", path, diagnostics),
      });
    } else if (
      parent?.uri === coreNamespace &&
      parent.local === "repository" &&
      isCore &&
      tag.local === "package"
    ) {
      packages.push(requiredAttribute(tag, "name", "", "repository/package", diagnostics));
    } else if (
      parent?.uri === coreNamespace &&
      parent.local === "repository" &&
      tag.uri === cNamespace &&
      tag.local === "include"
    ) {
      cIncludes.push(requiredAttribute(tag, "name", "", "repository/c:include", diagnostics));
    } else if (
      parent?.uri === coreNamespace &&
      parent.local === "repository" &&
      isCore &&
      tag.local === "namespace" &&
      attribute(tag, "name") === options.namespace.name
    ) {
      if (namespaceDepth !== null || namespaceMetadata !== null) {
        diagnostics.push(
          diagnostic("NTS4002", "repository/namespace", "Selected GIR namespace is duplicated"),
        );
      } else {
        namespaceDepth = depth;
        const actualVersion = requiredAttribute(
          tag,
          "version",
          "",
          `namespace/${options.namespace.name}`,
          diagnostics,
        );
        if (actualVersion !== options.namespace.version) {
          diagnostics.push(
            diagnostic(
              "NTS4002",
              `namespace/${options.namespace.name}/@version`,
              `Expected ${options.namespace.version}, received ${actualVersion}`,
            ),
          );
        }
        const split = (value: string | undefined): readonly string[] =>
          Object.freeze(
            (value ?? "")
              .split(",")
              .map((part) => part.trim())
              .filter((part) => part.length > 0)
              .sort(compareText),
          );
        namespaceMetadata = Object.freeze({
          name: options.namespace.name,
          version: actualVersion,
          sharedLibraries: split(attribute(tag, "shared-library")),
          identifierPrefixes: split(attribute(tag, "identifier-prefixes", cNamespace)),
          symbolPrefixes: split(attribute(tag, "symbol-prefixes", cNamespace)),
        });
      }
    } else if (
      namespaceDepth !== null &&
      depth === namespaceDepth + 1 &&
      isCore &&
      (tag.local === "class" || tag.local === "interface" ||
        (tag.local === "record" &&
          recordSelections.get(attribute(tag, "name") ?? "")?.boxed === true))
    ) {
      /* A GObject interface declares members exactly as a class does, and so
       * does a record projected as a handle, so one ingestion serves all
       * three. What they do not have is construction, a parent, or a
       * hierarchy, and those attributes are simply absent rather than
       * defaulted-and-wrong. */
      const isRecord = tag.local === "record";
      const isInterface = tag.local === "interface";
      const kindWord = isRecord ? "record" : isInterface ? "interface" : "class";
      const name = attribute(tag, "name") ?? "<missing>";
      const recordSelection = isRecord ? recordSelections.get(name) : undefined;
      const selection = isRecord
        ? recordSelection === undefined ? undefined : {
          name,
          constructors: new Set<string>(),
          methods: recordSelection.methods,
          signals: new Set<string>(),
          notify: new Set<string>(),
        }
        : (isInterface ? interfaceSelections : selections).get(name);
      const found = isRecord
        ? foundRecords
        : isInterface
          ? foundInterfaces
          : foundClasses;
      if (selection !== undefined) {
        const path = `namespace/${options.namespace.name}/${kindWord}/${name}`;
        if (found.has(name)) {
          diagnostics.push(
            diagnostic("NTS4002", path, `Selected GIR ${kindWord} '${name}' is duplicated`),
          );
        }
        found.add(name);
        requireIntrospectable(tag, path, diagnostics, `Selected GIR ${kindWord} '${name}'`);
        activeClass = {
          depth,
          path,
          selection,
          kind: isRecord ? "record" : isInterface ? "interface" : "class",
          name,
          cType: requiredAttribute(tag, "type", cNamespace, path, diagnostics),
          cSymbolPrefix: requiredAttribute(
            tag,
            "symbol-prefix",
            cNamespace,
            path,
            diagnostics,
          ),
          parent: ((): GirDeclarationReference | null => {
            const raw = isInterface || isRecord ? undefined : attribute(tag, "parent");
            return raw === undefined
              ? null
              : parseDeclarationReference(
                  raw,
                  options.namespace.name,
                  `${path}/@parent`,
                  diagnostics,
                );
          })(),
          abstract: booleanAttribute(tag, "abstract", path, diagnostics, false),
          final: booleanAttribute(tag, "final", path, diagnostics, false),
          fundamental: booleanAttribute(
            tag,
            "fundamental",
            path,
            diagnostics,
            false,
            glibNamespace,
          ),
          version: attribute(tag, "version") ?? null,
          deprecated: booleanAttribute(tag, "deprecated", path, diagnostics, false),
          deprecatedVersion: attribute(tag, "deprecated-version") ?? null,
          stability: attribute(tag, "stability") ?? null,
          glibTypeName: requiredAttribute(tag, "type-name", glibNamespace, path, diagnostics),
          glibGetType: requiredAttribute(tag, "get-type", glibNamespace, path, diagnostics),
          glibTypeStruct: attribute(tag, "type-struct", glibNamespace) ?? null,
          glibRefFunction: attribute(tag, "ref-func", glibNamespace) ?? null,
          glibUnrefFunction: attribute(tag, "unref-func", glibNamespace) ?? null,
          glibSetValueFunction: attribute(tag, "set-value-func", glibNamespace) ?? null,
          glibGetValueFunction: attribute(tag, "get-value-func", glibNamespace) ?? null,
          annotations: [],
          interfaces: [],
          constructors: [],
          methods: [],
          signals: [],
          boxedCopySymbol: attribute(tag, "copy-function") ?? null,
          boxedFreeSymbol: attribute(tag, "free-function") ?? null,
          boxedCopy: null,
          boxedFree: null,
          foundConstructors: new Set(),
          foundMethods: new Set(),
          foundSignals: new Set(),
        };
      }
    } else if (
      namespaceDepth !== null &&
      depth === namespaceDepth + 1 &&
      isCore &&
      tag.local === "record"
    ) {
      const name = attribute(tag, "name") ?? "<missing>";
      const selection = recordSelections.get(name);
      if (selection !== undefined) {
        const path = `namespace/${options.namespace.name}/record/${name}`;
        if (foundRecords.has(name)) {
          diagnostics.push(
            diagnostic("NTS4002", path, `Selected GIR record '${name}' is duplicated`),
          );
        }
        foundRecords.add(name);
        requireIntrospectable(tag, path, diagnostics, `Selected GIR record '${name}'`);
        activeRecord = {
          depth,
          path,
          selection,
          name,
          cType: requiredAttribute(tag, "type", cNamespace, path, diagnostics),
          disguised: booleanAttribute(tag, "disguised", path, diagnostics, false),
          foreign: booleanAttribute(tag, "foreign", path, diagnostics, false),
          opaque: booleanAttribute(tag, "opaque", path, diagnostics, false),
          pointer: booleanAttribute(tag, "pointer", path, diagnostics, false),
          version: attribute(tag, "version") ?? null,
          deprecated: booleanAttribute(tag, "deprecated", path, diagnostics, false),
          deprecatedVersion: attribute(tag, "deprecated-version") ?? null,
          stability: attribute(tag, "stability") ?? null,
          glibTypeName: attribute(tag, "type-name", glibNamespace) ?? null,
          glibGetType: attribute(tag, "get-type", glibNamespace) ?? null,
          cSymbolPrefix: attribute(tag, "symbol-prefix", cNamespace) ?? null,
          annotations: [],
          fields: [],
          foundFields: new Set(),
        };
      }
    } else if (
      namespaceDepth !== null &&
      depth === namespaceDepth + 1 &&
      isCore &&
      (tag.local === "enumeration" || tag.local === "bitfield")
    ) {
      const name = attribute(tag, "name") ?? "<missing>";
      const selection = enumerationSelections.get(name);
      if (selection !== undefined) {
        const kind = tag.local as GirEnumeration["kind"];
        const path = `namespace/${options.namespace.name}/${kind}/${name}`;
        if (foundEnumerations.has(name)) {
          diagnostics.push(diagnostic(
            "NTS4002",
            path,
            `Selected GIR ${kind} '${name}' is duplicated`,
          ));
        }
        foundEnumerations.add(name);
        requireIntrospectable(tag, path, diagnostics, `Selected GIR ${kind} '${name}'`);
        activeEnumeration = {
          depth,
          path,
          selection,
          kind,
          name,
          cType: requiredAttribute(tag, "type", cNamespace, path, diagnostics),
          glibTypeName: attribute(tag, "type-name", glibNamespace) ?? null,
          glibGetType: attribute(tag, "get-type", glibNamespace) ?? null,
          version: attribute(tag, "version") ?? null,
          deprecated: booleanAttribute(tag, "deprecated", path, diagnostics, false),
          deprecatedVersion: attribute(tag, "deprecated-version") ?? null,
          stability: attribute(tag, "stability") ?? null,
          annotations: [],
          members: [],
          foundMembers: new Set(),
        };
      }
    } else if (
      activeEnumerationMember !== null &&
      depth === activeEnumerationMember.depth + 1 &&
      isCore &&
      tag.local === "attribute"
    ) {
      activeEnumerationMember.annotations.push(readAnnotation(
        tag,
        `${activeEnumerationMember.path}/annotations/${activeEnumerationMember.annotations.length}`,
        diagnostics,
      ));
    } else if (
      activeEnumeration !== null &&
      depth === activeEnumeration.depth + 1 &&
      isCore &&
      tag.local === "attribute"
    ) {
      activeEnumeration.annotations.push(readAnnotation(
        tag,
        `${activeEnumeration.path}/annotations/${activeEnumeration.annotations.length}`,
        diagnostics,
      ));
    } else if (
      activeEnumeration !== null &&
      depth === activeEnumeration.depth + 1 &&
      isCore &&
      tag.local === "member"
    ) {
      const name = attribute(tag, "name") ?? "<missing>";
      if (activeEnumeration.selection.members.has(name)) {
        const path = `${activeEnumeration.path}/member/${name}`;
        if (activeEnumeration.foundMembers.has(name)) {
          diagnostics.push(diagnostic(
            "NTS4002",
            path,
            `Selected GIR enumeration member '${name}' is duplicated`,
          ));
        }
        activeEnumeration.foundMembers.add(name);
        requireIntrospectable(tag, path, diagnostics, `Selected GIR enumeration member '${name}'`);
        activeEnumerationMember = {
          depth,
          path,
          name,
          value: signedIntegerAttribute(tag, "value", path, diagnostics),
          cIdentifier: requiredAttribute(tag, "identifier", cNamespace, path, diagnostics),
          glibNick: attribute(tag, "nick", glibNamespace) ?? null,
          glibName: attribute(tag, "name", glibNamespace) ?? null,
          version: attribute(tag, "version") ?? null,
          deprecated: booleanAttribute(tag, "deprecated", path, diagnostics, false),
          deprecatedVersion: attribute(tag, "deprecated-version") ?? null,
          stability: attribute(tag, "stability") ?? null,
          annotations: [],
        };
      }
    } else if (
      activeRecord !== null &&
      activeRecordField === null &&
      depth === activeRecord.depth + 1 &&
      isCore &&
      tag.local === "attribute"
    ) {
      activeRecord.annotations.push(
        readAnnotation(
          tag,
          `${activeRecord.path}/annotations/${activeRecord.annotations.length}`,
          diagnostics,
        ),
      );
    } else if (
      activeRecord !== null &&
      depth === activeRecord.depth + 1 &&
      isCore &&
      tag.local === "field"
    ) {
      const name = attribute(tag, "name") ?? "<missing>";
      if (activeRecord.selection.fields.has(name)) {
        const path = `${activeRecord.path}/field/${name}`;
        if (activeRecord.foundFields.has(name)) {
          diagnostics.push(
            diagnostic("NTS4002", path, `Selected GIR field '${name}' is duplicated`),
          );
        }
        activeRecord.foundFields.add(name);
        requireIntrospectable(tag, path, diagnostics, `Selected GIR field '${name}'`);
        activeRecordField = {
          depth,
          path,
          name,
          readable: booleanAttribute(tag, "readable", path, diagnostics, true),
          writable: booleanAttribute(tag, "writable", path, diagnostics, false),
          bits: integerAttribute(tag, "bits", path, diagnostics),
          annotations: [],
          unsupportedType: false,
          type: null,
        };
      }
    } else if (
      activeRecordField !== null &&
      depth === activeRecordField.depth + 1 &&
      isCore &&
      tag.local === "attribute"
    ) {
      activeRecordField.annotations.push(
        readAnnotation(
          tag,
          `${activeRecordField.path}/annotations/${activeRecordField.annotations.length}`,
          diagnostics,
        ),
      );
    } else if (
      activeRecordField !== null &&
      depth > activeRecordField.depth &&
      isCore &&
      (tag.local === "type" || tag.local === "array") &&
      (parent?.local === "field" || typeStack.length > 0)
    ) {
      const path = `${activeRecordField.path}/type`;
      requireIntrospectable(tag, path, diagnostics, "Selected GIR record field type");
      const type: MutableTypeReference = {
        kind: tag.local === "array" ? "array" : "named",
        depth,
        cType: attribute(tag, "type", cNamespace) ?? null,
        name: tag.local === "type"
          ? requiredAttribute(tag, "name", "", path, diagnostics)
          : null,
        lengthParameter: tag.local === "array"
          ? integerAttribute(tag, "length", path, diagnostics)
          : null,
        fixedSize: tag.local === "array"
          ? integerAttribute(tag, "fixed-size", path, diagnostics)
          : null,
        zeroTerminated: tag.local === "array" && attribute(tag, "zero-terminated") !== undefined
          ? booleanAttribute(tag, "zero-terminated", path, diagnostics, false)
          : null,
        children: [],
      };
      const parentType = typeStack.at(-1);
      if (parentType === undefined) {
        if (activeRecordField.type !== null) {
          diagnostics.push(
            diagnostic("NTS4002", path, "GIR record field has multiple physical types"),
          );
        } else {
          activeRecordField.type = type;
        }
      } else {
        parentType.children.push(type);
      }
      typeStack.push(type);
    } else if (
      activeRecordField !== null &&
      depth > activeRecordField.depth &&
      isCore &&
      (tag.local === "callback" || tag.local === "varargs")
    ) {
      activeRecordField.unsupportedType = true;
      diagnostics.push(
        diagnostic(
          "NTS4004",
          `${activeRecordField.path}/type`,
          "Selected GIR record field type is outside the record-layout slice",
        ),
      );
    } else if (
      activeClass !== null &&
      depth === activeClass.depth + 1 &&
      isCore &&
      tag.local === "implements"
    ) {
      const implementsPath = `${activeClass.path}/implements`;
      const implemented = parseDeclarationReference(
        requiredAttribute(tag, "name", "", implementsPath, diagnostics),
        options.namespace.name,
        implementsPath,
        diagnostics,
      );
      if (implemented !== null) activeClass.interfaces.push(implemented);
    } else if (
      activeClass !== null &&
      activeCallable === null &&
      depth === activeClass.depth + 1 &&
      isCore &&
      tag.local === "attribute"
    ) {
      activeClass.annotations.push(
        readAnnotation(
          tag,
          `${activeClass.path}/annotations/${activeClass.annotations.length}`,
          diagnostics,
        ),
      );
    } else if (activeClass !== null && depth === activeClass.depth + 1) {
      const kind = tag.uri === coreNamespace && tag.local === "constructor"
        ? "constructor"
        : tag.uri === coreNamespace && tag.local === "method"
          ? "method"
          : tag.uri === glibNamespace && tag.local === "signal"
            ? "signal"
            : null;
      if (kind !== null) {
        const name = attribute(tag, "name") ?? "<missing>";
        const selected = kind === "constructor"
          ? activeClass.selection.constructors
          : kind === "method"
            ? activeClass.selection.methods
            : activeClass.selection.signals;
        /* A boxed record's `copy` and `free` are its contract rather than its
         * surface: the projection needs both to allocate one and to release
         * one, so they are read whether or not the project asked for them,
         * and only what it asked for becomes a member. */
        const memberPath = `${activeClass.path}/${kind}/${name}`;
        /* Which methods duplicate and release a boxed record. GIR states the
         * pair on the record where it knows it, and that is authoritative:
         * `GVariant` duplicates by taking a reference, which no naming
         * convention would find. Where it does not, the convention GLib
         * follows throughout is a `copy` and a `free`. */
        const contractSymbols = activeClass.boxedCopySymbol !== null ||
            activeClass.boxedFreeSymbol !== null
          ? [activeClass.boxedCopySymbol, activeClass.boxedFreeSymbol]
          : null;
        const boxedContract = activeClass.kind === "record" &&
          kind === "method" &&
          (contractSymbols === null
            ? name === "copy" || name === "free"
            : contractSymbols.includes(
              attribute(tag, "identifier", cNamespace) ?? null,
            )) &&
          /* A contract nobody can introspect is a contract this projection
           * does not have: `GObject.ValueArray` declares a `free` GIR marks
           * unintrospectable, and the record refuses for the reason that
           * matters — no free — rather than for a method nobody selected. */
          booleanAttribute(tag, "introspectable", memberPath, diagnostics, true);
        if (selected.has(name) || boxedContract) {
          const found = kind === "constructor"
            ? activeClass.foundConstructors
            : kind === "method"
              ? activeClass.foundMethods
              : activeClass.foundSignals;
          const path = `${activeClass.path}/${kind}/${name}`;
          if (found.has(name)) {
            diagnostics.push(
              diagnostic("NTS4002", path, `Selected GIR ${kind} '${name}' is duplicated`),
            );
          }
          if (selected.has(name)) {
            found.add(name);
            requireIntrospectable(
              tag,
              path,
              diagnostics,
              `Selected GIR ${kind} '${name}'`,
            );
          }
          const cIdentifier = kind === "signal"
            ? null
            : requiredAttribute(tag, "identifier", cNamespace, path, diagnostics);
          activeCallable = {
            depth,
            path,
            kind,
            name,
            cIdentifier,
            version: attribute(tag, "version") ?? null,
            deprecated: booleanAttribute(tag, "deprecated", path, diagnostics, false),
            deprecatedVersion: attribute(tag, "deprecated-version") ?? null,
            stability: attribute(tag, "stability") ?? null,
            throws: booleanAttribute(tag, "throws", path, diagnostics, false),
            shadowedBy: attribute(tag, "shadowed-by") ?? null,
            shadows: attribute(tag, "shadows") ?? null,
            movedTo: attribute(tag, "moved-to") ?? null,
            glibAsyncFunction: attribute(tag, "async-func", glibNamespace) ?? null,
            glibSyncFunction: attribute(tag, "sync-func", glibNamespace) ?? null,
            glibFinishFunction: attribute(tag, "finish-func", glibNamespace) ?? null,
            glibSetProperty: kind === "method"
              ? attribute(tag, "set-property", glibNamespace) ?? null
              : null,
            glibGetProperty: kind === "method"
              ? attribute(tag, "get-property", glibNamespace) ?? null
              : null,
            signalWhen: kind === "signal"
              ? signalWhenAttribute(tag, path, diagnostics)
              : null,
            signalAction: kind === "signal"
              ? booleanAttribute(tag, "action", path, diagnostics, false)
              : false,
            signalDetailed: kind === "signal"
              ? booleanAttribute(tag, "detailed", path, diagnostics, false)
              : false,
            signalNoHooks: kind === "signal"
              ? booleanAttribute(tag, "no-hooks", path, diagnostics, false)
              : false,
            signalNoRecurse: kind === "signal"
              ? booleanAttribute(tag, "no-recurse", path, diagnostics, false)
              : false,
            signalEmitter: kind === "signal" ? attribute(tag, "emitter") ?? null : null,
            annotations: [],
            result: null,
            parameters: [],
            parameterNames: new Set(),
            parameterOrdinal: 0,
            instanceParameterCount: 0,
          };
        }
      }
    } else if (
      activeCallable !== null &&
      activeValue === null &&
      depth === activeCallable.depth + 1 &&
      isCore &&
      tag.local === "attribute"
    ) {
      activeCallable.annotations.push(
        readAnnotation(
          tag,
          `${activeCallable.path}/annotations/${activeCallable.annotations.length}`,
          diagnostics,
        ),
      );
    } else if (
      activeCallable !== null &&
      depth === activeCallable.depth + 1 &&
      isCore &&
      tag.local === "return-value"
    ) {
      const path = `${activeCallable.path}/result`;
      requireIntrospectable(tag, path, diagnostics, "Selected GIR return value");
      if (activeCallable.result !== null || activeValue !== null) {
        diagnostics.push(
          diagnostic("NTS4002", path, "GIR callable has duplicate return values"),
        );
      }
      activeValue = {
        kind: "result",
        depth,
        path,
        name: null,
        direction: "out",
        transferOwnership: transferAttribute(tag, path, diagnostics),
        nullable: nullableAttribute(tag, path, diagnostics),
        optional: false,
        callerAllocates: false,
        skip: booleanAttribute(tag, "skip", path, diagnostics, false),
        scope: scopeAttribute(tag, path, diagnostics),
        closureParameter: integerAttribute(tag, "closure", path, diagnostics),
        destroyParameter: integerAttribute(tag, "destroy", path, diagnostics),
        annotations: [],
        unsupportedType: false,
        type: null,
      };
    } else if (
      activeValue !== null &&
      depth === activeValue.depth + 1 &&
      isCore &&
      tag.local === "attribute"
    ) {
      activeValue.annotations.push(
        readAnnotation(
          tag,
          `${activeValue.path}/annotations/${activeValue.annotations.length}`,
          diagnostics,
        ),
      );
    } else if (
      activeCallable !== null &&
      parent?.uri === coreNamespace &&
      parent.local === "parameters" &&
      grandparent !== undefined &&
      depth === activeCallable.depth + 2 &&
      isCore &&
      (tag.local === "parameter" || tag.local === "instance-parameter")
    ) {
      const ordinal = activeCallable.parameterOrdinal;
      activeCallable.parameterOrdinal += 1;
      const basePath = `${activeCallable.path}/parameters/${ordinal}`;
      const name = requiredAttribute(tag, "name", "", basePath, diagnostics);
      const path = `${basePath}/${name}`;
      if (activeCallable.parameterNames.has(name)) {
        diagnostics.push(
          diagnostic("NTS4002", path, `Duplicate GIR parameter name '${name}'`),
        );
      }
      activeCallable.parameterNames.add(name);
      if (tag.local === "instance-parameter") {
        activeCallable.instanceParameterCount += 1;
      }
      requireIntrospectable(tag, path, diagnostics, `Selected GIR parameter '${name}'`);
      activeValue = {
        kind: tag.local === "instance-parameter" ? "instance" : "parameter",
        depth,
        path,
        name,
        direction: directionAttribute(tag, path, diagnostics),
        transferOwnership: transferAttribute(tag, path, diagnostics),
        nullable: nullableAttribute(tag, path, diagnostics),
        optional: booleanAttribute(tag, "optional", path, diagnostics, false),
        callerAllocates: booleanAttribute(
          tag,
          "caller-allocates",
          path,
          diagnostics,
          false,
        ),
        skip: tag.local === "parameter"
          ? booleanAttribute(tag, "skip", path, diagnostics, false)
          : false,
        scope: scopeAttribute(tag, path, diagnostics),
        closureParameter: integerAttribute(tag, "closure", path, diagnostics),
        destroyParameter: integerAttribute(tag, "destroy", path, diagnostics),
        annotations: [],
        unsupportedType: false,
        type: null,
      };
    } else if (
      activeValue !== null &&
      depth > activeValue.depth &&
      isCore &&
      (tag.local === "type" || tag.local === "array") &&
      (parent?.local === "return-value" ||
        parent?.local === "parameter" ||
        parent?.local === "instance-parameter" ||
        typeStack.length > 0)
    ) {
      const path = `${activeValue.path}/type`;
      requireIntrospectable(tag, path, diagnostics, "Selected GIR type");
      const type: MutableTypeReference = {
        kind: tag.local === "array" ? "array" : "named",
        depth,
        cType: attribute(tag, "type", cNamespace) ?? null,
        name: tag.local === "type"
          ? requiredAttribute(tag, "name", "", path, diagnostics)
          : null,
        lengthParameter: tag.local === "array"
          ? integerAttribute(tag, "length", path, diagnostics)
          : null,
        fixedSize: tag.local === "array"
          ? integerAttribute(tag, "fixed-size", path, diagnostics)
          : null,
        zeroTerminated: tag.local === "array" && attribute(tag, "zero-terminated") !== undefined
          ? booleanAttribute(tag, "zero-terminated", path, diagnostics, false)
          : null,
        children: [],
      };
      const parentType = typeStack.at(-1);
      if (parentType === undefined) {
        if (activeValue.type !== null) {
          diagnostics.push(
            diagnostic("NTS4002", path, "GIR value has multiple physical types"),
          );
        } else {
          activeValue.type = type;
        }
      } else {
        parentType.children.push(type);
      }
      typeStack.push(type);
    } else if (
      activeValue !== null &&
      depth > activeValue.depth &&
      isCore &&
      (tag.local === "callback" || tag.local === "varargs")
    ) {
      activeValue.unsupportedType = true;
      diagnostics.push(
        diagnostic(
          "NTS4004",
          `${activeValue.path}/type`,
          tag.local === "callback"
            ? "Inline callback types are outside the first GIR ingestion slice"
            : "Variadic parameters are outside the GIR ingestion contract",
        ),
      );
    }

    stack.push(tag);
  });

  parser.on("closetag", (tag) => {
    const depth = stack.length - 1;
    const currentType = typeStack.at(-1);
    if (
      currentType !== undefined &&
      currentType.depth === depth &&
      tag.uri === coreNamespace &&
      (tag.local === "type" || tag.local === "array")
    ) {
      typeStack.pop();
    }
    if (activeRecordField !== null && activeRecordField.depth === depth) {
      if (activeRecordField.type === null) {
        if (!activeRecordField.unsupportedType) {
          diagnostics.push(
            diagnostic(
              "NTS4004",
              `${activeRecordField.path}/type`,
              "Selected GIR record field has no type",
            ),
          );
        }
      } else {
        validateTypeShape(activeRecordField.type, `${activeRecordField.path}/type`, diagnostics);
        activeRecord!.fields.push(Object.freeze({
          name: activeRecordField.name,
          readable: activeRecordField.readable,
          writable: activeRecordField.writable,
          bits: activeRecordField.bits,
          annotations: freezeAnnotations(activeRecordField.annotations),
          type: freezeType(activeRecordField.type),
        }));
      }
      activeRecordField = null;
      typeStack.length = 0;
    }
    if (activeValue !== null && activeValue.depth === depth) {
      if (activeValue.type === null) {
        if (!activeValue.unsupportedType) {
          diagnostics.push(
            diagnostic("NTS4004", `${activeValue.path}/type`, "Selected GIR value has no type"),
          );
        }
      } else {
        validateTypeShape(activeValue.type, `${activeValue.path}/type`, diagnostics);
        const frozenType = freezeType(activeValue.type);
        if (activeValue.kind === "result") {
          activeCallable!.result = Object.freeze({
            transferOwnership: activeValue.transferOwnership,
            nullable: activeValue.nullable,
            skip: activeValue.skip,
            scope: activeValue.scope,
            closureParameter: activeValue.closureParameter,
            destroyParameter: activeValue.destroyParameter,
            annotations: freezeAnnotations(activeValue.annotations),
            type: frozenType,
          });
        } else {
          activeCallable!.parameters.push(Object.freeze({
            kind: activeValue.kind,
            name: activeValue.name!,
            direction: activeValue.direction,
            transferOwnership: activeValue.transferOwnership,
            nullable: activeValue.nullable,
            optional: activeValue.optional,
            callerAllocates: activeValue.callerAllocates,
            skip: activeValue.skip,
            scope: activeValue.scope,
            closureParameter: activeValue.closureParameter,
            destroyParameter: activeValue.destroyParameter,
            annotations: freezeAnnotations(activeValue.annotations),
            type: frozenType,
          }));
        }
      }
      activeValue = null;
      typeStack.length = 0;
    }
    if (activeCallable !== null && activeCallable.depth === depth) {
      const expectedInstanceParameters = activeCallable.kind === "method" ? 1 : 0;
      if (activeCallable.instanceParameterCount !== expectedInstanceParameters) {
        diagnostics.push(
          diagnostic(
            "NTS4005",
            `${activeCallable.path}/parameters`,
            activeCallable.kind === "method"
              ? `Selected GIR method requires exactly one instance parameter, received ${activeCallable.instanceParameterCount}`
              : `Selected GIR ${activeCallable.kind} cannot declare an instance parameter`,
          ),
        );
      }
      if (activeCallable.result === null) {
        diagnostics.push(
          diagnostic("NTS4004", `${activeCallable.path}/result`, "Selected GIR callable has no result"),
        );
      } else {
        const callable = freezeCallable(activeCallable);
        if (callable.kind === "constructor") activeClass!.constructors.push(callable);
        if (callable.kind === "method") {
          const duplicates = activeClass!.boxedCopySymbol === null
            ? callable.name === "copy"
            : callable.cIdentifier === activeClass!.boxedCopySymbol;
          const releases = activeClass!.boxedFreeSymbol === null
            ? callable.name === "free"
            : callable.cIdentifier === activeClass!.boxedFreeSymbol;
          if (activeClass!.kind === "record" && duplicates) {
            activeClass!.boxedCopy = callable;
          }
          if (activeClass!.kind === "record" && releases) {
            activeClass!.boxedFree = callable;
          }
          if (activeClass!.selection.methods.has(callable.name)) {
            activeClass!.methods.push(callable);
          }
        }
        if (callable.kind === "signal") activeClass!.signals.push(callable);
      }
      activeCallable = null;
    }
    if (activeEnumerationMember !== null && activeEnumerationMember.depth === depth) {
      activeEnumeration!.members.push(Object.freeze({
        name: activeEnumerationMember.name,
        value: activeEnumerationMember.value,
        cIdentifier: activeEnumerationMember.cIdentifier,
        glibNick: activeEnumerationMember.glibNick,
        glibName: activeEnumerationMember.glibName,
        version: activeEnumerationMember.version,
        deprecated: activeEnumerationMember.deprecated,
        deprecatedVersion: activeEnumerationMember.deprecatedVersion,
        stability: activeEnumerationMember.stability,
        annotations: freezeAnnotations(activeEnumerationMember.annotations),
      }));
      activeEnumerationMember = null;
    }
    if (activeEnumeration !== null && activeEnumeration.depth === depth) {
      for (const name of activeEnumeration.selection.members) {
        if (!activeEnumeration.foundMembers.has(name)) {
          diagnostics.push(diagnostic(
            "NTS4003",
            `${activeEnumeration.path}/member/${name}`,
            `Selected GIR enumeration member '${name}' does not exist`,
          ));
        }
      }
      enumerations.push(Object.freeze({
        kind: activeEnumeration.kind,
        name: activeEnumeration.name,
        cType: activeEnumeration.cType,
        glibTypeName: activeEnumeration.glibTypeName,
        glibGetType: activeEnumeration.glibGetType,
        version: activeEnumeration.version,
        deprecated: activeEnumeration.deprecated,
        deprecatedVersion: activeEnumeration.deprecatedVersion,
        stability: activeEnumeration.stability,
        annotations: freezeAnnotations(activeEnumeration.annotations),
        members: Object.freeze([...activeEnumeration.members].sort((left, right) =>
          compareText(left.name, right.name)
        )),
      }));
      activeEnumeration = null;
    }
    if (activeClass !== null && activeClass.depth === depth) {
      const missing = (
        kind: "constructor" | "method" | "signal",
        selected: ReadonlySet<string>,
        found: ReadonlySet<string>,
      ): void => {
        for (const name of selected) {
          if (!found.has(name)) {
            diagnostics.push(
              diagnostic(
                "NTS4003",
                `${activeClass!.path}/${kind}/${name}`,
                `Selected GIR ${kind} '${name}' does not exist`,
              ),
            );
          }
        }
      };
      missing("constructor", activeClass.selection.constructors, activeClass.foundConstructors);
      missing("method", activeClass.selection.methods, activeClass.foundMethods);
      missing("signal", activeClass.selection.signals, activeClass.foundSignals);
      const byName = (left: GirCallable, right: GirCallable): number =>
        compareText(left.name, right.name);
      const boxed = activeClass.kind !== "record" ||
          activeClass.boxedCopy === null || activeClass.boxedFree === null
        ? null
        : Object.freeze({
          copy: activeClass.boxedCopy,
          free: activeClass.boxedFree,
        });
      if (activeClass.kind === "record" && boxed === null) {
        diagnostics.push(diagnostic(
          "NTS4004",
          activeClass.path,
          `Selected GIR record '${activeClass.name}' projects as a handle, ` +
            "which requires the copy and free it is duplicated and released by",
        ));
      }
      (activeClass.kind === "interface"
        ? interfaces
        : activeClass.kind === "record"
          ? boxedRecords
          : classes).push(Object.freeze({
        kind: activeClass.kind,
        name: activeClass.name,
        boxed,
        cType: activeClass.cType,
        cSymbolPrefix: activeClass.cSymbolPrefix,
        parent: activeClass.parent,
        abstract: activeClass.abstract,
        final: activeClass.final,
        fundamental: activeClass.fundamental,
        version: activeClass.version,
        deprecated: activeClass.deprecated,
        deprecatedVersion: activeClass.deprecatedVersion,
        stability: activeClass.stability,
        glibTypeName: activeClass.glibTypeName,
        glibGetType: activeClass.glibGetType,
        glibTypeStruct: activeClass.glibTypeStruct,
        glibRefFunction: activeClass.glibRefFunction,
        glibUnrefFunction: activeClass.glibUnrefFunction,
        glibSetValueFunction: activeClass.glibSetValueFunction,
        glibGetValueFunction: activeClass.glibGetValueFunction,
        annotations: freezeAnnotations(activeClass.annotations),
        interfaces: Object.freeze(
          [...activeClass.interfaces].sort(compareDeclarationReference),
        ),
        constructors: Object.freeze([...activeClass.constructors].sort(byName)),
        methods: Object.freeze([...activeClass.methods].sort(byName)),
        signals: Object.freeze([...activeClass.signals].sort(byName)),
        notify: Object.freeze([...activeClass.selection.notify].sort(compareText)),
      }));
      activeClass = null;
    }
    if (activeRecord !== null && activeRecord.depth === depth) {
      for (const name of activeRecord.selection.fields) {
        if (!activeRecord.foundFields.has(name)) {
          diagnostics.push(
            diagnostic(
              "NTS4003",
              `${activeRecord.path}/field/${name}`,
              `Selected GIR field '${name}' does not exist`,
            ),
          );
        }
      }
      if (
        activeRecord.disguised ||
        activeRecord.foreign ||
        activeRecord.opaque ||
        activeRecord.pointer
      ) {
        diagnostics.push(
          diagnostic(
            "NTS4004",
            activeRecord.path,
            "Selected GIR record is not a transparent by-value C aggregate",
          ),
        );
      }
      for (const field of activeRecord.fields) {
        if (field.bits !== null) {
          diagnostics.push(
            diagnostic(
              "NTS4004",
              `${activeRecord.path}/field/${field.name}/@bits`,
              "Bit-field layout is outside the first record evidence slice",
            ),
          );
        }
      }
      records.push(Object.freeze({
        kind: "record",
        name: activeRecord.name,
        cType: activeRecord.cType,
        disguised: activeRecord.disguised,
        foreign: activeRecord.foreign,
        opaque: activeRecord.opaque,
        pointer: activeRecord.pointer,
        version: activeRecord.version,
        deprecated: activeRecord.deprecated,
        deprecatedVersion: activeRecord.deprecatedVersion,
        stability: activeRecord.stability,
        glibTypeName: activeRecord.glibTypeName,
        glibGetType: activeRecord.glibGetType,
        cSymbolPrefix: activeRecord.cSymbolPrefix,
        annotations: freezeAnnotations(activeRecord.annotations),
        fields: Object.freeze([...activeRecord.fields]),
      }));
      activeRecord = null;
    }
    if (namespaceDepth === depth && tag.uri === coreNamespace && tag.local === "namespace") {
      namespaceDepth = null;
    }
    stack.pop();
  });

  try {
    parser.write(xml).close();
  } catch (error) {
    syntaxError ??= error instanceof Error ? error.message : String(error);
  }
  if (syntaxError !== null) {
    diagnostics.push(diagnostic("NTS4002", "xml", syntaxError));
  }
  if (repositoryVersion === null) {
    diagnostics.push(
      diagnostic("NTS4002", "repository", "GIR repository metadata is missing"),
    );
  }
  if (namespaceMetadata === null) {
    diagnostics.push(
      diagnostic(
        "NTS4003",
        `namespace/${options.namespace.name}`,
        `Selected GIR namespace ${options.namespace.name}-${options.namespace.version} does not exist`,
      ),
    );
  }
  for (const name of selections.keys()) {
    if (!foundClasses.has(name)) {
      diagnostics.push(
        diagnostic(
          "NTS4003",
          `namespace/${options.namespace.name}/class/${name}`,
          `Selected GIR class '${name}' does not exist`,
        ),
      );
    }
  }
  for (const name of interfaceSelections.keys()) {
    if (!foundInterfaces.has(name)) {
      diagnostics.push(
        diagnostic(
          "NTS4003",
          `namespace/${options.namespace.name}/interface/${name}`,
          `Selected GIR interface '${name}' does not exist`,
        ),
      );
    }
  }
  for (const name of recordSelections.keys()) {
    if (!foundRecords.has(name)) {
      diagnostics.push(
        diagnostic(
          "NTS4003",
          `namespace/${options.namespace.name}/record/${name}`,
          `Selected GIR record '${name}' does not exist`,
        ),
      );
    }
  }
  for (const name of enumerationSelections.keys()) {
    if (!foundEnumerations.has(name)) {
      diagnostics.push(diagnostic(
        "NTS4003",
        `namespace/${options.namespace.name}/enumeration/${name}`,
        `Selected GIR enumeration '${name}' does not exist`,
      ));
    }
  }
  // A same-namespace parent must be part of the selection. Without it the
  // generator would silently drop the ancestry: no `extends`, no identity
  // upcast, and no inherited surface, with nothing reporting the loss. A
  // cross-namespace parent is a deliberate boundary and is preserved as an
  // external reference instead.
  const selectedClasses = new Set(classes.map(({ name }) => name));
  for (const class_ of classes) {
    if (class_.parent?.kind !== "internal") continue;
    if (selectedClasses.has(class_.parent.name)) continue;
    diagnostics.push(
      diagnostic(
        "NTS4006",
        `namespace/${options.namespace.name}/class/${class_.name}/@parent`,
        `GIR class '${class_.name}' extends '${class_.parent.name}' in the same ` +
          `namespace, but '${class_.parent.name}' is not selected. Select it, or ` +
          "the generated class would lose its ancestry silently.",
      ),
    );
  }
  if (diagnostics.length > 0) throw new GirIngestionError(diagnostics);

  return Object.freeze({
    schema: "native-typescript.gir-snapshot",
    schemaVersion: 3,
    source: Object.freeze({
      logicalPath: options.logicalPath,
      digest: sourceDigest,
    }),
    repositoryVersion: "1.2",
    includes: Object.freeze(
      includes
        .sort((left, right) =>
          compareText(left.name, right.name) || compareText(left.version, right.version)
        )
        .map((include) => Object.freeze(include)),
    ),
    packages: Object.freeze([...new Set(packages)].sort(compareText)),
    cIncludes: Object.freeze([...new Set(cIncludes)].sort(compareText)),
    namespace: namespaceMetadata!,
    classes: Object.freeze(classes.sort((left, right) => compareText(left.name, right.name))),
    interfaces: Object.freeze(
      interfaces.sort((left, right) => compareText(left.name, right.name)),
    ),
    boxedRecords: Object.freeze(
      boxedRecords.sort((left, right) => compareText(left.name, right.name)),
    ),
    records: Object.freeze(records.sort((left, right) => compareText(left.name, right.name))),
    enumerations: Object.freeze(enumerations.sort((left, right) => compareText(left.name, right.name))),
  });
}
