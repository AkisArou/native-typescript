# Chromium and direct Blink feasibility

Status: Phase 8 design and migrated feasibility evidence

This document specializes the system rules in [Architecture](architecture.md)
for the DOM/Chromium research program. The root architecture remains
authoritative if the documents disagree. Current proof is recorded in
[Implementation status](status.md), and the acceptance sequence remains in
[the roadmap](roadmap.md).

## Position in the system

Chromium is a browser application environment and product host over an ordinary
OS/ABI target. A Linux Chromium build remains a Linux target; macOS and Windows
builds retain their own target identities. Chromium adds a sandboxed renderer,
Blink bindings, browser-process capabilities, resources, and product assembly.
It does not introduce a Chromium object format or a platform-specific compiler
backend.

The research objective is to host a ScriptC runtime in a Chromium renderer and
call Blink directly from statically compiled TypeScript:

```text
ordinary TypeScript + lib.dom.d.ts
                |
                v
       ScriptC frontend/checker
                |
     reachability + existing Native IR
                |
          C or LLVM lowering
                |
                v
       generated native application
                |
          typed extern "C" ABI
                |
                v
 generated Native TypeScript Blink capsules
                |
     binding-neutral Blink implementation seams
                |
                v
       real Blink DOM / Web APIs
```

The Native TypeScript binding path must not use V8 values, V8 DOM wrappers,
JavaScript functions, source evaluation, dynamic property lookup, or a generic
command bridge. Stock Chromium may still host ordinary JavaScript realms; that
is separate from the compiled application's binding path.

Synchronous Web APIs stay renderer-local and synchronous. Browser-process
authority crosses the existing security boundary only through finite typed
asynchronous capabilities.

## Semantic authorities

Three inputs have different owners.

### TypeScript standard libraries

`lib.dom.d.ts` and related libraries define what application source can say
and how the TypeScript checker resolves interfaces, members, overloads, and
source types. They are source declarations, not the Blink ABI.

### Blink WebIDL

Chromium's normalized `web_idl_database` from the exact pinned revision
defines Blink inheritance, overloads, dictionaries, unions, callbacks,
extended attributes, exposure, implementation names, and runtime conditions.
It is the implementation-semantic input for Chromium binding generation.

The digest of that database and the Chromium commit are mandatory provenance.
The WebIDL compiler is used from the pinned checkout rather than copied or
forked here.

### SCABI and Native IR

The WebIDL generator projects the reached supported surface into ordinary
TypeScript declarations, SCABI, and verified adapter capsules. SCABI may carry
versioned Blink extensions for facts such as exposure, implementation call
plans, and execution-context requirements. Extensions cannot override common
ownership, thread, type, or outcome semantics.

ScriptC consumes declarations and SCABI through its existing binding path.
Native IR remains closed, target-independent, and compiler-owned. A
deterministic normalized WebIDL snapshot or coverage report may exist inside
`bindgen-webidl`, but it is not a parallel compiler-facing “Native Web IR”.
When Blink exposes a genuinely new semantic category, the owning general
vocabulary is extended and validated first.

## Binding generator

Native TypeScript is a sibling output of Chromium's existing normalized WebIDL
pipeline, not an independent raw-IDL compiler:

```text
Blink *.idl
    |
    v
Chromium web_idl compiler
    |
    v
normalized web_idl_database
    |
    +-----------------------------+
    |                             |
    v                             v
Blink bind_gen                 nts_bind_gen
    |                             |
    v                             +-- declarations
V8 bindings                      +-- SCABI + Blink extensions
                                 +-- typed C declarations
                                 +-- direct Blink C++ capsules
                                 +-- coverage/refusal report
```

The generator computes stable interface, member, overload, callback,
dictionary, union, and enum identities. It emits precise refusal diagnostics
for unsupported reached semantics. It never falls back to a dynamic
`invoke(handle, name, values)` operation.

Whole-program reachability remains ScriptC's responsibility. Reached SCABI
binding IDs select the generated capsules and their closed dependencies.
Unreached Web APIs need not enter an application artifact.

## Realm and owner executor

One `NtsWebRealm` binds one ScriptC runtime instance to one Blink
`ExecutionContext`. The realm is confined to the Chromium sequence that owns
the context. Only that executor may:

- enter the ScriptC heap;
- resolve or mutate Blink-backed handles;
- call thread-affine Blink implementations;
- deliver callbacks and promise settlements;
- alter subscriptions or Oilpan roots;
- invalidate or destroy the realm.

Wrong-sequence synchronous access fails. It is never repaired by silently
posting an asynchronous task.

Chromium remains the scheduler. ScriptC participates in declared task and
microtask checkpoints; it does not run a competing browser event loop.

### Renderer runtime personality and suspension

