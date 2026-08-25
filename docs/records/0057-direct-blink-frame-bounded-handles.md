# 0057 — Lower frame-bounded WebIDL handles directly to Blink pointers

Status: implementation, browser acceptance, and repeated release measurement complete  
Recorded: 2026-08-25

The first Chromium performance fixture proved the build, host, and four-lane
instrument with one handwritten native call. Replacing that oracle with the
generated `@native-typescript/web-chromium` surface exposed the actual product
cost: every temporary DOM result entered a managed handle registry, acquired a
Blink `Persistent` root, and was released through the ScriptC runtime. That was
semantically safe but made the generated ScriptC lanes 6–13x slower than V8 on
the two reached workloads.

## Reached surface

The normalized WebIDL slice now generates TypeScript declarations, SCABI, C
entry points, and Blink C++ capsules for:

- the current `Document` and its `body`;
- `Document.createElement` and `Document.createTextNode`;
- `Node.appendChild`;
- `CharacterData.data` mutation;
- an owned, payload-free event subscription and explicit disposal;
- native error messages and release.

The counter fixture is compiled from ordinary TypeScript through both ScriptC
C and LLVM. In the pinned debug browser, both backends pass the script-free DOM
observer, real input event, DOMException and SecurityError projections, and
navigation teardown. The V8 lane remains ordinary page JavaScript and the C++
lane remains the handwritten Blink baseline.

## Lifetime lowering

SCABI schema 13 can attach a `frameBounded` alternate entry and release symbol
to an owned native-handle result. ScriptC escape analysis now selects that
entry when the value cannot escape the synchronous native frame, including an
ignored owned result and an identity handle upcast. Generated hot loops
therefore carry raw, untagged Blink pointers for temporary DOM values. Oilpan's
conservative stack scan keeps those objects visible while the compiled frame
is live.

Values that escape, participate in callbacks, or require stable identity use a
low-bit tagged managed peer instead. That peer remains realm-affine and owns a
Blink `Persistent` root. The checked fallback retains context-destruction,
wrong-realm, invalid-handle, exception, and explicit-release behavior. This is
a tiered product lifetime rule driven by compiler proof, not a benchmark-only
ABI.

The raw-pointer fast path also avoids managed-registry lookup, repeated realm
validation, and dynamic handle-type checks. `createElement` constructs its
`AtomicString` directly from the already validated UTF-8 span. The generated
benchmark loops contain no ScriptC handle allocation, retain, interning, or
release calls.

## Method

The official non-component `content_shell` uses ThinLTO, no symbols,
`is_debug=false`, `is_official_build=true`, and `chrome_pgo_phase=0`. Every lane
runs in a fresh renderer pinned to CPU 0. Each workload has three repetitions,
30 samples per repetition, 100,000 measured operations per sample, and 20,000
warmup operations. The native lanes time with monotonic `base::TimeTicks`; V8
uses `performance.now()`. Exact checksums reject dead or partial work.

“Per call” invokes a one-operation compiled function 100,000 times from the
native or JavaScript harness. “Compiled loop” invokes once and keeps the
100,000-iteration loop inside the lane. The detached counter-tree operation
creates a button and text node, appends the text, and mutates it from
`Count: 0` to `Count: 1`.

## Result

These are the confirmation-run medians; lower is better:

| Workload | C++ | ScriptC C | ScriptC LLVM | V8 | C/C++ | LLVM/C++ | C/V8 | LLVM/V8 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Create element, compiled loop | 53.64 ns | 61.96 ns | 61.58 ns | 97.50 ns | 1.155x | 1.148x | **0.635x** | **0.632x** |
| Create element, per call | 51.83 ns | 63.02 ns | 64.60 ns | 112.50 ns | 1.216x | 1.246x | **0.560x** | **0.574x** |
| Detached counter tree, compiled loop | 334.66 ns | 364.59 ns | 362.84 ns | 420.00 ns | 1.089x | 1.084x | **0.868x** | **0.864x** |
| Detached counter tree, per call | 337.53 ns | 379.92 ns | 374.42 ns | 413.00 ns | 1.126x | 1.109x | **0.920x** | **0.907x** |

The same generated WebIDL workloads before frame-bounded lowering measured
749.48/754.48 ns for the compiled create loop, 1,517.70/1,519.30 ns for
per-call create, 2,384.98/2,384.84 ns for the compiled tree, and
3,318.21/3,299.51 ns for the per-call tree. The current medians are therefore
roughly 12–14x, 23–24x, 6.2–6.6x, and 8.5–8.8x faster respectively.

An immediately preceding controlled run of the exact same source and binary
also passed every evaluator gate. In that run the two ScriptC medians ranged
from 0.959–1.160x handwritten C++ and 0.498–0.888x V8 across the four
workloads. The confirmation table is retained instead of selecting the more
favorable run.

The visible lifetime of each `content_shell` window is not the measured
interval: it also includes process startup, DevTools attachment, warmup,
result collection, and shutdown. The report contains 90 in-renderer timed
samples per lane and exact workload checksums.

## Decision

Keep frame-bounded raw Blink handles as the fast tier and managed rooted peers
as the escaping tier. The generated TypeScript boundary is now close enough to
handwritten C++ that the benchmark program should expand from boundary
falsifiers to application-shaped DOM work. Future work should add matched
construction, mutation, query, event, and teardown scenarios with independent
semantic observers, then optimize only gaps that repeat under the complete
matrix.

The canonical local evidence is:

- `.native-typescript/benchmarks/chromium/2026-08-25-webidl-dom-frame-confirmation/raw.json` (`sha256:df388666934088e4ede8fed388589e908166e1d94be1b45aeaa3ea07ef1bbfb3`);
- `.native-typescript/benchmarks/chromium/2026-08-25-webidl-dom-frame-confirmation/report.json` (`sha256:323030e90456136ac774430d40f26274596f3305fa36f4f7aad2d49833e86a71`);
- `.native-typescript/benchmarks/chromium/2026-08-25-webidl-dom-frame-fast-realm/raw.json` (`sha256:cde1a8feaf0ea24276fe1f3f1b4acf69a53179fd6bda03512cb15c87d03e5cbc`);
- `.native-typescript/benchmarks/chromium/2026-08-25-webidl-dom-frame-fast-realm/report.json` (`sha256:e569dec9176efba69bcd183ec9dfcae2e5918b1124ab63d7649d4ac681356245`).

The confirmation provenance identifies parent
`acde317cdbec534f32334f57ab2c07731b05ed63`, ScriptC
`3a1559745e73b7ffac948989b2e3a0c68a5d4919`, Chromium
`96324a4012fe62f48b9463a67486eeb645bc5c78`, the exact browser and archive
digests, GN arguments, pinned Clang, CPU set, and repetition policy.
