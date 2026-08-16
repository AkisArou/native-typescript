import type { NativeType, NumberConversion } from "@native-typescript/scabi";
import type { GirTypeReference } from "./gir-model.ts";

/**
 * The GLib scalars that project as exact branded TypeScript types.
 *
 * Each entry names one GIR type, the C spellings that type is allowed to have,
 * and the ABI it claims. The claim is not trusted: the Clang probe proves the
 * callable's real signature, so an entry that mis-states a width or a sign
 * fails generation rather than producing a program that reads the wrong bytes.
 *
 * Widths are fixed and unambiguous. `glong`, `gsize`, and friends vary by
 * platform and are deliberately absent until the probe's evidence, rather than
 * a table, decides their width. `gfloat` is absent because ScriptC has no
 * 32-bit float: admitting it here would silently widen every value.
 */
export interface SourceScalarType {
  readonly girName: string;
  readonly cTypes: readonly string[];
  readonly abiType: string;
  readonly nativeType: NativeType;
  /** 64-bit integers exceed what a TypeScript number holds exactly. */
  readonly carrier: "number" | "bigint";
  /** The source-visible carrier every position of this scalar declares.
   * GLib's ≤32-bit integers are dimensions, indices, counts, and spacings: a
   * double holds every one of them injectively, so they read and write as
   * ordinary numbers and the boundary check keeps that honest. `gdouble` is a
   * double already, so its crossing converts nothing at all — a brand there
   * would forbid arithmetic and ordering while protecting no representation.
   * A 64-bit integer is the one family that cannot make the promise, so it
   * keeps its exact carrier. */
  readonly conversion: NumberConversion | null;
}

function integerScalar(
  girName: string,
  cTypes: readonly string[],
  signed: boolean,
  bits: 8 | 16 | 32 | 64,
): SourceScalarType {
  return Object.freeze({
    girName,
    cTypes: Object.freeze([...cTypes]),
    abiType: girName,
    nativeType: Object.freeze({ kind: "integer", signed, bits }),
    carrier: bits === 64 ? "bigint" : "number",
    conversion: bits === 64 ? null : "number",
  });
}

export const sourceScalarTypes: readonly SourceScalarType[] = Object.freeze([
  Object.freeze({
    girName: "gdouble",
    cTypes: Object.freeze(["double", "gdouble"]),
    abiType: "gdouble",
    nativeType: Object.freeze({ kind: "float", bits: 64 }),
    carrier: "number",
    conversion: "number",
  }) as SourceScalarType,
  integerScalar("gint", ["gint", "int"], true, 32),
  integerScalar("guint", ["guint", "unsigned int"], false, 32),
  integerScalar("gint8", ["gint8"], true, 8),
  integerScalar("guint8", ["guint8"], false, 8),
  integerScalar("gint16", ["gint16", "short"], true, 16),
  integerScalar("guint16", ["guint16", "unsigned short"], false, 16),
  integerScalar("gint32", ["gint32"], true, 32),
  integerScalar("guint32", ["guint32"], false, 32),
  integerScalar("gint64", ["gint64"], true, 64),
  integerScalar("guint64", ["guint64"], false, 64),
]);

export function sourceScalarType(
  type: GirTypeReference,
): SourceScalarType | undefined {
  return type.kind === "named"
    ? sourceScalarTypes.find(
        (scalar) => scalar.girName === type.name &&
          type.cType !== null &&
          scalar.cTypes.includes(type.cType),
      )
    : undefined;
}
