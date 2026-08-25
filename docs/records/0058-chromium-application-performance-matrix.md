# 0058 — Establish the Chromium application performance matrix

Status: instrument implementation and structural validation complete; release browser rebuild and measurement pending  
Recorded: 2026-08-25

Record 0057 reduced the generated WebIDL boundary to within 1.084–1.246x
handwritten C++ and 0.560–0.920x ordinary V8 across creation and detached-tree
operations. Those results justify continuing the direct-Blink architecture,
but two tiny kernels cannot locate the ownership, callback, query, attachment,
and cleanup costs that will dominate a real application.

## Data-driven matrix

The Chromium fixture now lives with the other product benchmarks under
`benchmarks/chromium`. One exact JSON contract generates the ScriptC C and LLVM
profiles, the Blink host declarations, and the V8 workload contract. The
runner rejects lane, order, sample-count, per-call/compiled-loop iteration and
warmup counts, checksum, or diagnostic drift.

Seven matched workload families cover element creation, a detached counter
tree, retained attached text, an eight-row component list, selector-driven
state updates, synchronous event round trips, and attached component
mount/removal. Each runs both per-call and compiled-loop shapes, producing
fourteen observations in each of the handwritten C++, ScriptC C, ScriptC LLVM,
and ordinary V8 lanes.

The reached generated WebIDL surface adds `Node.removeChild`,
`Element.setAttribute`, `Element.querySelector`, and `HTMLElement.click`.
Synchronous DOM event dispatch now enters the ScriptC callback before `click`
returns, matching Blink's actual ordering rather than relying on an external
callback queue.

The two measurement shapes have independent budgets. The event per-call shape
intentionally measures a small number of complete subscription/click/disposal
lifecycles because that lifecycle is millisecond-scale in the current ScriptC
bridge. Its compiled-loop shape retains a large batch so steady-state dispatch
through one live listener remains a high-resolution measurement. This keeps
the pain point visible without allowing it to monopolize the full matrix.

## Oilpan interoperability diagnostics

The Blink managed registry exposes workload-boundary diagnostics for live node
peers, total claims, and event subscriptions. The benchmark contract requires:

- zero managed nodes after every non-retaining workload;
- exactly one peer and one claim after the retained attached-text workload;
- zero surviving managed subscriptions at every workload boundary.

This makes the intended tiering observable. Temporary DOM values must remain
raw, frame-bounded Blink pointers visible to Oilpan's conservative stack scan.
The one escaped text identity must become a canonical managed peer with a
`Persistent` root. The event listener must enter compiled code synchronously
and be released before the workload returns.

## Product-shape protocol

Every repetition/workload/lane tuple uses a fresh renderer. The runner first attaches on a
script-free blank fixture and records a baseline, explicitly navigates into the selected
lane, then navigates back to blank after the checked result. Forced collection
precedes baseline, post-workload, and post-teardown snapshots.

The raw report records renderer-only RSS and PSS, renderer peak RSS, live
documents/nodes/JavaScript listeners, startup time, workload wall time, total
start-through-teardown time, and the ScriptC registry state. It also records
the shared `content_shell` size and the C and LLVM archive sizes. Whole-browser
and Xvfb memory are excluded, and the shared browser binary is not falsely
attributed to every lane. Spare renderers are not summed: the measured PID is
the stable renderer whose CPU time advances across the workload, and the run
fails if that PID cannot be followed through teardown. This isolation also
keeps detached garbage and GC pressure from one case out of later cases.

Subscription retention is already a failing gate. Memory numbers are recorded
separately from latency and deliberately have no threshold until repeated
quiet-system runs establish variance and a useful baseline.

## Validation

The repository TypeScript build passes. Twenty-two focused Chromium tests pass,
including exact generated WebIDL, both ScriptC planners, schema-3 product-shape
validation, leak failure behavior, portable bridge execution, and runner
protocol structure. Both benchmark and WebIDL generators report that committed
artifacts are current.

No expanded-matrix performance or memory number is recorded here. The overlay
still needs to be applied to the pinned checkout, the optimized browser rebuilt
incrementally, both ScriptC browser lanes accepted, and the four-lane run
performed on an otherwise quiet machine. Until that completes, record 0057 is
the current performance result and this record is an unmeasured instrument
checkpoint.

The complete workload rationale, protocol, commands, and standards-test
relationship are documented in the
[Chromium benchmark README](../../benchmarks/chromium/README.md).
