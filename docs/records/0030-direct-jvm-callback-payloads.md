# 0030 — Keep callback object payloads in ART

Status: experimental direct-JVM slice implemented and measured  
Recorded: 2026-08-23

[Record 0029](0029-direct-jvm-callbacks.md) removed JNI from a same-thread
listener whose delivered `View` was unused. That proved dispatch, but not that
the TypeScript handler could consume the platform object without rebuilding a
managed handle or crossing back through an adapter.

## Decision

An object delivered to a verified direct-JVM interface callback remains the
exact Java reference ART supplied. The emitted TypeScript handler receives it
as its declared Java class, represents `T | null` as the same nullable
reference, and may call another reached direct member on it immediately.

This adds no resource-domain operation:

- the listener invokes the handler in the same Java frame;
- the callback payload is not promoted or interned;
- a nullable payload is one Java null check, not a tagged union;
- the subsequent `View.getId()` is an ordinary `invokevirtual`;
- the connection and zero-capture restrictions from record 0029 are
  unchanged.

The benchmark creates a second generated listener outside the timed loop,
roots its connection, sets the delivered button's ID to `7`, then performs
20,000 `Button.callOnClick()` deliveries. The TypeScript handler null-checks
the delivered `View`, calls `getId()`, and accumulates `140,000`. This is the
existing three-implementation `callback-payload` workload, not a new easier
kernel.

## Bytecode proof

The build gate requires the generated callback handler itself—not merely some
other method in the class—to contain:

```text
private static void ... (android.view.View)
  ifnull
  invokevirtual android/view/View.getId:()I
```

The nested listener still implements `android.view.View$OnClickListener` and
invokes `NtsCallback0.invoke(View)`. Neither class may contain a native method,
an `nts_jvm_` call, or a numeric-coercion helper in the proved integer loops.
The exact checksum separately proves that delivery, nullability, receiver
reuse, and accumulation all happened.

## On-device measurement

All four APKs ran for five cyclically ordered process rounds on the Pixel 10
Pro x86-64 API 37 AVD after ART `speed` compilation. Each measured sample
performed 20,000 deliveries after three warmups; registration and `setId(7)`
were outside the timed loop. There were 35 measured samples per
implementation. Lower is better.

| Implementation | Median per delivery | Ratio to Kotlin |
| --- | ---: | ---: |
| Kotlin | **4.59 ns** | 1.00x |
| direct JVM Native TypeScript | **4.92 ns** | **1.07x** |
| JNI Native TypeScript | 264.14 ns | 57.58x |
| NativeScript | 2,110.18 ns | 459.99x |

The direct path is 53.70x faster than the current JNI route and 429.01x
faster than NativeScript. Its 0.33 ns median gap to Kotlin is below the
variation visible across these emulator samples, so the supported claim is
parity rather than a win. The structural result is stronger: the delivered
object stays in ART through its next Android call.

Raw evidence:

```text
/home/akisarou/.cache/nts-tmp/direct-callback-payload-five-round/results.json
sha256:c734438857b95cd6a8757cdb1fdab7ec24ffbb900f22a7186032b3d6ad23c096

/home/akisarou/.cache/nts-tmp/direct-callback-payload-five-round/
  native-typescript-jvm/bytecode-evidence.txt
sha256:d61eb53759a84f2f91768ce0a284d31f96f37202819e275bef47e60ae24dae13
```

The eight-kernel direct-JVM APK remains 20,688 bytes. It is still a kernel
hosted by a small Java Activity rather than a complete application backend,
so launch and memory comparisons continue to apply only to the three full
applications.

## Consequence

The callback boundary now has the same direct representation rule as an
ordinary object result: when producer, consumer, and lifetime all stay in one
ART frame, the Java reference is already the optimal carrier. The next
callback slice is captured handler state. It must first state whether a
closure environment should become a generated Java object, a program peer,
or another representation; this record does not infer that policy from the
fact that zero-capture handlers are cheap.
