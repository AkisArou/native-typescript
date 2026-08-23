# 0027 — Keep JVM reference values in ART

Status: experimental direct-JVM slice implemented and measured  
Recorded: 2026-08-23

[Record 0026](0026-proved-jvm-integer-locals.md) brought three direct-JVM
kernels to Kotlin-shaped numeric bytecode. The next two measured costs were
not arithmetic problems. A Java `String` result crossed JNI into a second
language representation, and a nullable Java object result crossed into a
managed handle cell plus a tagged nullable-union box before an immediate
receiver call.

## Decision

The JVM backend uses the JVM's own reference representation when it is exact:

- a ScriptC `string` is `java.lang.String`; `string.length` emits
  `String.length()`, whose UTF-16 code-unit contract matches JavaScript;
- an exact two-arm `T | null`, where `T` is one concrete native handle, is one
  nullable Java reference of that concrete class;
- wrapping the handle arm and checker-proved narrowing are representation
  identities, while wrapping the null arm emits Java `null` and a tag test is
  an ordinary null comparison;
- a frame-bounded native result of that nullable shape needs no local/global
  JNI policy in this backend because ART's GC already owns the reference.

No other union is projected this way. The emitter validates the union table,
the handle and null tags, the nominal handle type, and the exact JVM result
descriptor. Every wider or differently shaped union retains the precise JVM
backend refusal.

The reached loops exposed two adjacent, general fact omissions. String
intrinsics are pure and therefore must not erase immutable-global or induction
facts. A string length is a whole, non-negative safe integer, though not
necessarily signed-int32. The shared number analysis now records that fact.
It also publishes immutable literal module globals already proved signed-int32,
allowing the JVM emitter to store bounds and masks as Java `int`. Mutable,
multiply-written, fractional, overflowing, NaN, infinity, or possible `-0`
globals remain `double`.

## Disagreeing proof

The compiler observer first failed on `strIntrinsic`. The executable JVM
observer then failed independently on `unionWrap` for this source shape:

```ts
const candidate: Widget | null = present ? widget : null;
if (candidate === null) return -1;
return candidate.depth();
```

After lowering, the JVM harness executes both nullable arms and checks a
surrogate-pair/ZWJ string whose JavaScript and Java UTF-16 length is five. The
Android benchmark preserves the existing `string-result` and `handle-result`
loops and checksums without a JVM-only simplification.

The accepted `javap` evidence contains these chains:

```text
Rect.flattenToString:()Ljava/lang/String;
String.length:()I

LinearLayout.getChildAt:(I)Landroid/view/View;
ifnull
View.getId:()I
```

It contains no native entry and no invocation of `ntsToInt32` or `ntsToBool`
inside a benchmark kernel. The helper definitions remain in the generated
class for unproved programs; absence of an invocation, rather than absence of
the generic helper, is the structural gate.

## On-device measurement

All four APKs ran for five cyclically ordered process rounds on the Pixel 10
Pro x86-64 API 37 AVD after ART `speed` compilation. Every row has 35 accepted
samples with identical inputs, warmups, iteration counts, and checksums. Lower
is better.

| Workload | Direct JVM | Kotlin | NTS/JNI | NativeScript | Direct/Kotlin | Direct/JNI |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| lightweight object | 26.38 ns | 22.55 ns | 163.61 ns | 3,179.45 ns | 1.17x | 0.161x |
| stable setter | 32.85 ns | 17.91 ns | 87.18 ns | 269.89 ns | 1.83x | 0.377x |
| ASCII/Unicode arguments | **35.89 ns** | 36.77 ns | 569.94 ns | 1,356.34 ns | **0.98x** | **0.063x** |
| fresh Java string result | **222.40 ns** | 221.46 ns | 531.90 ns | 692.59 ns | **1.00x** | **0.418x** |
| nullable handle result | **2.22 ns** | 3.97 ns | 181.57 ns | 659.24 ns | **0.56x** | **0.012x** |

The string-result kernel reached Kotlin parity and is 2.39x faster than the
current JNI route. The handle-result kernel is 81.85x faster than JNI and
297.15x faster than NativeScript. Its 0.56x Kotlin ratio is a whole-kernel ART
outcome: both programs perform the same lookup, null check, and receiver call,
but their containing method shapes differ. It is not a claim that TypeScript
changes the irreducible cost of `ViewGroup.getChildAt`.

The first two direct rows moved materially from record 0026 on this emulator
run. That variance is why each record keeps its matched Kotlin ratios and raw
evidence rather than combining medians from different runs. The new claims
depend on the two newly admitted rows, whose shapes are directly proved by
bytecode.

Raw evidence:

```text
/home/akisarou/.cache/nts-tmp/android-direct-reference-five-round/results.json
sha256:b959cd9c4d3a9b29f6271718157bf5b6fd3ced54349f3bd02179013adf3e18b3

/home/akisarou/.cache/nts-tmp/android-direct-reference-five-round/
  native-typescript-jvm/bytecode-evidence.txt
sha256:7bfb409c3d2facafb951336932c439db46b1012cdf3b03bb3020ad8c017a7146
```

The direct-JVM APK is 16,592 bytes. It remains a five-kernel experimental
artifact, not a complete application backend, so launch and memory comparisons
still apply only to the three full applications.

## Consequence

The two JNI hotspots were representation costs, not unavoidable TypeScript
costs. When the target VM already owns the exact language representation, the
fast and simpler lowering is to keep the value resident there. This evidence
supports extending the direct backend by reached semantic families rather than
building compensating JNI machinery for code intended to execute on ART.

The next reference-valued slice should be chosen by an unchanged workload. A
primitive-array/direct-buffer case or a same-thread callback/token case are
the strongest remaining candidates; both require new IR forms and must retain
the same bytecode-plus-device admission rule.
