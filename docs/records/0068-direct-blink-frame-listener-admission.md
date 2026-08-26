# 0068 — Specialize frame-only listener admission

Status: focused event gate passes; per-call path near direct C++  
Recorded: 2026-08-26

Record 0067 reduced callback dispatch itself to the handwritten-C++ range, but
the complete register/dispatch/dispose shape still carried a larger ScriptC
gap. Release disassembly located a composition cost before Blink registration:
the shared stable/frame helper discovered the current realm and checked its
liveness once while admitting a raw frame receiver, then repeated both steps
after string conversion when it selected the owning registry.

## Architecture

The stable registration entry keeps the general helper and its defensive
managed-handle path. The compiler-selected frame entry now has a dedicated
`EventTargetListenFrame` implementation. It:

1. establishes the active realm once;
2. resolves a tagged managed receiver through that realm or admits the raw
   compiler-proven frame receiver directly;
3. decodes the event type through the same realm; and
4. calls `BlinkManagedRegistry::ListenFrame` without rediscovering realm state.

All failure paths still transfer the callback-context release hook exactly
once. Realm invalidation still walks the intrusive listener list, unregisters
the exact Blink listener, closes callback admission, and releases the stack
closure before its declaring function can return. Escaping listeners still use
the stable managed representation.

The tiny realm predicates are now forced inline. Their semantics are
unchanged—owner-sequence, alive flag, and document root remain required—but the
official release artifact no longer emits an `IsAlive` call in frame admission.
The physical frame wrapper fell from 509 bytes in the shared implementation to
270 bytes and from two realm/liveness checks to one.

A second candidate encoded `active`, `linked`, and `closed` through existing
pointers. It made the Oilpan object 64 rather than 72 bytes and shortened
`Cancel`, but its focused per-call medians worsened to 1,112 ns C and 1,059.5 ns
LLVM from an admission-only exploratory run of 1,000/1,027.5 ns. The candidate
was rejected and the explicit lifecycle state restored. The published browser
therefore retains the clearer state machine and only the demonstrated
admission specialization.

## Controlled result

The pinned official non-component release `content_shell` ran only the
synchronous-event-round-trip family. Each lane used a fresh renderer pinned to
CPU 0, lane order rotated by repetition, and every result was checked. Three
repetitions with 30 samples produced 90 samples per cell. Lower is better.

| Event shape | C++ | ScriptC C | ScriptC LLVM | V8 | C/C++ | LLVM/C++ | C/V8 | LLVM/V8 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Reused listener | 1,017.50 ns | 969.95 ns | 1,022.10 ns | 1,000.00 ns | **0.953x** | 1.005x | **0.970x** | 1.022x |
| Listener per call | 1,020 ns | 1,065.5 ns | 1,123 ns | 1,800 ns | 1.045x | 1.101x | **0.592x** | **0.624x** |

The evaluator passes with no violations. The complete ScriptC lifecycle is
within 4.5–10.1% of handwritten C++ and 37.6–40.8% faster than V8. Reused
dispatch is within 0.5–4.7% of C++ and 2.2% of V8 in either direction.

This workload cannot honestly reach a twofold V8 advantage while remaining
close to direct C++: handwritten C++ itself is only 1.76x faster than V8 in the
per-call shape, and C++ and V8 are effectively tied in the reused-listener
shape because Blink event creation and dispatch dominate both. The correct
optimization target here is the C++ floor, which the compiled lanes now closely
track. Workloads where the C++ boundary itself retains a twofold advantage must
carry the broader 2x-V8 target.

Absolute medians still vary across repeated identical-binary runs, so the
entire cross-run delta is not attributed to one removed realm lookup. The
direct evidence is the exact release call graph and smaller wrapper; the
controlled result proves that those changes preserve the strict gate.

## Product shape

Every ScriptC run ended with zero managed node peers, node claims, and
subscriptions. Every lane returned to one blank document, ten fixture nodes,
and zero JavaScript event listeners. Median renderer peak RSS was 362.4 MiB for
C++, 362.5 MiB for ScriptC C, 363.1 MiB for ScriptC LLVM, and 175.2 MiB for V8.
The matching native/C++ high-water marks again identify native synchronous-turn
Oilpan scheduling rather than a ScriptC ownership leak.

## Validation and evidence

- TypeScript project build passed;
- no-V8-value bridge gate passed;
- focused Chromium binding/prototype/performance tests: 26/26 passed;
- real-browser C and LLVM hosted-async and frame-callback gates passed with
  checksum 192 and zero retained subscriptions;
- the final header-sensitive release rebuild completed 10/10 actions with 12
  local jobs and retained the existing Chromium cache;
- official focused benchmark: 12/12 isolated browser executions completed and
  the evaluator passed;
- Native TypeScript `355e15ba956c4668b9df41484376010b7588d381`;
- ScriptC `c2c96879e29cd7960959db9fd0fba50f8abbd5a4`;
- Chromium `96324a4012fe62f48b9463a67486eeb645bc5c78`;
- `content_shell` `sha256:60fcbffa3ea984de7ac0528166af1845eeb417ac35e4688a65a6679e610cdc4d`;
- `.native-typescript/benchmarks/chromium/2026-08-26-inline-frame-listener-admission/raw.json`
  (`sha256:1b1fb858612dec5535a95738df4f29f2bae0c7489ad6993d1bc76ec4afa3f1f9`);
- `.native-typescript/benchmarks/chromium/2026-08-26-inline-frame-listener-admission/report.json`
  (`sha256:568dae591441665373e7ec3eacffa62e74bb7038b36f893ab664eeb75eaa0b3c`).

Keep the single-realm frame entry, explicit lifecycle flags, and fail-closed
managed fallback. Select the next optimization from the complete application
matrix rather than trying to outrun the shared Blink event implementation.
