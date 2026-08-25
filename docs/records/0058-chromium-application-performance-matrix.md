# 0058 — Establish the Chromium application performance matrix

Status: baseline recorded; structural and lifetime acceptance passes; performance gate fails  
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

The two measurement shapes and four lanes have independent, provenance-recorded
budgets, with every result normalized per operation. Workload-specific budgets
preserve clock resolution without allowing a single application-shaped case to
dominate the matrix. The synchronous-event workload uses the same 100-event
per-call and 1,000-event compiled-loop budgets in all four lanes, so its ratios
compare equal amounts of subscription, dispatch, callback, and disposal work.

## Callback integration findings

The first complete event run appeared to leave each ScriptC window open for
more than 50 seconds. That was not execution time: the renderer crashed almost
immediately and the browser remained visible while Chromium processed the
crash. A bounded ScriptC panic sink exposed the first cause: the benchmark
archives had not installed ScriptC's retained-callback service before creating
the event listener. The benchmark host now configures that service inside the
active realm and proves a clean zero-discard shutdown.

The next diagnostic run exposed Chromium control-flow integrity rejecting the
indirect callback target from the separately compiled ScriptC archive. The
registry now uses one narrowly scoped `DISABLE_CFI_ICALL` ABI bridge around
that callback invocation; Chromium CFI remains enabled everywhere else. The
runner also subscribes to renderer-crash notifications and includes a bounded
`content_shell` output tail in failures, preventing a crash from being
misreported as a long benchmark.

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

## Recorded baseline

The canonical run used the pinned official non-component release browser, CPU
0, three repetitions, 30 timed samples per repetition, and a fresh renderer
for every repetition/workload/lane tuple. Every latency cell therefore contains
90 checked samples. Lower is better.

| Workload / shape | C++ | ScriptC C | ScriptC LLVM | V8 | C/C++ | LLVM/C++ | C/V8 | LLVM/V8 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Attached component mount / compiled | 1,382.0 ns | 2,509.0 ns | 2,480.0 ns | 1,800.0 ns | 1.815x | 1.795x | 1.394x | 1.378x |
| Attached component mount / per call | 1,426.0 ns | 2,523.5 ns | 2,750.5 ns | 2,000.0 ns | 1.770x | 1.929x | 1.262x | 1.375x |
| Create element / compiled | 54.33 ns | 42.67 ns | 47.39 ns | 104.00 ns | 0.785x | 0.872x | 0.410x | 0.456x |
| Create element / per call | 51.00 ns | 63.45 ns | 61.47 ns | 98.50 ns | 1.244x | 1.205x | 0.644x | 0.624x |
| Detached counter tree / compiled | 417.78 ns | 457.67 ns | 455.38 ns | 398.50 ns | 1.095x | 1.090x | 1.148x | 1.143x |
| Detached counter tree / per call | 332.74 ns | 371.16 ns | 372.69 ns | 412.00 ns | 1.115x | 1.120x | 0.901x | 0.905x |
| Eight-row component list / compiled | 5,854.5 ns | 11,440.0 ns | 11,660.5 ns | 7,650.0 ns | 1.954x | 1.992x | 1.495x | 1.524x |
| Eight-row component list / per call | 6,350.5 ns | 11,609.0 ns | 11,615.5 ns | 8,300.0 ns | 1.828x | 1.829x | 1.399x | 1.399x |
| Retained attached-text update / compiled | 119.15 ns | 135.13 ns | 135.38 ns | 84.00 ns | 1.134x | 1.136x | 1.609x | 1.612x |
| Retained attached-text update / per call | 124.08 ns | 139.76 ns | 144.25 ns | 92.00 ns | 1.126x | 1.163x | 1.519x | 1.568x |
| Selector-driven update / compiled | 133.50 ns | 161.20 ns | 161.50 ns | 120.00 ns | 1.207x | 1.210x | 1.343x | 1.346x |
| Selector-driven update / per call | 574.00 ns | 709.40 ns | 732.90 ns | 900.00 ns | 1.236x | 1.277x | 0.788x | 0.814x |
| Synchronous event round trip / compiled | 763.00 ns | 810.50 ns | 795.00 ns | 1,200.0 ns | 1.062x | 1.042x | 0.675x | 0.663x |
| Synchronous event round trip / per call | 1,050.0 ns | 2,400.0 ns | 2,450.0 ns | 2,000.0 ns | 2.286x | 2.333x | 1.200x | 1.225x |

