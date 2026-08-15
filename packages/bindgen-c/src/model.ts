export type CBindgenDiagnosticCode =
  | "NTS5001"
  | "NTS5002"
  | "NTS5003"
  | "NTS5004";

export interface CBindgenDiagnostic {
  readonly code: CBindgenDiagnosticCode;
  readonly severity: "error";
  readonly path: string;
  readonly message: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class CBindgenError extends Error {
  override readonly name = "CBindgenError";
  readonly diagnostics: readonly CBindgenDiagnostic[];

  constructor(diagnostics: readonly CBindgenDiagnostic[]) {
    const ordered = [...diagnostics].sort((left, right) =>
      compareText(left.path, right.path) ||
      compareText(left.code, right.code) ||
      compareText(left.message, right.message)
    );
    super(
      `C binding generation failed with ${ordered.length} error(s)\n${ordered
        .map(({ code, path, message }) => `${code} ${path}: ${message}`)
        .join("\n")}`,
    );
    this.diagnostics = Object.freeze(ordered.map((entry) => Object.freeze(entry)));
  }
}

export type CQualifier = "const" | "volatile" | "restrict";

export type CTypeCandidate =
  | {
      readonly kind: "named";
      readonly name: string;
      readonly qualifiers: readonly CQualifier[];
    }
  | {
      readonly kind: "pointer";
      readonly qualifiers: readonly CQualifier[];
      readonly pointee: CTypeCandidate;
    };

export interface CFunctionCandidate {
  readonly id: string;
  readonly symbol: string;
  readonly result: CTypeCandidate;
  readonly parameters: readonly CTypeCandidate[];
}

export interface CRecordFieldCandidate {
  readonly name: string;
  readonly type: CTypeCandidate;
}

export interface CRecordCandidate {
  readonly id: string;
  readonly typeName: string;
  readonly definition: "external" | "generated";
  readonly fields: readonly CRecordFieldCandidate[];
}

export interface CEnumMemberCandidate {
  readonly name: string;
  readonly cIdentifier: string;
  readonly value: string;
}

export interface CEnumCandidate {
  readonly id: string;
  readonly typeName: string;
  readonly members: readonly CEnumMemberCandidate[];
}

export interface ClangAbiProbe {
  readonly schema: "native-typescript.clang-abi-probe";
  readonly schemaVersion: 3;
  readonly source: string;
  readonly sourceDigest: string;
  readonly contractDigest: string;
  readonly includes: readonly string[];
  readonly functions: readonly CFunctionCandidate[];
  readonly records: readonly CRecordCandidate[];
  readonly enums: readonly CEnumCandidate[];
}

export interface ClangFunctionEvidence {
  readonly id: string;
  readonly symbol: string;
  readonly expectedType: string;
  readonly clangType: string;
}

export interface ClangRecordFieldEvidence {
  readonly name: string;
  readonly expectedType: string;
  readonly clangType: string;
  readonly offset: number;
  readonly size: number;
  readonly alignment: number;
}

export type ClangAbiType =
  | { readonly kind: "void" }
  | { readonly kind: "integer"; readonly bits: number }
  | {
      readonly kind: "float";
      readonly format: "half" | "bfloat" | "float" | "double" | "fp128" | "x86_fp80";
    }
  | { readonly kind: "pointer"; readonly addressSpace: number }
  | { readonly kind: "array"; readonly count: number; readonly element: ClangAbiType }
  | {
      readonly kind: "vector";
      readonly count: number;
      readonly scalable: boolean;
      readonly element: ClangAbiType;
    }
  | { readonly kind: "struct"; readonly packed: boolean; readonly fields: readonly ClangAbiType[] }
  | { readonly kind: "named"; readonly name: string };

export interface ClangAbiValue {
  readonly type: ClangAbiType;
  readonly alignment: number | null;
  readonly stackAlignment: number | null;
  readonly extension: "sign" | "zero" | null;
  readonly inRegister: boolean;
  readonly byValue: ClangAbiType | null;
  readonly structureReturn: ClangAbiType | null;
}

export interface ClangRecordCallingConventionEvidence {
  readonly result: ClangAbiValue;
  readonly parameters: readonly ClangAbiValue[];
}

export interface ClangRecordEvidence {
  readonly id: string;
  readonly typeName: string;
  readonly size: number;
  readonly alignment: number;
  readonly fields: readonly ClangRecordFieldEvidence[];
  readonly callingConvention: ClangRecordCallingConventionEvidence;
}

export interface ClangEnumMemberEvidence {
  readonly name: string;
  readonly cIdentifier: string;
  readonly value: string;
}

export interface ClangEnumEvidence {
  readonly id: string;
  readonly typeName: string;
  readonly clangType: string;
  readonly size: number;
  readonly alignment: number;
  readonly signed: boolean;
  readonly members: readonly ClangEnumMemberEvidence[];
}

export interface ClangAbiEvidenceSnapshot {
  readonly schema: "native-typescript.clang-abi-evidence";
  readonly schemaVersion: 3;
  readonly probeDigest: string;
  readonly semanticDigest: string;
  readonly clang: {
    readonly toolId: string;
    readonly version: string;
    readonly digest: string;
    readonly target: string;
  };
  readonly functions: readonly ClangFunctionEvidence[];
  readonly records: readonly ClangRecordEvidence[];
  readonly enums: readonly ClangEnumEvidence[];
}
