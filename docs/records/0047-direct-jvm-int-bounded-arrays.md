# 0047 — Keep Direct JVM array traversal in the integer domain

Status: implementation, host proof, and repeated device measurement complete  
Recorded: 2026-08-24

The Android `array-pipeline` workload remained 1.58x slower than Kotlin after
closed helper parameters became Java `int`. Its generated map, filter, and
reduce helpers exposed two costs inside every element traversal:

- `Array.length` returned Java `double`, so the synthetic loop bound and index
  remained `double` even though the backing storage uses an `int length`;
- map and filter appended one result through a Java varargs method, allocating
  a one-element array for every successful `push(value)`.

The generic machine-integer analysis could not simply declare every ScriptC
array length signed-int32. The language/runtime representation is not defined
by Java's array limit, and such a global assumption would silently narrow the
C and LLVM backends for the benefit of one target.

## Decision

Machine-integer inference now accepts a target representation declaration.
The Direct JVM emitter opts into `arrayLength: "int32"` because its generated
arrays are already physically bounded by `Integer.MAX_VALUE`; the default
analysis remains conservative.

Under that declared representation, the shared abstract interpreter proves:

- `length`, successful `push`, `pushSpread`, `unshift`, and `unshiftSpread`
  results are in `0..INT32_MAX`;
- `indexOf` is in `-1..INT32_MAX-1`;
- a synthetic induction variable bounded by array length stays signed-int32.

Array intrinsics evaluate their receiver and arguments without pretending to
invoke unknown user code. Mutating operations still invalidate heap-path
facts, while immutable module facts survive.

The Java mechanics now expose exact fast paths:

- `length()` returns `int`;
- `get(int)` and `set(int, value)` avoid finite/integer conversion while the
  `double` overloads preserve arbitrary TypeScript index semantics;
- `push(value)` is fixed arity, so the common one-element append allocates no
  varargs array;
- `push(values...)`, `pushSpread`, and `indexOf` return `int` internally;
- source-visible `number` boundaries still widen to `double` where required.

This is a target representation fact, not a change to TypeScript's number or
array model. An unproved fractional, non-finite, negative, or otherwise general
number index continues through the JavaScript-exact checked `double` path.

## Structural and semantic proof

The machine-integer observer was written first and failed because array length
was unmodeled. It now proves the disagreeing boundary: generic analysis does
not classify the length or loop local as int32, while the explicit Direct JVM
representation classifies the length, bound, and induction variable.

The JVM emitter observer checks primitive array storage, both checked index
overloads, fixed and variadic append overloads, integer length/append results,
and the absence of generated `for (double ...)` loops.

The parent bytecode gate compiles and executes the complete array fixture with
`javac`, preserving its existing numeric, boolean, string-equality, capture,
spread-order, and self-spread results. `javap` then proves the emitted class
contains:

```text
private int length();
private double get(int);
private double get(double);
private int push(double);
private int push(double...);
```

and that the higher-order helpers call `get:(I)D` and `push:(D)I`. The device
artifact independently contains integer loop comparisons and no per-element
varargs construction in map or filter.

## Repeated on-device result

The unchanged `array-pipeline` and `array-operations` workloads were measured
twice after implementation. Each run used five cyclic process rounds on the
API 37 x86-64 Pixel 10 Pro AVD, giving 35 samples per application and scenario
after ART `speed` compilation. Lower is better.

| Workload | Before | First optimized run | Repeated run | Direct/Kotlin before → repeated |
| --- | ---: | ---: | ---: | ---: |
| map → filter → reduce pipeline | 647.30 ns | 238.36 ns | **234.96 ns** | **1.58x → 0.82x** |
| dynamic array lifecycle | 233.52 ns | 156.63 ns | **162.65 ns** | 1.40x → 1.80x |

The pipeline improvement repeated within 1.5%: raw Direct JVM time fell 63.7%
and the target moved from 58% slower than Kotlin to 18% faster for this exact
pipeline. That normalized comparison matters because Kotlin itself moved from
408.64 ns in the earlier run to 285.98 ns in the repeated run.

The ordinary lifecycle's raw Direct JVM median fell 30.3%, but it is not a
relative Kotlin win: Kotlin moved from 166.68 ns to 90.29 ns between those
runs, leaving the repeated ratio near the original complete-matrix gap. Its
remaining work is array allocation, capacity growth, a multi-value varargs
append, search, and pop rather than synthetic callback traversal. This row is
reported as a control, not used to overstate the optimization.

Every one of the 280 observations in each post-change run completed with the
unchanged checksum. The repeated raw schema-8 reports are:

- `.native-typescript/benchmarks/android/2026-08-24T16-39-59-211Z/results.json`;
- `.native-typescript/benchmarks/android/2026-08-24T16-42-25-468Z/results.json`.

The comparable pre-change report is
`.native-typescript/benchmarks/android/2026-08-24T15-25-08-505Z/results.json`.
