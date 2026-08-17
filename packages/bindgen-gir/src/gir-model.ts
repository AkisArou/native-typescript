export type GirDiagnosticCode =
  | "NTS4001"
  | "NTS4002"
  | "NTS4003"
  | "NTS4004"
  | "NTS4005"
  | "NTS4006";

export interface GirDiagnostic {
  readonly code: GirDiagnosticCode;
  readonly severity: "error";
  readonly path: string;
  readonly message: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class GirIngestionError extends Error {
  override readonly name = "GirIngestionError";
  readonly diagnostics: readonly GirDiagnostic[];

  constructor(diagnostics: readonly GirDiagnostic[]) {
    const ordered = [...diagnostics].sort((left, right) =>
      compareText(left.path, right.path) ||
      compareText(left.code, right.code) ||
      compareText(left.message, right.message)
    );
    super(
      `GIR ingestion failed with ${ordered.length} error(s)\n${ordered
        .map(({ code, path, message }) => `${code} ${path}: ${message}`)
        .join("\n")}`,
    );
    this.diagnostics = Object.freeze(ordered.map((entry) => Object.freeze(entry)));
  }
}

export interface GirClassSelection {
  readonly name: string;
  readonly constructors?: readonly string[];
  readonly methods?: readonly string[];
  readonly signals?: readonly string[];
  /** GObject property names to observe, spelled as GIR spells them
   * (`reveal-child`). Each becomes one `notify::` registration, which is a
   * detail of the class's `notify` signal rather than a signal of its own —
   * so it is selected here rather than beside the signals, and the property
   * it names has to be one this class projects. */
  readonly notify?: readonly string[];
}

export interface GirRecordSelection {
  readonly name: string;
  readonly fields: readonly string[];
}

export interface GirEnumerationSelection {
  readonly name: string;
  readonly members: readonly string[];
}

export interface GirIngestionOptions {
  readonly logicalPath: string;
  readonly expectedDigest?: string;
  readonly namespace: {
    readonly name: string;
    readonly version: string;
  };
  readonly classes: readonly GirClassSelection[];
  readonly records?: readonly GirRecordSelection[];
  readonly enumerations?: readonly GirEnumerationSelection[];
}

export interface GirInclude {
  readonly name: string;
  readonly version: string;
}

/**
 * A reference from one declaration to another, with the namespace boundary
 * made explicit.
 *
 * GIR spells a same-namespace reference as a bare name (`Widget`) and a
 * cross-namespace reference as a qualified one (`Gio.Application`). Carrying
 * that distinction as a raw string loses the only fact that matters to the
 * generator: whether the referent can be resolved inside this snapshot, or
 * belongs to another namespace and therefore another generated package.
 *
 * An `internal` referent must be part of the same selection. An `external`
 * referent is a deliberate boundary: the selected surface stops there.
 */
export type GirDeclarationReference =
  | { readonly kind: "internal"; readonly name: string }
  | {
      readonly kind: "external";
      readonly namespace: string;
      readonly name: string;
    };

export interface GirAnnotation {
  readonly name: string;
  readonly value: string;
}

export type GirTransferOwnership = "none" | "container" | "full";
export type GirParameterDirection = "in" | "out" | "inout";
export type GirCallbackScope = "call" | "async" | "notified" | "forever";
export type GirSignalWhen = "first" | "last" | "cleanup";

export type GirTypeReference =
  | {
      readonly kind: "named";
      readonly name: string;
      readonly cType: string | null;
      readonly arguments: readonly GirTypeReference[];
    }
  | {
      readonly kind: "array";
      readonly cType: string | null;
      readonly lengthParameter: number | null;
      readonly fixedSize: number | null;
      readonly zeroTerminated: boolean | null;
      readonly element: GirTypeReference;
    };

export interface GirReturnValue {
  readonly transferOwnership: GirTransferOwnership;
  readonly nullable: boolean;
  readonly skip: boolean;
  readonly scope: GirCallbackScope | null;
  readonly closureParameter: number | null;
  readonly destroyParameter: number | null;
  readonly annotations: readonly GirAnnotation[];
  readonly type: GirTypeReference;
}

export interface GirParameter {
  readonly kind: "instance" | "parameter";
  readonly name: string;
  readonly direction: GirParameterDirection;
  readonly transferOwnership: GirTransferOwnership;
  readonly nullable: boolean;
  readonly optional: boolean;
  readonly callerAllocates: boolean;
  readonly skip: boolean;
  readonly scope: GirCallbackScope | null;
  readonly closureParameter: number | null;
  readonly destroyParameter: number | null;
  readonly annotations: readonly GirAnnotation[];
  readonly type: GirTypeReference;
}

export interface GirCallable {
  readonly kind: "constructor" | "method" | "signal";
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
  readonly annotations: readonly GirAnnotation[];
  readonly result: GirReturnValue;
  readonly parameters: readonly GirParameter[];
}

export interface GirClass {
  readonly kind: "class";
  readonly name: string;
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
  readonly annotations: readonly GirAnnotation[];
  readonly interfaces: readonly GirDeclarationReference[];
  readonly constructors: readonly GirCallable[];
  readonly methods: readonly GirCallable[];
  readonly signals: readonly GirCallable[];
  /** The GObject property names this selection observes. */
  readonly notify: readonly string[];
}

export interface GirRecordField {
  readonly name: string;
  readonly readable: boolean;
  readonly writable: boolean;
  readonly bits: number | null;
  readonly annotations: readonly GirAnnotation[];
  readonly type: GirTypeReference;
}

export interface GirRecord {
  readonly kind: "record";
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
  readonly annotations: readonly GirAnnotation[];
  readonly fields: readonly GirRecordField[];
}

export interface GirEnumerationMember {
  readonly name: string;
  readonly value: string;
  readonly cIdentifier: string;
  readonly glibNick: string | null;
  readonly glibName: string | null;
  readonly version: string | null;
  readonly deprecated: boolean;
  readonly deprecatedVersion: string | null;
  readonly stability: string | null;
  readonly annotations: readonly GirAnnotation[];
}

export interface GirEnumeration {
  readonly kind: "enumeration" | "bitfield";
  readonly name: string;
  readonly cType: string;
  readonly glibTypeName: string | null;
  readonly glibGetType: string | null;
  readonly version: string | null;
  readonly deprecated: boolean;
  readonly deprecatedVersion: string | null;
  readonly stability: string | null;
  readonly annotations: readonly GirAnnotation[];
  readonly members: readonly GirEnumerationMember[];
}

export interface GirSnapshot {
  readonly schema: "native-typescript.gir-snapshot";
  readonly schemaVersion: 3;
  readonly source: {
    readonly logicalPath: string;
    readonly digest: string;
  };
  readonly repositoryVersion: "1.2";
  readonly includes: readonly GirInclude[];
  readonly packages: readonly string[];
  readonly cIncludes: readonly string[];
  readonly namespace: {
    readonly name: string;
    readonly version: string;
    readonly sharedLibraries: readonly string[];
    readonly identifierPrefixes: readonly string[];
    readonly symbolPrefixes: readonly string[];
  };
  readonly classes: readonly GirClass[];
  readonly records: readonly GirRecord[];
  readonly enumerations: readonly GirEnumeration[];
}
