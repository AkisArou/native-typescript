# 0015 — The first Android/NativeScript performance baseline

Status: observed baseline; no timing threshold is a correctness gate  
Recorded: 2026-08-22

[Record 0014](0014-first-android-kotlin-baseline.md) established the first
direct-Android Kotlin comparison. This record adds a third implementation:
plain NativeScript TypeScript using raw Android APIs, without React, XML UI,
or a NativeScript widget tree in the measured workload. The reusable
instrument is documented in
[Android performance comparison](../../benchmarks/android/README.md).

## Instrument

All three release applications execute the same constants, Android objects,
method calls, sample counts, and checksums:

- Native TypeScript through the normal JVM target and generated adapters;
- Kotlin 2.3.10 compiled directly against `android.jar`;
- NativeScript 9.0.7 with Android runtime 9.0.5 and core 9.0.20.

The NativeScript program uses one `Placeholder` only to hand a raw Android
root view to the stock application bootstrap. Every timed constructor,
setter, callback, and view-tree operation is a direct `android.*` call. Its
CLI, runtime, core, declarations, webpack 5.0.38, TypeScript 5.7.3, and the
two build tools required by pnpm's strict dependency layout are pinned in the
workspace's named `nativescript` catalog. The release APK contains only the
x86-64 runtime.

The runner asks ART to compile all packages with the `speed` filter, rotates
their order every round, and preserves every raw result. Repeated kernels use
three warmups followed by seven retained samples in each fresh process.
After a workload logs completion, the runner waits briefly and proves that
the process remains alive.

That last assertion was required by falsification. The first NativeScript
manifest used a platform Material theme for its `AppCompatActivity`. The
workload logged before `setContentView`, then `onCreate` crashed because the
theme was incompatible. A timing-only observer would have accepted every
sample. The fixed fixture uses NativeScript's generated `AppTheme`; the
permanent process check includes Android's crash buffer on failure.

## Environment

The accepted run used five cyclically ordered process rounds on the Pixel 10
Pro x86-64 AVD:

```text
device:               sdk_gphone16k_x86_64
Android:              API 37 / Android 17 emulator image
ABI under test:       x86_64
NTS/NativeScript API: Android API 35
NDK clang:            18.0.2
Kotlin:               kotlinc-jvm 2.3.10
NativeScript CLI:     9.0.7
NativeScript Android: 9.0.5
ART filter:           speed for all three packages
parent:               70edc275816354c4c5a3737456ac1c115d6ab1e4
ScriptC:              485b9dedd3eb4884881ce0d6707de4c487b9c4b0
```

The working tree contained the benchmark and performance-document work being
measured; the report records that complete dirty-state inventory and hashes
all three application sources. The measured APKs were:

| Application | Bytes | SHA-256 |
| --- | ---: | --- |
| Native TypeScript | 569,627 | `5dedf36a50b95c87f67f2ec94f9415d1adb0c88f8bd8b0fcfc19e9b832603594` |
| Kotlin | 16,592 | `63b95b2e558a0fc8fde4dfbd7f962940144b13449589b94c51deb908704fdc2f` |
| NativeScript | 28,638,400 | `0f4bb0654f5975a6b048a5d9112e54b5410433a9d0092ae0d9600df715973789` |

The Kotlin artifact is deliberately a bare application. Native TypeScript
includes its compiled runtime and reached binding mechanics. NativeScript
includes V8, its Android runtime, application classes, metadata, and the
minimized JavaScript bundle. The sizes describe these product shapes; they do
not attribute every byte to application code.

## Observations

The four repeated workloads contain 35 retained samples per implementation.
`view-tree` contains one sample per process, for five total:

