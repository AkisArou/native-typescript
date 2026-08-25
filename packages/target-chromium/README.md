# Chromium feasibility package

Status: generated direct-Blink counter browser-accepted and release-measured; not an implemented target provider

This package is the Native TypeScript home for the direct-Blink feasibility
work originally developed in the temporary `electron-like` repository. It
preserves executable evidence and the pinned Chromium seam without promoting
prototype contracts into the product architecture.

Chromium is an application environment and product host over an ordinary OS/ABI
target. It does not define a new target triple, object format, or compiler
backend.

## What is here

- `chromium/revision.json` pins the investigated Chromium commit.
- `chromium/patches/product.series` contains the single shared exception
  capture seam admitted after the stock-Blink compile.
- `chromium/patches/fixture.series` contains the test-only `content_shell`
  acceptance hook.
- `chromium/overlay/` contains the handwritten direct-Blink bridge specimen.
- `chromium/webidl/` contains the pinned normalized slice, source provenance,
  generated declarations, and SCABI manifest.
- `prototype/` contains the experimental C ABI, portable slot table, C
  counter, create-element probe, and standalone tests.
- `scripts/` can export the normalized slice, regenerate/check the binding
  artifacts, verify their ABI, build both ScriptC benchmark libraries, verify
  the patches, scan the bridge, or apply the specimen to an explicitly
  supplied clean checkout.
- `src/` validates the committed Chromium revision metadata for later build
  planning.

The package intentionally does not export a `TargetDefinition`. A real
Chromium application profile must preserve the selected Linux, macOS, or
Windows ABI target and compose Chromium-specific artifacts above it.

## Evidence boundary

The repository's normal tests prove:

- the experimental handle table's generation and invalidation behavior;
- the plain-C counter callback/cleanup contract against a fake Web backend;
- compilation of the create-element/DOMException probe;
- absence of forbidden V8/source-evaluation carriers in the handwritten bridge;
- syntactic integrity of the complete patch series;
- validation of the pinned revision and WebIDL provenance input;
- deterministic regeneration of the first declarations, SCABI manifest, and
  typed Blink capsule, including successful ScriptC Native IR translation;
- realm-affine handle refusal and pinned-Clang layout/calling-convention
  evidence;
- equivalent ScriptC C and LLVM plans for the first benchmark kernel, with
  target-owned runtime localization so both archives can share one renderer.
- compiler-selected frame-bounded DOM handles with managed rooted peers retained
  for escaping identity and callback lifetimes.

The networked patch verifier additionally proves that every selected product
and fixture patch applies to the exact pinned Chromium sources.

At the pinned revision, a symbol-light component-debug `content_shell` build
has completed with the overlay in Chromium's real GN graph. Both the stock
exception path and the single product exception-capture patch then passed the
script-free browser acceptance lane: the rendered counter changed from
`Count: 0` to `Count: 1` after a real input event, the DOMException probe
completed, the product path preserved distinct sanitized and privileged
SecurityError messages, and navigation caused explicit host teardown.

The same pinned debug browser now accepts the generated TypeScript counter
through both ScriptC C and LLVM. Each backend creates and mutates real DOM,
handles a real input event, preserves the reached exception projections, and
tears down its realm-owned state on navigation. This is still a fixture-hosted
ScriptC instance rather than a production renderer lifecycle. The
`content_shell` target and its complete dependency graph were built; the larger
`chrome` product target was not.

## Deliberate prototype boundaries

The following are migration oracles, not permanent contracts:

- `NtsWebHandle`, `NtsHandleTable`, and `NtsWebSubscription`;
- the target-specific result and exception structs;
- UTF-8 as the carrier for every WebIDL string;
- handwritten DOM member wrappers;
- the hard-coded callback token and singleton counter state;
- the counter-specific `content_shell` host patch;
- in-place patching of a disposable Chromium checkout.

