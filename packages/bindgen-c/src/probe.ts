import { createHash } from "node:crypto";
import { CBindgenError } from "./model.ts";
import { parseClangRecordCallingConventions } from "./llvm-abi.ts";
import type {
  CRecordCandidate,
  CBindgenDiagnostic,
  CBindgenDiagnosticCode,
  CFunctionCandidate,
  ClangFunctionEvidence,
  ClangAbiEvidenceSnapshot,
  ClangAbiType,
  ClangAbiValue,
  ClangAbiProbe,
  ClangRecordEvidence,
  ClangRecordFieldEvidence,
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

function semanticAbiType(type: ClangAbiType): object {
  switch (type.kind) {
    case "void":
      return { kind: type.kind };
    case "integer":
      return { kind: type.kind, bits: type.bits };
    case "float":
      return { kind: type.kind, format: type.format };
    case "pointer":
      return { kind: type.kind, addressSpace: type.addressSpace };
    case "array":
      return { kind: type.kind, count: type.count, element: semanticAbiType(type.element) };
    case "vector":
      return {
        kind: type.kind,
        count: type.count,
        scalable: type.scalable,
        element: semanticAbiType(type.element),
      };
    case "struct":
      return {
        kind: type.kind,
        packed: type.packed,
        fields: type.fields.map(semanticAbiType),
      };
    case "named":
      return { kind: type.kind, name: type.name };
  }
}

function semanticAbiValue(value: ClangAbiValue): object {
  return {
    type: semanticAbiType(value.type),
    alignment: value.alignment,
    stackAlignment: value.stackAlignment,
    extension: value.extension,
    inRegister: value.inRegister,
    byValue: value.byValue === null ? null : semanticAbiType(value.byValue),
    structureReturn: value.structureReturn === null
      ? null
      : semanticAbiType(value.structureReturn),
  };
}

export function digestClangAbiEvidence(input: Pick<
  ClangAbiEvidenceSnapshot,
  "probeDigest" | "clang" | "functions" | "records"
>): string {
  return sha256(JSON.stringify({
    schema: "native-typescript.clang-abi-evidence",
    schemaVersion: 2,
    probeDigest: input.probeDigest,
    clang: {
      toolId: input.clang.toolId,
      version: input.clang.version,
      digest: input.clang.digest,
      target: input.clang.target,
    },
    functions: input.functions.map((function_) => ({
      id: function_.id,
      symbol: function_.symbol,
      expectedType: function_.expectedType,
      clangType: function_.clangType,
    })),
    records: input.records.map((record) => ({
      id: record.id,
      typeName: record.typeName,
      size: record.size,
      alignment: record.alignment,
      fields: record.fields.map((field) => ({
        name: field.name,
        expectedType: field.expectedType,
        clangType: field.clangType,
        offset: field.offset,
        size: field.size,
        alignment: field.alignment,
      })),
      callingConvention: {
        result: semanticAbiValue(record.callingConvention.result),
        parameters: record.callingConvention.parameters.map(semanticAbiValue),
      },
    })),
  }));
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

export function generateClangAbiProbe(input: {
  readonly includes: readonly string[];
  readonly functions: readonly CFunctionCandidate[];
  readonly records: readonly CRecordCandidate[];
}): ClangAbiProbe {
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

  const records: CRecordCandidate[] = [];
  const seenRecordTypes = new Set<string>();
  for (const [index, record] of input.records.entries()) {
    const path = `records/${index}`;
    if (!identityPattern.test(record.id)) {
      diagnostics.push(
        diagnostic("NTS5001", `${path}/id`, `Invalid record identity '${record.id}'`),
      );
    } else if (seenIds.has(record.id)) {
      diagnostics.push(
        diagnostic("NTS5002", `${path}/id`, `Duplicate ABI identity '${record.id}'`),
      );
    }
    if (!cIdentifierPattern.test(record.typeName)) {
      diagnostics.push(
        diagnostic("NTS5001", `${path}/typeName`, `Invalid C type identifier '${record.typeName}'`),
      );
    } else if (seenRecordTypes.has(record.typeName)) {
      diagnostics.push(
        diagnostic("NTS5002", `${path}/typeName`, `Duplicate record type '${record.typeName}'`),
      );
    }
    if (record.definition !== "external" && record.definition !== "generated") {
      diagnostics.push(
        diagnostic(
          "NTS5001",
          `${path}/definition`,
          `Invalid record definition origin '${String(record.definition)}'`,
        ),
      );
    }
    seenIds.add(record.id);
    seenRecordTypes.add(record.typeName);
    const seenFields = new Set<string>();
    const fields = record.fields.map((field, fieldIndex) => {
      const fieldPath = `${path}/fields/${fieldIndex}`;
      if (!cIdentifierPattern.test(field.name)) {
        diagnostics.push(
          diagnostic("NTS5001", `${fieldPath}/name`, `Invalid C field '${field.name}'`),
        );
      } else if (seenFields.has(field.name)) {
        diagnostics.push(
          diagnostic("NTS5002", `${fieldPath}/name`, `Duplicate C field '${field.name}'`),
        );
      }
      seenFields.add(field.name);
      return Object.freeze({
        name: field.name,
        type: normalizeType(field.type, `${fieldPath}/type`, diagnostics),
      });
    });
    records.push(Object.freeze({
      id: record.id,
      typeName: record.typeName,
      definition: record.definition,
      fields: Object.freeze(fields),
    }));
  }

  const generatedRecordsByType = new Map(
    records
      .filter((record) => record.definition === "generated")
      .map((record) => [record.typeName, record]),
  );
  const generatedDefinitionOrder: CRecordCandidate[] = [];
  const generatedDefinitionState = new Map<string, "active" | "complete">();
  const visitGeneratedRecord = (record: CRecordCandidate): void => {
    const state = generatedDefinitionState.get(record.typeName);
    if (state === "complete") return;
    if (state === "active") {
      diagnostics.push(diagnostic(
        "NTS5001",
        `records/${record.id}/definition`,
        `Generated record '${record.typeName}' has a recursive by-value definition`,
      ));
      return;
    }
    generatedDefinitionState.set(record.typeName, "active");
    for (const field of record.fields) {
      if (field.type.kind !== "named") continue;
      const dependency = generatedRecordsByType.get(field.type.name);
      if (dependency !== undefined) visitGeneratedRecord(dependency);
    }
    generatedDefinitionState.set(record.typeName, "complete");
    generatedDefinitionOrder.push(record);
  };
  for (const record of [...generatedRecordsByType.values()].sort((left, right) =>
    compareText(left.typeName, right.typeName)
  )) visitGeneratedRecord(record);
  if (functions.length === 0 && records.length === 0) {
    diagnostics.push(
      diagnostic("NTS5001", "selection", "A Clang ABI probe requires a function or record"),
    );
  }
  if (diagnostics.length > 0) throw new CBindgenError(diagnostics);

  includes.sort(compareText);
  functions.sort((left, right) => compareText(left.id, right.id));
  records.sort((left, right) => compareText(left.id, right.id));
  const contractDigest = sha256(JSON.stringify({
    schema: "native-typescript.clang-abi-contract",
    schemaVersion: 2,
    includes,
    functions,
    records,
  }));
  const recordName = `nts_abi_probe_snapshot_${contractDigest
    .slice("sha256:".length, "sha256:".length + 16)}`;
  const lines = [
    "/* Generated by @native-typescript/bindgen-c. */",
    ...includes.map((include) => `#include <${include}>`),
    "",
  ];
  for (const record of generatedDefinitionOrder) {
    lines.push(
      `typedef struct ${record.typeName} ${record.typeName};`,
      `struct ${record.typeName} {`,
      ...record.fields.map((field) =>
        `  ${renderCType(field.type)} ${field.name};`
      ),
      "};",
      "",
    );
  }
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
  for (const [recordIndex, record] of records.entries()) {
    const recordSuffix = recordIndex.toString().padStart(4, "0");
    for (const [fieldIndex, field] of record.fields.entries()) {
      const fieldSuffix = fieldIndex.toString().padStart(4, "0");
      const typeName = `nts_abi_record_${recordSuffix}_field_${fieldSuffix}_expected`;
      lines.push(
        `typedef ${renderCType(field.type)} ${typeName};`,
        "_Static_assert(",
        `  __builtin_types_compatible_p(__typeof__(((${record.typeName} *)0)->${field.name}), ${typeName}),`,
        `  "NTS5004 C record field mismatch for ${record.id}.${field.name}"`,
        ");",
        "",
      );
    }
    lines.push(
      `__attribute__((noinline, used)) ${record.typeName} ` +
        `nts_abi_classify_record_${recordSuffix}(${record.typeName} value) {`,
      "  return value;",
      "}",
      "",
    );
  }
  lines.push(`struct ${recordName} {`);
  for (const [index, function_] of functions.entries()) {
    const suffix = index.toString().padStart(4, "0");
    lines.push(`  __typeof__(&${function_.symbol}) symbol_${suffix};`);
  }
  for (const [recordIndex, record] of records.entries()) {
    const recordSuffix = recordIndex.toString().padStart(4, "0");
    lines.push(
      `  unsigned char record_${recordSuffix}_size[sizeof(${record.typeName})];`,
      `  unsigned char record_${recordSuffix}_alignment[_Alignof(${record.typeName})];`,
    );
    for (const [fieldIndex, field] of record.fields.entries()) {
      const prefix = `record_${recordSuffix}_field_${fieldIndex.toString().padStart(4, "0")}`;
      const expression = `((${record.typeName} *)0)->${field.name}`;
      lines.push(
        `  __typeof__(${expression}) ${prefix}_type;`,
        `  unsigned char ${prefix}_offset[__builtin_offsetof(${record.typeName}, ${field.name}) + 1];`,
        `  unsigned char ${prefix}_size[sizeof(${expression})];`,
        `  unsigned char ${prefix}_alignment[_Alignof(__typeof__(${expression}))];`,
      );
    }
  }
  lines.push("};", "");
  const source = lines.join("\n");
  return Object.freeze({
    schema: "native-typescript.clang-abi-probe",
    schemaVersion: 2,
    source,
    sourceDigest: sha256(source),
    contractDigest,
    includes: Object.freeze(includes),
    functions: Object.freeze(functions),
    records: Object.freeze(records),
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseClangAbiEvidence(
  astJson: string,
  llvmIr: string,
  input: {
    readonly probe: ClangAbiProbe;
    readonly clang: {
      readonly toolId: string;
      readonly version: string;
      readonly digest: string;
      readonly target: string;
    };
  },
): ClangAbiEvidenceSnapshot {
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
  const expectedFieldCount = input.probe.functions.length + input.probe.records.reduce(
    (count, record) => count + 2 + record.fields.length * 4,
    0,
  );
  if (fields.length !== expectedFieldCount) {
    diagnostics.push(
      diagnostic(
        "NTS5004",
        "ast/fields",
        `Expected ${expectedFieldCount} ABI evidence fields, received ${fields.length}`,
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

  const fieldsByName = new Map(
    fields.flatMap((field) =>
      isRecord(field) && typeof field.name === "string" ? [[field.name, field] as const] : []
    ),
  );
  const arrayExtent = (name: string, path: string): number | null => {
    const field = fieldsByName.get(name);
    const type = isRecord(field) && isRecord(field.type) ? field.type : null;
    const spelling = typeof type?.desugaredQualType === "string"
      ? type.desugaredQualType
      : typeof type?.qualType === "string"
        ? type.qualType
        : null;
    const match = spelling === null ? null : /\[([0-9]+)\]$/u.exec(spelling);
    if (match === null) {
      diagnostics.push(diagnostic("NTS5004", path, `Clang AST field '${name}' has no constant extent`));
      return null;
    }
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value < 1) {
      diagnostics.push(diagnostic("NTS5004", path, `Clang AST field '${name}' has an invalid extent`));
      return null;
    }
    return value;
  };
  const records: ClangRecordEvidence[] = [];
  const callingConventions = parseClangRecordCallingConventions(llvmIr, input.probe);
  for (const [recordIndex, record] of input.probe.records.entries()) {
    const recordSuffix = recordIndex.toString().padStart(4, "0");
    const size = arrayExtent(`record_${recordSuffix}_size`, `ast/records/${recordIndex}/size`);
    const alignment = arrayExtent(
      `record_${recordSuffix}_alignment`,
      `ast/records/${recordIndex}/alignment`,
    );
    const recordFields: ClangRecordFieldEvidence[] = [];
    for (const [fieldIndex, candidate] of record.fields.entries()) {
      const prefix = `record_${recordSuffix}_field_${fieldIndex.toString().padStart(4, "0")}`;
      const typeField = fieldsByName.get(`${prefix}_type`);
      const type = isRecord(typeField) && isRecord(typeField.type) ? typeField.type : null;
      const clangType = typeof type?.desugaredQualType === "string"
        ? type.desugaredQualType
        : typeof type?.qualType === "string"
          ? type.qualType
          : null;
      const offsetExtent = arrayExtent(`${prefix}_offset`, `ast/records/${recordIndex}/fields/${fieldIndex}/offset`);
      const fieldSize = arrayExtent(`${prefix}_size`, `ast/records/${recordIndex}/fields/${fieldIndex}/size`);
      const fieldAlignment = arrayExtent(
        `${prefix}_alignment`,
        `ast/records/${recordIndex}/fields/${fieldIndex}/alignment`,
      );
      if (clangType === null) {
        diagnostics.push(
          diagnostic(
            "NTS5004",
            `ast/records/${recordIndex}/fields/${fieldIndex}/type`,
            `Clang AST field '${prefix}_type' is missing or malformed`,
          ),
        );
      }
      if (
        clangType !== null &&
        offsetExtent !== null &&
        fieldSize !== null &&
        fieldAlignment !== null
      ) {
        recordFields.push(Object.freeze({
          name: candidate.name,
          expectedType: renderCType(candidate.type),
          clangType,
          offset: offsetExtent - 1,
          size: fieldSize,
          alignment: fieldAlignment,
        }));
      }
    }
    if (size !== null && alignment !== null && recordFields.length === record.fields.length) {
      records.push(Object.freeze({
        id: record.id,
        typeName: record.typeName,
        size,
        alignment,
        fields: Object.freeze(recordFields),
        callingConvention: callingConventions[recordIndex]!,
      }));
    }
  }
  if (diagnostics.length > 0) throw new CBindgenError(diagnostics);

  const semanticInput = {
    probeDigest: input.probe.sourceDigest,
    clang,
    functions,
    records,
  };
  return Object.freeze({
    schema: "native-typescript.clang-abi-evidence",
    schemaVersion: 2,
    probeDigest: input.probe.sourceDigest,
    semanticDigest: digestClangAbiEvidence(semanticInput),
    clang,
    functions: Object.freeze(functions),
    records: Object.freeze(records),
  });
}