The strict evaluator reports 22 violations: twenty individual lane checks and
both boundary-heavy aggregate checks. This is a useful failed baseline rather
than an invalid run. Compiled create-element and steady-state event dispatch
are already 0.410–0.456x and 0.663–0.675x V8 respectively. In contrast, the
eight-row list is about 2x handwritten C++ and 1.50x V8, attached mount is
1.80–1.93x C++ and 1.26–1.38x V8, and retained attached-text mutation is only
1.13–1.16x C++ but 1.52–1.61x V8. Per-call event subscription and disposal is
2.29–2.33x C++ while the compiled loop through one retained listener is only
1.04–1.06x C++. That separation identifies lifecycle setup and managed-root
interop—not callback dispatch itself—as the first event optimization target.

## Memory and product shape

Renderer peak RSS is a process high-water mark measured across the complete
workload, including warmup and all samples. The table reports the median of the
three fresh-renderer repetitions.

| Workload | C++ | ScriptC C | ScriptC LLVM | V8 |
| --- | ---: | ---: | ---: | ---: |
| Attached component mount | 159.9 MiB | 186.3 MiB | 186.5 MiB | 176.2 MiB |
| Create element | 192.8 MiB | 193.2 MiB | 193.4 MiB | 206.7 MiB |
| Detached counter tree | 1,161.0 MiB | 1,162.4 MiB | 1,162.0 MiB | 210.1 MiB |
| Eight-row component list | 278.5 MiB | 382.7 MiB | 383.0 MiB | 181.6 MiB |
| Retained attached-text update | 121.1 MiB | 120.7 MiB | 121.0 MiB | 134.6 MiB |
| Selector-driven update | 159.6 MiB | 159.9 MiB | 159.7 MiB | 176.6 MiB |
| Synchronous event round trip | 154.3 MiB | 157.0 MiB | 156.9 MiB | 169.3 MiB |

The 1.16 GiB detached-tree peak occurs in handwritten C++ as well as both
ScriptC lanes, while V8 peaks at 210.1 MiB. It therefore points first to
Oilpan collection scheduling/safepoint cooperation in long native allocation
loops, not to ScriptC reference counting. The eight-row list is different:
ScriptC peaks near 383 MiB versus 278.5 MiB C++ and 181.6 MiB V8, making its
generated construction/string path a separate compiler-owned target.

Across all 21 fresh-renderer observations per lane, the product-shape medians
are:

| Lane | Blank PSS | Post-work PSS delta | Post-teardown PSS delta | Startup |
| --- | ---: | ---: | ---: | ---: |
| C++ | 52.1 MiB | +1.0 MiB | +1.1 MiB | 164.9 ms |
| ScriptC C | 52.3 MiB | +3.1 MiB | +3.4 MiB | 167.2 ms |
| ScriptC LLVM | 52.2 MiB | +2.6 MiB | +2.7 MiB | 162.6 ms |
| V8 | 52.6 MiB | +14.5 MiB | +14.7 MiB | 163.1 ms |

All 84 teardown snapshots returned to the blank fixture's DOM-node and
JavaScript-listener counts. All 42 ScriptC observations ended with zero managed
subscriptions; the six retained-text observations had exactly one peer and one
claim, and the other 36 had zero. PSS retention alone is allocator/process
retention and is not labelled a leak without repeated-baseline evidence.

The shared `content_shell` is 334.9 MiB. The unlinked ScriptC C and LLVM
archives are 420.1 KiB and 417.1 KiB respectively; these are provenance facts,
not claims about final incremental binary size.

## Validation

The repository TypeScript build passes. Twenty-two focused Chromium tests pass,
including exact generated WebIDL, both ScriptC planners, schema-3 product-shape
validation, leak failure behavior, portable bridge execution, and runner
protocol structure. Both benchmark and WebIDL generators report that committed
artifacts are current. The overlay and both current ScriptC archives are linked
into the pinned official release `content_shell`.

The canonical three-repetition run completed all 84 fresh-renderer executions
with every checked result accepted. Its provenance records Native TypeScript
`f54717cbbcbaa29db633dbeb4a4cf536d9a7fb4c`, ScriptC
`3a1559745e73b7ffac948989b2e3a0c68a5d4919`, Chromium
`96324a4012fe62f48b9463a67486eeb645bc5c78`, pinned Clang 24, the exact GN
arguments, CPU set, browser/archive/fixture digests, and every lane budget.

The canonical local evidence is:

- `.native-typescript/benchmarks/chromium/2026-08-25-application-matrix/raw.json` (`sha256:246c3b8070f301924b51a63525b0ee2917aa7944cf190013130ec3110c4c9c7b`);
- `.native-typescript/benchmarks/chromium/2026-08-25-application-matrix/report.json` (`sha256:ee03d86676c4358f1be06b25c8ec8b79905852073cd3df69deb921a62ed5aea7`).

The complete workload rationale, protocol, commands, and standards-test
relationship are documented in the
[Chromium benchmark README](../../benchmarks/chromium/README.md).