`chromium-renderer` is a library/runtime personality over the existing C and
LLVM backends, not a third machine-code backend. The frontend still produces
the same Native IR and both backends consume one shared hosted-async transform.
Native executable profiles retain ScriptC's stackful fiber implementation;
renderer profiles do not link or invoke it.

The hosted transform splits a suspending `async` function into ordinary typed
step functions. A synthetic cycle-traced record owns the locals live at each
`await`, the result promise, the awaited promise, and—when the function is
lifted—the closure environment. PromiseCore owns that record while suspended.
Settlement enqueues one native continuation through Blink's
`EventLoop::EnqueueMicrotask`, so ScriptC reactions and page/V8 microtasks share
one FIFO checkpoint. No raw Blink or frame-bounded handle may enter a
continuation record.

The first executable lowering supports eager async prefixes, typed promises,
non-Promise await hops, multiple/nested awaits, lifted closure environments,
and suspending `if`/`else` control flow. Unsupported lazy expressions, loops,
promise-or-unit/dynamic awaits, boxed locals, generators, and suspension across
`try`/`catch`/`finally` fail closed at compilation. Those cases are admitted
only as the shared state-machine vocabulary grows; neither backend may fall
back to a fiber in a renderer profile.

Realm invalidation first closes scheduler admission and cancels every parked
continuation frame. A Blink microtask accepted before invalidation still runs
the runtime cancellation job, but cannot re-enter an invalid realm.

Navigation, frame detachment, or context destruction closes admission,
cancels registrations and pending async work where permitted, invalidates all
realm-backed managed handles, releases Oilpan roots on the owner sequence,
stops the ScriptC instance, and then destroys the realm.

## Object identity and ownership

Blink/Oilpan owns Blink objects. Native TypeScript owns only the strong GC edges
required by live managed references.

Product work uses ScriptC's existing native-handle cells, aliasing, disposal,
retained callbacks, and owner-executor contracts. A Blink-side registry backs
those cells with Oilpan roots and generated type descriptors. It must provide:

- realm affinity and context-wide invalidation;
- stable identity interning for repeated acquisition;
- generated exact-type checks and WebIDL upcasts;
- release of the corresponding Oilpan edge at the final managed release;
- deterministic teardown on the owner sequence.

The current managed node peer uses Blink's stable `DOMNodeId` as a realm-local
hash key, so repeated acquisition is expected O(1). The hash is non-owning;
the canonical peer's `Persistent<Node>` remains the sole Oilpan root, and the
entry is removed before that root is released or invalidated.

Compiler-proven immortal UTF-8 strings use a parallel value-boundary fast
path. SCABI supplies an opaque non-zero static identity beside the borrowed
data and length; computed strings supply zero. Each realm caches decoded Blink
`String` and `AtomicString` values by that token and clears both caches during
invalidation. The token is never dereferenced and the ordinary bytes remain
the semantic value, so this avoids exposing ScriptC's string layout while
removing repeated literal decoding and atomization.

The imported prototype's independent table is retained only as an executable
oracle. Its handles now carry realm, slot, and generation so the oracle can
actually prove wrong-realm refusal and context invalidation. It remains
unsuitable as the product managed-handle representation because ScriptC owns
managed cells, aliasing, disposal, and closure reachability.

## Typed ABI and capsules

Generated entry points use statically identified C symbols. A capsule may:

- validate realm and executor state;
- resolve a typed receiver through the Blink backing registry;
- perform exact WebIDL conversions and defaults;
- check exposure and runtime feature state;
- create binding-neutral exception, realm, callback, or promise adapters;
- call the exact Blink implementation method;
- intern returned interfaces;
- translate success or failure into the compiler-owned boundary algebra.

A capsule may not decide reachability, closure escape, ScriptC heap ownership,
application partitioning, or generic scheduling semantics.

WebIDL values map through existing native types where their semantics match.
`DOMString` requires a code-unit-preserving representation, `USVString`
requires scalar-value normalization, and `ByteString` requires checked byte
semantics. The prototype's universal UTF-8 view is scaffolding only.

No C++ exception unwinds through C or ScriptC frames. DOMException, TypeError,
RangeError, SyntaxError, security failure, disabled operation, and internal
target failure remain distinguishable through the common outcome model.

## Horizontal Blink seams

Scalability depends on a few binding-neutral mechanisms rather than one manual
Blink overload per member:

- an exception sink that preserves existing V8 behavior and can also record a
  ScriptC-visible failure without creating V8 values;
- a binding realm/context abstraction that supplies execution context, owner
  task runner, realm identity, exception construction, and promise settlement;
- a binding-neutral async resolver that can settle either a V8 promise or a
  ScriptC promise directly;
