# 0036 — Make the Android benchmark a Direct JVM application

Status: implementation and host proof complete; device measurement pending  
Recorded: 2026-08-24

The first native-subclass slice emitted an Android-compatible `Activity`, but
the benchmark APK still launched a handwritten Java `Activity`. That shell
called static methods emitted from `direct/kernel.ts`, while the TypeScript
`Activity` was packaged only as an independently launchable second component.
This proved lifecycle lowering without yet making the Direct JVM benchmark an
application compiled wholly from TypeScript. It also duplicated each workload
between a growing Java dispatcher and the compiler-owned class.

## Decision

`benchmarks/android/direct/activity.ts` is now the sole launcher and owns the
entire Direct JVM benchmark:

```text
Android creates MainActivity
        ↓
ordinary JVM onCreate override emitted from TypeScript
        ↓
TypeScript scenario selection, warmup, timing, checksum, and logging
        ↓
ordinary ART calls and objects
```

The obsolete Java launcher and exported `NativeTypeScriptKernel` have been
removed. The Direct JVM APK build now plans one checked TypeScript module,
emits one top-level Java `Activity` plus its reached nested managed classes and
listener adapter, compiles those classes with javac, and names that generated
class directly in the Android manifest. There is no compatibility Activity,
static kernel ABI, JNI entry point, or native method in this product.

All currently declared Android workloads are TypeScript-owned, including the
full view tree, managed inheritance and virtual dispatch, constructors,
setters, three callback shapes, Java string arguments/results, byte arrays,
nullable handle results, text updates, and composite screen construction.
The Activity's `completedSamples` field remains on the platform-created ART
receiver and therefore continues to exercise the direct native-subclass field
model rather than a static benchmark-only state holder.

## String operations become a measured language workload

A boundary-only string result does not answer how the Direct JVM backend
handles ordinary JavaScript text processing after the value arrives. The
benchmark matrix therefore gains `string-operations`, a matched 10,000-step
workload across Native TypeScript, Direct JVM, Kotlin, and plain NativeScript.
Every step performs:

- ECMAScript whitespace trimming;
- locale-independent case conversion;
- substring search;
- negative/relative-capable slicing;
- padding;
- UTF-16 length and `charCodeAt` observation.

The input contains ASCII, Greek, an astral emoji, and a combining mark. Its
checksum is 960 per iteration, or 9,600,000 per sample, so an implementation
cannot silently skip either the allocations or the Unicode observations.

To make that workload an honest Direct JVM program, ScriptC now lowers the
non-array-returning string intrinsic surface into Java `String` operations and
small reached helpers. It covers `charCodeAt`, `charAt`, `indexOf`, `includes`,
`startsWith`, `endsWith`, `slice`, `substring`, `repeat`, `padStart`, `padEnd`,
the three trim forms, Unicode case conversion, `isWellFormed`, and
`toWellFormed`. `split` remains a
precise refusal until ordinary JavaScript arrays have a Direct JVM
representation.

The helpers preserve source semantics that a naive Java method substitution
would lose: ToIntegerOrInfinity, negative slice coordinates, substring's
argument swap, UTF-16 code-unit indexing, the exact ECMAScript whitespace
set, catchable repeat/padding range failures, and repair of lone surrogates.
Receiver and argument expressions still evaluate once and from left to right.

`Uint8Array` construction and element stores also now remain Java `byte[]`
operations. Construction from a length performs the JavaScript length
conversion, construction from another `Uint8Array` clones, and stores apply
ToUint8 without allocating a managed handle.

## Evidence at this checkpoint

The string observer first failed with the intended backend refusal:

```text
JVM backend does not support string intrinsic 'charCodeAt'
```

After lowering, the focused compiler suite passes all nine JVM emitter tests.
The parent JVM executable lane passes six tests, including a real javac/JVM
program which checks UTF-16 indexing, out-of-range results, negative slicing,
substring swapping, repeat failures, non-breaking-space trimming, Unicode
casing, padding, and lone-surrogate repair.

The complete benchmark Activity also plans against the real generated Android
SCABI package and emits 61,399 Java source characters. The structural probe
finds the platform superclass, `setContentView`, direct callback adapter,
Java `byte[]`, trim/padding helpers, and `Locale.ROOT` casing in that one
translation unit.

This is not on-device evidence. The expensive four-implementation Android
build and measurement batch remains deliberately deferred. Until that batch
runs, this record makes no launch, memory, or timing claim for the Direct JVM
application or the new string workload.
