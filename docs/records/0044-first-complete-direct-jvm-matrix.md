# 0044 — First complete Direct JVM Android matrix

Status: measured  
Recorded: 2026-08-24

The Direct JVM compiler tier had accumulated independently proved slices for
Android calls, callbacks, native subclasses, managed classes, arrays, records,
optional values, maps, sets, Math, and number parsing. Until this run, the
newer language-runtime slices had only host execution and classfile evidence.
That was enough to prove semantics and boundary placement, but not enough to
choose the next optimization.

## Measurement

The runner cold-built and installed four complete programmatic Android apps:

- Native TypeScript through ScriptC C/JNI;
- the Direct JVM compiler tier;
- idiomatic Kotlin;
- plain NativeScript TypeScript with raw Android APIs and no React or XML UI.

All four executed contract version 12: 23 scenarios with identical constants,
warmups, iteration counts, and checked results. ART used the `speed` filter.
The runner rotated process order for three rounds on an API 37 x86-64 Pixel 10
Pro AVD. Every repeated scenario therefore has 21 measured samples
(`3 rounds × 7 samples`); `view-tree` has three process samples.

The completed report contains exactly:

- 24 launch observations: four apps × three rounds × process/warm launch;
- 1,860 workload observations: 12 `view-tree` samples plus 22 × four apps ×
  three rounds × seven samples;
- 12 memory observations: four apps × three rounds.

Every checksum and post-workload process-liveness check passed. The raw report
is
`.native-typescript/benchmarks/android/2026-08-24T14-42-33-751Z/results.json`.
It records schema 8, source hashes, dirty state, device fingerprint, APK
digests, Direct classfile evidence, and Kotlin standard-library jar digests.

## Workload medians

All values are nanoseconds per scenario-declared operation. Lower is better.

| Scenario | Native/JNI | Direct JVM | Kotlin | NativeScript | Direct/Kotlin |
| --- | ---: | ---: | ---: | ---: | ---: |
| `view-tree` | 101,546.11 | 175,123.23 | 64,668.13 | 46,687.16 | 2.71x |
| `light-object` | 242.36 | 0.68 | 0.34 | 3,759.45 | 2.01x |
| `managed-class` | 59.62 | 1.48 | 1.31 | 2.20 | 1.13x |
| `constructor` | 29,173.87 | 26,080.33 | 24,191.67 | 30,892.12 | 1.08x |
| `setter` | 78.01 | 63.38 | 18.68 | 362.58 | 3.39x |
| `callback` | 189.99 | 20.87 | 20.01 | 1,617.98 | 1.04x |
| `string-argument` | 628.27 | 67.17 | 32.53 | 1,505.59 | 2.07x |
| `string-result` | 662.50 | 224.17 | 230.47 | 773.62 | 0.97x |
| `string-operations` | 661.69 | 2,652.96 | 2,393.09 | 341.81 | 1.11x |
| `array-operations` | 207.71 | 230.62 | 126.50 | 71.16 | 1.82x |
| `array-pipeline` | 673.91 | 460.55 | 295.55 | 171.19 | 1.56x |
| `record-objects` | 88.61 | 69.32 | 1.42 | 0.90 | 48.90x |
| `optional-values` | 101.04 | 67.14 | 7.30 | 1.78 | 9.20x |
| `map-operations` | 116.27 | 90.26 | 38.02 | 21.60 | 2.37x |
| `set-operations` | 72.29 | 101.07 | 12.57 | 12.64 | 8.04x |
| `math-operations` | 30.41 | 75.62 | 26.27 | 8.74 | 2.88x |
| `number-parsing` | 111.61 | 250.10 | 161.01 | 102.47 | 1.55x |
| `byte-array` | 1,479.62 | 609.06 | 525.18 | 8,693.67 | 1.16x |
| `handle-result` | 222.66 | 36.48 | 3.69 | 785.93 | 9.89x |
| `callback-payload` | 265.72 | 21.34 | 26.76 | 2,300.74 | 0.80x |
| `callback-capture` | 361.49 | 26.03 | 27.72 | 2,394.53 | 0.94x |
| `text-update` | 503.91 | 510.20 | 292.44 | 1,754.65 | 1.74x |
| `screen-build` | 154,681.97 | 110,294.72 | 118,639.09 | 148,144.09 | 0.93x |

## What the matrix says

The Direct JVM architecture is already credible for Android application code.
It is within 16% of Kotlin for managed dispatch, construction, same-thread
callbacks, returned strings, string operations, byte arrays, callback payloads
and captures, and the composite screen. It wins four measured comparisons:
returned strings, callback payloads, callback captures, and composite screen
rows. Those wins are not a reason to generalize from one emulator, but they do
falsify the idea that a TypeScript surface necessarily requires a costly
Android bridge.

The matrix also gives a concrete optimization order:

1. Fixed records are 48.90x Kotlin. Their Java representation is semantically
   direct, so this points at allocation and escape/field-update shape rather
   than a JNI boundary.
2. Nullable returned handles are 9.89x Kotlin and optionals are 9.20x. Both
   need inspection of result representation and repeated control-flow shape.
3. Sets are 8.04x. The generated iterator cleanup is correct; the bounded
   update/iteration path is not yet competitive with Kotlin's collection use.
4. Stable setters are 3.39x, Math is 2.88x, maps are 2.37x, and two string
   arguments are 2.07x. These are smaller but frequent application costs.
5. Arrays are 1.56–1.82x and parsing is 1.55x. They are real targets after the
   larger gaps, while construction/callback/string-result/byte-array paths
   should be protected against regression.

NativeScript shows the complementary shape: its mature V8 runtime wins many
pure JavaScript kernels, but Direct JVM is dramatically faster for the
measured Android calls and callbacks. The goal is therefore not to reproduce a
general JavaScript VM. It is to specialize the reached TypeScript semantics
into JVM forms that ART can optimize while preserving JavaScript behavior.

`light-object` is sub-nanosecond in Direct and Kotlin because ART can optimize
the closed loop and non-escaping object, so it is not a literal allocation
latency. `view-tree` has only three high-variance observations; the 21-sample
`screen-build` result is the stronger application-shaped signal.

## Application shape

| Measurement | Native/JNI | Direct JVM | Kotlin | NativeScript |
| --- | ---: | ---: | ---: | ---: |
| Process launch | 461 ms | 477 ms | 456 ms | 796 ms |
| Warm foreground | 89 ms | 68 ms | 28 ms | 37 ms |
| Total PSS | 18,503 KiB | 17,586 KiB | 18,673 KiB | 76,102 KiB |
| Total RSS | 143,816 KiB | 141,480 KiB | 142,948 KiB | 203,140 KiB |
| APK size | 811,291 B | 61,648 B | 2,461,904 B | 28,640,616 B |

The APK sizes describe deliberately different product shapes. The Kotlin APK
now includes the exact reached Kotlin standard library because its idiomatic
number parser requires it; schema 8 records those jar hashes. Direct JVM's
small artifact does not yet imply full JavaScript standard-library coverage.

This measurement establishes the regression baseline for subsequent Direct
JVM slices. An optimization is admitted only with unchanged checked workloads,
host semantic/classfile proof, and a new matched device batch when the expected
effect is performance rather than coverage.