- Oilpan-aware native callback implementations that enter the realm gateway.

An API that genuinely consumes or produces arbitrary JavaScript values remains
unsupported until its semantics exist in the native value algebra.

Patch count is a measured maintenance cost. The first stock-Blink compile used
no product patch: the invalid-name `createElement` fixture used Chromium's
existing `DummyExceptionStateForTesting`, and native event listeners used the
stock activity-logger path. That proved no per-method exception overload and no
listener patch were needed. Product code admits one horizontal patch: a data
sink in existing `ExceptionState` that captures code, sanitized message, and
unsanitized security message without constructing a V8 value.

Durable patches are split into product and fixture profiles. The
`content_shell` counter hook is fixture-only and must disappear when the
Native TypeScript-owned Content host exists. Per-method overloads and parallel
exception classes remain outside the accepted scaling strategy.

## Events and promises

An event registration connects a reached compiled closure to a typed generated
callback stub and a native Blink `EventListener`. Delivery occurs on the realm
sequence and materializes only the reached event payload.

The connection is an owned resource. Removal must match Web listener identity
and options, unregister the exact Blink listener, and then release the retained
callback. Realm shutdown cancels every connection before callback storage is
destroyed. The prototype's one-new-listener-per-registration subscription token
does not yet prove duplicate-listener or `removeEventListener` semantics.

There are two compiler-selected ownership tiers. A registration that escapes
its synchronous function uses a stable ScriptC native-handle cell and a traced
callback edge. When Native IR proves that a local registration is cancelled
exactly once before return, with no suspension, escape, mutation, or later use,
the C and LLVM backends transfer a direct callback context to Blink and retain
only the raw frame-owned subscription. Blink removes the listener, closes
callback admission, and invokes the supplied context release exactly once on
explicit cancellation, registration failure, or realm teardown. This scoped
path stores the retained closure directly in Blink's subscription, removing
both the stable handle/lifecycle allocation and a standalone callback wrapper
without weakening the escaping path or allowing a raw Oilpan pointer across
`await`.

Blink promises settle ScriptC promises directly through a binding-neutral
resolver. Compatibility evidence must pin observable ordering between the
current turn, Blink tasks, callback/promise ingress, ScriptC microtasks,
subsequent Chromium tasks, and rendering.

## Process and capability boundary

The sandboxed renderer owns Blink, the realm, generated capsules, the ScriptC
runtime, and compiled application code. Privileged application features stay
in the trusted browser process unless Chromium already exposes them safely in
the renderer.

Filesystem access, process execution, application windows, menus, dialogs,
updates, and unrestricted OS integration use finite typed asynchronous
capabilities over Mojo or an equivalent generated transport. DOM objects, Blink
pointers, and ScriptC closures never cross the process boundary.

## Build and provenance

The final build is an artifact graph rooted in the Native TypeScript checkout:

```text
pinned Chromium checkout + WebIDL database
        |
        +-- bindgen-webidl -> declarations + SCABI + capsules + report
        |
TypeScript application
        +-- ScriptC -> C/LLVM object + reached binding IDs
        |
Chromium runtime/host/patch inputs
        |
        v
declared GN/Ninja actions -> sandboxed renderer product
```

Every result identifies the Native TypeScript commit, ScriptC submodule commit,
Chromium commit, GN arguments, toolchain versions, WebIDL database digest,
TypeScript library digest, SCABI manifest digest, reached binding set, runtime
contract version, build target, command, and exit status.

A disposable Chromium checkout is build input. Durable patches, generator
sources, runtime code, and host code live in this repository. Product actions
must not mutate an unknown user checkout or discover decisive tools
incidentally from `PATH`.

## Performance falsifier

The direct-Blink path exists to approach native call performance, so semantic
success alone does not admit the target. Every measurement uses the same
pinned Chromium build, DOM operations, fixture data, warmup policy, sample
count, and renderer conditions across these lanes:

1. handwritten C++ calling Blink directly, which defines the implementation
   ceiling;
2. TypeScript compiled by ScriptC's C backend and calling generated typed Blink
   capsules;
3. TypeScript compiled by ScriptC's LLVM backend and calling the same capsules;
4. ordinary JavaScript using Chromium's generated V8 DOM bindings;
5. an optional IPC/command bridge only when a conventional bridge comparison
   becomes useful.

Boundary-only microbenchmarks isolate call and conversion overhead. Mixed
workloads include realistic DOM construction, mutation, query, event delivery,
and teardown so an optimized empty call cannot hide application costs. Reports
record median, p95, allocation counts, artifact identity, and raw observations.

