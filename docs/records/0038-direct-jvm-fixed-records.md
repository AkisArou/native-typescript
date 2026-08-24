# 0038 — Give fixed TypeScript records exact JVM fields

Status: implementation and host proof complete; device measurement pending  
Recorded: 2026-08-24

Plain TypeScript object literals and interfaces are structural records in
Native IR. Their shapes are already interned and closed, so representing them
as `HashMap<String, Object>`, an `Object[]`, or a generic JavaScript-value cell
would discard facts the compiler owns and add hashing, boxing, and dynamic
dispatch to every property access.

## Decision

The Direct JVM emitter generates one nested Java class per reached fixed
record shape. Every declared property becomes an exact field:

```text
number property  -> double field
boolean property -> boolean field
string property  -> String field
record/object     -> exact generated/reference field
```

Record literals call a generated factory whose parameters follow the
literal's source order. This detail is semantic: Native IR canonicalizes shape
fields by name, but JavaScript evaluates literal values in source order. Java
evaluates method arguments left-to-right, after which the factory stores each
parameter in its canonical field. Field reads and writes then become ordinary
Java `getfield`/`putfield` operations.

Index-signature records, overflow properties, dropped mapped fields, record
clones/spreads, and dynamic keyed access remain precise unsupported surfaces.
They require different representations or lowering and do not weaken the
fixed-record path.

## Matched workload

Android benchmark workload version 7 adds `record-objects` to Native
TypeScript, Direct JVM, Kotlin, and plain NativeScript. Each of 50,000
iterations:

- allocates one fixed-shape row containing a number, an alternating
  ASCII/Unicode string, and a boolean;
- mutates the numeric property using the string length;
- conditionally mutates it through the boolean property;
- consumes the final value in a checksum.

The shape is friendly to ART escape analysis on purpose. Kotlin may
scalar-replace its ordinary class and Direct JVM should have the same
opportunity; a generic property map would prevent or greatly complicate that
optimization. The independently calculated checksum is 6,730,460.

## Evidence at this checkpoint

The compiler observer first failed at the intended boundary:

```text
JVM backend does not support expression 'recordLit'
```

After lowering:

- the focused JVM emitter lane passes;
- generated Java contains exact `double`, `boolean`, and `String` fields;
- generated Java contains no `HashMap`, `Object[]`, JNI, `Double.valueOf`, or
  `Boolean.valueOf` on the record path;
- javac compiles the generated source and the JVM returns `20` for field
  mutation and `1212` for the disagreeing source-order probe;
- all four benchmark implementations declare the same iteration count,
  program shape, and expected checksum.

No APK, emulator, or device timing was run for this slice. The matched batch
remains the authority for whether exact records close or expose a performance
gap against Kotlin and NativeScript.
