# 0067 — Reuse the enclosing realm for frame-bounded Blink callbacks

Status: focused event gate passes; callback dispatch seam reduced  
Recorded: 2026-08-26

The frame-only event tier introduced in records 0061–0062 proves that listener
registration, every admitted callback, and cancellation are contained in one
synchronous ScriptC frame. A callback is therefore necessarily reentrant in
the `ScopedCurrentWebRealm` already installed at the host-to-ScriptC boundary.
The listener previously ignored that proof and installed a second realm scope
for every dispatch.

## Architecture

`BlinkFrameEventListener::Invoke` now fails closed unless
`CurrentWebRealm() == realm_`, then invokes the ScriptC callback directly. Its
release path no longer calls `NtsWebRealm::IsAlive`, resolves the document and
execution context twice, or constructs and destroys a nested realm scope.
Debug builds retain assertions for the event, context, live realm, document,
and matching execution context.

This specialization is deliberately confined to the compiler-proven
frame-bounded listener. The escaping `BlinkManagedEventListener` still owns a
stable lifecycle and installs `ScopedCurrentWebRealm` defensively, so a later
Blink task cannot acquire the frame-only fast path.

The optimized official binary confirms the intended physical result:

| Callback body | Code size | Out-of-line work before ScriptC callback |
| --- | ---: | --- |
| Before | about 145 bytes | realm/liveness/document/context checks and realm-scope construction/destruction |
| After | 63 bytes | one `CurrentWebRealm()` guard |

The remaining guard is intentional. The callback context is stack-backed; a
dispatch outside the admitting frame must be rejected rather than becoming a
use-after-return.

## Controlled result

The pinned official non-component release `content_shell` ran only the
synchronous-event-round-trip family. Each lane used a fresh renderer pinned to
CPU 0, lane order rotated by repetition, and every result was checked. Three
repetitions with 30 samples produced 90 samples per cell. Lower is better.

| Event shape | C++ | ScriptC C | ScriptC LLVM | V8 | C/C++ | LLVM/C++ | C/V8 | LLVM/V8 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Reused listener | 1,009.25 ns | 947.35 ns | 963.30 ns | 1,000.00 ns | **0.939x** | **0.954x** | **0.947x** | **0.963x** |
| Listener per call | 1,018 ns | 1,255 ns | 1,143 ns | 1,600 ns | 1.233x | 1.123x | **0.784x** | **0.714x** |

The evaluator passes with no violations. In the callback-heavy reused-listener
shape, ScriptC C and LLVM are 6.1% and 4.6% faster than handwritten C++ and
5.3% and 3.7% faster than V8. The complete register/dispatch/dispose shape
remains 12.3–23.3% slower than C++, identifying registration and disposal—not
the callback realm scope—as the remaining ScriptC-specific event seam. It is
21.6–28.6% faster than V8.

Absolute timings moved together across the handwritten C++, ScriptC, and V8
controls relative to preceding records, and per-repetition medians show
frequency/noise drift. The benchmark therefore supports compatibility with the
performance gate, but it does not assign every cross-run nanosecond change to
this small dispatch edit. The code-size and call-graph reduction are the direct
attribution evidence.

## Product shape

All ScriptC executions ended with zero managed node peers, node claims, and
subscriptions. The blank fixture returned to one document, ten nodes, and zero
JavaScript event listeners in every lane. Median renderer peak RSS was 368.3
MiB for C++, 366.9 MiB for ScriptC C, 367.0 MiB for ScriptC LLVM, and 182.8 MiB
for V8. The near-identical native and handwritten-C++ peaks make this a native
synchronous-turn Oilpan scheduling characteristic, not a ScriptC ownership
leak; the `[NewObject]` checkpoint in record 0066 does not count the benchmark
host's direct event allocations.

## Validation and evidence

- TypeScript project build passed;
- no-V8-value bridge gate passed;
- focused Chromium binding/prototype/performance tests: 26/26 passed;
- real-browser C and LLVM async/lifecycle gate passed, including frame callback
  result 192 and zero surviving subscriptions;
- release `content_shell` incremental rebuild completed in two actions;
- official focused benchmark: 12/12 isolated browser executions completed and
  the evaluator passed;
- Native TypeScript `0bc315d1ad1856ee40a06adb144294791d308005`;
- ScriptC `c2c96879e29cd7960959db9fd0fba50f8abbd5a4`;
- Chromium `96324a4012fe62f48b9463a67486eeb645bc5c78`;
- `content_shell` `sha256:034808c07e08171a3f27faf40479f70c7ab83945989ff2a7a92381119f42c898`;
- `.native-typescript/benchmarks/chromium/2026-08-26-frame-realm-reuse/raw.json`
  (`sha256:dc479a838b1c9cfef47c4531fbab33bbdedb0cdbc7e5fc9c127615672654489a`);
- `.native-typescript/benchmarks/chromium/2026-08-26-frame-realm-reuse/report.json`
  (`sha256:e3d0d66a288cb0cf22cf4da73c26b7c54357b7152d0353438dcb61904e434cc5`).

Keep the realm guard and the split between frame-only and escaping listener
types. The next event optimization should profile registration and disposal;
it should not weaken callback admission or move the frame context to the heap.
