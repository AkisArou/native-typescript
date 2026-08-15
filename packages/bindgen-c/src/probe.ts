import { createHash } from "node:crypto";
import { CBindgenError } from "./model.ts";
import type {
  CBindgenDiagnostic,
  CBindgenDiagnosticCode,
  CFunctionCandidate,
  ClangFunctionEvidence,
  ClangFunctionEvidenceSnapshot,
  ClangFunctionProbe,
  CQualifier,
  CTypeCandidate,
} from "./model.ts";

const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@#+-]*$/u;
const cIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const headerSegmentPattern = /^[A-Za-z0-9_+.-]+$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const qualifierOrder: readonly CQualifier[] = ["const", "volatile", "restrict"];
const qualifierSet = new Set<string>(qualifierOrder);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function diagnostic(
  code: CBindgenDiagnosticCode,
  path: string,
  message: string,
): CBindgenDiagnostic {
  return { code, severity: "error", path, message };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeQualifiers(
  value: readonly CQualifier[],
  path: string,
  diagnostics: CBindgenDiagnostic[],
  allowRestrict: boolean,
): readonly CQualifier[] {
  const seen = new Set<string>();
  for (const [index, qualifier] of value.entries()) {
    if (!qualifierSet.has(qualifier)) {
      diagnostics.push(
        diagnostic("NTS5001", `${path}/${index}`, `Unknown C qualifier '${qualifier}'`),
      );
    } else if (seen.has(qualifier)) {
      diagnostics.push(
        diagnostic("NTS5002", `${path}/${index}`, `Duplicate C qualifier '${qualifier}'`),
      );
    } else if (qualifier === "restrict" && !allowRestrict) {
      diagnostics.push(
        diagnostic("NTS5001", `${path}/${index}`, "restrict can qualify only a pointer"),
      );
    }
    seen.add(qualifier);
  }
  return Object.freeze(
    qualifierOrder.filter((qualifier) => seen.has(qualifier)),
  );
}

function normalizeType(
  value: CTypeCandidate,
  path: string,
  diagnostics: CBindgenDiagnostic[],
  depth = 0,
): CTypeCandidate {
  if (depth > 16) {
    diagnostics.push(
      diagnostic("NTS5001", path, "C candidate type nesting exceeds 16 levels"),
    );
    return Object.freeze({ kind: "named", name: "void", qualifiers: Object.freeze([]) });
  }
  if (value.kind === "named") {
    if (!cIdentifierPattern.test(value.name)) {
      diagnostics.push(
        diagnostic("NTS5001", `${path}/name`, `Invalid C type identifier '${value.name}'`),
      );
    }
    return Object.freeze({
      kind: "named",
      name: value.name,
      qualifiers: normalizeQualifiers(
        value.qualifiers,
        `${path}/qualifiers`,
        diagnostics,
        false,
      ),
    });
  }
  return Object.freeze({
    kind: "pointer",
    qualifiers: normalizeQualifiers(
      value.qualifiers,
      `${path}/qualifiers`,
      diagnostics,
      true,
    ),
    pointee: normalizeType(value.pointee, `${path}/pointee`, diagnostics, depth + 1),
  });
}

function renderQualifiers(qualifiers: readonly CQualifier[]): string {
  return qualifiers.length === 0 ? "" : `${qualifiers.join(" ")} `;
}

export function parseCTypeCandidate(
  spelling: string,
  path = "type",
): CTypeCandidate {
  const diagnostics: CBindgenDiagnostic[] = [];
  const tokens = spelling.match(/[A-Za-z_][A-Za-z0-9_]*|\*/gu) ?? [];
  if (
    spelling.trim().length === 0 ||
    spelling.replace(/\s/gu, "") !== tokens.join("")
  ) {
    throw new CBindgenError([
      diagnostic("NTS5001", path, `Unsupported C type candidate '${spelling}'`),
    ]);
  }
  let index = 0;
  const takeQualifiers = (): CQualifier[] => {
    const qualifiers: CQualifier[] = [];
    while (qualifierSet.has(tokens[index] ?? "")) {
      qualifiers.push(tokens[index] as CQualifier);
      index += 1;
    }
    return qualifiers;
  };
  const baseQualifiers = takeQualifiers();
  const name = tokens[index];
  if (name === undefined || name === "*" || qualifierSet.has(name)) {
    diagnostics.push(
      diagnostic("NTS5001", path, `C type candidate '${spelling}' has no base type`),
    );
  } else {
    index += 1;
  }
  let result: CTypeCandidate = {
    kind: "named",
    name: name ?? "void",
    qualifiers: baseQualifiers,
  };
  while (tokens[index] === "*") {
    index += 1;
    result = {
      kind: "pointer",
      qualifiers: takeQualifiers(),
      pointee: result,
    };
  }
  if (index !== tokens.length) {
    diagnostics.push(
      diagnostic(
        "NTS5001",
        path,
        `C type candidate '${spelling}' exceeds the named/pointer type slice`,
      ),
    );
  }
  result = normalizeType(result, path, diagnostics);
  if (diagnostics.length > 0) throw new CBindgenError(diagnostics);
  return result;
}

export function renderCType(type: CTypeCandidate): string {
  if (type.kind === "named") {
    return `${renderQualifiers(type.qualifiers)}${type.name}`;
  }
  const pointerQualifiers = type.qualifiers.length === 0
    ? ""
    : ` ${type.qualifiers.join(" ")}`;
  return `${renderCType(type.pointee)} *${pointerQualifiers}`.trimEnd();
}

export function renderCFunctionPointerType(
  function_: CFunctionCandidate,
  name: string,
): string {
  const parameters = function_.parameters.length === 0
    ? "void"
    : function_.parameters.map(renderCType).join(", ");
  return `${renderCType(function_.result)} (*${name})(${parameters})`;
}

export function generateClangFunctionProbe(input: {
  readonly includes: readonly string[];
  readonly functions: readonly CFunctionCandidate[];
}): ClangFunctionProbe {
  const diagnostics: CBindgenDiagnostic[] = [];
  const includes = [...input.includes];
  const seenIncludes = new Set<string>();
  for (const [index, include] of includes.entries()) {
    const segments = include.split("/");
    if (
      include.length === 0 ||
      include.includes("\\") ||
      segments.some((segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !headerSegmentPattern.test(segment)
      )
    ) {
      diagnostics.push(
        diagnostic("NTS5001", `includes/${index}`, `Invalid C include '${include}'`),
      );
    } else if (seenIncludes.has(include)) {
      diagnostics.push(
        diagnostic("NTS5002", `includes/${index}`, `Duplicate C include '${include}'`),
      );
    }
    seenIncludes.add(include);
  }

  const functions: CFunctionCandidate[] = [];
  const seenIds = new Set<string>();
  const seenSymbols = new Set<string>();
  for (const [index, function_] of input.functions.entries()) {
    const path = `functions/${index}`;
    if (!identityPattern.test(function_.id)) {
      diagnostics.push(
        diagnostic("NTS5001", `${path}/id`, `Invalid function identity '${function_.id}'`),
      );
    } else if (seenIds.has(function_.id)) {
      diagnostics.push(
        diagnostic("NTS5002", `${path}/id`, `Duplicate function identity '${function_.id}'`),
      );
    }
    if (!cIdentifierPattern.test(function_.symbol)) {
      diagnostics.push(
        diagnostic("NTS5001", `${path}/symbol`, `Invalid C symbol '${function_.symbol}'`),
      );
    } else if (seenSymbols.has(function_.symbol)) {
      diagnostics.push(
        diagnostic("NTS5002", `${path}/symbol`, `Duplicate C symbol '${function_.symbol}'`),
      );
    }
    seenIds.add(function_.id);
    seenSymbols.add(function_.symbol);
    functions.push(Object.freeze({
      id: function_.id,
      symbol: function_.symbol,
      result: normalizeType(function_.result, `${path}/result`, diagnostics),
      parameters: Object.freeze(
        function_.parameters.map((parameter, parameterIndex) =>
          normalizeType(
            parameter,
            `${path}/parameters/${parameterIndex}`,
            diagnostics,
          )
        ),
      ),
    }));
  }
  if (functions.length === 0) {
    diagnostics.push(
      diagnostic("NTS5001", "functions", "A Clang function probe requires a selection"),
    );
  }
  if (diagnostics.length > 0) throw new CBindgenError(diagnostics);

  includes.sort(compareText);
  functions.sort((left, right) => compareText(left.id, right.id));
  const contractDigest = sha256(JSON.stringify({
    schema: "native-typescript.clang-function-contract",
    schemaVersion: 1,
    includes,
    functions,
  }));
  const recordName = `nts_abi_probe_snapshot_${contractDigest
    .slice("sha256:".length, "sha256:".length + 16)}`;
  const lines = [
    "/* Generated by @native-typescript/bindgen-c. */",
    ...includes.map((include) => `#include <${include}>`),
    "",
  ];
  for (const [index, function_] of functions.entries()) {
    const suffix = index.toString().padStart(4, "0");
    const typeName = `nts_abi_expected_${suffix}`;
    lines.push(
      `typedef ${renderCFunctionPointerType(function_, typeName)};`,
      "_Static_assert(",
      `  __builtin_types_compatible_p(__typeof__(&${function_.symbol}), ${typeName}),`,
      `  "NTS5004 C ABI mismatch for ${function_.id}"`,
      ");",
      "",
    );
  }
  lines.push(`struct ${recordName} {`);
  for (const [index, function_] of functions.entries()) {
    const suffix = index.toString().padStart(4, "0");
    lines.push(`  __typeof__(&${function_.symbol}) symbol_${suffix};`);
  }
  lines.push("};", "");
  const source = lines.join("\n");
  return Object.freeze({
    schema: "native-typescript.clang-function-probe",
    schemaVersion: 1,
    source,
    sourceDigest: sha256(source),
    contractDigest,
    includes: Object.freeze(includes),
    functions: Object.freeze(functions),
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseClangFunctionEvidence(
  astJson: string,
  input: {
    readonly probe: ClangFunctionProbe;
    readonly clang: {
      readonly toolId: string;
      readonly version: string;
      readonly digest: string;
      readonly target: string;
    };
  },
): ClangFunctionEvidenceSnapshot {
  const diagnostics: CBindgenDiagnostic[] = [];
  const clang = Object.freeze({
    toolId: input.clang.toolId,
    version: input.clang.version,
    digest: input.clang.digest,
    target: input.clang.target,
  });
  if (!digestPattern.test(input.clang.digest)) {
    diagnostics.push(
      diagnostic("NTS5001", "clang/digest", "Clang tool digest is not canonical sha256"),
    );
  }
  if (
    !digestPattern.test(input.probe.sourceDigest) ||
    sha256(input.probe.source) !== input.probe.sourceDigest
  ) {
    diagnostics.push(
      diagnostic("NTS5001", "probe/sourceDigest", "Clang probe source digest is invalid"),
    );
  }
  if (!digestPattern.test(input.probe.contractDigest)) {
    diagnostics.push(
      diagnostic("NTS5001", "probe/contractDigest", "Clang probe contract digest is invalid"),
    );
  }
  for (const [field, value] of Object.entries(clang)) {
    if (field !== "digest" && !identityPattern.test(value)) {
      diagnostics.push(
        diagnostic("NTS5001", `clang/${field}`, `Invalid Clang identity '${value}'`),
      );
    }
  }
  let root: unknown;
  try {
    root = JSON.parse(astJson);
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "NTS5003",
        "ast",
        `Clang AST output is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  if (
    !isRecord(root) ||
    root.kind !== "RecordDecl" ||
    root.name !== `nts_abi_probe_snapshot_${input.probe.contractDigest
      .slice("sha256:".length, "sha256:".length + 16)}` ||
    root.completeDefinition !== true ||
    !Array.isArray(root.inner)
  ) {
    diagnostics.push(
      diagnostic("NTS5003", "ast", "Clang AST did not contain the complete probe record"),
    );
  }

  const fields = isRecord(root) && Array.isArray(root.inner)
    ? root.inner.filter((entry) => isRecord(entry) && entry.kind === "FieldDecl")
    : [];
  if (fields.length !== input.probe.functions.length) {
    diagnostics.push(
      diagnostic(
        "NTS5004",
        "ast/fields",
        `Expected ${input.probe.functions.length} verified symbols, received ${fields.length}`,
      ),
    );
  }
  const functions: ClangFunctionEvidence[] = [];
  for (const [index, function_] of input.probe.functions.entries()) {
    const field = fields[index];
    const expectedName = `symbol_${index.toString().padStart(4, "0")}`;
    const type = isRecord(field) && isRecord(field.type) ? field.type : null;
    const clangType = typeof type?.desugaredQualType === "string"
      ? type.desugaredQualType
      : typeof type?.qualType === "string"
        ? type.qualType
        : null;
    if (!isRecord(field) || field.name !== expectedName || clangType === null) {
      diagnostics.push(
        diagnostic(
          "NTS5004",
          `ast/fields/${index}`,
          `Clang AST field '${expectedName}' is missing or malformed`,
        ),
      );
      continue;
    }
    functions.push(Object.freeze({
      id: function_.id,
      symbol: function_.symbol,
      expectedType: renderCFunctionPointerType(function_, ""),
      clangType,
    }));
  }
  if (diagnostics.length > 0) throw new CBindgenError(diagnostics);

  const semanticValue = {
    schema: "native-typescript.clang-function-evidence",
    schemaVersion: 1,
    probeDigest: input.probe.sourceDigest,
    clang,
    functions,
  };
  return Object.freeze({
    schema: "native-typescript.clang-function-evidence",
    schemaVersion: 1,
    probeDigest: input.probe.sourceDigest,
    semanticDigest: sha256(JSON.stringify(semanticValue)),
    clang,
    functions: Object.freeze(functions),
  });
}
