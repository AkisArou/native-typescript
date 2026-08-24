# 0046 — Keep numeric optional unions in one primitive JVM word

Status: implementation, host proof, and focused device measurement complete  
Recorded: 2026-08-24

After closed integer parameters removed the conversion barrier around the
Android language workloads, `number | undefined` still took 28.69 ns per two
lookups against Kotlin's 9.18 ns. The generated Java exposed the cause: every
present number constructed an `NtsUnion` object containing an integer tag and
a `double` payload. `Map<string, number>.get` paid the same allocation before
the caller could test for `undefined` and recover the number.

Reference optionals already use Java `null` without a union object. Numeric
optionals need a different representation because every 64-bit `double` value
is a valid payload and `null` and `undefined` remain distinct TypeScript arms.

## Decision

A JVM union with exactly one `number` arm and whose remaining arms are
`null` and/or `undefined` is now represented by one primitive Java `long`.

- a number is encoded with `Double.doubleToLongBits`;
- ordinary values, infinities, and negative zero retain their number bits;
- Java canonicalizes every NaN to `0x7ff8000000000000`;
- the otherwise unreachable non-canonical quiet-NaN words
  `0x7ff8000000000001` and `0x7ff8000000000002` name the unit arms;
- narrowing decodes the payload with `Double.longBitsToDouble`;
- a generated tag helper recognizes the sentinels without allocating.

This representation covers `number | undefined`, `number | null`, and
`number | null | undefined`. It is deliberately not used for a mixed payload
union such as `number | string`: those arms retain the exact generated tagged
class. NaN payload bits are not a distinct JavaScript `number` value on the
currently supported Direct JVM surface; NaN, infinities, and `-0` retain all
observable number semantics.

The primitive carrier crosses closed helper calls directly, is stored in
`long[]` for ordinary arrays, participates in mutable-capture boxes, and is
used by typed-map `get`. The map still stores its declared numeric values in
`double[]`; only the optional result is encoded, and a miss returns the
`undefined` sentinel. This keeps the collection representation exact while
removing one short-lived result object per lookup.

## Semantic proof

The observer was added before the lowering and initially found three generated
union classes. It now checks all of the disagreeing shapes:

- a present number and a missing optional result;
- `NaN` and `-0`, including `Object.is(value, -0)`;
- distinct `null` and `undefined` arms in a three-arm union;
- numeric optionals stored in and narrowed from an ordinary array;
- a mixed `number | string` union that must remain a tagged class.

The parent bytecode gate compiles and executes the fixture with `javac`, then
uses `javap` to prove `doubleToLongBits` and `longBitsToDouble` are present,
only the mixed union class remains, and neither `Double.valueOf` nor JNI enters
the path. The typed-map emitter observer separately proves a string-key,
number-value map has a `long get(String)` result and encodes its `double[]`
payload without allocating a union object.

The pre-existing precise refusal for identity operations such as
`includes`/`indexOf` on union-element arrays remains in force. This change does
not silently invent identity semantics for that unsupported surface.

## On-device measurement

The unchanged optional and map workloads were measured for five cyclic process
rounds on the API 37 x86-64 Pixel 10 Pro AVD, giving 35 samples per application
and scenario after ART `speed` compilation. The before run is the focused
post-integer-parameter measurement, so both sides use the same five-round
instrument. Lower is better.

| Workload | Before | Primitive union | Raw change | Direct/Kotlin before → after |
| --- | ---: | ---: | ---: | ---: |
| two scalar/reference optional lookups | 28.69 ns | **1.47 ns** | **-94.9%** | **3.12x → 0.23x** |
| bounded map update | 97.60 ns | **36.77 ns** | **-62.3%** | **2.12x → 1.26x** |

Kotlin's `Double?` has a boxed nullable representation in this shape, so an
allocation-free closed TypeScript numeric union can legitimately beat it. The
optional microbenchmark is a representation result, not a general ranking of
the languages. The map workload is more application-shaped: it combines
lookup, hashing, update, deletion, reinsertion, and optional results, and is
now within 26% of Kotlin.

Every one of the 280 measured observations completed with the unchanged
checksum. The post-change raw schema-8 report is
`.native-typescript/benchmarks/android/2026-08-24T16-06-36-782Z/results.json`;
the comparable pre-change report is
`.native-typescript/benchmarks/android/2026-08-24T15-25-08-505Z/results.json`.

## Reclassified returned-handle gap

Inspection found no allocation or generic wrapper in the Direct JVM
`ViewGroup.getChildAt` path: it is an ordinary Java reference result with a
null test and direct `getId`. Remeasuring after record 0045's integer parameter
specialization changed the stale complete-matrix result from 36.48 ns and
9.89x Kotlin to 3.19 ns and 1.13x Kotlin. The old gap was another consequence
of the workload's `double` loop/index boundary, not a handle representation
problem, so no handle-specific optimization was added. The focused evidence is
`.native-typescript/benchmarks/android/2026-08-24T15-55-58-848Z/results.json`.
