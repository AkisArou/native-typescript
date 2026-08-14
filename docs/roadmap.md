# Roadmap

Status: normative sequencing; scope changes require architecture review  
Last revised: 2026-08-14

The roadmap is a sequence of permanent vertical slices. A phase exists to prove
and ship reusable architecture, not to create a disposable demo. Dates are set
only when the preceding exit gate is satisfied.

## Delivery rules

- No phase begins by bypassing an unfinished foundation from an earlier phase.
- Each slice includes implementation, diagnostics, conformance tests,
  documentation, and representative benchmarks.
- A target-specific need that reveals a missing general primitive returns to the
  owning foundation; it is not patched into the target.
- Generated adapters and packaging use the same artifact graph intended for
  production.
- Unsupported behavior fails precisely. A demo may be narrow, but never relies
  on silent stubs or leaks.
- Performance budgets are measured from the first executable fixture.
- The active tree contains one architecture. Refactors remove superseded paths.

## Phase 0: architecture baseline

### Deliverables

- Normative architecture and focused specifications.
- Clear ownership between the scriptc fork and this repository.
- Pre-1.0 refactor and schema policy.
- Initial scriptc compatibility register.
- Replacement of the previous combined Milestone 1 with gated phases.

### Exit gate

- Every compiler/runtime/build value has an identified owner, lifetime, thread,
  process/domain, and serialization rule where applicable.
- Target, SCABI, runtime, ownership, partition, and artifact specifications agree.
- No implementation package claims an API that contradicts the documents.

## Phase 1: compiler and C ABI foundation

This phase creates the reusable platform substrate.

### Compiler fork

- Establish immutable compiler phase hooks required by target planning.
- Define and validate generic Native IR.
- Separate native operations from closed Node/runtime-specific operation tables
  where required by the new boundary.
- Implement exact native scalar values and conversions in frontend, IR, C, and
  LLVM backends.
- Implement native aggregate/layout values.
- Implement native handles and ownership operations.
- Implement callback-table and owner-scheduler gateway primitives.
- Extend coverage diagnostics and IR/cache versioning.

### Native TypeScript workspace

- Implement the provider-based Target SPI.
- Implement SCABI v1 schema, canonicalization, validation, and declaration
  agreement checks.
- Implement a Clang-backed C header binding generator.
- Implement C native lowering and adapter planning.
- Implement artifact-graph planning/execution for host C builds.
- Implement native executable and C-callable static/shared library products.
- Emit build, binding, ownership, callback, and cache reports.

### Permanent conformance fixture

One fixture library exercises:

- exact integer and floating-point values;
- padded structs passed and returned by value;
- borrowed strings and bytes;
- owned native returns and exact destruction;
- call-scoped and retained callbacks;
- a `void` callback arriving concurrently from a foreign native thread;
- owner-thread delivery and promise ordering;
- native error conversion;
- TypeScript functions exported through the C ABI.

The fixture remains the cross-backend and sanitizer regression suite.

### Current implementation boundary

The permanent fixture and Native IR path currently cover exact integers,
indirect padded structs, borrowed UTF-8 and byte views, owned owner-confined
opaque handles, and synchronous call-scoped callbacks with exact scalar values
and trailing context. C and LLVM agree for these cases, including captured
callback state and exception propagation, and the ASan/reference-count gate is
clean. The fork also implements and independently stress-tests the generic
instance-owned MPSC owner gateway, including wake coalescing, bounded drains,
admission/stop races, reentrant shutdown, and exact event destruction. This is
now paired with transport-only callback tokens whose generation identity and
atomic leases linearize cancellation against foreign admission. Plain,
ASan/UBSan, and TSan gates cover that boundary. The owner-only table now adds
explicit active-registration roots, closing-entry lookup for admitted leases,
generation-safe slot reuse, and exact anchor release. Result native handles now
claim those registrations and order token close, blocking foreign destruction,
and cancellation completion. This is implemented foundation, not a substitute
path.

Phase 1 still requires generated copied callback payloads and invocation thunks,
Native IR/SCABI cancellation attachment, target wake and owner-loop integration,
error conversion, TypeScript-to-C exports, provider hooks, artifact execution,
and the remaining workspace-side generator/product/reporting work before its
exit gate can pass.

### Exit gate

- C and LLVM backends have equivalent observable results.
- Checked/sanitizer builds report no leaks, races at the gateway, stale handles,
  or use-after-free.
