# 0032 — Keep managed TypeScript classes inside ART

Status: experimental direct-JVM slice implemented and measured  
Recorded: 2026-08-23

The direct-JVM tier could already keep Android objects, strings, arrays, and
same-thread callbacks in ART, but it still refused an ordinary TypeScript
class. That left a major ambiguity in the proposed Android architecture: a
JVM target that only accelerated foreign calls would still have to cross into
the native runtime for user-owned objects, fields, inheritance, and dispatch.

## Decision

A non-runtime ScriptC class is an ordinary generated Java class in a direct-JVM
artifact:

- ScriptC inheritance becomes Java inheritance;
- instance fields become fields on that Java object;
- `new` allocates the Java object and runs the already-lowered TypeScript
  constructor semantics;
- a reached virtual method gets an ordinary Java instance method, so ART owns
  dynamic dispatch;
- `super` continues to select the exact lowered base implementation;
- object upcasts, checked downcasts, and `instanceof` use Java references and
  Java's class relation directly.

This is deliberately different from a native subclass peer. A managed
TypeScript object created inside ART does not need a native handle, identity
table, reference-counted allocation, or second peer object. Java GC owns its
lifetime, while the checked Native IR remains the semantic input.

Number fields keep JavaScript `number` semantics by default. The shared
whole-program number analysis now publishes a narrower field fact only when
the default value and every reached write are finite, whole, signed-int32,
never `-0`, and range-safe. Inherited views resolve to the declaring field;
an unknown write or `fieldIncDec` keeps the field as `double`. The JVM emitter
spells a proved field as `int` but does not invent the proof.

JavaScript `>>>` needs one additional context distinction. Its observed
Number result is unsigned `0..2^32-1`, but a surrounding bitwise operation
immediately applies `ToInt32`. In that consumer context, Java's signed `int`
already carries the exact same 32 bits. The emitter therefore keeps that path
as `iushr` instead of widening through `long` and `double` only to call
`ntsToInt32` again.

## Disagreeing proof

The compiler corpus contains a base class with a constructor and field, a
derived class with another field and override, a `super` call, and a call
through a base-typed receiver. A host JVM compiles and executes the generated
Java and must print `42.0`. `javap` must show `invokevirtual`, with no native or
JNI entry.

A second class carries this recurrence in an instance field:

```ts
this.value = ((this.value << 5) ^ (this.value >>> 2) ^ 17) & 1023;
```

It must print `240.0` after one step. Generated source and classfile observers
require an `int` field and reject any invocation of `ntsToInt32` in the proved
kernel. A separate number-facts test includes a fractional control whose field
must remain `double`.

The first Android workload merely alternated assigned values. Kotlin and
NativeScript both reported sub-nanosecond medians, showing that the instrument
could be collapsed rather than that dispatch was free; that shape was rejected.
The retained workload advances the stateful recurrence above for 100,000
virtual calls, calls `super` in every derived override, reads a derived field,
and accumulates every result into the checked checksum. All four implementations
must agree.

The Android build also refuses unless the generated classfile contains:

```text
invokevirtual ...m_...:()D
putfield ...d_...:I
ishl / iushr / ixor / iand
```

and contains no numeric-coercion invocation or native entry in the direct
kernel.

## On-device measurement

All four APKs ran for five cyclically ordered process rounds on the Pixel 10
Pro x86-64 API 37 AVD after ART `speed` compilation. Each implementation
performed three warmups and seven measured samples per process, giving 35
samples. Lower is better.

| Implementation | Median per dispatch | Observed range | Ratio to Kotlin |
| --- | ---: | ---: | ---: |
| Kotlin | **1.33 ns** | 1.17–5.09 ns | 1.00x |
| NativeScript | **1.96 ns** | 1.72–3.57 ns | 1.47x |
| direct JVM Native TypeScript | **2.17 ns** | 1.49–47.94 ns | **1.63x** |
| JNI Native TypeScript | 76.38 ns | 66.01–187.90 ns | 57.41x |

The direct route is 35.12x faster than the native/JNI route for this managed
class workload and within 0.84 ns of Kotlin. It is 11.2% slower than
NativeScript in the matched run, so this is near-parity evidence rather than a
win claim.

Raw evidence:

```text
/home/akisarou/.cache/nts-tmp/managed-field-int-five-round/results.json
sha256:8fa480f6b41e30d47a90470e5598705187596113b707e9b12e2036a62124c4dc

/home/akisarou/.cache/nts-tmp/managed-field-int-five-round/
  native-typescript-jvm/bytecode-evidence.txt
sha256:efe88fd0aaba26bdac9482889f23ced90a4c73e63969630ae7d265929d3ea834
```

The ten-kernel direct-JVM APK is 24,784 bytes. It remains hosted by a small
Java Activity, so this result makes no direct-tier launch, lifecycle, or memory
claim.

## Consequence

The direct-JVM proposal is now more than a foreign-call fast path: ordinary
TypeScript object identity, storage, inheritance, `super`, and virtual dispatch
can stay in ART too. The remaining generated method shape still has a thin
instance wrapper around the static lowered semantic body, and public Number
returns remain `double`. Those are measurable next candidates; neither should
be changed on the assumption that 0.84 ns necessarily belongs to one of them.

Native Android subclasses remain a distinct next slice. Their Java base class
is platform-owned and their lifecycle is generated, but the managed field and
method machinery established here is the reusable half needed to put the
TypeScript peer directly into the generated ART class.
