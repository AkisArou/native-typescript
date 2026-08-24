# 0043 — Parse JavaScript numbers directly in ART

Status: implementation, host proof, and device measurement complete  
Recorded: 2026-08-24

The Direct JVM tier already keeps primitive numbers and static `Math` calls
unboxed, but the next ordinary data-processing boundary still refused:
numeric recognition and parsing arrived as closed Native IR `libCall`
operations. Sending those operations through JNI or a generic JavaScript
dispatcher would surrender the reason for compiling the surrounding program
to JVM code.

## Decision

The JVM emitter now consumes the reached numeric library surface directly:

- `Number.isFinite`, `Number.isNaN`, `Number.isInteger`, and
  `Number.isSafeInteger` operate on primitive `double` values;
- global `isNaN` consumes the frontend's already-number-coerced operand;
- numeric `Object.is` compares canonical double bits, so all NaNs agree while
  positive and negative zero remain different;
- `parseInt`, `parseFloat`, and `Number(string)` use JavaScript grammar rather
  than Java's whole-string grammar.

The parsers scan UTF-16 strings without regular expressions. They recognize
JavaScript's exact whitespace set, signs, radix inference, prefixes, longest
valid prefixes, exponent grammar, `Infinity`, invalid tails, and negative
zero. Decimal conversion delegates only a validated span to
`Double.parseDouble`. Integer conversion stays in a signed `long` while exact,
uses `BigInteger` only after overflow for decimal and power-of-two radices, and
ports V8's 32-bit chunk folding for other radices so very long values round to
the same binary64 result as JavaScript.

Support is reachability-gated. A program using no parser emits no parser, no
`BigInteger` reference, and no dispatcher. Predicate arguments are evaluated
once, including when integer/safe-integer recognition needs a helper call.

## Matched workload

Android benchmark contract version 12 adds `number-parsing` to Native
TypeScript/JNI, Direct JVM, Kotlin, and plain NativeScript. Each sample runs
50,000 iterations over bounded signed integer, fractional, and exponent
strings and performs one base-10 integer parse, one prefix float parse, and
one whole-string number conversion per iteration. Inputs use exactly
representable binary fractions, and the independently computed checksum is
`-62,856,250`.

The Kotlin control deliberately uses idiomatic `String.toInt()` and
`String.toDouble()`. That made an older assumption visible: the hand-built APK
rejected any Kotlin runtime reference. The benchmark now feeds the core and
available JDK overlay stdlib jars from the exact `kotlinc` distribution into
D8. Report schema 8 records each jar name and SHA-256 digest, making that
runtime cost explicit instead of rewriting Kotlin into Java calls or silently
shipping an incomplete APK.

## What the cold build exposed

Invalidating every affected cache and building all four APKs found four
independent gaps that focused parser tests could not reveal:

1. An external ScriptC library plan knew regex support was required but could
   not produce the vendored `libregexp.c` and `libunicode.c` objects. Those
   sources are now ordinary declared runtime-resource inputs in a planned
   build; the direct builder retains its cached-object fast path.
2. The Set workload's direct `for...of` reached the frontend's generated
   `catch (e) { iterExit(); rethrow e; }` shape. The JVM tier now emits the
   exact cleanup catch and rethrows the same `Throwable` through generic
   erasure—never a wrapper—so live-iteration depth is released on every Java
   failure.
3. `string | null` is represented as a nullable Java `String`, but passing it
   to a declared `CharSequence` input was refused. Input assignability now
   admits the directional `String -> CharSequence` widening without allocating
   a union carrier. Result equivalence remains strict: an arbitrary returned
   `CharSequence` is still not projected as a TypeScript string.
4. The Direct application id did not own the generated Activity coordinates
   carried by the shared binding package. Its distinct application id now
   owns that package prefix, while remaining independently installable beside
   the native and Kotlin controls.

These are part of the executable benchmark slice: without them a warm cache
could claim coverage that a clean four-application build could not reproduce.

## Evidence at this checkpoint

- the first observer failed specifically on `number.isFinite`;
- fixed edge cases and generated vectors for every radix from 2 through 36
  agree bit-for-bit with Node, including huge values, overflow, NaN, and
  signed zero;
- javac/JVM execution finds `Double.parseDouble`, the overflow-only
  `BigInteger` path, specialized parser helpers, and no regex, boxing, JNI, or
  generic dispatch;
- direct Set iteration executes on the host JVM, and emitted Java contains
  the generated cleanup catch plus identity-preserving rethrow;
- a separately compiled Java `CharSequence` fixture accepts both a stored
  string and null through one nullable TypeScript local, with no union class or
  JNI in bytecode;
- the library-plan observer proves both regex matcher objects depend on the
  declared ScriptC runtime resource;
- a host-only cold build produced all four APKs and a schema-8 report with 23
  scenarios and exact artifact/runtime hashes.

## On-device result

The complete three-round four-application batch measured the unchanged
50,000-iteration contract on the API 37 x86-64 Pixel 10 Pro AVD:

| Route | Median ns/parsed triple | Relative to Kotlin |
| --- | ---: | ---: |
| Native TypeScript / JNI | 111.61 | 0.69x |
| Direct JVM | 250.10 | 1.55x |
| Kotlin | 161.01 | 1.00x |
| NativeScript | 102.47 | 0.64x |

The result is a semantic and architecture win, not yet a speed win. The
Direct path executes the JavaScript grammar entirely in ART with primitive
values and no JNI or generic dispatcher, but it remains 1.55x Kotlin and
2.44x NativeScript on this bounded base-10 workload. The native ScriptC parser
is currently 2.24x faster than the Direct parser. That makes scanner shape,
validated-span conversion, and the common decimal path measured follow-up
targets; it does not justify weakening the exact radix, invalid-tail, huge
integer, NaN, or signed-zero behavior.

The raw schema-8 report is
`.native-typescript/benchmarks/android/2026-08-24T14-42-33-751Z/results.json`.
All 21 number-parsing samples per application produced the declared
`-62,856,250` checksum. The complete 23-scenario context is recorded in
[record 0044](0044-first-complete-direct-jvm-matrix.md).
