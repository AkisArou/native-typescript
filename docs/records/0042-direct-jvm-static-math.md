# 0042 — Keep static JavaScript Math primitive on the JVM

Status: implementation and host proof complete; device measurement pending  
Recorded: 2026-08-24

ScriptC already lowers a closed static Math surface into typed `libCall`
operations. Refusing all `libCall` expressions in the Direct JVM emitter left
ordinary geometry, animation, layout, and numeric normalization kernels unable
to enter the tier, even though every operand and result is an unboxed number.

## Decision

The Direct JVM emitter consumes the complete static Math surface currently
promised by Native IR:

- `floor`, `ceil`, and `abs` call `java.lang.Math` directly;
- `trunc` uses a small signed helper because Java has no matching `double`
  operation;
- `round` uses the JavaScript half-toward-positive-infinity rule, including
  negative zero and the representable value immediately below `0.5`;
- scalar `min` and `max` use Java's NaN-poisoning and signed-zero-aware
  operations;
- spread extrema fold an exact generated `double[]`, seeded with the correct
  infinity for an empty array;
- `random` uses `Math.random()` and remains an unboxed `[0, 1)` result.

Support helpers are emitted only when a reached `libCall` requires them.
Unsupported library calls still fail at the JVM boundary with the exact call
name; this change does not introduce a generic runtime dispatcher.

## Matched workload

Android benchmark contract version 11 adds `math-operations` to Native
TypeScript/JNI, Direct JVM, Kotlin, and plain NativeScript. Each sample runs
100,000 deterministic quarter-step transforms through `floor`, `ceil`,
`trunc`, JavaScript `round`, `abs`, `min`, and `max`. Kotlin carries the same
explicit JavaScript rounding helper instead of substituting its different
round-to-even operation. The independently computed checksum is 3,075,216.

`Math.random()` is covered semantically but intentionally excluded from the
timed workload: the four runtimes expose different random-number generators,
so comparing their throughput would not isolate the lowering cost.

## Evidence at this checkpoint

The initial observer failed precisely on `expression 'libCall'`. After
lowering:

- ordinary transforms execute through javac and the host JVM;
- rounding preserves the epsilon boundary, negative half, and negative zero;
- truncation and ceiling preserve negative zero;
- extrema preserve signed-zero order and NaN poisoning;
- zero-, one-, variadic-, non-empty-spread-, and empty-spread extrema agree;
- argument side effects retain left-to-right order;
- 4,096 random values satisfy the range and 53-bit lattice invariant;
- classfile inspection finds direct primitive Math calls, exact `double[]`
  spread storage, and no boxing, Java collection, JNI, or generic dispatcher.

No APK, emulator, or device timing was run for this slice.
