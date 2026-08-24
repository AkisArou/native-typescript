# 0050 — Parse short JavaScript integers once on Direct JVM

Status: implementation, semantic proof, and repeated device measurement complete  
Recorded: 2026-08-24

After the general integer-calling and array work, a focused five-round
rebaseline removed two apparently large priorities from the original complete
matrix:

| Scenario | Direct JVM | Kotlin | Direct/Kotlin |
| --- | ---: | ---: | ---: |
| stable scalar setter | 15.01 ns | 14.14 ns | 1.06x |
| two string arguments | 29.53 ns | 29.21 ns | 1.01x |
| fixed record | 2.20 ns | 0.99 ns | 2.23x |
| set operations | 12.54 ns | 9.58 ns | 1.31x |
| three numeric parses | 188.46 ns | 135.92 ns | 1.39x |

The old setter and string ratios had already disappeared through changes at
their owning compiler boundaries. The record gap is only 1.2 ns in an
optimized loop, and the Set gap is 3.0 ns. Numeric parsing remained both
stable relative to its earlier 1.36x result and materially larger in raw time,
so it became the next inspection target.

## Finding

`parseInt` validated the complete digit prefix, then called
`ntsDigitsToDouble`, which scanned the same short prefix again to convert it.
An exact integer radix already proved by machine-integer analysis also widened
to Java `double`, only for the parser to apply JavaScript `ToInt32` and recover
the same `int`.

The duplicate scan was not required by JavaScript semantics. The first scan
already knows every digit and can accumulate any sufficiently short value
without overflow. Twelve significant digits are safe for every admitted
radix: even `36^12 - 1` is `4,738,381,338,321,616,895`, below Java's signed
`long` maximum of `9,223,372,036,854,775,807`.

## Decision

Direct JVM now emits two exact parser entries:

```java
private static double ntsParseInt(String value, double radix) {
  return ntsParseInt(value, ntsToInt32(radix));
}

private static double ntsParseInt(String value, int parsedRadix) {
  // JavaScript whitespace, sign, radix, prefix, and longest-prefix scan
}
```

The emitter selects the `int` overload only when shared machine-integer facts
prove the radix is signed int32 and not negative zero. Public or otherwise
general `number` radices retain the `double` entry and exact `ToInt32`
behavior.

During the existing validity scan, the parser accumulates up to twelve
significant digits in a `long`. A completed short prefix returns that value
directly as binary64. Larger prefixes still enter the established exact
conversion machinery: signed-`long`/`BigInteger` conversion for decimal and
power-of-two radices, and V8-style chunk folding for the other radices. Long
leading-zero runs retain signed-zero behavior without forcing the magnitude
onto the slow path.

## Proof

The source observer was red first on the absent `int` parser overload. It now
also requires the short-prefix arm. The parent classfile gate requires both
descriptors:

```text
ntsParseInt:(Ljava/lang/String;D)D
ntsParseInt:(Ljava/lang/String;I)D
```

The JVM execution gate continues to compare raw binary64 bits with Node for:

- JavaScript whitespace, signs, prefixes, invalid tails, NaN, and negative
  zero;
- every radix from 2 through 36;
- very long values and overflow;
- the new twelve- and thirteen-digit base-36 boundary;
- `parseFloat` and whole-string `Number` grammar.

All vectors agree. No regular expression, boxing, JNI call, or generic
dispatcher enters the path.

## Repeated on-device result

The unchanged `number-parsing` contract performs one base-10 `parseInt`, one
`parseFloat`, and one whole-string `Number` conversion per operation. The
baseline and each optimized run used five cyclic process rounds on the API 37
x86-64 Pixel 10 Pro AVD, giving 35 samples per application after ART `speed`
compilation. Lower is better.

| Route | Before | Optimized first run | Optimized repeat |
| --- | ---: | ---: | ---: |
| Native TypeScript / JNI | 76.78 ns | 84.53 ns | 77.03 ns |
| Direct JVM | 188.46 ns | **165.70 ns** | **160.00 ns** |
| Kotlin | 135.92 ns | 128.65 ns | 134.12 ns |
| NativeScript | 79.32 ns | 70.82 ns | 69.61 ns |
| Direct/Kotlin | 1.39x | **1.29x** | **1.19x** |

Direct JVM improves 12.1% and 15.1% in the two post-change observations. The
repeat ratio is within 19.3% of Kotlin while preserving JavaScript's broader
grammar; Kotlin's comparison uses strict `String.toInt()` and
`String.toDouble()`. NativeScript/V8 and the native ScriptC parser remain
faster, so decimal span scanning and conversion remain legitimate measured
follow-up targets. All four routes produced the unchanged checksum.

The pre-change schema-8 report is:

- `.native-typescript/benchmarks/android/2026-08-24T17-48-40-407Z/results.json`.

The post-change reports are:

- `.native-typescript/benchmarks/android/2026-08-24T17-55-37-308Z/results.json`;
- `.native-typescript/benchmarks/android/2026-08-24T17-57-34-380Z/results.json`.
