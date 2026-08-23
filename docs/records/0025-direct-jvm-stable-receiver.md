# 0025 — Pass platform-owned receivers directly through ART

Status: experimental slice implemented and measured; JNI remains the shipped backend  
Recorded: 2026-08-23

[Record 0024](0024-direct-jvm-object-calls.md) kept a TypeScript-created,
non-escaping Android object as a Java local. This slice asks a different
question: can an object the Android framework supplied enter checked
TypeScript, participate in a native-handle identity upcast, and become the
constructor argument for an object that receives repeated calls without
crossing JNI?

## Decision

Executable planning now accepts exact entry-file functions as external roots.
This is for targets whose generated host class calls a TypeScript body from
outside ScriptC's module-evaluation graph. It keeps only the named bodies; it
does not retain every export or add fake calls whose evaluation could affect
program behaviour.

The Native TypeScript SCABI translator independently accepts host-supplied
native type IDs. Their representations and transitive upcast closure enter
Native IR without selecting an unrelated native binding. The benchmark can
therefore describe an `android.app.Activity` parameter even though no reached
Android method produces it.

For the direct JVM emitter, an identity upcast between two concrete native
handles is representation-free. The emitter validates both classes from their
authoritative JVM coordinates and emits the original Java reference. It does
not emit a cast: `javac` remains responsible for proving, for example, that
`Activity` is assignable to the `Context` parameter of `TextView(Context)`.
Non-handle upcasts remain a precise refusal.

Together these rules lower the unchanged setter kernel:

```ts
export function runSetters(activity: Activity): number {
  const view = new TextView(activity);
  let checksum = 0;
  let index = 0;
  while (index < 50000) {
    view.setTextSize(index & 1 ? 12 : 13);
    checksum += index & 1;
    index += 1;
  }
  return checksum;
}
```

to a generated Java entry receiving `android.app.Activity`, one ordinary
`new android.widget.TextView(activity)`, and direct
`invokevirtual TextView.setTextSize:(F)V` calls. There is no native entry,
native handle cell, JNI reference, or adapter dispatch in this path.

## Disagreeing proof

The executable observer first failed because the externally called function
was correctly absent from reachability. After external roots admitted its body,
the Android build failed because the host-provided `Activity` type was absent
from Native IR. After the type-root primitive admitted it, the emitter failed
at the intended next boundary:

```text
JvmUnsupportedError: JVM backend does not support expression 'upcast'
```

The final observer executes a generated method with a host-created `Widget(9)`
and requires the result `9`. A separate SCABI test proves a host type and its
upcast base enter the type closure while the selected binding set remains
empty. The Android evidence then requires all of:

```text
NativeTypeScriptKernel.runSetters:(Landroid/app/Activity;)D
android/widget/TextView."<init>":(Landroid/content/Context;)V
android/widget/TextView.setTextSize:(F)V
```

and the direct APK contains no native library or generated native entry.

## On-device measurement

All four APKs ran for five cyclically ordered process rounds on the Pixel 10
Pro x86-64 API 37 AVD after ART `speed` compilation. Each implementation
contributed 35 accepted setter samples with the same 50,000 calls, three
in-process warmups per round, and required checksum 25,000. Lower is better.

| Implementation | `setter` median | Range | Relative to Kotlin |
| --- | ---: | ---: | ---: |
| Kotlin | 13.41 ns/call | 11.54–134.59 ns | 1.00x |
| Native TypeScript, direct JVM | **59.00 ns/call** | 49.06–170.93 ns | **4.40x** |
| Native TypeScript, C/LLVM + JNI | 75.04 ns/call | 50.10–220.72 ns | 5.59x |
| NativeScript | 235.98 ns/call | 217.61–257.24 ns | 17.59x |

Direct JVM execution is 21.4% faster than the current JNI route and 4.0x
faster than NativeScript for this stable receiver. The improvement is smaller
than the object and string cases because the emitted loop still preserves a
generic JavaScript `number`: its bytecode repeatedly calls `ntsToInt32`,
performs truthiness conversion for the ternary, converts the selected double
to float, and repeats the integer conversion for the checksum. Kotlin keeps
the induction variable and bit operation as integer instructions. The direct
Android call is no longer the dominant difference, so this result points to
proved numeric representation specialization as the next compiler
optimization.

The two earlier direct arms were rerun in the same artifact. `light-object`
measured 26.46 ns/object versus 22.32 for Kotlin, 157.61 for JNI, and 3,324.89
for NativeScript. `string-argument` measured 61.36 ns/comparison versus 33.15,
452.23, and 1,030.85 respectively. Run-to-run emulator variation is why this
record uses only same-run ratios and does not rewrite the historical numbers
in earlier records.

Artifact observations from this run are:

| Implementation | APK bytes | SHA-256 |
| --- | ---: | --- |
| Native TypeScript, C/LLVM + JNI | 602,395 | `f19c6e6065710adceb7bd58f40358f410fb87e14fdf6ae8b2a169ceb96b5dd5f` |
| Native TypeScript, direct JVM slice | 12,496 | `3ac6f31c0bd73f67852fc4d10619e5c4e1c3d338c19958ab6eef2cc228fa3363` |
| Kotlin | 20,688 | `7d59ba2786ad92e36de127b0658d98cc54bbd559d441c474c73427ff9785dfe5` |
| NativeScript | 28,639,528 | `d715c276f039d01c88958766f6502b8ecad241cb512b92c1100adf91a52d168a` |

The direct artifact remains a three-kernel harness, so its size is not
comparable to the three complete applications and it participates in neither
launch nor memory summaries.

Raw report and bytecode evidence:

```text
/home/akisarou/.cache/nts-benchmark-direct-setter-20260823-device-a/results.json
sha256:a02fcf308f3ffbcb57edf2cfe84f94cc3a43ac485cca5cd8bf2621345bf0e152

/home/akisarou/.cache/nts-benchmark-direct-setter-20260823-device-a/
  native-typescript-jvm/bytecode-evidence.txt
sha256:9d0787faba81526aa2b8cfdf1ea8a4df52d0d052d7629c599e5c5e68d1d2c72c
```

## Consequence

Platform-owned Java objects do not require a JNI handle merely because the
generated TypeScript entry is external to ScriptC's ordinary reachability
graph. Concrete host parameters, identity upcasts, constructors, and stable
receiver calls can remain ordinary verified Java references.

The next slice should not broaden direct binding shapes blindly. It should
specialize values proven to remain integer-valued through induction, bitwise
operations, comparisons, and numeric native arguments, while preserving
JavaScript overflow and conversion semantics at the exact point they become
observable. The setter bytecode and Kotlin comparison provide the falsifier.
