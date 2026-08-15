export type GirDiagnosticCode =
  | "NTS4001"
  | "NTS4002"
  | "NTS4003"
  | "NTS4004"
  | "NTS4005";

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
}

export interface GirRecordSelection {
  readonly name: string;
  readonly fields: readonly string[];
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
}

export interface GirInclude {
  readonly name: string;
  readonly version: string;
}

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
  readonly parent: string | null;
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
  readonly interfaces: readonly string[];
  readonly constructors: readonly GirCallable[];
  readonly methods: readonly GirCallable[];
  readonly signals: readonly GirCallable[];
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

export interface GirSnapshot {
  readonly schema: "native-typescript.gir-snapshot";
  readonly schemaVersion: 1;
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
}
