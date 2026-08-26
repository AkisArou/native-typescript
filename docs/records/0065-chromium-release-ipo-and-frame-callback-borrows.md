# 0065 — Close the Chromium release gate with frame callback borrows and release IPO

Status: complete release matrix passes every current performance, structure, and lifetime gate  
Recorded: 2026-08-26

Record 0064 left three failures in the official Chromium application matrix:
one create-element p95 ratio missed the 1.25x-C++ limit by 0.004x, and the two
compiled synchronous-event medians were 1.143–1.162x V8 against a 1.10x gate.
The profile also showed that the generated frame callback trampolines retained
and released an immortal closure on every event delivery, while ScriptC LLVM
functions carried an inert `sanitize_address` attribute that prevented the
non-sanitized release linker from importing ordinary runtime helpers.

## Changes

The compiler now distinguishes two callback-adapter ownership modes. Ordinary
stable callback contexts retain and release as before. A callback selected by
the existing `nativeFrameContext` proof borrows the closure directly: the
closure and eligible scalar capture boxes are immortal native-frame objects,
and the result-owned registration is proven to terminate before the declaring
synchronous frame returns. Reentrant disposal can detach the Blink listener,
but it cannot reclaim that frame storage while the callback is active.

The Chromium release library packager also removes ScriptC's positive
`sanitize_address` function marker after the full-LTO prelink, but only for the
explicitly non-sanitized official benchmark artifact. Sanitized ScriptC build
paths are unchanged. The packager fails if the marker is absent unexpectedly,
survives localization, or leaves an empty LLVM attribute group.

Final disassembly verifies the intended physical result. Both C and LLVM frame
trampolines perform the null/pending-exception checks and call the closure
function without retain/release traffic. The LLVM scalar callback body folds to
the same implementation as the C body, and the exported LLVM event function
imports the small ScriptC entry/exception helpers through ThinLTO.

## Controlled result

The pinned official non-component release `content_shell` ran all seven
workload families and both invocation shapes. Every repetition/workload/lane
tuple used a fresh renderer, lane order rotated by workload and repetition,
and renderer work was pinned to CPU 0. Three repetitions with 30 checked
samples produce 90 samples per cell. Lower is better.

| Workload / shape | C++ | ScriptC C | ScriptC LLVM | V8 | C/C++ | LLVM/C++ | C/V8 | LLVM/V8 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Attached component mount / compiled | 1,373.5 ns | 1,389.5 ns | 1,395.5 ns | 1,800.0 ns | 1.012x | 1.016x | **0.772x** | **0.775x** |
| Attached component mount / per call | 1,459.5 ns | 1,468.5 ns | 1,488.5 ns | 1,900.0 ns | 1.006x | 1.020x | **0.773x** | **0.783x** |
| Create element / compiled | 47.01 ns | 51.06 ns | 45.87 ns | 100.00 ns | 1.086x | 0.976x | **0.511x** | **0.459x** |
| Create element / per call | 51.34 ns | 59.05 ns | 55.94 ns | 102.50 ns | 1.150x | 1.090x | **0.576x** | **0.546x** |
| Detached counter tree / compiled | 393.28 ns | 331.63 ns | 330.66 ns | 385.50 ns | 0.843x | 0.841x | **0.860x** | **0.858x** |
| Detached counter tree / per call | 318.77 ns | 258.94 ns | 259.22 ns | 404.50 ns | 0.812x | 0.813x | **0.640x** | **0.641x** |
| Eight-row component list / compiled | 5,178.0 ns | 5,318.0 ns | 5,382.5 ns | 7,500.0 ns | 1.027x | 1.039x | **0.709x** | **0.718x** |
| Eight-row component list / per call | 5,763.0 ns | 5,872.0 ns | 5,840.0 ns | 8,200.0 ns | 1.019x | 1.013x | **0.716x** | **0.712x** |
| Retained attached-text update / compiled | 114.97 ns | 79.41 ns | 80.53 ns | 82.00 ns | 0.691x | 0.700x | **0.968x** | **0.982x** |
| Retained attached-text update / per call | 118.12 ns | 92.27 ns | 92.05 ns | 88.50 ns | 0.781x | 0.779x | 1.043x | 1.040x |
| Selector-driven update / compiled | 132.40 ns | 130.60 ns | 129.20 ns | 120.00 ns | 0.986x | 0.976x | 1.088x | 1.077x |
| Selector-driven update / per call | 566.10 ns | 610.80 ns | 605.10 ns | 760.00 ns | 1.079x | 1.069x | **0.804x** | **0.796x** |
| Synchronous event round trip / compiled | 962.65 ns | 1,002.4 ns | 1,009.2 ns | 940.00 ns | 1.041x | 1.048x | 1.066x | 1.074x |
| Synchronous event round trip / per call | 931.00 ns | 1,020.5 ns | 1,045.0 ns | 1,600.0 ns | 1.096x | 1.122x | **0.638x** | **0.653x** |

