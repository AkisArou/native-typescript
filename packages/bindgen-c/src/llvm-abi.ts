import { CBindgenError } from "./model.ts";
import type {
  CBindgenDiagnostic,
  ClangAbiProbe,
  ClangAbiType,
  ClangAbiValue,
  ClangRecordCallingConventionEvidence,
} from "./model.ts";

interface ParsedType {
  readonly type: ClangAbiType;
  readonly end: number;
}

function diagnostic(path: string, message: string): CBindgenDiagnostic {
  return { code: "NTS5003", severity: "error", path, message };
}

function skipSpace(text: string, start: number): number {
  let index = start;
  while (/\s/u.test(text[index] ?? "")) index += 1;
  return index;
}

function integer(text: string, start: number): { readonly value: number; readonly end: number } | null {
  const match = /^[0-9]+/u.exec(text.slice(start));
  if (match === null) return null;
  const value = Number(match[0]);
  return Number.isSafeInteger(value) ? { value, end: start + match[0].length } : null;
}

function keyword(text: string, start: number, value: string): number | null {
  if (!text.startsWith(value, start)) return null;
  const next = text[start + value.length];
  return next === undefined || !/[A-Za-z0-9_]/u.test(next)
    ? start + value.length
    : null;
}

function parseSequence(
  text: string,
  start: number,
  close: string,
): { readonly values: readonly ClangAbiType[]; readonly end: number } | null {
  const values: ClangAbiType[] = [];
  let index = skipSpace(text, start);
  if (text.startsWith(close, index)) return { values: Object.freeze(values), end: index + close.length };
  while (index < text.length) {
    const parsed = parseType(text, index);
    if (parsed === null) return null;
    values.push(parsed.type);
    index = skipSpace(text, parsed.end);
    if (text.startsWith(close, index)) {
      return { values: Object.freeze(values), end: index + close.length };
    }
    if (text[index] !== ",") return null;
    index = skipSpace(text, index + 1);
  }
  return null;
}

function parseType(text: string, start: number): ParsedType | null {
  const index = skipSpace(text, start);
  const integerType = /^i([1-9][0-9]*)/u.exec(text.slice(index));
  if (integerType !== null) {
    const end = index + integerType[0].length;
    if (!/[A-Za-z0-9_]/u.test(text[end] ?? "")) {
      return {
        type: Object.freeze({ kind: "integer", bits: Number(integerType[1]) }),
        end,
      };
    }
  }
  const floats = ["x86_fp80", "bfloat", "double", "float", "fp128", "half"] as const;
  for (const format of floats) {
    const end = keyword(text, index, format);
    if (end !== null) return { type: Object.freeze({ kind: "float", format }), end };
  }
  const voidEnd = keyword(text, index, "void");
  if (voidEnd !== null) return { type: Object.freeze({ kind: "void" }), end: voidEnd };
  const pointerEnd = keyword(text, index, "ptr");
  if (pointerEnd !== null) {
    let end = skipSpace(text, pointerEnd);
    let addressSpace = 0;
    if (text.startsWith("addrspace(", end)) {
      const value = integer(text, end + "addrspace(".length);
      if (value === null || text[value.end] !== ")") return null;
      addressSpace = value.value;
      end = value.end + 1;
    } else {
      end = pointerEnd;
    }
    return { type: Object.freeze({ kind: "pointer", addressSpace }), end };
  }
  if (text[index] === "%") {
    const quoted = /^%"(?:[^"\\]|\\.)+"/u.exec(text.slice(index));
    const plain = /^%[-A-Za-z$._0-9]+/u.exec(text.slice(index));
    const match = quoted ?? plain;
    if (match === null) return null;
    return {
      type: Object.freeze({ kind: "named", name: match[0] }),
      end: index + match[0].length,
    };
  }
  if (text[index] === "[") {
    let cursor = skipSpace(text, index + 1);
    const count = integer(text, cursor);
    if (count === null) return null;
    cursor = skipSpace(text, count.end);
    if (text[cursor] !== "x") return null;
    const element = parseType(text, cursor + 1);
    if (element === null) return null;
    cursor = skipSpace(text, element.end);
    if (text[cursor] !== "]") return null;
    return {
      type: Object.freeze({ kind: "array", count: count.value, element: element.type }),
      end: cursor + 1,
    };
  }
  if (text.startsWith("<{", index)) {
    const sequence = parseSequence(text, index + 2, "}>");
    return sequence === null
      ? null
      : {
          type: Object.freeze({ kind: "struct", packed: true, fields: sequence.values }),
          end: sequence.end,
        };
  }
  if (text[index] === "{") {
    const sequence = parseSequence(text, index + 1, "}");
    return sequence === null
      ? null
      : {
          type: Object.freeze({ kind: "struct", packed: false, fields: sequence.values }),
          end: sequence.end,
        };
  }
  if (text[index] === "<") {
    let cursor = skipSpace(text, index + 1);
    let scalable = false;
    if (text.startsWith("vscale", cursor)) {
      scalable = true;
      cursor = skipSpace(text, cursor + "vscale".length);
      if (text[cursor] !== "x") return null;
      cursor = skipSpace(text, cursor + 1);
    }
    const count = integer(text, cursor);
    if (count === null) return null;
    cursor = skipSpace(text, count.end);
    if (text[cursor] !== "x") return null;
    const element = parseType(text, cursor + 1);
    if (element === null) return null;
    cursor = skipSpace(text, element.end);
    if (text[cursor] !== ">") return null;
    return {
      type: Object.freeze({
        kind: "vector",
        count: count.value,
        scalable,
        element: element.type,
      }),
      end: cursor + 1,
    };
  }
  return null;
}

