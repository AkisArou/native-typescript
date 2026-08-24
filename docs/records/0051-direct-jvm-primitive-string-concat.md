# 0051 — Feed exact primitives directly into Direct JVM string concatenation

Status: implementation, semantic proof, and repeated device measurement complete  
Recorded: 2026-08-24

The dynamic Android text-update workload remained 1.52x Kotlin after nearby
string operations had reached 1.10x. Both applications create the same
changing text and assign it to one stable `TextView`, but the generated Direct
JVM source exposed an extra object:

```java
"Count: " + Integer.toString(index & 1023)
```

Kotlin appends the integer into its final concatenation. Direct JVM first
allocated the integer's standalone `String`, then copied that string into the
final result. That intermediate identity is not observable when the compiler's
`toString` node is consumed immediately by the enclosing concatenation.

## Decision

When a string-concatenation operand is:

- a boolean-to-string conversion; or
- a number-to-string conversion whose operand shared machine-integer facts
  prove is signed int32 and cannot be negative zero,

the Direct JVM emitter now supplies the primitive directly to Java string
concatenation. The measured source becomes:

```java
"Count: " + (index & 1023)
```

Java's boolean and signed-int decimal spellings are exactly the corresponding
JavaScript spellings. Arbitrary `number` values still use
`ntsNumberToString`, preserving JavaScript formatting for NaN, infinities,
negative zero, decimal/scientific thresholds, and exponent signs.

Two adjacent primitive substitutions need special care. Emitting `left +
right` would perform numeric addition before a string existed, so the emitter
adds an empty-string anchor when both immediate operands are primitives:

```java
"" + left + right
```

Evaluation remains left-to-right, each operand is evaluated once, and the
conversion stays at its original concatenation point.

## Semantic and structural proof

The observer was red first because emitted source and bytecode contained
`Integer.toString`. It now includes both a normal template and a deliberately
disagreeing adjacent template:

```ts
`Count: ${value & 1023}`
`${value & 255}${value & 15}`
```

For `value = 42`, the second result must be `"4210"`; numeric addition would
produce `"52"` or `52`. The executed JVM fixture returns the exact Node result.

`javap` proves the generated class contains no call to either
`Integer.toString` or `Boolean.toString`, while the general-double fixture
continues to call the JavaScript-exact formatter and preserves all edge-case
outputs. The on-device generated source independently contains the direct
primitive concatenation shown above.

## Repeated on-device result

The unchanged `text-update` target and `string-operations` control were
measured before and after the change. Each run used five cyclic process rounds
on the API 37 x86-64 Pixel 10 Pro AVD, giving 35 samples per application and
scenario after ART `speed` compilation. Lower is better.

| Workload | Before | Optimized first run | Optimized repeat |
| --- | ---: | ---: | ---: |
| dynamic text update | 335.67 ns | **258.90 ns** | **252.95 ns** |
| Kotlin text update | 220.98 ns | 218.85 ns | 233.10 ns |
| Direct/Kotlin | 1.52x | **1.18x** | **1.09x** |
| string-operation control | 1,766.94 ns | 1,722.46 ns | 1,793.32 ns |
| control Direct/Kotlin | 1.10x | 1.07x | 1.09x |

The targeted update improves 22.9% and 24.6% in the two observations. Its
Kotlin-normalized ratio reaches within 8.5% in the repeat, while the unmodified
string control stays in its prior band. NativeScript remains much slower on
this Android mutation path at 1,104.08/1,080.63 ns, even though its V8 runtime
wins the pure string-transform control. Every checksum passed.

The pre-change schema-8 report is:

- `.native-typescript/benchmarks/android/2026-08-24T18-11-39-792Z/results.json`.

The post-change reports are:

- `.native-typescript/benchmarks/android/2026-08-24T18-16-30-406Z/results.json`;
- `.native-typescript/benchmarks/android/2026-08-24T18-18-54-780Z/results.json`.
