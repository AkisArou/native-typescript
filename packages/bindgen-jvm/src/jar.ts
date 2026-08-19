/**
 * Reads the class entries out of a JAR (or any ZIP-framed container that
 * carries class files, which includes .jmod: its leading magic is absorbed
 * by the standard leading-garbage offset correction). This is the input
 * format the real platform metadata arrives in — `android.jar` is the
 * authoritative Android API surface — so the reader exists exactly to feed
 * `ingestJvmClasses` real sources.
 *
 * Deliberate bounds, each failing precisely rather than partially:
 * - ZIP64 archives, encrypted entries, and compression methods other than
 *   stored/deflate are refused with a diagnostic (NTS6005) until a real
 *   archive needs them.
 * - `META-INF/**` is not class surface and is skipped entirely; in a
 *   multi-release JAR this reads the base-release surface, which is the
 *   surface a consumer that names no release gets from the JAR spec too.
 */

import { inflateRawSync } from "node:zlib";
import { JvmIngestionError } from "./jvm-model.ts";
import type {
  JvmClassSource,
  JvmDiagnostic,
  JvmDiagnosticCode,
} from "./jvm-model.ts";

const eocdSignature = 0x06054b50;
const centralSignature = 0x02014b50;
const localSignature = 0x04034b50;

function fail(
  code: JvmDiagnosticCode,
  path: string,
  message: string,
): never {
  const diagnostic: JvmDiagnostic = { code, severity: "error", path, message };
  throw new JvmIngestionError([diagnostic]);
}

export function readJarClassSources(
  jarBytes: Uint8Array,
  jarLogicalPath: string,
): JvmClassSource[] {
  const view = new DataView(
    jarBytes.buffer,
    jarBytes.byteOffset,
    jarBytes.byteLength,
  );
  /* The end-of-central-directory record sits at the end, before a comment of
   * at most 65535 bytes. Scanning backward for it is the specified way in. */
  const scanFloor = Math.max(0, jarBytes.byteLength - 22 - 65535);
  let eocd = -1;
  for (let i = jarBytes.byteLength - 22; i >= scanFloor; i--) {
    if (view.getUint32(i, true) === eocdSignature) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    fail(
      "NTS6002",
      jarLogicalPath,
      "Not a ZIP archive: no end-of-central-directory record",
    );
  }
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const statedCentralOffset = view.getUint32(eocd + 16, true);
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    statedCentralOffset === 0xffffffff
  ) {
    fail("NTS6005", jarLogicalPath, "ZIP64 archives are not supported yet");
  }
  /* A .jmod (or a self-extracting archive) carries bytes before the ZIP
   * frame, and every stored offset is short by their length. The actual
   * central directory position is known from the EOCD position, so the
   * correction is exact rather than guessed. */
  const centralStart = eocd - centralSize;
  if (centralStart < 0) {
    fail("NTS6002", jarLogicalPath, "Central directory overruns the archive");
  }
  const offsetDelta = centralStart - statedCentralOffset;

  const sources: JvmClassSource[] = [];
  let cursor = centralStart;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let entry = 0; entry < entryCount; entry++) {
    if (
      cursor + 46 > eocd ||
      view.getUint32(cursor, true) !== centralSignature
    ) {
      fail(
        "NTS6002",
        jarLogicalPath,
        `Malformed central directory at entry ${entry}`,
      );
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true) + offsetDelta;
    let name: string;
    try {
      name = decoder.decode(
        jarBytes.subarray(cursor + 46, cursor + 46 + nameLength),
      );
    } catch {
      fail(
        "NTS6002",
        jarLogicalPath,
        `Entry ${entry} has a name that is not UTF-8`,
      );
    }
    cursor += 46 + nameLength + extraLength + commentLength;

    if (!name.endsWith(".class") || name.startsWith("META-INF/")) continue;
    const entryPath = `${jarLogicalPath}!/${name}`;
    if ((flags & 0x0001) !== 0) {
      fail("NTS6005", entryPath, "Encrypted ZIP entries are not supported");
    }
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset - offsetDelta === 0xffffffff
    ) {
      fail("NTS6005", entryPath, "ZIP64 entries are not supported yet");
    }
    if (
      localOffset + 30 > jarBytes.byteLength ||
      view.getUint32(localOffset, true) !== localSignature
    ) {
      fail("NTS6002", entryPath, "Local file header is missing or malformed");
    }
    /* Name and extra lengths in the local header may differ from the central
     * directory's copies; the data position follows the local ones. */
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > jarBytes.byteLength) {
      fail("NTS6002", entryPath, "Entry data overruns the archive");
    }
    const compressed = jarBytes.subarray(dataStart, dataStart + compressedSize);
    let bytes: Uint8Array;
    if (method === 0) {
      bytes = compressed;
    } else if (method === 8) {
      try {
        bytes = inflateRawSync(compressed);
      } catch (error) {
        fail(
          "NTS6002",
          entryPath,
          `Entry does not inflate: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else {
      fail(
        "NTS6005",
        entryPath,
        `ZIP compression method ${method} is not supported`,
      );
    }
    if (bytes.byteLength !== uncompressedSize) {
      fail(
        "NTS6002",
        entryPath,
        `Entry inflates to ${bytes.byteLength} byte(s); the archive ` +
          `declares ${uncompressedSize}`,
      );
    }
    sources.push({ logicalPath: entryPath, bytes });
  }
  return sources;
}
