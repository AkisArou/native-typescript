# 0049 — Reserve exact capacity for adjacent Direct JVM array appends

Status: implementation, semantic proof, and repeated device measurement complete  
Recorded: 2026-08-24

After fixed two-value `push` removed its argument-array allocation, the
ordinary array lifecycle still allocated and copied its backing storage twice.
The benchmark source initializes four values and immediately appends two:

```ts
const values = [index & 255, 3, 5, 7];
values.push(1024, 13);
```

The Direct JVM emitter created an exact four-element primitive array. `push`
then grew it to eight elements and copied the four initialized values. The
equivalent Kotlin fixture constructs `ArrayList<Int>(6)`, so it has no growth
or copy in the measured lifetime.

## Decision

For a non-spread array literal assigned to a local, the Direct JVM emitter now
looks through immediately following, unconditional, fixed-argument `push`
statements on that same local. It reserves the exact initialized-plus-appended
capacity while preserving the literal's logical length:

```java
private static NtsArray0 ntsArrayLiteral0(
    double v0,
    double v1,
    double v2,
    double v3
) {
  NtsArray0 value = new NtsArray0(new double[6], 4);
  value.data[0] = v0;
  value.data[1] = v1;
  value.data[2] = v2;
  value.data[3] = v3;
  return value;
}
```

The later `push` remains an ordinary call. It therefore still evaluates its
receiver and arguments at the original statement, returns the same length,
and uses the array's existing capacity check. Only the backing allocation
policy changes.

The plan stops at the first intervening statement. It does not reserve for a
conditional or non-adjacent append, does not blanket-overallocate literals,
and does not change spread literals or spread pushes. Those shapes need their
own proof rather than speculation about future mutations.

## Semantic and structural proof

The emitter observer was written first and failed because the generated array
had only the exact-data constructor. It now requires the separate
backing-array-plus-logical-length constructor and an exact five-slot factory
for the three-plus-two fixture.

A second fixture makes evaluation order disagree with any attempted fusion:

```ts
const values = [10];
const length = values.push(values.length, values.length);
```

Both arguments must observe the initialized logical length of 1, and `push`
must return 3. The executed JVM result is `3011`, proving that capacity
reservation did not move the append or its arguments into literal creation.
The parent `javap` gate also requires the new primitive-array constructor and
the literal factory descriptor; existing one-value, two-value, variadic, and
spread append paths remain present.

The benchmark artifact independently records the optimized application shape:

```text
new NtsArray0(new double[6], 4)
```

## Repeated on-device result

The unchanged `array-operations` workload and `array-pipeline` control were
measured twice. Each run used five cyclic process rounds on the API 37 x86-64
Pixel 10 Pro AVD, giving 35 samples per application and scenario after ART
`speed` compilation. Lower is better.

| Workload | Fixed-push first run | Reserved first run | Fixed-push repeat | Reserved repeat |
| --- | ---: | ---: | ---: | ---: |
| dynamic array lifecycle | 141.37 ns | **103.80 ns** | 144.07 ns | **85.55 ns** |
| Kotlin lifecycle | 107.32 ns | 102.99 ns | 111.20 ns | 109.34 ns |
| Direct/Kotlin | 1.32x | **1.008x** | 1.30x | **0.782x** |
| map → filter → reduce control | 228.17 ns | 245.46 ns | 233.31 ns | 223.57 ns |

The targeted lifecycle improved 26.6% and 40.6% in the paired runs. It reached
Kotlin parity in the first run and was 21.8% faster in the repeat. The
unmodified pipeline control moved in opposite directions and remained in its
normal recent band, while Kotlin's lifecycle stayed stable. This supports the
removed growth-and-copy as the cause rather than a general device-speed shift.
All four implementations produced the required checksums.

NativeScript's V8-backed array implementation remains faster in this
pure-language microcase: 44.68 ns and 44.28 ns in the two post-change runs.
The result is retained rather than normalized away; Direct JVM is now
2.32x/1.93x NativeScript instead of paying an avoidable ART-side copy.

The post-change schema-8 reports are:

- `.native-typescript/benchmarks/android/2026-08-24T17-28-31-573Z/results.json`;
- `.native-typescript/benchmarks/android/2026-08-24T17-30-52-841Z/results.json`.

The corresponding fixed-push reports are:

- `.native-typescript/benchmarks/android/2026-08-24T17-02-41-721Z/results.json`;
- `.native-typescript/benchmarks/android/2026-08-24T17-05-03-909Z/results.json`.
