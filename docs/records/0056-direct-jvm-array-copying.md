# 0056 — Lower array copying and reversal directly on the JVM

Status: implementation and matched instrument complete; device measurement pending  
Recorded: 2026-08-25

The complete schema-14 matrix showed practical Kotlin parity on every reached
Direct JVM feature. The next useful step was therefore to extend coverage to
ordinary array operations that shared Native IR already supported but the JVM
emitter precisely refused: `slice`, `reverse`, `toReversed`, and `with`.

## Semantic observer

A new ScriptC corpus fixture first failed with the exact unsupported-intrinsic
diagnostic for `slice`. It now exercises all four operations, including:

- negative and fractional relative indices;
- clamped and empty slices;
- in-place mutation and returned identity for `reverse`;
- non-mutating `toReversed` and `with`;
- negative `with` indices and the original array remaining unchanged.

The generated program returns independently fixed results of `62` and `20`.
The parent host test compiles and executes that Java, then inspects the nested
specialized array class. Copying uses `java.util.Arrays.copyOfRange`; the path
contains neither `ArrayList` nor boxed `Double` values.

## Lowering

Each reached specialized primitive array class now implements the operations
directly over its primitive backing array:

- `slice` normalizes JavaScript relative indices and copies only the selected
  range;
- `reverse` swaps elements in place and returns the same wrapper;
- `toReversed` copies the logical extent once and reverses the copy;
- `with` validates its relative index, copies once, and replaces one element.

The representation remains the existing specialized array wrapper. No generic
JavaScript dispatcher, object array, collection adapter, or per-element boxing
was introduced.

## Matched Android instrument

Workload schema 15 adds `array-copying` to Native/JNI, Direct JVM, Kotlin, and
plain NativeScript. Each iteration performs the same four transformations and
contributes an observable checksum. The contract has 31 unique scenarios,
20,000 measured operations for this case, and an independently calculated
checksum of `5,932,832`.

The Direct JVM and NativeScript sources use the TypeScript operations directly.
The Kotlin source uses corresponding primitive/list copying and reversal while
preserving the same operation sequence and result. The source lockstep and
checksum contract pass.

## Pending decision

The user paused the performance goal to reclaim machine resources. The AVD,
ADB server, and Gradle daemon were stopped, so this checkpoint intentionally
contains no device number and makes no performance claim. When the goal
resumes, rebuild all four applications, run the schema-15 cyclic measurement,
and accept or revise the lowering from the measured result before committing
the slice.

