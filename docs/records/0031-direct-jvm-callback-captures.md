# 0031 — Keep captured callback state in ART

Status: experimental direct-JVM slice implemented and measured  
Recorded: 2026-08-23

[Record 0030](0030-direct-jvm-callback-payloads.md) kept a delivered Android
object in ART, but the listener still accepted only a zero-capture closure.
That excluded ordinary application handlers: even a callback that reads a
nearby view or increments a local counter has lexical state.

## Decision

A retained direct-JVM callback owns its captured state in the generated Java
listener that already owns its registration lifetime:

- an immutable capture is stored as its exact Java value;
- a mutable `number`, `boolean`, or reference binding is shared through a
  generated typed holder, preserving TypeScript reassignment aliasing;
- the callback payload remains the exact reference ART delivered;
- the listener calls the reached emitted TypeScript body directly rather than
  invoking a generic generated handler interface;
- cancellation is idempotent, invalidates the registration arm, and clears
  captured reference and holder fields;
- a captured temporal-dead-zone binding remains a precise refusal.

The representation follows the ownership already present in the source. A
retained Java listener is a closure object; adding a native closure environment,
JNI global references, or generation tokens would duplicate that object graph
for a same-thread callback that never leaves ART.

One generated listener class can serve multiple reached registration sites.
Each site receives an exact registration method and capture fields; a small
integer arm selects the corresponding direct static body on delivery. This
replaced the first implementation's generic `NtsCallback0` field, lambda, and
`invokeinterface` dispatch.

## Disagreeing proof

The host observer captures three values with different semantics:

- a mutable numeric accumulator;
- a mutable `Widget` binding initially pointing at depth `5`, reassigned to a
  new widget at depth `9` after registration;
- an immutable widget at depth `3`.

A Java host delivers one object twice. The program exits with `26`, proving
that both deliveries see one shared accumulator, the post-registration
reference assignment, the immutable captured object, and the delivered
payload. Rebuilding a closure per delivery or copying the mutable reference at
registration produces a different result.

The generated-source and `javap` assertions also require:

```text
NtsDoubleBox
NtsReferenceBox
NtsCallbackAdapter0.ntsRegister0(...captures...)
DirectCallback.f_...(...captures..., fixture.Button)
```

They reject `NtsCallback0`, `invokeinterface`, any `nts_jvm_` call, and any
native method in the direct callback path.

The Android workload creates a delivered button with ID `7` and a distinct
captured button with ID `11`, registers once outside the timed loop, and makes
20,000 deliveries. The handler calls `getId()` on both objects and must report
`360,000`. A payload-only callback, a rebuilt capture, or a missing retained
association cannot agree with that checksum.

## On-device measurement

All four APKs ran for five cyclically ordered process rounds on the Pixel 10
Pro x86-64 API 37 AVD after ART `speed` compilation. Each implementation
performed three warmups and seven measured samples per process, giving 35
measured samples. Lower is better.

| Implementation | Median per delivery | Observed range | Ratio to Kotlin |
| --- | ---: | ---: | ---: |
| Kotlin | **5.29 ns** | 5.03–34.43 ns | 1.00x |
| direct JVM Native TypeScript | **24.19 ns** | 21.53–630.75 ns | **4.58x** |
| JNI Native TypeScript | 346.60 ns | 256.29–938.81 ns | 65.57x |
| NativeScript | 1,701.14 ns | 1,613.44–2,460.56 ns | 321.82x |

The direct route is 14.33x faster than the current JNI route and 70.32x faster
than NativeScript. It remains 4.58x Kotlin, so captured state is a measured
remaining cost rather than a parity claim.

The first correct implementation used a generated handler interface and
lambda and measured 30.74 ns per delivery. Replacing that generic dispatch
with registration-site fields and a direct static body call reduced the
median by 21.3% to 24.19 ns. A further experiment emitted a constructor-site
listener subclass to remove the remaining arm switch. It changed the
Kotlin-normalized ratio only from 4.58x to 4.53x, about 1.1%, while adding an
IR prewalk and one class per site. That shape was rejected as noise-priced
complexity; the measured interface-free base listener is the retained design.

Raw evidence:

```text
/home/akisarou/.cache/nts-tmp/direct-callback-capture-specialized-five-round/results.json
sha256:558c0f8f0812f7b3e2bbcffa582d3d8178ad782c7b6c7f886a2ff62ed9d8b5d0

/home/akisarou/.cache/nts-tmp/direct-callback-capture-specialized-five-round/
  native-typescript-jvm/bytecode-evidence.txt
sha256:f10aaab7a0b5fbc3b301bab3d9b763702e943c554c61586b95b01351f362485f
```

A clean build of the retained source produced the same bytecode-evidence
digest as the measured artifact. The nine-kernel direct-JVM APK is 24,784
bytes. It remains a kernel hosted by a small Java Activity rather than a
complete application backend, so launch and memory comparisons continue to
apply only to the three full applications.

## Consequence

Direct JVM callbacks now cover the ordinary synchronous listener shape:
delivered platform values, immutable captures, mutable bindings, retained
ownership, and cancellation all stay in ART. The remaining 4.58x gap is not
evidence for another representation layer: removing the visible arm switch
did not materially change it. The next investigation should inspect Kotlin
and generated DEX/ART code shape or move to the next missing language feature,
then admit an optimization only when a disagreeing device measurement assigns
the cost.
