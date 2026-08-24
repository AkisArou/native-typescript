# 0039 — Keep Direct JVM unions typed

Status: implementation and host proof complete; device measurement pending  
Recorded: 2026-08-24

TypeScript optional values and general unions are closed types in Native IR.
Erasing their payload to `Object` would force primitive boxing and cast every
narrowed read. Treating every missing arm as Java `null` would be fast but
wrong whenever one union contains both `null` and `undefined` or carries a
scalar arm.

## Decision

The Direct JVM emitter uses two representations.

A union containing exactly one supported ART reference and exactly one unit
arm (`null` or `undefined`) is the reference itself. Java `null` encodes the
single missing arm, so `string | undefined`, a fixed record plus `undefined`,
arrays, managed objects, functions, and native handles need no tag object.
This is an internal representation rule: only a declared `null` arm may cross
a Java platform boundary as `null`; `undefined` is never silently projected
into a platform call.

Every other reached union gets one generated exact Java class:

```text
final int tag
final double payload0
final String payload1
...
```

There is one typed factory per payload arm and one shared singleton per
payload-less unit arm. Narrowing reads the exact arm field and tag tests read
the integer tag. There is no `Object` payload, `Double.valueOf`, reflection,
generic JavaScript value, managed native handle, or JNI operation. Short-lived
boxes remain ordinary final Java objects so javac and ART escape analysis can
scalar-replace them.

## Matched workload

Android benchmark contract version 8 adds `optional-values` to Native
TypeScript/JNI, Direct JVM, Kotlin, and plain NativeScript. Each of 50,000
iterations calls two helpers:

- a scalar optional result is present on three of four calls and otherwise
  contributes a missing-value fallback;
- a string optional result alternates between `"alpha"` and missing;
- both results are narrowed and consumed immediately in a checksum.

This gives Direct JVM and Kotlin the same inlining and scalar-replacement
opportunity while retaining the source-language optional-value shape. The
independently calculated checksum is 5,344,720.

## Evidence at this checkpoint

The first observer failed at the intended boundary:

```text
JVM backend does not support non-nullable-reference union construction
```

After lowering:

- a two-arm scalar optional and a three-arm number/string/null union execute
  correctly through javac and the host JVM;
- optional record and string locals are emitted as exact nullable Java
  references;
- generated union classes have final integer tags and exact primitive or
  reference payload fields;
- bytecode contains no `Object` payload, `Double.valueOf`, or JNI path;
- all four benchmark implementations declare the same 50,000-iteration
  workload and checksum.

No APK, emulator, or device timing was run for this slice. The next matched
batch is the authority on whether ART eliminates the short-lived scalar union
allocation and how that compares with Kotlin nullable values and NativeScript.