- A target is implemented without adding target-specific cases throughout the
  compiler pipeline.
- Clean and cached builds produce identical unsigned artifacts.
- SCABI/layout mismatches fail before native code executes.
- The resulting interfaces are accepted as the foundation for the next target;
  placeholders and experimental duplicate paths are removed.

## Phase 2: GTK native application

GTK/GObject is the first UI consumer because it exercises metadata generation,
object identity, floating references, signals, callbacks, thread affinity, an
external event loop, resources, and packaging through a broadly C-compatible
stack.

### Deliverables

- GIR plus authoritative header/layout binding ingestion.
- GObject handle and identity rules.
- GLib main-context runtime provider.
- Signal registration and deterministic disconnection.
- GTK application lifecycle and packaging.
- Raw TypeScript access to a deliberately narrow but real GTK surface.

### Acceptance application

A native counter application:

- creates real GTK widgets from TypeScript;
- handles a retained signal callback;
- updates UI only on the owning main context;
- performs asynchronous work without blocking UI delivery;
- disposes the window, signal, and runtime with zero unexplained roots;
- ships no JavaScript engine.

### Exit gate

- No GTK-specific ownership or callback primitive exists outside the target
  adapter/SCABI extension.
- The event-loop integration passes common runtime conformance tests.
- Incremental rebuilds reuse unchanged generated bindings and native objects.
- Raw toolkit access is usable without React.

## Phase 3: hosted mobile runtime and application packaging

Android is implemented first to validate JNI and managed/native thread
boundaries. Apple follows using the same generic contracts; it is a separate
exit gate rather than a simultaneous checkbox.

### Android deliverables

- JAR/AAR/class/Kotlin metadata ingestion for a bounded API surface.
- JNI SCABI extension and generated Java/C++ registration adapters.
- runtime ownership tied to application/activity lifecycle;
- main-Looper integration, global/weak references, exception conversion;
- generated manifest/resources and Gradle/D8 packaging plan;
- platform permission metadata.

### Android acceptance application

A TypeScript application creates a real Android view, receives a native
listener, performs an asynchronous platform operation, survives a lifecycle
transition defined by the fixture, and shuts down cleanly with no handwritten
application Java/Kotlin glue.

### Apple deliverables

- framework headers, modules, and Objective-C-compatible Swift-header ingestion;
- Objective-C/ARC SCABI extension and Objective-C++ adapters;
- runtime ownership tied to application/scene lifecycle;
- main-run-loop/dispatch integration, autorelease, weak delegates, errors;
- generated property lists/resources and Xcode packaging plan;
- an explicit adapter path for pure-Swift-only surfaces.

### Apple acceptance application

The equivalent TypeScript application creates a UIKit view, receives a native
target/delegate callback, performs an asynchronous platform operation, handles
lifecycle, and shuts down cleanly without handwritten application Swift or
Objective-C glue.

### Exit gate

Each target independently passes common SCABI, ownership, callback, scheduler,
artifact, and packaging tests. Supporting one platform may not introduce
conditional semantics into the generic compiler for the next.

## Phase 4: React compatibility and one renderer

React work begins as a compiler compatibility program, not a renderer demo.

### Compatibility gate

- Pin an upstream React and reconciler revision.
- Record static coverage and reduce every reachable fence.
- Implement generally sound missing language/runtime behavior in scriptc.
- Document any preprocessing transform by semantic purpose.
- Avoid a React fork unless a minimal, maintained patch is the only sound option.
- Differentially test hooks, effects, updates, errors, scheduling, suspense
  behavior in the promised surface, and teardown.

The gate passes only with zero unexplained reachable dynamic fences in AOT-only
mode.

### Renderer

Implement one renderer against an already-conformant target, initially GTK or
the most mature native target at that time. The renderer uses the same public
bindings, handles, callbacks, scheduler, and artifact graph as ordinary code.

The first API is a Native TypeScript renderer package. It does not claim the
full `react-native` or `react-dom` surface.

### Exit gate

- Actual pinned React and reconciler execute as native code without an engine.
- A counter and lifecycle fixture exercise `useState`, effects, native events,
  scheduling, unmount, and cleanup.
- Framework-specific compiler changes have general language tests.
- Renderer API/version instability is contained inside the integration package.

## Phase 5: partitions and secure capabilities

### Deliverables

