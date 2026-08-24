# 0048 — Remove two-value `push` varargs allocation on Direct JVM

Status: implementation, host proof, and repeated device measurement complete  
Recorded: 2026-08-24

After integer-bounded array traversal landed, the generated code for the
ordinary Android array lifecycle still exposed one allocation unrelated to
TypeScript semantics. This source:

```ts
values.push(1024, 13);
```

selected the generated Java varargs method and therefore allocated a fresh
two-element primitive array on every iteration before appending either value.
Kotlin's comparison uses two direct `ArrayList.add` calls and allocates no
equivalent argument container.

## Decision

Each specialized Direct JVM array now provides a two-value overload in
addition to its one-value and general variadic paths:

```java
private int push(double first, double second)
```

The overload performs one overflow check, one capacity check, two direct
writes, and one length update. Java overload resolution selects it for an
ordinary two-argument call, so no temporary primitive array or
`System.arraycopy` is needed for the arguments. Calls with three or more
values retain the variadic implementation, and spread calls retain their
dedicated array-to-array path.

This preserves the observable ordering and atomic capacity check of
`Array.prototype.push`: Java evaluates both arguments before entering the
method, and the receiver is not changed if its final length would exceed the
Direct JVM representation's declared `Integer.MAX_VALUE` bound. Rewriting the
operation into two independent one-value calls would not have preserved that
boundary behavior.

## Structural and semantic proof

The source observer was written first and failed because the generated class
contained only `push(double)` and `push(double...)`. It now requires the
fixed two-value overload.

The parent JVM gate compiles and executes the existing array fixture, whose
`mutateNumbers` function calls `push(4, 5)`, and preserves every array result.
`javap` proves both the mechanics and the selected call descriptor:

```text
private int push(double, double);
NtsArray*.push:(DD)I
```

The variadic overload remains present for the larger argument-count corpus.

## Repeated on-device result

The unchanged `array-operations` workload and `array-pipeline` control were
measured twice. Each run used five cyclic process rounds on the API 37 x86-64
Pixel 10 Pro AVD, giving 35 samples per application and scenario after ART
`speed` compilation. Lower is better.

| Workload | Prior first run | Optimized first run | Prior repeat | Optimized repeat |
| --- | ---: | ---: | ---: | ---: |
| dynamic array lifecycle | 156.63 ns | **141.37 ns** | 162.65 ns | **144.07 ns** |
| map → filter → reduce control | 238.36 ns | 228.17 ns | 234.96 ns | 233.31 ns |

The targeted lifecycle improved 9.7% and 11.4% in the paired runs. Its
Direct/Kotlin ratio improved from 1.60x and 1.80x to 1.32x and 1.30x. The
pipeline control remained within 2.9% of its prior repeated result, supporting
the attribution to the removed per-lifecycle argument-array allocation rather
than a broad device-speed change. All checksums passed.

The generated lifecycle still grows its four-element backing array when the
two values are appended. Eliminating that copy requires a distinct allocation
capacity plan; this change intentionally does not infer capacity from a
particular following statement.

The post-change schema-8 reports are:

- `.native-typescript/benchmarks/android/2026-08-24T17-02-41-721Z/results.json`;
- `.native-typescript/benchmarks/android/2026-08-24T17-05-03-909Z/results.json`.

The corresponding pre-change reports are:

- `.native-typescript/benchmarks/android/2026-08-24T16-39-59-211Z/results.json`;
- `.native-typescript/benchmarks/android/2026-08-24T16-42-25-468Z/results.json`.
