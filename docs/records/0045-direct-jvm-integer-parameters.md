# 0045 — Specialize closed integer parameter entries on Direct JVM

Status: implementation, host proof, and focused device measurement complete  
Recorded: 2026-08-24

The first complete Android matrix made fixed records look like a representation
failure: Direct JVM took 69.32 ns per record lifecycle against Kotlin's 1.42
ns. The emitted record itself was already a fixed Java class with primitive
fields. Inspection instead found a more general boundary around the workload:
its `iterations: number` parameter and loop index stayed Java `double`, so each
bitwise use repeatedly called the JavaScript-exact `ToInt32` helper.

That helper must handle fractions, infinities, NaN, overflow, and negative
zero. Calling it for a loop value already proved to be a signed 32-bit integer
was both unnecessary work and an obstacle to ART seeing the loop and
short-lived record as ordinary integer code.

## Decision

The shared machine-integer analysis now infers implementation-only parameter
carriers from the complete direct call graph. A source `number` parameter is
emitted as Java `int` only when every visible direct call passes a value proved
to be a signed int32 and never negative zero. The caller supplies the proved
integer expression directly, and the parameter seeds the callee's existing
integer-local analysis. The inference participates in the same fixed point as
integer fields, locals, returns, and virtual method families, so a proved
parameter can expose further integer storage without a separate backend
heuristic.

This is an internal calling-convention specialization, not a change to
TypeScript's number model. The analysis refuses a parameter when any entry can
carry an arbitrary number:

- module entry and JVM-exported functions retain their general `double` ABI;
- functions used as closures are excluded, even when they also have direct
  calls;
- managed and native class implementations retain their declared method ABI;
- captured, async, generator, and boxed parameters are excluded;
- a function with no observed direct caller, a missing argument, or one
  non-integer argument does not specialize.

Consequently a public method remains `(D)D`, including JavaScript `ToInt32`
where its body requires it, while a closed helper can become `(I)I` or `(I)D`.
No annotation or source-visible overload is introduced.

## Host proof

The abstract-interpretation observer first failed because a direct-only
parameter remained unknown inside its callee. It now proves both the parameter
and a copied local, then supplies the same function as externally callable and
proves neither fact survives.

The JVM emitter observer compiles a disagreeing fixture containing a closed
integer helper and an exported `number` function. It checks that the helper
accepts `int` without `ntsToInt32`, while the export retains a public `double`
parameter and wrapper.

The parent host gate compiles that fixture with `javac`, executes both paths,
and inspects `javap` output. The closed helper has an `(I)I` or `(I)D`
descriptor and no conversion call; the public method has `(D)D`. Calling the
public path with `511.75` still produces JavaScript's bitwise result `255`, so
an integer-only internal caller cannot accidentally narrow the external ABI.

The real Android benchmark build also contains `int iterations` and an `int`
loop index in fixed records, optionals, sets, Math, parsing, and other reached
closed helpers. The fixed-record loop contains no `ntsToInt32` call. Its
record's numeric field widens only where the declared Java field requires a
`double`, leaving ART free to scalar-replace the non-escaping object.

## Focused on-device result

The unchanged contract was measured for the nine language workloads whose
closed helpers receive bounded integer iteration counts. The post-change run
used five cyclic rounds on the same API 37 x86-64 Pixel 10 Pro AVD, giving 35
samples per application and scenario. The earlier complete matrix used three
rounds, so Direct/Kotlin ratios are the stronger cross-run comparison; raw
Direct medians are included to show the scale. Lower is better.

| Scenario            | Direct before | Direct after | Raw change | Direct/Kotlin before → after |
| ------------------- | ------------: | -----------: | ---------: | ---------------------------: |
| `string-operations` |   2,652.96 ns |  2,344.96 ns |     -11.6% |                1.11x → 1.17x |
| `array-operations`  |     230.62 ns |    233.52 ns |      +1.3% |                1.82x → 1.40x |
| `array-pipeline`    |     460.55 ns |    647.30 ns |     +40.5% |                1.56x → 1.58x |
| `record-objects`    |      69.32 ns |      3.13 ns | **-95.5%** |           **48.90x → 1.56x** |
| `optional-values`   |      67.14 ns |     28.69 ns | **-57.3%** |            **9.20x → 3.12x** |
| `map-operations`    |      90.26 ns |     97.60 ns |      +8.1% |                2.37x → 2.12x |
| `set-operations`    |     101.07 ns |     23.41 ns | **-76.8%** |            **8.04x → 1.67x** |
| `math-operations`   |      75.62 ns |     32.86 ns | **-56.6%** |            **2.88x → 1.27x** |
| `number-parsing`    |     250.10 ns |    242.50 ns |      -3.0% |                1.55x → 1.36x |

The pipeline's raw time rose in the later run, but Kotlin rose by a similar
amount; its relative gap changed only from 1.56x to 1.58x. That workload's
map/filter callbacks are intentionally excluded from direct parameter
specialization because they also enter through closure invocation. Likewise,
map and string work are dominated by their collection/string operations once
the loop boundary is cheap. They are not evidence for weakening the entry
proof.

The fixed-record result falsifies the initial allocation diagnosis. Once the
integer conversion barrier disappeared, ART reduced the same fixed record
shape from 48.90x to 1.56x Kotlin. The broad wins for optionals, sets, and Math
show that the correct owning boundary was the compiler's closed calling
convention, not workload-specific record or collection code.

The focused raw schema-8 report is
`.native-typescript/benchmarks/android/2026-08-24T15-25-08-505Z/results.json`.
Every one of the 1,260 workload observations completed with its unchanged
checksum. The complete pre-change regression baseline remains in
[record 0044](0044-first-complete-direct-jvm-matrix.md).