- explicit multi-entry domain configuration;
- program partition validation and Native IR;
- generated request/response and stream protocols;
- policy schema and build-time authority checks;
- remote handles, cancellation, transferable buffers, and backpressure;
- process and trusted-loopback transports;
- cross-domain tracing and failure diagnostics;
- an initial asynchronous `node:fs/promises` capability surface.

### Acceptance application

A sandboxed renderer requests an authorized file through a scoped capability,
streams or transfers its data, rejects unauthorized paths and malformed
messages in the privileged process, and releases all resources when either
process exits.

### Exit gate

- Renderer-compromise fixtures cannot exceed declared authority.
- Process and loopback transports pass the same semantic suite.
- No raw pointer, closure, or arbitrary object crosses the boundary.
- Cross-domain latency and authority are visible in reports and traces.

## Phase 6: additional native targets and renderer portability

Windows/COM/WinRT/WinUI and AppKit-specific desktop work validate that the
foundation is genuinely portable. React renderers may follow raw target access,
not precede it.

Each target receives its own bounded vertical slice and exit gate. Broad SDK
coverage grows only after ownership, error, thread, packaging, and conformance
behavior are correct for the initial surface.

## Phase 7: DOM/Chromium feasibility program

This is an explicit research gate with production-quality fixtures. It does not
change the core architecture unless a generally reusable primitive is proven.

### Stage A: embedding

- Build and package a pinned Chromium Content runtime SDK.
- Host one sandboxed Native TypeScript runtime instance on the correct Chromium
  sequence.
- Demonstrate process lifecycle, task scheduling, shutdown, and diagnostics.

### Stage B: direct Blink projection

- Ingest a minimal Web IDL/extended-attribute surface.
- Create/read/mutate one real DOM element directly from compiled TypeScript.
- Preserve wrapper identity and document/execution-context invalidation.
- Deliver an event through the callback gateway.
- Adapt one Blink promise into ScriptC promise ordering.
- Translate one DOM exception correctly.

### Stage C: coexistence decision

Evaluate:

- maintenance against Chromium updates;
- ScriptC/Blink/Oilpan wrapper and cycle behavior;
- optional V8 realm identity and lifetime;
- performance against a conventional renderer bridge;
- security and binary/update costs.

Only after these stages do we decide whether to maintain `scriptc-dom`, use a
system WebView/bridge target, or support both. The project remains successful as
a native TypeScript platform even if direct Blink is rejected.

## Continuous work

Every phase maintains:

- upstream scriptc synchronization and patch review;
- compatibility register updates;
- compiler/runtime differential tests;
- size, startup, call-overhead, callback-latency, and build benchmarks;
- sanitizer, leak, and security suites;
- reproducible toolchain/SDK provenance;
- deletion of superseded pre-1.0 contracts.

## Implementation starting point

After Phase 0 review, implementation begins with the smallest part of Phase 1
that establishes a permanent seam:

1. model compiler capabilities and immutable target planning (**implemented**);
2. ratify the first SCABI C fixture (**implemented**);
3. add the generic Native IR required by that fixture to the scriptc fork
   (**implemented**);
4. lower and validate one exact scalar C call through both backends
   (**implemented**);
5. resolve exact declaration symbols and translate reached SCABI bindings into
   the compiler frontend (**implemented**);
6. extend the exact direct-call path across signed and unsigned 8-, 16-, and
   32-bit integers, including C ABI extension rules and an IR version fence
   (**implemented**);
7. define the fixed 64-bit BigInt-literal boundary and lower `i64`/`u64`
   through C and LLVM without adding general BigInt (**implemented**);
8. define pointer-width identity and lower `isize`/`usize` using explicit
   target ABI facts (**implemented**);
9. lower nominal padded structs, typed field reads, and authoritative indirect
   by-value ABI passing through C and LLVM (**implemented**);
10. lower nominal owned opaque handles, method receiver bindings, checked
    borrowed calls, alias-safe explicit disposal, and automatic exact-once
    destruction through C and LLVM (**implemented**);
11. project one borrowed TypeScript UTF-8 string into const data and byte-length
    ABI slots with single evaluation and no copy (**implemented**);
12. project borrowed `Uint8Array`/Buffer views into const data and byte-length
    ABI slots with exact offsets, single evaluation, no copy, and prompt
    post-call release (**implemented**);
13. expand ownership beyond the first C handle mode and add callbacks.

No separate prototype API is created. Each increment extends the conformance
fixture and the production path.
