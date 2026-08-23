# 0016 — Frame-bounded native object results

Status: implemented and measured; no timing threshold is a correctness gate  
Recorded: 2026-08-23

[Record 0015](0015-first-android-nativescript-baseline.md) identified the
lightweight-object kernel as the first performance target. A `Rect` constructed
inside a loop was used only by one synchronous borrowed `width()` call, but the
JVM adapter still promoted every result to a global JNI reference, allocated a
managed ScriptC handle cell, and later destroyed both. This record captures the
first compiler-selected resource domain and the unchanged-workload device run
after it landed.

## Boundary

One source operation may now advertise two mechanics arms:

```text
stable entry         -> owned foreign handle -> managed handle cell
frame-bounded entry  -> raw foreign handle   -> exact lexical release
```

SCABI and Native IR carry the alternate entry and release as a result
capability. They do not select it. ScriptC's whole-function analysis selects
the frame-bounded arm only for an immutable, unboxed, exact native-handle local
initialized directly by a capable call when every use is a whole argument to a
synchronous call-scoped borrowed-handle parameter. Async/generator functions,
storage, capture, return, mutation, nullable results, result-owned callbacks,
and receiver-owned registrations remain stable.

That ownership split is deliberate. A JVM capsule knows how to return and
delete a JNI local reference, but cannot know whether a TypeScript value
escapes. The compiler knows whether it escapes, but must not invent target
mechanics. Both the C and LLVM backends consume the same selected Native IR
fact.

## Structural observer

The ScriptC Native IR fixture has two arms that cannot agree accidentally:

| Arm | Global promotions | Local releases | Managed cells |
| --- | ---: | ---: | ---: |
| non-escaping borrowed uses | 0 | 1 | 0 |
| sibling stored in a managed array | 1 | 1 | 1 |

Before specialization the first arm exited 11 because it observed one global
promotion. After specialization both C and LLVM exit 42, including their ASan
lanes with exact managed-cell instrumentation enabled. The escaping sibling is
the control: weakening the analysis into “all capable results are local” makes
it fail rather than silently agreeing.

The JVM generator separately executes both alternate entries against a live
HotSpot JNI runtime and releases the local reference through the named local
release. The Android build's generated C calls the frame entry for `Rect`,
passes the raw reference directly to `Rect.width()`, calls the frame release at
scope exit, and contains no `scr_native_handle_prepare` in that function.

## On-device measurement

The benchmark sources, constants, checksums, sample counts, and Kotlin and
NativeScript implementations are unchanged from record 0015. The accepted run
used five cyclically ordered fresh-process rounds on the Pixel 10 Pro x86-64
AVD, API 37, with ART's `speed` filter. Repeated kernels retain 35 samples per
implementation; view-tree retains five.

```text
parent at build start: 510bf7085a0f7836e3b712933d3ace613f98c9a4
ScriptC base:          485b9dedd3eb4884881ce0d6707de4c487b9c4b0
NDK clang:             18.0.2
Kotlin:                kotlinc-jvm 2.3.10
NativeScript CLI:      9.0.7
NativeScript Android:  9.0.5
```

The report records the complete uncommitted optimization inventory and all
three source hashes. Its packaged artifacts were:

| Application | Bytes | SHA-256 |
| --- | ---: | --- |
| Native TypeScript | 573,723 | `d53dd7af9edee4c192dad6c964021a4f3dd2310a1bcc59779e27a1a7cd60a93c` |
| Kotlin | 16,592 | `bf9e79ba347f20b3c76624f02e738f8aeba74002486ecef8c343f0b07701c30e` |
| NativeScript | 28,638,412 | `99a729165bdb2d9e73dcb5c0c72e5def701891823d7a5fe2a6f49618f7aabb48` |

The current medians are:

| Workload | Native TypeScript | Kotlin | NativeScript | NTS / Kotlin | NativeScript / Kotlin | NTS / NativeScript |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 128-child view tree | 68,408 ns/child | 98,895 ns/child | 55,004 ns/child | 0.69x | 0.56x | 1.24x |
| lightweight `Rect` construction and `width()` | 248.84 ns/op | 27.85 ns/op | 3,516.18 ns/op | 8.94x | 126.26x | 0.071x |
| `TextView` construction and scalar call | 25,823 ns/op | 25,668 ns/op | 28,717 ns/op | 1.006x | 1.12x | 0.90x |
| repeated `TextView.setTextSize` | 118.32 ns/op | 21.42 ns/op | 302.36 ns/op | 5.52x | 14.12x | 0.39x |
| synchronous `Button.callOnClick` | 332.19 ns/op | 2.52 ns/op | 1,654.60 ns/op | 132.05x | 657.72x | 0.20x |

The targeted before/after comparison is:

| Lightweight-object observation | Before | Frame-bounded | Change |
| --- | ---: | ---: | ---: |
| Native TypeScript | 340.81 ns/op | 248.84 ns/op | 27.0% lower / 1.37x faster |
| NTS / Kotlin | 11.26x | 8.94x | gap reduced 20.6% |
| NTS / NativeScript | 0.100x | 0.071x | 14.13x faster than NativeScript now |

This is the expected directional result from removing `NewGlobalRef`, managed
cell allocation, and stable destruction from the targeted loop. It is not a
controlled A/B on a physical device: the two observations are separate
emulator runs, and Kotlin moved from 30.27 to 27.85 ns/op while NativeScript
moved from 3,398.83 to 3,516.18 ns/op. Structural counts establish the
mechanism; the device timing establishes that the real generated application
benefits at the observed scale.

Constructor parity improved from 1.04x to 1.006x relative to Kotlin, but both
absolute constructor medians moved upward between runs. That supports “parity
in this observation,” not attribution of an absolute widget-construction win.
The five-sample view-tree ranges are broad—Native TypeScript 29,467–407,247,
Kotlin 48,638–184,051, and NativeScript 38,416–76,748 ns/child—so they admit no
ranking. Setter and callback mechanics were not changed by this slice.

Launch completion medians were 548/514/791 ms for Native TypeScript, Kotlin,
and NativeScript after force-stop, and 78/47/42 ms when returning the existing
task from Home. They are `am start -W` completion observations with broad
ranges, not first-visible-frame measurements. Settled median PSS was
19,152/18,801/73,979 KiB; median RSS was 143,980/142,252/200,736 KiB.

## What this admits next

The resource-domain architecture now has an evidence-backed first slice:
package mechanics remain target-owned, escape selection remains compiler-owned,
and C/LLVM agree. The remaining 8.94x Kotlin gap in the cheap-object kernel is
large enough to keep optimizing, but no longer includes the managed handle or
global-reference work removed here.

The next measurement should carry `JNIEnv *` once through a legalized
same-thread foreign region instead of performing `JavaVM->GetEnv` in the
constructor, `width()` call, and local release independently. That mechanism
also affects setters and other native-to-Java calls, so it should have exact
acquisition counters and rerun the unchanged three-way instrument before any
claim. Callback token dispatch is a separate later slice: its Kotlin ratio is
large, but Native TypeScript's absolute callback median is still only 0.332
microseconds.

The requested matched counter was later expanded to compare lookup, scoped
TLS, and an explicit operand. The scoped carrier reached the explicit
operand's host lower bound without changing the compiler ABI and improved this
light-object ART median from 221.70 to 159.09 ns/op. The mechanism and why the
earlier threshold was re-evaluated are in
[record 0019](0019-scoped-jni-environment-capability.md).