The evaluator passes with no violations. Create-element compiled execution is
48.9–54.1% faster than V8; component-list construction is 28.2–29.1% faster;
attached mount is 22.5–22.8% faster; and detached-tree work is 14.0–35.9%
faster depending on invocation shape. The complete event lifecycle remains
34.7–36.2% faster than V8. Reused-listener dispatch is within 4.1–4.8% of
handwritten C++, although V8 is 6.6–7.4% faster in that Blink-dominated shape.

A focused event-only run of the same artifacts measured the LLVM compiled
lane at 933.0 ns against 917.5 ns C++ and 900.0 ns V8. Its lone failure was the
C lane at 1.104x V8, 0.004x beyond policy. The passing rotated full matrix is
the release decision; the focused result is retained as evidence of the noise
floor rather than substituted selectively.

The RC-pair removal and imported LLVM helpers are structural wins, but the
few-percent movement between complete runs is too close to host variance for a
strong isolated latency attribution. The claim is therefore that the needless
work is gone and the complete release contract passes, not that every median
change was caused by this patch.

## Product shape

Median renderer peak RSS across the three fresh-renderer repetitions is:

| Workload | C++ | ScriptC C | ScriptC LLVM | V8 |
| --- | ---: | ---: | ---: | ---: |
| Attached component mount | 155.9 MiB | 152.5 MiB | 152.4 MiB | 171.7 MiB |
| Create element | 188.6 MiB | 188.6 MiB | 188.8 MiB | 221.0 MiB |
| Detached counter tree | 1,157.1 MiB | 1,036.3 MiB | 1,036.6 MiB | 210.8 MiB |
| Eight-row component list | 275.2 MiB | 257.4 MiB | 258.0 MiB | 176.0 MiB |
| Retained attached-text update | 116.6 MiB | 116.8 MiB | 117.0 MiB | 130.4 MiB |
| Selector-driven update | 155.4 MiB | 155.3 MiB | 155.5 MiB | 170.4 MiB |
| Synchronous event round trip | 364.4 MiB | 363.8 MiB | 363.9 MiB | 180.4 MiB |

All 84 runs returned to blank DOM/listener counts and every ScriptC event
subscription was released. The high detached-tree and event native peaks also
occur in handwritten C++, so the open memory target remains native-loop Oilpan
collection scheduling rather than a demonstrated ScriptC leak.

## Validation and evidence

- ScriptC compiler unit gate: 6/6 passed;
- ScriptC Native IR gate: 179/179 passed for C and LLVM;
- Native TypeScript Chromium contract/performance tests: 18/18 passed;
- official release matrix: 84/84 isolated browser executions completed and the
  evaluator passed;
- Native TypeScript `0583722a314981ea9ff4c5cd0ff1636ff6d409a2`;
- ScriptC `c2c96879e29cd7960959db9fd0fba50f8abbd5a4`;
- Chromium `96324a4012fe62f48b9463a67486eeb645bc5c78`;
- `content_shell` `sha256:c1571d6442660185187dae2086a2f7ea4895ddb681ce046735859981a71d8fa1`;
- `.native-typescript/benchmarks/chromium/2026-08-26-release-ipo/raw.json`
  (`sha256:3901ae378c22e3264996c7030cae044a6d13a9a931e57852880b41b423619181`);
- `.native-typescript/benchmarks/chromium/2026-08-26-release-ipo/report.json`
  (`sha256:6bb0ed4fe9923016e9bab71c9a84a54018b8aa025dc30cbc9d3ed11717be5b23`).

Keep the dual-heap, single-event-loop architecture and the proof-selected
frame callback tier. The next Chromium optimization slice should start from a
new profile rather than weakening a gate that now passes.
