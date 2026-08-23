# 0017 — An Android hotspot matrix before the next optimization

Status: implemented and measured; timings remain observations, not test gates  
Recorded: 2026-08-23

[Record 0016](0016-frame-bounded-native-results.md) left one cheap-object
kernel, one widget constructor, one scalar setter, one callback, and one view
tree as the evidence for choosing the next optimization. That was enough to
prove the first frame-bounded reference result, but not enough to distinguish
string conversion, primitive-array copying, returned object handles, callback
payloads, and real dynamic UI work. Optimizing from that five-case view risked
making the easiest visible kernel faster while missing the application-facing
cost.

This record freezes the expanded matrix and its first device observation.

## Selection rule

The benchmark now separates three layers:

```text
boundary microcase -> identifies one crossing/resource family
Android operation  -> combines that family with one real framework operation
app composite      -> asks whether the costs remain visible in a small screen
```

This split follows Android's own
[Microbenchmark guidance](https://developer.android.com/topic/performance/benchmarking/microbenchmark-overview):
benchmark hot work that repeats often, include conversion/processing paths,
vary inputs enough not to observe only one cached value, and profile before
choosing the target. The runner already follows Android's
[measurement guidance](https://developer.android.com/topic/performance/measuring-performance)
by comparing the same applications on one device, rotating order, and asking
ART to compile each package with the `speed` filter.

The string cases are separate because the
[JNI string contract](https://developer.android.com/ndk/guides/jni-tips) has
UTF-16 and modified-UTF-8 mechanics that a scalar call does not. The byte-array
case uses an actual Java primitive array in NativeScript, created through
`Array.create` as required by its
[Android marshalling contract](https://docs.nativescript.org/guide/android-marshalling),
instead of passing a JavaScript array and accidentally timing a different API.

## Declared workloads

`native-project.ts` is now the single machine-readable scenario catalog. The
runner serializes the layer, hotspot, operation unit, iteration count, sample
count, and expected checksum into schema version 3 of every report. It derives
execution and summaries from that catalog, while source-literal checks still
prevent the Native TypeScript, Kotlin, and NativeScript implementations from
drifting.

| Layer | Scenario | Disagreeing operation |
| --- | --- | --- |
| Android | `view-tree` | 128 real widgets and hierarchy edges |
| Boundary | `light-object` | exact non-null object result that does not escape |
| Android | `constructor` | real widget result followed by a scalar argument |
| Boundary | `setter` | primitive argument on one stable receiver |
| Boundary | `callback` | same-owner synchronous delivery without payload use |
| Boundary | `string-argument` | alternating equal ASCII and Unicode `CharSequence` pairs |
| Boundary | `string-result` | a fresh Java `String` from `Rect.flattenToString()` |
| Boundary | `byte-array` | 256 bytes into and a fresh encoded byte array out of Android |
| Boundary | `handle-result` | nullable `getChildAt()` result, null check, then immediate `getId()` |
| Boundary | `callback-payload` | delivered `View` payload immediately reused for `getId()` |
| Android | `text-update` | changing counter formatting plus `TextView.setText()` |
| Composite | `screen-build` | nested rows, labels, buttons, two dynamic strings, scalar setters, and hierarchy edges |

The input shapes are controls, not decoration. `string-argument` alternates
ASCII with Greek, emoji, a zero-width joiner, and a combining mark. The Kotlin
control constructs separate equal strings so `TextUtils.equals` cannot answer
only through reference equality. `handle-result` reuses one 16-child container
for 32,000 deliveries, so setup is outside the timed loop and every iteration
must project and consume the returned receiver. `callback` and
`callback-payload` differ only in whether the delivered object is consumed.

Every repeated case warms three times and emits seven measured samples in a
fresh process. The five-round observation therefore has 35 values per repeated
implementation and five for `view-tree`. Exact checksums made all 36
implementation/scenario combinations pass before a timing was accepted.

## First five-round observation

The run used the same Pixel 10 Pro x86-64 AVD at API 37 and ART `speed`
compilation as the preceding records. The benchmark was built from parent
`b103b04f` and ScriptC `c6de252b`; all benchmark edits were uncommitted and the
report recorded their three SHA-256 source digests.

```text
Native TypeScript source: 685b1c63b00ab2ab3ee9193b7ae46f3fcd3cb0fe2bbc8d8e975c5c80ef6c95d0
Kotlin source:            6df4098db7b7c3051a35e9f2694daa609b63c9317ea7615a70167edb2b866ea5
NativeScript source:      a5dee8af2ec70c266a05d9fa38cc2f8714bf68e6f27af752359f7032444550cd
Kotlin:                   kotlinc-jvm 2.3.10
NativeScript CLI/runtime: 9.0.7 / 9.0.5
NDK clang:                18.0.2
```

Medians, lower being better:

| Scenario | Native TypeScript | Kotlin | NativeScript | NTS / Kotlin | NTS / NativeScript |
| --- | ---: | ---: | ---: | ---: | ---: |
| `view-tree` | 65,158 ns/child | 35,563 ns/child | 38,312 ns/child | 1.83x | 1.70x |
| `light-object` | 223.32 ns/op | 24.20 ns/op | 3,469.82 ns/op | 9.23x | 0.064x |
| `constructor` | 23,627 ns/op | 22,263 ns/op | 29,137 ns/op | 1.06x | 0.81x |
| `setter` | 86.90 ns/op | 13.67 ns/op | 225.66 ns/op | 6.36x | 0.39x |
| `callback` | 303.10 ns/delivery | 1.91 ns/delivery | 1,500.75 ns/delivery | 158.92x | 0.20x |
| `string-argument` | 497.21 ns/comparison | 29.77 ns/comparison | 1,027.01 ns/comparison | 16.70x | 0.48x |
| `string-result` | 516.17 ns/result | 182.14 ns/result | 496.26 ns/result | 2.83x | 1.04x |
| `byte-array` | 1,423.68 ns/encoding | 753.10 ns/encoding | 6,585.08 ns/encoding | 1.89x | 0.22x |
| `handle-result` | 366.31 ns/lookup | 2.82 ns/lookup | 509.41 ns/lookup | 129.78x | 0.72x |
| `callback-payload` | 378.83 ns/delivery | 3.19 ns/delivery | 1,713.54 ns/delivery | 118.59x | 0.22x |
| `text-update` | 457.82 ns/update | 297.50 ns/update | 1,108.54 ns/update | 1.54x | 0.41x |
| `screen-build` | 91,002 ns/row | 97,839 ns/row | 118,677 ns/row | 0.93x | 0.77x |

The APKs were 602,395 bytes for Native TypeScript, 20,688 bytes for the narrow
Kotlin control, and 28,639,616 bytes for NativeScript. Median settled PSS was
19,046, 19,218, and 75,343 KiB respectively; median RSS was 143,316, 142,216,
and 201,712 KiB. Median `am start -W` completion after force-stop was 371, 351,
and 482 ms; warm foreground completion was 41, 37, and 41 ms.

These are emulator observations. `view-tree` has only five high-variance
values, and `screen-build` still has framework and allocation noise despite 35
samples. Neither licenses a platform ranking. The structural shape and the
repeatable microcases are the mechanism probes; the Android/composite cases
show whether their scale survives real framework work.

## What the matrix changes

The next target is no longer chosen from one cheap-object loop:

- Widget construction remains close to Kotlin, and the composite screen-build
  median is also at parity in this observation. Broad constructor work is not
  the first problem.
- The nullable object-result path is the clearest unoptimized resource seam:
  `getChildAt()` followed immediately by `getId()` costs 366 ns in Native
  TypeScript versus 2.82 ns in Kotlin. The existing frame-bounded proof admits
  only exact non-null results, so this disagreeing case specifically observes
  what it cannot select.
- Callback payload consumption adds an object projection and nested receiver
  call above the payload-free callback. Both remain sub-microsecond in Native
  TypeScript, but the separate cases can now prove whether a token or payload
  resource change affects dispatch, payload handling, or both.
- Two outbound strings cost about 497 ns per `TextUtils.equals` call, while a
  real changing `TextView` update is 458 ns total and only 1.54x Kotlin in this
  run. String work matters, but a language/runtime representation change must
  beat the already bounded real-widget case rather than only a synthetic ratio.
- The 256-byte array round trip is 1.89x Kotlin and 4.63x faster than
  NativeScript. It is measurable, but Android's Base64 work intentionally
  prevents the result from being mislabelled as pure marshalling overhead.
- A Java string result is already at NativeScript parity. That does not make it
  free; it makes it a weaker first target than returned object handles.

`JNIEnv *` acquisition counters are still required before capability
propagation. The matrix strengthens that falsifier: the setter, both string
directions, arrays, object results, and both callback cases would all expose a
claimed general boundary improvement, while the constructor and composite
cases would say whether it matters to an Android application.

That counter was subsequently expanded to compare lookup, scoped TLS, and an
explicit operand. The smaller target-owned scope matched the explicit
operand's host lower bound and improved the targeted ART cases by 12.8–34.1%.
[Record 0019](0019-scoped-jni-environment-capability.md) records why this
evidence admits the narrow carrier without admitting a compiler-wide context
ABI.

The matrix intentionally stops here. Async/foreign-thread callbacks,
first-frame rendering, touch latency, lifecycle teardown, databases,
networking, image buffers, and layout/draw work need their own instruments;
adding them as more synchronous loops would produce reassuring numbers about
the wrong operation.
