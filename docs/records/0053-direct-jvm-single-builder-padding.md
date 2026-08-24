# 0053 — Build Direct JVM padding once

Status: implementation, hotspot isolation, and repeated device measurement complete  
Recorded: 2026-08-24

The aggregate `string-operations` benchmark combined trim, locale-root case
conversion, slicing, padding, substring search, and indexed UTF-16 access. It
showed a real application-language cost but could not identify its owner.
Workload schema 13 therefore adds four matched probes to all four Android
applications: `string-normalize`, `string-slice`, `string-pad`, and
`string-search`. They keep the same non-ASCII input and 10,000-iteration
shape as the aggregate workload.

## Finding

The first five-round API 37 x86-64 Pixel 10 Pro AVD run separated the costs:

| Scenario | Direct JVM | Kotlin | Direct/Kotlin |
| --- | ---: | ---: | ---: |
| `string-normalize` | 1,647.78 ns | 2,066.21 ns | **0.80x** |
| `string-slice` | 77.68 ns | 71.83 ns | 1.08x |
| `string-pad` | 533.13 ns | 213.06 ns | **2.50x** |
| `string-search` | 25.46 ns | 29.38 ns | **0.87x** |

Normalization, slicing, and search were already at or better than practical
Kotlin parity. Padding alone owned the actionable gap.

The generated helper first built a padding-only `StringBuilder`. `padStart`
could append the value to that builder, but `padEnd` then evaluated
`value + padding`, asking javac/ART to perform a second string-construction
path. The helper knew the exact final UTF-16 length before either operation.

## Decision

`ntsStringPad` now allocates one builder with the final target length. For
`padEnd` it appends the value before the repeated fill; for `padStart` it
appends the same fill before the value. Multi-code-unit fill repetition and
the final partial fill still use the original JavaScript UTF-16 code-unit
rules. No benchmark-only constant or single-character overload was added.

```java
StringBuilder result = new StringBuilder((int)integer);
if (!start) result.append(value);
// Append complete and partial fill repetitions.
if (start) result.append(value);
return result.toString();
```

## Falsification and semantics

The fork observer was red first because generated source still contained a
padding-only builder. It now requires one final-sized result builder and
forbids that older allocation shape.

The parent JVM execution test compiles and runs generated Java. It covers both
`padStart` and `padEnd` through the exported fixture and now includes a
multi-code-unit `"ab"` fill whose final repetition is truncated. The Android
probe checks the result on every sample. The existing range, empty-fill, and
full JavaScript string corpus remains unchanged.

The benchmark runner's no-JNI proof was also made syntactic. Its former
`/ native /` text search mistook the new lowercase benchmark literal
`"native typescript"` for a Java `native` declaration. It now matches a
declaration-shaped `javap` line, so string contents cannot satisfy the proof.

## Repeated on-device result

Each report contains five cyclic process rounds and 35 samples per
application after ART `speed` compilation. Lower is better.

| Route | Before | Optimized first run | Optimized repeat |
| --- | ---: | ---: | ---: |
| Direct JVM `string-pad` | 533.13 ns | **227.56 ns** | **302.67 ns** |
| Kotlin `string-pad` | 213.06 ns | 216.26 ns | 224.24 ns |
| Direct/Kotlin | 2.50x | **1.05x** | **1.35x** |

Direct JVM improves 57.3% and 43.2% in the two post-change observations. The
comparison app remains in the same band, so the improvement is not a Kotlin
slowdown. The unchanged aggregate `string-operations` workload measured
2,494.40 ns against Kotlin's 2,426.46 ns in the repeat, or 1.03x. Every
checksum passed.

The pre-change probe report is:

- `.native-typescript/benchmarks/android/2026-08-24T19-35-43-996Z/results.json`.

The post-change reports are:

- `.native-typescript/benchmarks/android/2026-08-24T19-41-36-152Z/results.json`;
- `.native-typescript/benchmarks/android/2026-08-24T19-44-34-234Z/results.json`.
