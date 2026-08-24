# 0037 — Specialize JavaScript arrays in the Direct JVM tier

Status: implementation and host proof complete; device measurement pending  
Recorded: 2026-08-24

Ordinary JavaScript arrays were the next representation gap after strings and
`Uint8Array`. Sending every element through `Object`, `ArrayList<Object>`, or a
generic `JsValue` would make the surface easy to extend, but it would also box
every numeric and boolean element and insert dynamic dispatch into operations
whose element type Native IR already knows.

## Decision

The Direct JVM emitter generates one compact array class for every reached
monomorphic Native IR array type. Each class owns an exact backing array, a
logical length, and geometric capacity growth:

```text
number[]       -> double[]  + length
boolean[]      -> boolean[] + length
string[]       -> String[]  + length
Uint8Array[]   -> byte[][]  + length
managed T[]    -> exact generated T[] + length
native T[]     -> exact Java platform T[] + length
nested T[][]   -> exact generated array-wrapper[] + length
```

The first slice lowers array literals, indexed reads and writes, `length`,
variadic `push`, `pop`, `indexOf`, and `includes`. Indexed assignment may
replace an existing slot or append exactly at the current length; a negative,
fractional, non-finite, or hole-producing index traps, matching Native IR's
already documented static-array discipline. Java argument evaluation preserves
the required receiver/index/value and variadic argument order.

`indexOf` and `includes` deliberately do not share one equality helper:

- numbers use strict equality for `indexOf`, so `NaN` never matches;
- numbers use SameValueZero for `includes`, so `NaN` does match;
- strings compare by contents;
- managed objects, native objects, byte arrays, and nested arrays compare by
  ART reference identity.

No generic object array, reflective call, JNI transition, or language-runtime
boxing sits on these paths. ART remains free to inline the small wrapper and
scalar-replace short-lived arrays.

The new representation also closes the string-separator `String.split` gap.
The generated helper preserves the unsigned limit, leading/trailing empty
parts, exact substring matching, and empty-separator UTF-16 code-unit behavior,
and returns the same specialized `String[]` wrapper.

The second slice admits ordinary function values without falling back to a
boxed callable protocol. Every reached monomorphic function type becomes a
primitive-signature Java functional interface. Inline closures become Java
lambdas, immutable captures become direct lambda captures, mutable captures
share the emitter's typed box, and named top-level functions use one cached
singleton function value. The frontend's existing `map`, `filter`, `reduce`,
and `forEach` lowering therefore emits ordinary structured Java loops over the
same specialized arrays. No reflective invocation or `Object...` argument
vector is introduced.

## Matched Android workload

Benchmark workload version 6 adds two array cases to Native TypeScript, Direct
JVM, Kotlin, and plain NativeScript. `array-operations` performs one complete
dynamic numeric-array lifetime per iteration:

- allocate four elements;
- grow by two elements;
- replace and read indexed elements;
- perform strict `indexOf` and SameValueZero `includes` searches;
- pop the final element;
- feed every observation into a checksum.

Kotlin uses `ArrayList<Int>`, its ordinary mutable dynamically-sized array
surface. Direct JVM uses the compiler-generated `double[]` specialization.
That is an intentional language-runtime comparison: using a fixed Kotlin
`IntArray` would remove the growth and pop semantics the scenario is meant to
measure.

The varying input is masked to 0…255 and the search needle is 1024. An earlier
needle of 11 collided with the varying first element and changed `indexOf`'s
answer; the independent checksum probe exposed that fixture defect before a
device number could legitimize it. The corrected expected checksum is
3,626,416 per sample.

`array-pipeline` performs an idiomatic `map → filter → reduce` chain per
iteration. The mapping callback receives the element and index and captures a
varying delta; filtering creates a second intermediate collection; reduction
keeps the result observable. Kotlin uses the corresponding `listOf`,
`mapIndexed`, `filter`, and `fold` surface. The independently calculated
checksum is 5,807,121 per sample.

## Evidence at this checkpoint

The compiler observer first failed with the intended refusal:

```text
JVM backend does not support expression 'arrayLit'
```

After lowering:

- all ten focused JVM emitter tests pass;
- generated Java compiles and executes number, boolean, and string arrays;
- generated Java executes no-capture, immutable-capture, mutable-capture, and
  named-function array callbacks with exact results;
- bytecode inspection finds `double[]`, `boolean[]`, and `String[]`, and no
  `Object[]`, `ArrayList`, `Double.valueOf`, or `Boolean.valueOf` on the
  generated array/callback paths;
- the string executable probe checks separator limits, trailing empty parts,
  and UTF-16 splitting of an astral character;
- the complete TypeScript-owned benchmark Activity plans against the cached
  real Android SCABI package, emits 67,279 Java characters, and javac accepts
  it against Android API 35;
- all four benchmark sources declare the same workload constant and scenario,
  and the independent Direct workload computes the declared checksum.

This remains host evidence. No APK build, emulator run, or timing result was
performed for this slice; the four-implementation device batch remains
deferred until explicitly requested.

## Deliberately still open

Array spreads and the remaining mutating/copying methods still refuse by their
exact IR operation. Function rest parameters, labeled loop control, and other
dynamic callable shapes remain precise refusals. Those should be admitted from
real reached programs without replacing these monomorphic arrays and function
interfaces with a generic JavaScript value path.