The first implemented falsifier fixture fixes one operation,
`document.createElement("div")`, and two invocation shapes: an exported
one-call primitive and an exported batch whose inner loop repeatedly crosses
the typed native boundary. ScriptC emits C and LLVM archives from the same
TypeScript kernel. The Chromium target then combines and localizes each
archive's reached runtime with the pinned LLVM tools, leaving only its
backend-specific entry symbols global; this permits both compiled lanes and
the handwritten C++ ceiling to live in one release `content_shell`. A static
page script owns the V8 lane. The runner uses CDP DOM, Page, and Target
commands only and records raw samples with build and artifact digests. The
official non-component `content_shell` fixture has completed a full ThinLTO
build with `chrome_pgo_phase=0`; its final link includes both localized
archives, whose exported symbols exactly match their declared surfaces. This
is verified build evidence, not measured performance evidence.

For each initial synchronous primitive, both compiled TypeScript lanes must
have median and p95 latency no more than 25% above handwritten C++. Across the
boundary-heavy aggregate they must be at least 15% faster than the V8 lane, and
no individual initial workload may be more than 10% slower than V8. Generated
scalar capsules additionally fail structural review if they use generic
dispatch, V8 values, avoidable boxing, or per-call heap allocation. These are
admission gates, not claims about the current specimen.

## Current specimen and acceptance gates

The migrated specimen is under
[`packages/target-chromium`](../packages/target-chromium/README.md). Its
portable C tests and source-level patch/V8 gates pass. The repaired patch series
also applies to the pinned remote sources. The product profile contains one
binding-neutral `ExceptionState` capture seam; the only fixture patch is the
`content_shell` hook.

The pinned overlay has now completed a real component-debug `content_shell`
build with symbols disabled. The stock path and the product-patched path both
passed the script-free CDP acceptance lane in the built browser: a real input
event changed the rendered counter from `Count: 0` to `Count: 1`, the
DOMException probe completed, navigation produced explicit teardown, and the
product path retained distinct sanitized and privileged SecurityError
messages. The admitted product seam changes `exception_state.cc` and adds an
optional capture header; it leaves the central `exception_state.h` contract
unchanged. No event-listener patch is required.

The same pin has also completed the official non-component release fixture.
Its resolved arguments include `is_official_build=true`, `is_debug=false`, and
`is_component_build=false`; both ScriptC backend archives and all four lane
selectors are present in the final artifact graph.

The first controlled performance run passed all initial admission gates. The
subsequent application matrix now covers create, detached and attached DOM
construction, retained text, selector mutation, synchronous event lifecycle,
and component-shaped lists in both exported-per-call and compiled-loop shapes.
Every tuple uses a fresh renderer, CPU affinity to one performance core,
rotated lane order, three repetitions, and 30 checked samples per repetition.

Compiler-proven frame callback storage and conditional static string identities
reduce strict performance violations from the initial matrix's 22 to 3.
Retained text compiled medians are 0.683x handwritten C++ and about 0.98x V8;
eight-row construction is 1.053–1.054x C++ and 0.731–0.732x V8; attached mount
is 1.028–1.036x C++ and 0.777–0.783x V8. Two reproducible failures are the
create-element per-call p95 ratios at 1.299x/1.313x C++. The third full-matrix
failure, an LLVM event median at 1.137x V8, passes at 1.046x in a focused rerun
of the exact artifacts and remains recorded as variance rather than being
discarded. This is representative evidence for the reached surface, not a
general DOM-performance or compatibility claim.

The first closed normalized WebIDL slice reaches exactly
`Document.createElement(DOMString)`. It deterministically generates TypeScript
declarations, valid SCABI, and a typed C++ capsule, and the reached binding
translates through ScriptC's existing Native IR input. Pinned Chromium clang
evidence fixes the realm-tagged handle and result-envelope layouts and their
aggregate calling convention. The raw binding currently exposes a
status/handle envelope; projecting its detailed DOMException payload into the
compiler-owned public outcome algebra remains open.

These fixtures build the complete `content_shell` dependency graph, not the
larger `chrome` product target. They now prove a renderer-hosted ScriptC runtime
for both backends, ScriptC-owned Oilpan peers with O(1) identity interning and
realm invalidation, detailed DOM failure capture, direct native event
delivery and teardown, stackless typed awaits on Blink's shared microtask
queue, and the representative matrix above.

The host remains fixture-owned rather than the final Content embedder. Product
work therefore remains: attach the existing renderer runtime personality
through a final Content lifecycle provider, broaden reached-only WebIDL
generation, project captured detailed DOM failures, complete DOMString
code-unit semantics and event options/identity, add typed native resolvers for
suitable asynchronous Web APIs, and expose only finite browser-process
capabilities through Mojo. Hard V8-semantic APIs may use a visible
compatibility tier, but the reached synchronous DOM path remains typed direct
Blink.
