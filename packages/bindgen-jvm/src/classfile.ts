/**
 * A structural reader for the JVM class-file format (JVMS §4). It reads only
 * what ingestion consumes — identity, hierarchy, member surfaces, and the
 * attributes that state contract facts (ConstantValue, Exceptions, Signature,
 * Deprecated, InnerClasses) — and skips every other attribute by its declared
 * length, which the format defines for exactly this purpose. Anything
 * structurally wrong fails with a positioned diagnostic; nothing is guessed.
 */

import type {
  JvmConstantValue,
  JvmDiagnostic,
  JvmNesting,
} from "./jvm-model.ts";

/* Class-file versions this reader understands: JDK 1.1 (45) through the JDK
 * current at the time of writing (69 = Java 25). A later major is refused
 * rather than read on the assumption nothing changed. */
const minSupportedMajor = 45;
const maxSupportedMajor = 69;

export interface ParsedMethod {
  readonly name: string;
  readonly descriptor: string;
  readonly accessFlags: number;
  readonly deprecated: boolean;
  readonly genericSignature: string | null;
  readonly exceptions: readonly string[];
}

export interface ParsedField {
  readonly name: string;
  readonly descriptor: string;
  readonly accessFlags: number;
  readonly deprecated: boolean;
  readonly genericSignature: string | null;
  readonly constantValue: JvmConstantValue | null;
}

export interface ParsedClass {
  readonly binaryName: string;
  readonly major: number;
  readonly minor: number;
  readonly accessFlags: number;
  readonly superName: string | null;
  readonly interfaceNames: readonly string[];
  readonly nested: JvmNesting | null;
  readonly deprecated: boolean;
  readonly genericSignature: string | null;
  readonly methods: readonly ParsedMethod[];
  readonly fields: readonly ParsedField[];
}

class ClassFileError extends Error {
  constructor(message: string) {
    super(message);
  }
}

type PoolEntry =
  | { readonly tag: 1; readonly text: string }
  | { readonly tag: 3; readonly int: number }
  | { readonly tag: 4; readonly bits: string }
  | { readonly tag: 5; readonly long: string }
  | { readonly tag: 6; readonly bits: string }
  | { readonly tag: 7; readonly nameIndex: number }
  | { readonly tag: 8; readonly stringIndex: number }
  | { readonly tag: number };

/* Java class files use modified UTF-8: U+0000 as C0 80, no four-byte forms,
 * supplementary characters as CESU-8 surrogate pairs. A standard UTF-8
 * decoder misreads all three, so this is decoded by hand. Each decoded unit
 * is a UTF-16 code unit, which is exactly what a JS string is made of. */
function decodeModifiedUtf8(
  bytes: Uint8Array,
  start: number,
  length: number,
): string {
  const units: number[] = [];
  let i = start;
  const end = start + length;
  while (i < end) {
    const b0 = bytes[i]!;
    if (b0 >= 0x01 && b0 <= 0x7f) {
      units.push(b0);
      i += 1;
      continue;
    }
    if (b0 >= 0xc0 && b0 <= 0xdf) {
      if (i + 1 >= end) throw new ClassFileError("Truncated 2-byte UTF-8 unit");
      const b1 = bytes[i + 1]!;
      if ((b1 & 0xc0) !== 0x80) {
        throw new ClassFileError("Malformed 2-byte UTF-8 unit");
      }
      units.push(((b0 & 0x1f) << 6) | (b1 & 0x3f));
      i += 2;
      continue;
    }
    if (b0 >= 0xe0 && b0 <= 0xef) {
      if (i + 2 >= end) throw new ClassFileError("Truncated 3-byte UTF-8 unit");
      const b1 = bytes[i + 1]!;
      const b2 = bytes[i + 2]!;
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) {
        throw new ClassFileError("Malformed 3-byte UTF-8 unit");
      }
      units.push(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
      i += 3;
      continue;
    }
    throw new ClassFileError(
      `Byte 0x${b0.toString(16)} is not modified UTF-8`,
    );
  }
  return String.fromCharCode(...units);
}

class Reader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private cursor = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private need(count: number): void {
    if (this.cursor + count > this.bytes.byteLength) {
      throw new ClassFileError(
        `Truncated class file: needed ${count} byte(s) at offset ${this.cursor}`,
      );
    }
  }

  u1(): number {
    this.need(1);
    return this.view.getUint8(this.cursor++);
  }

  u2(): number {
    this.need(2);
    const value = this.view.getUint16(this.cursor);
    this.cursor += 2;
    return value;
  }

  u4(): number {
    this.need(4);
    const value = this.view.getUint32(this.cursor);
    this.cursor += 4;
    return value;
  }

  i4(): number {
    this.need(4);
    const value = this.view.getInt32(this.cursor);
    this.cursor += 4;
    return value;
  }

  hexBits(byteCount: 4 | 8): string {
    this.need(byteCount);
    let hex = "";
    for (let i = 0; i < byteCount; i++) {
      hex += this.view.getUint8(this.cursor + i).toString(16).padStart(2, "0");
    }
    this.cursor += byteCount;
    return `0x${hex}`;
  }

  longDecimal(): string {
    this.need(8);
    const value = this.view.getBigInt64(this.cursor);
    this.cursor += 8;
    return value.toString(10);
  }

  utf8(length: number): string {
    this.need(length);
    const text = decodeModifiedUtf8(this.bytes, this.cursor, length);
    this.cursor += length;
    return text;
  }

  skip(count: number): void {
    this.need(count);
    this.cursor += count;
  }
}

