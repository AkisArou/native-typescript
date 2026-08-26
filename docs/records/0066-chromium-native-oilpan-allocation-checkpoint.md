# 0066 — Bound native Oilpan allocation growth with a renderer checkpoint

Status: focused detached-tree memory target closed; performance gate passes  
Recorded: 2026-08-26

Record 0065 showed a renderer-memory failure that was independent of ScriptC's
heap: the detached counter-tree workload peaked at 1,157.1 MiB in handwritten
C++, 1,036.3 MiB in ScriptC C, and 1,036.6 MiB in ScriptC LLVM, while the V8
lane peaked at 210.8 MiB. All lanes returned to the expected blank DOM and the
ScriptC lanes released every native handle, so the evidence pointed at Oilpan
collection scheduling during a long synchronous native turn rather than a
ScriptC leak.

## Architecture

The renderer now counts successful generated WebIDL operations marked
`[NewObject]`. The hot path is a decrement and branch in `NtsWebRealm`; after
65,536 reached allocations it requests one ordinary unified V8/Oilpan
collection. Failed capsules do not consume allocation credit, realm
invalidation resets the budget, and a checkpoint rejected because collection
is temporarily disallowed is retried after the next successful allocation.

The V8 dependency has one narrow, pinned embedding seam:

```text
v8::CollectGarbageAtNativeAllocationCheckpoint(
    isolate,
    cppgc::EmbedderStackState::kMayContainHeapPointers)
```

V8 owns the `IsGCAllowed()` decision, installs an explicit embedder-stack-state
scope, and performs an ordinary full unified collection. The active native
stack may contain raw Blink pointers inside a synchronous capsule, so the
checkpoint conservatively reports that stack state. This is deliberately not
`LowMemoryNotification`, memory-pressure simulation, a second event loop, or a
V8 WebIDL membrane.

The API lives in a dedicated `v8-native-heap-checkpoint.h` header so future
changes do not invalidate the broad V8 public-header graph. Chromium and its
nested V8 dependency are pinned and verified independently. The no-V8 bridge
gate continues to reject V8 value carriers and permits only `v8::Isolate` plus
this checkpoint function in the realm implementation.

## Controlled result

The pinned official non-component release `content_shell` ran only the
detached counter-tree family. Each lane used a fresh renderer pinned to CPU 0,
lane order rotated by repetition, and every result was checked. Three
repetitions with 30 samples produced 90 samples per cell. Lower is better.

| Shape | C++ | ScriptC C | ScriptC LLVM | V8 | C/C++ | LLVM/C++ | C/V8 | LLVM/V8 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Compiled loop | 332.63 ns | 255.76 ns | 261.21 ns | 415.50 ns | 0.769x | 0.785x | **0.616x** | **0.629x** |
| Per call | 348.09 ns | 268.96 ns | 268.81 ns | 432.00 ns | 0.773x | 0.772x | **0.623x** | **0.622x** |

The evaluator passes with no violations. The compiled ScriptC lanes are
21.5–23.1% faster than handwritten C++ and 37.1–38.4% faster than V8 in this
focused run; the per-call lanes are 22.7–22.8% faster than C++ and about 37.8%
faster than V8. Variation from record 0065 is too large to assign those latency
changes to the rare checkpoint itself. The defensible conclusion is that the
checkpoint introduces no measured regression while the native lanes retain a
clear advantage.

## Product shape

Median renderer memory across the three fresh-renderer repetitions is:

| Lane | Baseline RSS | Post-workload RSS | Peak RSS | Peak change from record 0065 |
| --- | ---: | ---: | ---: | ---: |
| C++ | 113.9 MiB | 121.4 MiB | 133.3 MiB | −88.5% |
| ScriptC C | 114.0 MiB | 124.5 MiB | 136.1 MiB | −86.9% |
| ScriptC LLVM | 115.0 MiB | 125.5 MiB | 137.3 MiB | −86.8% |
| V8 | 113.9 MiB | 136.4 MiB | 208.2 MiB | −1.2% |

The three native peaks are now within 4.1 MiB of one another and 70.9–74.9 MiB
below V8. Peak native RSS fell by roughly 900–1,024 MiB while the V8 control
was effectively unchanged. Every run again ended with one blank document, ten
fixture nodes, and zero JavaScript event listeners. This closes the detached
native-loop Oilpan scheduling target without moving ScriptC objects into
Oilpan or charging every DOM operation for a collection check.

## Validation and evidence

- TypeScript project build passed;
- deterministic WebIDL capsule generation passed;
- no-V8-value bridge gate passed;
- exact Chromium and nested V8 patch verification passed for product and all
  profiles;
- focused Chromium contract/performance tests: 26/26 passed;
- release `content_shell` rebuild: 1,329/1,329 remaining actions completed;
- official focused benchmark: 12/12 isolated browser executions completed and
  the evaluator passed;
- Native TypeScript `fcd35fb037ed67a5e946f042c4db1f0ff7575298`;
- ScriptC `c2c96879e29cd7960959db9fd0fba50f8abbd5a4`;
- Chromium `96324a4012fe62f48b9463a67486eeb645bc5c78`;
- V8 `d127ec28557eaa1dd66be142879816486a8a23da`;
- `content_shell` `sha256:e3eb78eaa383d2466485fa6148ad088380df56215ddb1fddbfa05f93cfffb426`;
- `.native-typescript/benchmarks/chromium/2026-08-26-native-allocation-checkpoint/raw.json`
  (`sha256:44530f173629367b5c7d56f6913e9759c066ec5b5593f9e66605729741e134d3`);
- `.native-typescript/benchmarks/chromium/2026-08-26-native-allocation-checkpoint/report.json`
  (`sha256:06cf8c343fa28cf325b8abd46bad6d4b9a4e5a7aebddb01532dc98b548d676a9`).

Keep this narrow dual-heap checkpoint and the existing ScriptC ownership
model. The next Chromium slice should profile a different remaining cost; it
should not broaden this V8 seam or turn memory pressure into normal control
flow.
