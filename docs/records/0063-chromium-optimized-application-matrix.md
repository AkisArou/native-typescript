# 0063 — Remeasure the Chromium application matrix after lifetime specialization

Status: optimized matrix recorded; lifetime acceptance passes; performance gate has eight remaining violations  
Recorded: 2026-08-26

Record 0058 established the first seven-family Chromium application matrix.
It passed every correctness, teardown, and product-shape check but failed 22
performance checks. Its largest gaps were the eight-row component list at
1.954–1.992x handwritten C++, attached component mount at 1.795–1.929x C++,
and per-call event lifecycle at 2.286–2.333x C++.

Records 0060–0062 then added process-lifetime identities for compiler-proven
string literals, a frame-owned event-registration tier, native-frame closure
and scalar-capture storage, and a single Oilpan listener representation for
that tier. This record remeasures the entire matrix with all of those changes
present. It reports their combined product effect; the focused event
before/after attribution remains in record 0062.

## Controlled result

The pinned official non-component release `content_shell` ran all seven
workload families and both measurement shapes. Each repetition/workload/lane
tuple used a fresh renderer, lane order rotated by workload and repetition, and
renderer work was pinned to CPU 0. Three repetitions with 30 checked samples
produce 90 samples per cell. Lower is better.

| Workload / shape | C++ | ScriptC C | ScriptC LLVM | V8 | C/C++ | LLVM/C++ | C/V8 | LLVM/V8 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Attached component mount / compiled | 1,372.0 ns | 1,443.0 ns | 1,443.5 ns | 1,800.0 ns | 1.052x | 1.052x | **0.802x** | **0.802x** |
| Attached component mount / per call | 1,495.0 ns | 1,518.0 ns | 1,521.0 ns | 1,950.0 ns | 1.015x | 1.017x | **0.778x** | **0.780x** |
| Create element / compiled | 45.77 ns | 43.27 ns | 44.10 ns | 103.00 ns | 0.945x | 0.963x | **0.420x** | **0.428x** |
| Create element / per call | 56.77 ns | 64.30 ns | 62.24 ns | 97.50 ns | 1.133x | 1.096x | **0.659x** | **0.638x** |
| Detached counter tree / compiled | 395.19 ns | 332.78 ns | 334.98 ns | 382.50 ns | 0.842x | 0.848x | **0.870x** | **0.876x** |
| Detached counter tree / per call | 312.62 ns | 255.77 ns | 260.06 ns | 395.50 ns | 0.818x | 0.832x | **0.647x** | **0.658x** |
| Eight-row component list / compiled | 5,058.0 ns | 5,463.5 ns | 5,432.0 ns | 6,750.0 ns | 1.080x | 1.074x | **0.809x** | **0.805x** |
| Eight-row component list / per call | 5,948.0 ns | 6,027.0 ns | 6,584.5 ns | 7,500.0 ns | 1.013x | 1.107x | **0.804x** | **0.878x** |
| Retained attached-text update / compiled | 115.59 ns | 128.14 ns | 128.81 ns | 81.00 ns | 1.109x | 1.114x | 1.582x | 1.590x |
| Retained attached-text update / per call | 118.59 ns | 131.60 ns | 132.80 ns | 90.00 ns | 1.110x | 1.120x | 1.462x | 1.476x |
| Selector-driven update / compiled | 130.10 ns | 135.00 ns | 134.40 ns | 120.00 ns | 1.038x | 1.033x | 1.125x | 1.120x |
| Selector-driven update / per call | 552.40 ns | 610.90 ns | 613.00 ns | 780.00 ns | 1.106x | 1.110x | **0.783x** | **0.786x** |
| Synchronous event round trip / compiled | 958.55 ns | 977.65 ns | 941.70 ns | 950.00 ns | 1.020x | 0.982x | 1.029x | **0.991x** |
| Synchronous event round trip / per call | 919.50 ns | 1,080.0 ns | 1,002.0 ns | 1,500.0 ns | 1.175x | 1.090x | **0.720x** | **0.668x** |