The initial stock fixture used Chromium's existing
`DummyExceptionStateForTesting` and proved that no per-method Blink overload is
needed. Product code now uses one capture sink in the existing
`ExceptionState` machinery. It preserves the code, sanitized message, and
unsanitized security message without constructing a V8 value. The stock
native-listener path remains unchanged: merely consulting Chromium's
isolated-world activity logger is not a V8 data carrier.

The current oracle handle carries realm, slot, and generation, so independent
realms cannot issue indistinguishable values and wrong-realm status is tested.
Product work must still attach the Blink backing registry and realm-wide
invalidation to ScriptC's existing native-handle ownership rather than bless
this parallel table as the managed representation.

The public prototype header was narrowed during migration to operations the
Blink overlay actually defines. The spike had also declared `window`,
`Node.remove`, and `Element.setAttribute` without implementations.

## Product binding boundary

The durable generation flow is:

```text
pinned Blink WebIDL database
        |
        v
bindgen-webidl normalization and call-plan analysis
        |
        +-- TypeScript declarations
        +-- SCABI manifest with Blink extensions
        +-- generated typed C ABI
        +-- generated Blink C++ capsules
        +-- coverage/refusal/provenance report
        |
        v
existing ScriptC declaration + SCABI + Native IR pipeline
```

The normalized WebIDL snapshot may be a deterministic bindgen artifact, but it
is not a second compiler-facing native vocabulary. ScriptC remains the single
owner of Native IR, handles, callback lifetime, exceptions, promises, and
owner-executor semantics.

## Focused commands

From the repository root:

```sh
cmake -S packages/target-chromium/prototype \
  -B /path/on/a-real-filesystem/nts-chromium-prototype
cmake --build /path/on/a-real-filesystem/nts-chromium-prototype
ctest --test-dir /path/on/a-real-filesystem/nts-chromium-prototype \
  --output-on-failure

node packages/target-chromium/scripts/check-no-v8-bridge.ts
node packages/target-chromium/scripts/generate-chromium-webidl.ts --check
```

The patch verifier downloads exact Chromium inputs and is therefore
intentionally outside the network-free default suite. The ABI verifier is also
explicit because it requires a prepared pinned checkout and its clang:

```sh
node packages/target-chromium/scripts/verify-chromium-patches.ts
node packages/target-chromium/scripts/verify-chromium-abi.ts \
  /path/to/chromium/src
```

Applying or building the overlay requires a full clean checkout at the pinned
revision:

```sh
node packages/target-chromium/scripts/sync-chromium.ts \
  /path/to/chromium-root --depot-tools /path/to/depot_tools
node packages/target-chromium/scripts/apply-chromium.ts /path/to/chromium/src
node packages/target-chromium/scripts/build-chromium-counter.ts \
  /path/to/chromium/src --depot-tools /path/to/depot_tools
node packages/target-chromium/scripts/run-chromium-counter.ts \
  /path/to/chromium/src
```

The build helper generates a component debug build with symbols disabled by
default, compiles the narrow Blink bridge target first, and only then compiles
`content_shell`. It defaults to four concurrent compile jobs for machines near
Chromium's memory floor. Pass `--gn-args` or `--jobs` to replace those defaults.
The acceptance runner uses Xvfb automatically when Linux has no display. It
drives only the external DevTools DOM, Input, Page, and Target domains: the
fixture page contains no script and no source-evaluation command is used. The
gate requires the initial DOM, a native click update, navigation, and explicit
counter-host teardown evidence.

The performance harness has separate build and run commands so compiling a
large official release browser cannot accidentally produce timing evidence.
The default preset sets `is_official_build=true`; Chromium's ordinary
`is_debug=false` configuration retains DCHECKs and is not valid for timings.
It also sets `chrome_pgo_phase=0` so a public checkout does not depend on a
separately downloaded Chrome training profile and every lane is compared in
the same reproducible optimized binary:

```sh
node packages/target-chromium/scripts/build-chromium-benchmark.ts \
  /path/to/chromium/src --depot-tools /path/to/depot_tools
# Run only on an otherwise quiet machine:
node packages/target-chromium/scripts/run-chromium-benchmark.ts \
  /path/to/chromium/src --repetitions 3 --renderer-cpu-set 0 \
  --output /path/to/raw-input.json
node packages/target-chromium/scripts/evaluate-chromium-performance.ts \
  /path/to/raw-input.json --output /path/to/report.json
```

