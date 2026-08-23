# 0024 — Keep short-lived Android objects on ART

Status: experimental slice implemented and measured; JNI remains the shipped backend  
Recorded: 2026-08-23

[Record 0023](0023-direct-jvm-android-call.md) showed that a checked TypeScript
loop can call one static Android member as ordinary ART bytecode. This slice
tests the more consequential object path: construction, a typed local, and an
instance call on the same non-escaping Java object.

## Decision

The ScriptC JVM emitter now represents a concrete Native IR handle as its Java
class when that handle definition carries authoritative JVM `nativeName`
coordinates. It can therefore lower:

```ts
const rectangle = new Rect(0, 0, 1, 1);
checksum += rectangle.width();
```

to an ordinary Java reference:

```java
android.graphics.Rect rectangle = new android.graphics.Rect(0, 0, 1, 1);
checksum += rectangle.width();
```

The binding sidecar still supplies the exact owner, kind, name, descriptor,
and native adapter symbol. The emitter checks those facts against the checked
Native IR before emitting `new`, `invokevirtual`, or `invokestatic`. A
constructor result must name the class it constructs, instance calls must
receive a handle, parameter/result descriptors must implement the IR types,
and a generic `jobject` handle remains a precise refusal because it supplies no
Java class coordinate.

Native IR marks this constructor result frame-bounded for the C/LLVM+JNI
backend. On the direct JVM route the same lifetime means a lexical Java local:
ART owns the object and its garbage collector reclaims it. There is no JNI
local/global reference operation, native release call, managed handle cell, or
identity interning operation to spell.

This is deliberately not a change to the backend-neutral ownership contract.
It is the JVM representation of an already-proven non-escaping handle. A
future value that escapes into TypeScript-managed state still needs the
appropriate direct-JVM object/peer representation before it can be admitted.

## Disagreeing proof

The compiler observer first failed with the existing precise refusal:

```text
JvmUnsupportedError: JVM backend does not support frame-bounded native handles
```

It now compiles and executes a host `Widget` constructor and instance method,
alongside the existing static call. `javap` must contain all three exact
members and no native entry.

The Android APK uses the existing `light-object` workload unchanged: 50,000
`android.graphics.Rect(0, 0, 1, 1)` constructions, an immediate `width()` on
each object, and a required checksum of 50,000. Its evidence file contains:

```text
android/graphics/Rect."<init>":(IIII)V
android/graphics/Rect.width:()I
android/text/TextUtils.equals:
  (Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Z
```

The generated kernel and Java Activity contain neither a native declaration,
an `nts_jvm_*` invocation, nor a packaged native library.

## On-device measurement

All four APKs ran for five cyclically ordered process rounds on the Pixel 10
Pro x86-64 API 37 AVD after ART `speed` compilation. Each implementation
contributed 35 accepted samples per supported repeated scenario. Lower is
better.

| Implementation | `light-object` median | Range | Relative to Kotlin |
| --- | ---: | ---: | ---: |
| Kotlin | 20.18 ns/object | 15.38–219.85 ns | 1.00x |
| Native TypeScript, direct JVM | **30.04 ns/object** | 24.97–426.54 ns | **1.49x** |
| Native TypeScript, C/LLVM + JNI | 173.21 ns/object | 121.66–420.96 ns | 8.58x |
| NativeScript | 3,505.71 ns/object | 2,813.01–15,060.13 ns | 173.75x |

For this operation, direct JVM execution is 5.77x faster than the current JNI
route, an 82.7% reduction, and 116.7x faster than NativeScript. The remaining
1.49x Kotlin gap includes JavaScript `number` loop/index/arithmetic semantics;
this run does not attribute that remainder to one operation.

The direct string arm was rerun in the same artifact and measured 78.22
ns/comparison, versus 37.40 for Kotlin, 594.16 for Native TypeScript/JNI, and
1,375.93 for NativeScript. The object result therefore confirms the direction
with a second foreign shape rather than relying on the first string result.

Artifact observations from the same run are:

| Implementation | APK bytes | SHA-256 |
| --- | ---: | --- |
| Native TypeScript, C/LLVM + JNI | 602,395 | `aa8dba5ad269b656361c268157b0ba5bf74589b29998182c6c52c8ecfbc76580` |
| Native TypeScript, direct JVM slice | 12,496 | `2c5599ee85945cefb9bc433367fcc61a1263fb47c2e744e75679eec1573a952f` |
| Kotlin | 20,688 | `e274234821cb26cccee8f9e51b9e15c0b8e05288992baf003c946c2043ef50e8` |
| NativeScript | 28,639,588 | `ddaba7343ea1b589bdedf0ce70ee4101baaae74f0a1bcf74245f43ca8d1b17ac` |

The direct artifact remains a two-kernel harness, so its size is not
comparable to the three complete applications and it participates in neither
launch nor memory summaries.

Raw report and bytecode evidence:

```text
/home/akisarou/.cache/nts-benchmark-direct-object-20260823-b/results.json
sha256:cd6634c9dfa1560c01e369e1807793e80e088f8e64c390d83892e7a6e0075519

/home/akisarou/.cache/nts-benchmark-direct-object-20260823-b/
  native-typescript-jvm/bytecode-evidence.txt
sha256:2b4ec2f73936af78e594245ef8123a489fe53adffa28426c9226c1e9344d2d05
```

## Consequence

Continue the direct JVM route for Android-heavy TypeScript. Two distinct
boundary families now show that avoiding JNI is materially larger than
another mechanics-only bridge improvement, while the native backend remains
necessary for native targets and native computation.

The next measurement-bearing slice should target an existing stable receiver
operation such as `setter`. That requires importing a platform-created object
into the generated JVM entry point or generating more of the Activity itself;
the former is the smaller falsifier. It should preserve exact class
coordinates, reject unsupported escaping storage, and join the unchanged
benchmark before broader class, callback, or lifecycle work is claimed.

[Record 0025](0025-direct-jvm-stable-receiver.md) completes that smaller
falsifier: a host-supplied `Activity` enters checked TypeScript as a concrete
Java reference, constructs one `TextView`, and remains on ART for repeated
instance calls.