| Workload | Native TypeScript | Kotlin | NativeScript | NTS / Kotlin | NativeScript / Kotlin | NTS / NativeScript |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 128-child view tree | 29,780 ns/child | 43,953 ns/child | 37,753 ns/child | 0.68x | 0.86x | 0.79x |
| lightweight `Rect` construction and `width()` | 340.81 ns/op | 30.27 ns/op | 3,398.83 ns/op | 11.26x | 112.28x | 0.10x |
| `TextView` construction and scalar call | 23,278 ns/op | 22,345 ns/op | 27,841 ns/op | 1.04x | 1.25x | 0.84x |
| repeated `TextView.setTextSize` | 88.62 ns/op | 13.23 ns/op | 227.07 ns/op | 6.70x | 17.16x | 0.39x |
| synchronous `Button.callOnClick` | 272.52 ns/op | 2.15 ns/op | 1,337.37 ns/op | 126.63x | 621.41x | 0.20x |

Native TypeScript was approximately 10.0x faster than NativeScript in the
light-object kernel, 2.6x faster in the setter kernel, 4.9x faster in callback
delivery, and 1.2x faster in widget construction. The callback ratios against
Kotlin are visually large because Kotlin's direct warm callback is about two
nanoseconds; Native TypeScript's absolute median remains 0.273 microseconds.

The view-tree result favors Native TypeScript in this observation, but five
emulator samples do not establish product-level superiority. Kotlin ranged
from 30,448 to 170,708 ns per child, while Native TypeScript ranged from
28,207 to 58,409. It must be repeated on hardware before it supports a UI
claim.

Current ART omits `TotalTime` for the stock `NativeScriptActivity` and labels
its launch state `UNKNOWN`. The shared launch summary therefore uses
`am start -W`'s `WaitTime` for every implementation and retains all raw
fields:

| Launch shape | Native TypeScript | Kotlin | NativeScript |
| --- | ---: | ---: | ---: |
| force-stopped process, warm filesystem cache | 337 ms | 375 ms | 494 ms |
| existing task returned from Home | 45 ms | 47 ms | 21 ms |

These are command-completion observations, not first-visible-frame timing.
Their ranges remain broad, especially the first process launch, so they admit
no launch ranking.

Post-warm-foreground memory snapshots were:

| Application | Total PSS | Total RSS |
| --- | ---: | ---: |
| Native TypeScript | 17,876 KiB | 142,428 KiB |
| Kotlin | 17,560 KiB | 141,568 KiB |
| NativeScript | 73,795 KiB | 202,708 KiB |

Native TypeScript was 316 KiB above Kotlin in median PSS and 860 KiB in RSS.
NativeScript was 56,235 KiB above Kotlin in PSS and 61,140 KiB in RSS. These
are settled emulator snapshots, not peak allocation or a component-level
runtime attribution.

## What this admits

The three-way result validates the current architectural direction. Static,
typed adapters and compiled TypeScript materially outperform a mature dynamic
TypeScript bridge in every isolated boundary kernel, without requiring a
renderer or framework workload to demonstrate the difference.

It does not remove the first optimization target. Native TypeScript is still
11.26x Kotlin in the lightweight-object kernel while being about 10x faster
than NativeScript. This is exactly the shape expected from a static bridge
that still pays unnecessary `NewGlobalRef`, managed-handle allocation, and
later release for a proven non-escaping result. Frame-bounded object results
remain the first implementation slice.

Widget construction is already within 4% of Kotlin at the median. Therefore
the resource specialization must be reported structurally and remeasured in
`light-object`, `constructor`, and `view-tree`; the synthetic improvement must
not be projected onto UI construction without evidence.

Setter and callback costs remain later candidates, not reasons to reorder the
program. Native TypeScript already has a substantial advantage over
NativeScript there, and their absolute medians are below 0.1 and 0.3
microseconds respectively. The unchanged kernels can choose the next target
after local/stable specialization lands.

## Next measurement slice

Keep all three application sources and checksums unchanged while adding exact
counters for:

```text
NewGlobalRef / DeleteGlobalRef
DeleteLocalRef
managed native-handle cell allocation
```

The optimized `light-object` arm must show no global promotion and no managed
cell for a non-escaping result; an escaping control arm must still promote
exactly once. Then rerun this same three-way device instrument. Kotlin and
NativeScript are baselines, not timing gates: semantic equivalence and exact
resource counts decide correctness.