If Siso cannot write its own logs because the system `/tmp` has a per-user
quota, point `TMPDIR` at a task-owned directory on a filesystem with free space
before invoking the build helper. This changes only transient tool files; the
Chromium output directory and its incremental build cache remain unchanged.

The release fixture contains handwritten C++, ScriptC C, ScriptC LLVM, and
ordinary page-JavaScript lanes for a generated application-shaped matrix. Both
generated archives are compiled with Chromium's pinned Clang and Linux sysroot.
The harness records raw per-call and compiled-loop samples plus Chromium,
Native TypeScript, ScriptC, toolchain, binary, archive, fixture, GN, repetition,
lane-isolation, and CPU-set identities. Each lane runs in a fresh renderer. On
heterogeneous Linux CPUs, `--renderer-cpu-set` should select one measured core
class without constraining the browser and display-server support processes.

The runner also records renderer-only RSS, PSS, peak RSS, live DOM/listener
counts, startup/workload/teardown wall time, managed ScriptC/Oilpan peer and
subscription counts, and shared-binary/archive sizes. It explicitly navigates
from a measured blank baseline into the workload and back to blank for a
post-collection teardown snapshot. See the
[benchmark README](../../benchmarks/chromium/README.md) for the workload matrix,
measurement protocol, and standards-test pyramid.

At the pinned revision, the official non-component fixture has completed a
full `content_shell` build with ThinLTO and `chrome_pgo_phase=0`. Structural
verification confirms that the final link includes the native benchmark host
and both localized ScriptC archives, and that each archive exports exactly its
declared backend-specific symbols. That structural verification is
separate from timing, which still requires a quiet-system window.

The current generated-WebIDL run at this pin used three repetitions, 30 samples
per repetition, 100,000 operations per sample, a fresh renderer per lane, and
renderer CPU set `0`. Its 90-sample report passes every latency and structural
gate:

| Workload median | C++ | ScriptC C | ScriptC LLVM | V8 |
| --- | ---: | ---: | ---: | ---: |
| Create element, compiled loop | 53.64 ns | 61.96 ns | 61.58 ns | 97.50 ns |
| Create element, per call | 51.83 ns | 63.02 ns | 64.60 ns | 112.50 ns |
| Detached counter tree, compiled loop | 334.66 ns | 364.59 ns | 362.84 ns | 420.00 ns |
| Detached counter tree, per call | 337.53 ns | 379.92 ns | 374.42 ns | 413.00 ns |

The generated ScriptC medians are 1.084–1.246x handwritten C++ and
0.560–0.920x V8. A second controlled run of the exact same source and binary
also passed. The lifetime rule, before/after result, caveats, and exact local
evidence coordinates are in
[`record 0057`](../../docs/records/0057-direct-blink-frame-bounded-handles.md).
This remains evidence for the earlier two-workload reached synchronous DOM
surface, not a general DOM-performance claim. The expanded matrix and
product-shape instrument are implemented and structurally validated but have
not replaced this table until the optimized browser is rebuilt and measured;
see [`record 0058`](../../docs/records/0058-chromium-application-performance-matrix.md).

Those helpers are research tools. The product build must express checkout
validation, patches, overlays, GN/Ninja tools, outputs, and provenance as
declared artifact-graph inputs and actions.

## Next gates

1. Rebuild and accept the expanded application-shaped matrix, then record its
   latency, renderer-memory, DOM-retention, and artifact-size results.
2. Adapt reached Test262 and Web Platform Test semantics into the compiled
   harness and add Speedometer-shaped end-to-end user journeys.
3. Prove event payload identity and cancellation plus promise/microtask
   ordering through the compiler-owned runtime.
4. Replace the fixture host with a production renderer-owned ScriptC lifecycle
   and declared Chromium application artifacts.
