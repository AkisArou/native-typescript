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
  readonly fields: readonly CRecordFieldCandidate[];
}

export interface ClangAbiProbe {
  readonly schema: "native-typescript.clang-abi-probe";
  readonly schemaVersion: 1;
  readonly source: string;
  readonly sourceDigest: string;
  readonly contractDigest: string;
  readonly includes: readonly string[];
  readonly functions: readonly CFunctionCandidate[];
  readonly records: readonly CRecordCandidate[];
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

export interface ClangRecordEvidence {
  readonly id: string;
  readonly typeName: string;
  readonly size: number;
  readonly alignment: number;
  readonly fields: readonly ClangRecordFieldEvidence[];
}

export interface ClangAbiEvidenceSnapshot {
  readonly schema: "native-typescript.clang-abi-evidence";
  readonly schemaVersion: 1;
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
}
