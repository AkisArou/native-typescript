# 0054 — Isolate numeric parsing before changing it

Status: benchmark instrumentation complete; speculative optimization rejected  
Recorded: 2026-08-25

The Android `number-parsing` workload performs `parseInt`, `parseFloat`, and
`Number(string)` once per operation. That is useful application-shaped work,
but its aggregate could not say which JavaScript grammar owned the remaining
Direct JVM cost. Workload schema 14 adds three matched probes to all four
applications while preserving the aggregate's inputs, iteration count, and
checksums:

- `parse-int` measures the base-10 integer-prefix parser;
- `parse-float` measures the decimal-prefix parser;
- `number-from-string` measures whole-string numeric conversion.

The contract now has 30 scenarios. Every route is checked in the parent test,
and every application must produce the same independently calculated result.

## Finding

The first five-round API 37 x86-64 Pixel 10 Pro AVD run separated the aggregate:

| Scenario | Direct JVM | Kotlin | Direct/Kotlin |
| --- | ---: | ---: | ---: |
| `parse-int` | 15.66 ns | 17.22 ns | **0.91x** |
| `parse-float` | 124.74 ns | 107.89 ns | 1.16x |
| `number-from-string` | 104.85 ns | 97.12 ns | 1.08x |

`parseInt` already won. The other two differences were small enough that a
compiler change needed an adjacent falsifier rather than a comparison with one
historical run.

## Rejected implementation

The generated `parseFloat` helper first recognizes the JavaScript decimal
prefix and then asks `Double.parseDouble` to produce an exactly rounded binary64
result. A speculative fast path attempted to send ordinary complete decimal
strings directly to ART while retaining the exact scanner for prefix parses,
Unicode whitespace, invalid exponents, Java hex floats, and Java numeric
suffixes.

The first version scanned every character for eligibility. It sometimes made
the isolated `parseFloat` probe look 20%–25% faster, but applying the same idea
to `Number(string)` repeatedly made that control 17%–25% slower. The
`Number(string)` arm was therefore removed immediately.

A second version used only leading/trailing and prefix/suffix guards so the
ordinary decimal path was genuinely single-pass. Its adjacent A/B/A results
were:

| Generated parser | `parse-float` | untouched `Number(string)` | aggregate |
| --- | ---: | ---: | ---: |
| guarded candidate A | 116.62 ns | 107.64 ns | 233.19 ns |
| exact scanner B | **106.14 ns** | 121.62 ns | 272.84 ns |
| guarded candidate A | **100.52 ns** | 145.92 ns | 275.75 ns |

The two candidate observations straddled the exact-parser baseline, while the
untouched control and aggregate moved independently. That is not a repeatable
compiler win. The fast path was deleted and the ScriptC fork is unchanged by
this record.

## Semantic falsification retained

Although the optimization was rejected, its disagreeing cases remain in the
host JVM execution oracle. Generated Java results are compared bit-for-bit
with Node for:

- signed Java hexadecimal floating-point syntax;
- Java `f`, `F`, `d`, and `D` suffixes, including precision-changing values;
- Java-only leading control whitespace;
- JavaScript Unicode whitespace;
- incomplete exponents, prefix parses, infinities, subnormals, overflow, and
  negative zero.

This prevents a future direct-ART parser shortcut from silently accepting Java
grammar as JavaScript grammar.

## Decision

Keep the probes and exact parser. Do not spend more compiler complexity on the
current 8%–16% single-operation gap without a lower-variance instrument or a
new implementation that wins inside one process. The measurements also show
why an aggregate improvement alone is insufficient: unrelated parser arms can
move by more than the proposed optimization.

The initial probe report is:

- `.native-typescript/benchmarks/android/2026-08-24T20-19-59-339Z/results.json`.

The adjacent final A/B/A reports are:

- `.native-typescript/benchmarks/android/2026-08-24T20-48-51-008Z/results.json`;
- `.native-typescript/benchmarks/android/2026-08-24T20-53-25-224Z/results.json`;
- `.native-typescript/benchmarks/android/2026-08-24T20-57-17-859Z/results.json`.

The discarded full-scan experiments remain available in the intervening raw
reports so the negative result is reproducible rather than rewritten as an
unmeasured design preference.
