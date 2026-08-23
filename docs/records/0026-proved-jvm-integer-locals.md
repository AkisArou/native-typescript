# 0026 — Keep proved integer locals in JVM integer registers

Status: experimental direct-JVM slice implemented and measured  
Recorded: 2026-08-23

[Record 0025](0025-direct-jvm-stable-receiver.md) removed JNI from the stable
`TextView.setTextSize` kernel but still measured 4.40x Kotlin. Its generated
bytecode explained the gap: ScriptC's public `number` representation was
`double`, so every iteration performed two `ToInt32` calls, numeric
truthiness, double arithmetic, and a float conversion around one direct ART
call.

## Decision

The public language type remains JavaScript `number`. The compiler now asks
the existing flow-sensitive analysis for a narrower storage proof and uses a
Java `int` only for a local whose every reachable write is proved to be:

- whole and finite;
- never NaN;
- inside signed 32-bit range; and
- never the observably distinct IEEE-754 value `-0`.

Parameters and public results remain `double`. A fractional value, an
overflowing update, an unproved call result, infinity, NaN, or possible `-0`
keeps the ordinary representation. Arithmetic is emitted as integer
arithmetic only when the result and its operands carry the same proof;
otherwise integer locals are widened before the Java operation so Java cannot
silently introduce integer division or overflow.

This is not a JVM emitter heuristic. `ir/number-facts.ts` remains the owner of
the interval, wholeness, NaN, branch, and loop reasoning already used by the
library and native-number boundaries. It now also carries signed-zero evidence
and publishes machine-integer local/expression facts. The JVM emitter merely
spells those facts.

Immutable numeric module constants with exactly one literal initializer seed
the analysis. Pure lowered truthiness and identity upcasts preserve the
environment. Native calls retain immutable facts when their Native IR
contract cannot re-enter a retained callback; unknown or reentrant calls keep
the conservative path.

## Disagreeing proof

The first observer kept the benchmark's module `const` bound and external
function-root shape. It also included three controls that must stay `double`:

```ts
let overflow = 2147483647;
overflow = overflow + 1; // 2147483648

let fractional = 0.5;
fractional = fractional + 1;

let signedZero = -0;
1 / signedZero; // -Infinity
```

It failed because no Java integer local existed. After the first lowering,
the source observer and JVM execution harness passed, but the Android
bytecode still showed a double induction. Two deliberately preserved shapes
found missing general transfer rules:

1. numeric `toBool` inside a ternary fell through the analyzer's unknown-node
   case and erased all global facts;
2. the identity `Activity → Context` upcast did the same before the setter
   loop.

Both operations are pure and now evaluate their children without a global
havoc. An intermediate device run then measured 40.59 ns/call but still
contained two `ntsToInt32` invocations. It was rejected as a partial result.
The benchmark build now refuses if any proved direct kernel invokes
`ntsToInt32` or `ntsToBool`.

The accepted setter bytecode is structurally:

```text
iconst_0 / istore       integer induction
iload / iconst_1 / iand bit selection
i2f                     exact Android float argument
invokevirtual           TextView.setTextSize:(F)V
iload / iconst_1 / iadd integer update
```

There is no numeric coercion helper, native entry, handle cell, or JNI call in
that method. The executable JVM observer returns 25,000 for the bounded loop,
2,147,483,648 for the overflow control, 1.5 for the fractional control, and
negative infinity for `1 / -0`.

## On-device measurement

All four APKs ran for five cyclically ordered process rounds on the Pixel 10
Pro x86-64 API 37 AVD after ART `speed` compilation. Each implementation
contributed 35 accepted samples with identical inputs, warmups, iteration
counts, and checksums. Lower is better.

| Workload | Direct JVM | Kotlin | NTS/JNI | NativeScript | Direct/Kotlin |
| --- | ---: | ---: | ---: | ---: | ---: |
| stable setter | **14.30 ns/call** | 15.26 ns/call | 76.52 ns/call | 291.36 ns/call | **0.94x** |
| ASCII/Unicode arguments | **38.89 ns/comparison** | 36.51 ns/comparison | 659.73 ns/comparison | 1,557.24 ns/comparison | **1.07x** |
| lightweight object | **1.25 ns/object** | 24.03 ns/object | 164.70 ns/object | 3,821.59 ns/object | **0.05x** |

Against the recorded pre-specialization direct-JVM medians, the raw changes
are 59.00 → 14.30 ns for the setter (-75.8%), 61.36 → 38.89 ns for string
arguments (-36.6%), and 26.46 → 1.25 ns for the lightweight object loop
(-95.3%). Emulator runs vary, so the matched ratios are the primary evidence:
the setter reached Kotlin parity and was 20.4x faster than NativeScript; the
string loop was within 1.07x of Kotlin.

The lightweight-object value was stable across all five process rounds
(per-round medians 1.06–1.27 ns). Both sources construct the same constant
`Rect` and consume `width()`. The generated direct kernel is a small static
method whose integer loop lets ART scalar-replace or fold far more work than
the larger Kotlin Activity method. That is a legitimate whole-kernel outcome,
but not a claim that an irreducible Android object allocation costs 1.25 ns.

Raw evidence:

```text
/home/akisarou/.cache/nts-benchmark-integer-specialization-20260823-final-device-a/results.json
sha256:56453fca7cba356e7d64731ada9a2c62acb94a380d6efe3905e469d0f64d8466

/home/akisarou/.cache/nts-benchmark-integer-specialization-20260823-final-device-a/
  native-typescript-jvm/bytecode-evidence.txt
sha256:1d17fef40b3bbafbc3cf20d90749c1ac55c499b9c8a6799260c51fde96b48076
```

The direct-JVM APK was 12,496 bytes. It remains a three-kernel experimental
artifact and is not comparable to the complete applications for launch,
memory, or package-size claims.

## Consequence

The stable setter's previous Kotlin gap was not an unavoidable TypeScript or
ART tax. It was a representation choice exposed by bytecode and removed by a
proof the compiler already mostly possessed. Whole-program numeric facts can
let ordinary TypeScript loops reach Kotlin-shaped ART bytecode without
changing the source type system or weakening JavaScript boundary semantics.

This first slice specializes local signed-int32 storage only in the JVM tier.
It does not yet specialize globals, parameters, return ABIs, C/LLVM storage,
or guarded values that may overflow and then return to f64. Those extensions
need their own reached workloads and must preserve the same overflow,
fractional, NaN, infinity, and signed-zero controls.
