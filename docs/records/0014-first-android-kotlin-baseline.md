# 0014 — The first Android/Kotlin performance baseline

Status: observed baseline; no timing threshold is a correctness gate  
Recorded: 2026-08-22

[The performance program](../performance.md) requires application-level ART
measurements against equivalent direct Android Kotlin before a runtime
optimization becomes a priority. This record captures the first such
measurement and, more importantly, the decisions it does and does not admit.
The reusable harness lives in [Android performance comparison](../../benchmarks/android/README.md).

## Instrument

The harness builds two signed, installable applications from readable source:

- Native TypeScript through the normal JVM target and generated adapters;
- Kotlin 2.3.10 directly against `android.jar`, with no benchmark framework or
  application support library in either package.

Both applications execute the same constants and checksums. The runner
refuses to proceed if their declared workloads drift, requests ART's `speed`
compilation filter for both packages, alternates their order each round, and
records every raw timing. Workload loops use
`SystemClock.elapsedRealtimeNanos()` on the device. Process launch is measured
separately with `am start -W`; memory is sampled with `dumpsys meminfo` after
the warm foreground launch.

The benchmark is deliberately separate from acceptance. A wrong checksum,
missing sample, failed install, or unparsable measurement fails the run. A
slow sample does not fail the build.

## Environment

The first run used five alternating process rounds on the Pixel 10 Pro
x86-64 AVD:

```text
device:       sdk_gphone16k_x86_64
Android:      API 37 / Android 17 emulator image
ABI:          x86_64
NTS target:   Android API 35, NDK clang 18.0.2
Kotlin:       kotlinc-jvm 2.3.10
ART filter:   speed for both packages
parent:       70edc275816354c4c5a3737456ac1c115d6ab1e4
ScriptC:      485b9dedd3eb4884881ce0d6707de4c487b9c4b0
```

The APKs measured in that run were:

| Application | Bytes | SHA-256 |
| --- | ---: | --- |
| Native TypeScript | 569,627 | `95f60385aa75bf420f3e711714a41de5cce9896ea860cc62e72acbe04252c19c` |
| Kotlin | 16,592 | `a1133b80814ef60509f5a000d5143f251481cca3aa37b40624c633eced376136` |

The Native TypeScript package includes its native runtime and generated
binding mechanics; the Kotlin package contains only its application classes.
The size difference is recorded rather than attributed to one component.

## Observations

The repeated operation workloads warm up three samples and retain seven
samples in each of five process rounds. Values below are medians across the 35
retained samples, except `view-tree`, which has one observation per process.

| Workload | Native TypeScript | Kotlin | NTS / Kotlin |
| --- | ---: | ---: | ---: |
| 128-child view tree | 105,976 ns/child | 22,576 ns/child | 4.69x |
| lightweight `Rect` construction and `width()` | 318.82 ns/op | 23.99 ns/op | 13.29x |
| `TextView` construction and scalar call | 23,557 ns/op | 21,773 ns/op | 1.08x |
| repeated `TextView.setTextSize` | 141.34 ns/op | 14.08 ns/op | 10.04x |
| synchronous `Button.callOnClick` | 296.82 ns/op | 2.28 ns/op | 130.13x |

The callback ratio is large because Kotlin's warm same-process callback is
extremely small. The Native TypeScript median is still below 0.3 microseconds
per delivery. That makes it a visible boundary cost, not evidence that normal
human-frequency click handling should displace object-resource work.

Launch observations were:

| Launch shape | Native TypeScript median | Kotlin median |
| --- | ---: | ---: |
| force-stopped process, warm filesystem cache | 632 ms | 645 ms |
| existing task returned from Home | 583 ms | 283 ms |

Process-start samples ranged from 314–1,765 ms for Native TypeScript and
316–936 ms for Kotlin. Warm-foreground measurements include Android task and
animation behavior and were similarly noisy. This run supports no launch
superiority claim in either direction and is not a first-visible-frame
instrument.

The five post-launch memory snapshots had these medians:

| Application | Total PSS | Total RSS |
| --- | ---: | ---: |
| Native TypeScript | 16,487 KiB | 142,372 KiB |
| Kotlin | 15,996 KiB | 140,876 KiB |

The observed median difference was 491 KiB PSS and 1,496 KiB RSS. These are
settled snapshots, not peak allocation, native-handle attribution, or terminal
teardown measurements.

## What this admits

The lightweight `Rect` case isolates a cheap Java object whose current Native
TypeScript path promotes the returned local reference, allocates a managed
handle cell, and later disposes both. Its 13.29x ratio on ART agrees with the
desktop mechanism falsifier: frame-bounded object results are the first
performance implementation to build.

The `TextView` case supplies the necessary counterweight. At 1.08x, real
widget construction is dominated by platform work, so the resource-domain
slice must be judged again in the view-tree application after it lands. A
large improvement in the synthetic object kernel cannot be reported as an
equally large UI improvement.

Setter and callback crossings are measurable candidates for later work. Their
absolute medians are currently 0.14 and 0.30 microseconds. They do not yet
admit `JNIEnv *` propagation, callback-token redesign, or call fusion ahead of
local/stable resource specialization. After promotion overhead is removed,
the same unchanged workloads can determine whether those costs become the
next material limit.

The view-tree result is application-relevant but has only five high-variance
samples: Native TypeScript ranged from 48,797 to 306,931 ns per child. It is a
baseline to improve and rerun on hardware, not a stable 4.69x product claim.

## Next measurement slice

The first resource specialization should add deterministic counters for:

```text
NewGlobalRef / DeleteGlobalRef
DeleteLocalRef
managed native-handle cell allocation
```

The `light-object`, `constructor`, and `view-tree` source and checksums then
remain unchanged. The optimized run must prove structurally that a
non-escaping result performs no global promotion and allocates no managed
handle cell, while an escaping control arm still promotes exactly once. The
same device harness records whether that mechanism changes real UI work.

Before using launch or lifecycle results to admit work, extend the harness
with first-visible-frame, rotation/terminal teardown, peak reference/allocation
counters, and idle CPU/wakeup instruments. Those claims cannot be recovered
from the current `am start -W` and settled-memory observations.