The strict evaluator now reports eight violations instead of 22. The two
create-element per-call p95 values exceed the primitive 1.25x-C++ tail gate.
Four retained attached-text medians and two compiled selector medians exceed
the individual 1.10x-V8 gate. No median exceeds the primitive C++ gate, both
boundary-heavy aggregate gates pass at 0.775–0.781x V8, and every structural
and lifetime gate passes.

## What changed materially

The component-list compiled medians fell from 11,440/11,660.5 ns to
5,463.5/5,432.0 ns, reducing the C++ ratio from 1.954–1.992x to
1.074–1.080x. Attached mount fell from 2,509/2,480 ns to 1,443/1,443.5 ns and
is now 1.052x C++. Those string-heavy results are consistent with eliminating
repeated literal decoding and atomization; they validate the chosen static
identity design at application scale.

Per-call event lifecycle is now 1.090–1.175x C++ and 0.668–0.720x V8 in the
full matrix. Its separate focused run measured 1.070–1.102x C++ and
0.655–0.675x V8. The difference is ordinary run-to-run variation rather than a
different artifact; both measurements show that the former 2.3x-C++ lifecycle
gap is gone.

The remaining retained-text failure needs careful framing. ScriptC is only
1.109–1.120x handwritten C++, while V8 reaches 81–90 ns and is faster than the
handwritten direct-Blink oracle. The next investigation must profile handle
resolution, string construction, and the exact Blink setter path; merely
optimizing general ScriptC code cannot assume that matching C++ will satisfy
this V8-relative gate.

## Product shape

Median renderer peak RSS across the three fresh-renderer repetitions is:

| Workload | C++ | ScriptC C | ScriptC LLVM | V8 |
| --- | ---: | ---: | ---: | ---: |
| Attached component mount | 159.3 MiB | 155.1 MiB | 155.1 MiB | 173.9 MiB |
| Create element | 190.9 MiB | 191.8 MiB | 191.0 MiB | 205.2 MiB |
| Detached counter tree | 1,158.4 MiB | 1,038.9 MiB | 1,038.9 MiB | 208.6 MiB |
| Eight-row component list | 277.3 MiB | 260.8 MiB | 259.9 MiB | 202.7 MiB |
| Retained attached-text update | 119.5 MiB | 119.5 MiB | 119.6 MiB | 133.7 MiB |
| Selector-driven update | 157.9 MiB | 158.4 MiB | 157.9 MiB | 176.2 MiB |
| Synchronous event round trip | 366.6 MiB | 366.4 MiB | 366.5 MiB | 180.5 MiB |

The component-list ScriptC peaks fell by roughly 122 MiB from record 0058 and
are now below handwritten C++. The remaining large native peaks occur in the
handwritten lane too, so they continue to identify Oilpan scheduling during
long native loops rather than a ScriptC-only leak. All 84 runs return to blank
DOM/listener counts and every ScriptC event subscription is released.

## Evidence and decision

The measured artifacts record Native TypeScript
`0c0d74d62b0b9e188b8fe5406a19fea609ab2892`, ScriptC
`da877549864deb920aa3bed37c3b957e1710e839`, Chromium
`96324a4012fe62f48b9463a67486eeb645bc5c78`, and the exact browser, archive,
fixture, Clang, GN, workload-budget, affinity, and lane-scheduling provenance.

- `.native-typescript/benchmarks/chromium/2026-08-26-application-matrix-after-frame-events/raw.json` (`sha256:e96258d51b5ffa0e842c003c9aff737f1f33a356be2720cb35bc5636063b43e7`);
- `.native-typescript/benchmarks/chromium/2026-08-26-application-matrix-after-frame-events/report.json` (`sha256:7c3aa251eb39ec907939e2f79af10be0aa46bbe3f3462673033eae85eab36e76`).

Keep the direct-Blink, static-identity, and lifetime-specialization
architecture. Use retained attached-text mutation as the next profiling
target, with selector update as a secondary confirmation case. Do not weaken
the C++ gate or reinterpret the remaining V8-relative failures as correctness
failures.