class ConstantPool {
  private readonly entries: (PoolEntry | undefined)[];

  constructor(reader: Reader) {
    const count = reader.u2();
    this.entries = new Array(count);
    let index = 1;
    while (index < count) {
      const tag = reader.u1();
      switch (tag) {
        case 1: {
          const length = reader.u2();
          this.entries[index] = { tag, text: reader.utf8(length) };
          break;
        }
        case 3:
          this.entries[index] = { tag, int: reader.i4() };
          break;
        case 4:
          this.entries[index] = { tag, bits: reader.hexBits(4) };
          break;
        case 5:
          this.entries[index] = { tag, long: reader.longDecimal() };
          break;
        case 6:
          this.entries[index] = { tag, bits: reader.hexBits(8) };
          break;
        case 7:
          this.entries[index] = { tag, nameIndex: reader.u2() };
          break;
        case 8:
          this.entries[index] = { tag, stringIndex: reader.u2() };
          break;
        case 9:
        case 10:
        case 11:
        case 12:
          reader.skip(4);
          this.entries[index] = { tag };
          break;
        case 15:
          reader.skip(3);
          this.entries[index] = { tag };
          break;
        case 16:
          reader.skip(2);
          this.entries[index] = { tag };
          break;
        case 17:
        case 18:
          reader.skip(4);
          this.entries[index] = { tag };
          break;
        case 19:
        case 20:
          reader.skip(2);
          this.entries[index] = { tag };
          break;
        default:
          throw new ClassFileError(
            `Unknown constant pool tag ${tag} at entry ${index}`,
          );
      }
      /* Longs and doubles take two pool slots by specification. */
      index += tag === 5 || tag === 6 ? 2 : 1;
    }
    if (index !== count) {
      throw new ClassFileError(
        "Constant pool 8-byte entry overruns the declared count",
      );
    }
  }

  at(index: number): PoolEntry {
    const entry = this.entries[index];
    if (entry === undefined) {
      throw new ClassFileError(`Constant pool index ${index} is not an entry`);
    }
    return entry;
  }

  utf8At(index: number): string {
    const entry = this.at(index);
    if (entry.tag !== 1 || !("text" in entry)) {
      throw new ClassFileError(
        `Constant pool index ${index} is not a Utf8 entry`,
      );
    }
    return entry.text;
  }

  classNameAt(index: number): string {
    const entry = this.at(index);
    if (entry.tag !== 7 || !("nameIndex" in entry)) {
      throw new ClassFileError(
        `Constant pool index ${index} is not a Class entry`,
      );
    }
    return this.utf8At(entry.nameIndex);
  }

  constantValueAt(index: number): JvmConstantValue {
    const entry = this.at(index);
    switch (entry.tag) {
      case 3:
        if ("int" in entry) return { kind: "int", value: String(entry.int) };
        break;
      case 4:
        if ("bits" in entry) return { kind: "float", bits: entry.bits };
        break;
      case 5:
        if ("long" in entry) return { kind: "long", value: entry.long };
        break;
      case 6:
        if ("bits" in entry) return { kind: "double", bits: entry.bits };
        break;
      case 8:
        if ("stringIndex" in entry) {
          return { kind: "string", value: this.utf8At(entry.stringIndex) };
        }
        break;
    }
    throw new ClassFileError(
      `Constant pool index ${index} is not a constant value`,
    );
  }
}

interface MemberAttributes {
  deprecated: boolean;
  genericSignature: string | null;
  exceptions: string[];
  constantValue: JvmConstantValue | null;
}

function readMemberAttributes(
  reader: Reader,
  pool: ConstantPool,
): MemberAttributes {
  const out: MemberAttributes = {
    deprecated: false,
    genericSignature: null,
    exceptions: [],
    constantValue: null,
  };
  const count = reader.u2();
  for (let i = 0; i < count; i++) {
    const name = pool.utf8At(reader.u2());
    const length = reader.u4();
    switch (name) {
      case "Deprecated":
        reader.skip(length);
        out.deprecated = true;
        break;
      case "Signature":
        if (length !== 2) {
          throw new ClassFileError("Signature attribute must be 2 bytes");
        }
        out.genericSignature = pool.utf8At(reader.u2());
        break;
      case "Exceptions": {
        const exceptionCount = reader.u2();
        if (length !== 2 + exceptionCount * 2) {
          throw new ClassFileError("Exceptions attribute length disagrees");
        }
        for (let j = 0; j < exceptionCount; j++) {
          out.exceptions.push(pool.classNameAt(reader.u2()));
        }
        break;
      }
      case "ConstantValue":
        if (length !== 2) {
          throw new ClassFileError("ConstantValue attribute must be 2 bytes");
        }
        out.constantValue = pool.constantValueAt(reader.u2());
        break;
      default:
        reader.skip(length);
        break;
    }
  }
  return out;
}