function balancedArgument(text: string, marker: string): string | null {
  const start = text.indexOf(`${marker}(`);
  if (start < 0) return null;
  let depth = 1;
  for (let index = start + marker.length + 1; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    if (text[index] === ")") depth -= 1;
    if (depth === 0) return text.slice(start + marker.length + 1, index);
  }
  return null;
}

function parseValue(text: string, path: string): ClangAbiValue {
  const starts = [...text.matchAll(/(?:^|\s)(?=void\b|i[1-9][0-9]*\b|half\b|bfloat\b|float\b|double\b|fp128\b|x86_fp80\b|ptr\b|%|\[|\{|<)/gu)]
    .map((match) => (match.index ?? 0) + match[0].length);
  let parsed: ParsedType | null = null;
  let typeStart = -1;
  for (const start of starts) {
    const candidate = parseType(text, start);
    if (candidate !== null) {
      parsed = candidate;
      typeStart = start;
      break;
    }
  }
  if (parsed === null) {
    throw new CBindgenError([diagnostic(path, `Unsupported LLVM ABI value '${text.trim()}'`)]);
  }
  const attributes = `${text.slice(0, typeStart)} ${text.slice(parsed.end)}`;
  const alignmentMatch = /(?:^|\s)align\s+([1-9][0-9]*)(?:\s|$)/u.exec(attributes);
  const stackAlignmentMatch = /\balignstack\(([1-9][0-9]*)\)/u.exec(attributes);
  const byValue = balancedArgument(attributes, "byval");
  const structureReturn = balancedArgument(attributes, "sret");
  const parseAttributeType = (value: string | null, name: string): ClangAbiType | null => {
    if (value === null) return null;
    const attributeType = parseType(value, 0);
    if (attributeType === null || skipSpace(value, attributeType.end) !== value.length) {
      throw new CBindgenError([diagnostic(path, `Unsupported LLVM ${name} type '${value}'`)]);
    }
    return attributeType.type;
  };
  return Object.freeze({
    type: parsed.type,
    alignment: alignmentMatch === null ? null : Number(alignmentMatch[1]),
    stackAlignment: stackAlignmentMatch === null ? null : Number(stackAlignmentMatch[1]),
    extension: /\bsignext\b/u.test(attributes)
      ? "sign"
      : /\bzeroext\b/u.test(attributes)
        ? "zero"
        : null,
    inRegister: /\binreg\b/u.test(attributes),
    byValue: parseAttributeType(byValue, "byval"),
    structureReturn: parseAttributeType(structureReturn, "sret"),
  });
}

function splitParameters(text: string): readonly string[] {
  const result: string[] = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let angle = 0;
  for (let index = 0; index < text.length; index += 1) {
    const value = text[index];
    if (value === "(") round += 1;
    if (value === ")") round -= 1;
    if (value === "[") square += 1;
    if (value === "]") square -= 1;
    if (value === "{") curly += 1;
    if (value === "}") curly -= 1;
    if (value === "<") angle += 1;
    if (value === ">") angle -= 1;
    if (value === "," && round === 0 && square === 0 && curly === 0 && angle === 0) {
      result.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail.length > 0) result.push(tail);
  return Object.freeze(result);
}

function signature(
  llvmIr: string,
  symbol: string,
  path: string,
): ClangRecordCallingConventionEvidence {
  const marker = `@${symbol}(`;
  const markerIndex = llvmIr.indexOf(marker);
  const defineIndex = llvmIr.lastIndexOf("\ndefine ", markerIndex);
  if (markerIndex < 0 || defineIndex < 0) {
    throw new CBindgenError([diagnostic(path, `LLVM IR is missing classifier '${symbol}'`)]);
  }
  const parametersStart = markerIndex + marker.length;
  let depth = 1;
  let parametersEnd = -1;
  for (let index = parametersStart; index < llvmIr.length; index += 1) {
    if (llvmIr[index] === "(") depth += 1;
    if (llvmIr[index] === ")") depth -= 1;
    if (depth === 0) {
      parametersEnd = index;
      break;
    }
  }
  if (parametersEnd < 0) {
    throw new CBindgenError([diagnostic(path, `LLVM classifier '${symbol}' has a malformed signature`)]);
  }
  const resultText = llvmIr.slice(defineIndex + "\ndefine ".length, markerIndex).trim();
  return Object.freeze({
    result: parseValue(resultText, `${path}/result`),
    parameters: Object.freeze(
      splitParameters(llvmIr.slice(parametersStart, parametersEnd)).map((parameter, index) =>
        parseValue(parameter, `${path}/parameters/${index}`)
      ),
    ),
  });
}

export function parseClangRecordCallingConventions(
  llvmIr: string,
  probe: ClangAbiProbe,
): readonly ClangRecordCallingConventionEvidence[] {
  return Object.freeze(probe.records.map((_record, index) =>
    signature(
      llvmIr,
      `nts_abi_classify_record_${index.toString().padStart(4, "0")}`,
      `llvm/records/${index}/callingConvention`,
    )
  ));
}
