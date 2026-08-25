# Chromium benchmark

This fixture compares four ways to perform the same Blink-visible work in one
pinned, official, non-component `content_shell` build:

- handwritten Blink C++;
- TypeScript compiled through ScriptC's C backend;
- TypeScript compiled through ScriptC's LLVM backend;
- ordinary page JavaScript executed by Chromium V8.

The ScriptC lanes call generated Blink capsules directly. They do not route
through V8 values, source evaluation, a JavaScript compatibility realm, or a
generic DOM dispatcher. The C++ lane is the native floor; V8 is the browser's
ordinary JavaScript baseline.

## Workload contract

[`workloads.json`](workloads.json) is the exact, validated source of workload
IDs, function/symbol mappings, iteration counts, warmup counts, sample count,
and evaluator categories. The TypeScript generator emits the ScriptC profiles,
the Blink host include, and the V8 contract from it. Generated files are
checked in so source drift is reviewable.

The current matrix contains:

| Workload | Product behavior | Boundary it stresses |
| --- | --- | --- |
| `create-element` | Create a detached `div` | Smallest result-handle crossing |
| `detached-counter-tree` | Create button/text, append, then update text | Several frame-bounded handles |
| `retained-attached-text-update` | Attach and repeatedly update retained text | ScriptC peer and Oilpan root |
| `eight-row-component-list` | Build an attributed eight-row result list | Application-shaped construction |
| `selector-driven-update` | Query a descendant and change state | Nullable returned handle and strings |
| `synchronous-event-round-trip` | Listen, click, invoke callback, dispose | Blink-to-ScriptC callback and cleanup |
| `attached-component-mount` | Build, attach, and remove a small card | Attached tree lifecycle and teardown |

Every workload has an independently checked result. The ScriptC lanes also
publish registry diagnostics after every workload. Before the retained-text
case there must be no managed peers; afterward there must be exactly one peer
and one claim. Every workload boundary must have zero managed subscriptions.
Those checks distinguish compiler-proved frame-bounded Blink pointers from
the managed, Oilpan-rooted handles required for escaped identity.

Each workload is measured in two shapes. `per-call` invokes a one-operation
function repeatedly from the host, exposing call-boundary cost. `compiled-loop`
keeps the whole loop in the lane, matching optimized application code more
closely. Neither shape alone is treated as the product result.

## Product-shape measurements

Latency samples and product-shape measurements are separate report dimensions.
For every repetition and lane, the runner starts a fresh renderer on
`about:blank`, attaches DevTools, and records a baseline. It then navigates to
the fixture, waits for its checked result, forces a collection, records the
post-workload state, navigates back to `about:blank`, forces another collection,
and records teardown state.

The report contains:

- process start to attached blank renderer, workload-navigation to checked
  result, and full start-through-teardown wall time;
- renderer-only RSS, proportional set size (PSS), and process peak RSS;
- live document, DOM-node, and JavaScript-listener counts at baseline, after
  work, and after teardown;
- final ScriptC managed-peer, claim, and subscription counts;
- the shared `content_shell` size and each generated ScriptC archive size.

RSS and PSS come from the renderer's Linux `/proc/<pid>/smaps_rollup`; peak RSS
comes from `VmHWM`. Browser, GPU/utility, Xvfb, and runner memory are excluded.
The shared browser executable is reported once because assigning all of it to
each lane would be misleading. Archive sizes are useful compiler-output facts,
but are not the final linked incremental cost of a lane.

Subscription retention is an acceptance failure. Memory and startup values
remain measurements until repeated quiet-system runs provide a defensible
baseline and variance envelope; they are not mixed into the nanoseconds/op
pass/fail score.

## Commands

From the repository root:

```sh
node packages/target-chromium/scripts/generate-chromium-benchmark.ts --check
node packages/target-chromium/scripts/build-chromium-benchmark.ts \
  /path/to/chromium/src --depot-tools /path/to/depot_tools

# Run only on an otherwise quiet Linux machine.
node packages/target-chromium/scripts/run-chromium-benchmark.ts \
  /path/to/chromium/src --repetitions 3 --renderer-cpu-set 0 \
  --output /path/to/raw.json
node packages/target-chromium/scripts/evaluate-chromium-performance.ts \
  /path/to/raw.json --output /path/to/report.json
```

The timing runner requires a clean Native TypeScript worktree, an exact
ScriptC gitlink, the pinned clean Chromium revision, and the official release
GN preset. Raw evidence belongs under the ignored local
`.native-typescript/benchmarks/chromium/` tree; conclusions and hashes belong
in numbered [`docs/records`](../../docs/records/).

## Standards and larger suites

The benchmark matrix is not a substitute for conformance. The intended test
pyramid is:

1. [Test262](https://github.com/tc39/test262) for ECMAScript language and
   runtime semantics supported by the compiler;
2. adapted [Web Platform Tests](https://web-platform-tests.org/) vectors and
   oracles for the reached DOM surface, run through both ordinary V8 and the
   compiled binding path;
3. this four-lane matrix for controlled boundary and application kernels;
4. [Speedometer 3](https://browserbench.org/Speedometer3.0/about.html)-shaped
   user journeys for larger application behavior.

Test262 contains JavaScript tests rather than a performance corpus. WPT is the
authoritative source of browser behavior tests, but its harness normally
assumes JavaScript execution, so the useful approach is to adapt reached test
vectors and retain an ordinary Chromium oracle. A future end-to-end suite
should borrow Speedometer's interaction shapes and measurement discipline; it
should not claim an unchanged Speedometer score unless Native TypeScript can
run the unmodified benchmark applications and harness.