interface ClassAttributes {
  deprecated: boolean;
  genericSignature: string | null;
  nested: JvmNesting | null;
}

function readClassAttributes(
  reader: Reader,
  pool: ConstantPool,
  binaryName: string,
): ClassAttributes {
  const out: ClassAttributes = {
    deprecated: false,
    genericSignature: null,
    nested: null,
  };
  const count = reader.u2();
  for (let i = 0; i < count; i++) {
    const name = pool.utf8At(reader.u2());
    const length = reader.u4();
    switch (name) {
      case "Deprecated":
        reader.skip(length);
        out.deprecated = true;
        break;
      case "Signature":
        if (length !== 2) {
          throw new ClassFileError("Signature attribute must be 2 bytes");
        }
        out.genericSignature = pool.utf8At(reader.u2());
        break;
      case "InnerClasses": {
        const entryCount = reader.u2();
        if (length !== 2 + entryCount * 8) {
          throw new ClassFileError("InnerClasses attribute length disagrees");
        }
        for (let j = 0; j < entryCount; j++) {
          const innerIndex = reader.u2();
          const outerIndex = reader.u2();
          const innerNameIndex = reader.u2();
          const innerFlags = reader.u2();
          /* Only the entry describing this class itself states where it
           * sits; the rest describe classes it merely references. */
          if (pool.classNameAt(innerIndex) !== binaryName) continue;
          out.nested = {
            outer: outerIndex === 0 ? null : pool.classNameAt(outerIndex),
            innerName:
              innerNameIndex === 0 ? null : pool.utf8At(innerNameIndex),
            static: (innerFlags & 0x0008) !== 0,
          };
        }
        break;
      }
      default:
        reader.skip(length);
        break;
    }
  }
  return out;
}

export function parseClassFile(
  bytes: Uint8Array,
  path: string,
  diagnostics: JvmDiagnostic[],
): ParsedClass | null {
  try {
    const reader = new Reader(bytes);
    const magic = reader.u4();
    if (magic !== 0xcafebabe) {
      diagnostics.push({
        code: "NTS6002",
        severity: "error",
        path,
        message: `Not a class file: magic is 0x${magic.toString(16)}`,
      });
      return null;
    }
    const minor = reader.u2();
    const major = reader.u2();
    if (major < minSupportedMajor || major > maxSupportedMajor) {
      diagnostics.push({
        code: "NTS6005",
        severity: "error",
        path,
        message:
          `Unsupported class file version ${major}.${minor}; ` +
          `supported majors are ${minSupportedMajor}..${maxSupportedMajor}`,
      });
      return null;
    }
    const pool = new ConstantPool(reader);
    const accessFlags = reader.u2();
    const binaryName = pool.classNameAt(reader.u2());
    const superIndex = reader.u2();
    const superName = superIndex === 0 ? null : pool.classNameAt(superIndex);
    const interfaceCount = reader.u2();
    const interfaceNames: string[] = [];
    for (let i = 0; i < interfaceCount; i++) {
      interfaceNames.push(pool.classNameAt(reader.u2()));
    }
    const fields: ParsedField[] = [];
    const fieldCount = reader.u2();
    for (let i = 0; i < fieldCount; i++) {
      const flags = reader.u2();
      const name = pool.utf8At(reader.u2());
      const descriptor = pool.utf8At(reader.u2());
      const attributes = readMemberAttributes(reader, pool);
      fields.push({
        name,
        descriptor,
        accessFlags: flags,
        deprecated: attributes.deprecated,
        genericSignature: attributes.genericSignature,
        constantValue: attributes.constantValue,
      });
    }
    const methods: ParsedMethod[] = [];
    const methodCount = reader.u2();
    for (let i = 0; i < methodCount; i++) {
      const flags = reader.u2();
      const name = pool.utf8At(reader.u2());
      const descriptor = pool.utf8At(reader.u2());
      const attributes = readMemberAttributes(reader, pool);
      methods.push({
        name,
        descriptor,
        accessFlags: flags,
        deprecated: attributes.deprecated,
        genericSignature: attributes.genericSignature,
        exceptions: attributes.exceptions,
      });
    }
    const classAttributes = readClassAttributes(reader, pool, binaryName);
    return {
      binaryName,
      major,
      minor,
      accessFlags,
      superName,
      interfaceNames,
      nested: classAttributes.nested,
      deprecated: classAttributes.deprecated,
      genericSignature: classAttributes.genericSignature,
      methods,
      fields,
    };
  } catch (error) {
    if (!(error instanceof ClassFileError)) throw error;
    diagnostics.push({
      code: "NTS6002",
      severity: "error",
      path,
      message: error.message,
    });
    return null;
  }
}
