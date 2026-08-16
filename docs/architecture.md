# Architecture

Status: normative pre-1.0 architecture  
Last revised: 2026-08-14

This document defines the system boundaries and invariants that implementation
must preserve. Focused specifications may add detail but may not weaken these
rules.

The key words **must**, **must not**, **should**, and **may** are normative.

## Mission

Native TypeScript extends scriptc so TypeScript can be used across the native
software stack: executables, servers, native libraries, operating-system APIs,
desktop, mobile, and terminal applications, native UI, React renderers,
isolated services, and potentially the real browser DOM.

The project optimizes for a clean, high-performance architecture with explicit
semantics. It does not preserve unpublished internal APIs when a refactor finds
a better boundary.

## Goals

- Compile supported TypeScript and TSX ahead of time to native machine code.
- Preserve JavaScript-observable behavior where the static language profile
  promises it.
- Expose low-level native platforms without forcing a framework.
- Make native ABI, ownership, threading, errors, and process transitions
  visible to the compiler and developer.
- Generate repetitive platform glue from validated metadata.
- Allow independent targets without turning every target into a scriptc fork.
- Produce native libraries as well as packaged applications.
- Make performance, compatibility, authority, and generated artifacts
  inspectable.

## Non-goals

- Accept every JavaScript program statically.
- Hide a JavaScript engine behind unsupported operations.
- Emulate every platform through one lowest-common-denominator UI API.
- Make native pointers appear memory-safe.
- Promise transparent object identity across runtimes or processes.
- Reimplement platform linkers, DEX compilers, Xcode, Gradle, or equivalent
  tools when a reliable platform toolchain already owns that job.
- Freeze public APIs before the underlying contracts have passed conformance
  gates.

## System invariants

### Static execution is explicit

Every reachable operation in an AOT-only build must either lower statically or
produce a precise diagnostic. A dynamic compatibility realm is an explicit
build input, a separate runtime domain, and visible in the build report.

### Syntax and semantics are separate promises

Applications use ordinary TypeScript syntax. Static execution follows the
documented Native TypeScript language profile, which may be narrower than the
behavior accepted by a JavaScript VM. No limitation is silently inferred from
scriptc's current implementation.

### The compiler owns semantics; targets own platform realization

The compiler owns language semantics, generic specialization, control flow,
effects, native value categories, ownership operations, callback operations,
partitions, validation, and backend-independent diagnostics.

Targets own platform binding discovery, native ABI lowering, scheduler
adapters, generated glue, resources, toolchain inputs, and packaging.

If several targets need a semantic operation, it belongs in the generic
compiler model. A target must not encode new language semantics in an opaque
code-generation callback.

### Native boundaries are declarative

Native declarations resolve to immutable, validated binding records before
lowering. Arbitrary executable code is forbidden in binding manifests.
Generated adapters are declared artifacts with provenance and cache keys.

### Runtime heaps are owner-confined

Each ScriptC runtime instance has exactly one owner executor. Only work running
on that executor may access the instance's heap. Foreign threads communicate by
copying transport-safe values into a scheduler gateway.

Multiple runtime instances may execute concurrently, but do not share ordinary
heap objects. Shared memory, if introduced, uses explicit native buffer types
with separately specified synchronization.

### Native resources are handles

Managed native resources are represented by opaque, generation-checked
handles. The runtime enforces lifetime, identity, thread affinity, process
affinity, and disposal. Compiler analysis improves diagnostics but is not the
sole safety boundary.

### Cross-domain communication is asynchronous and authorized

Cross-process calls use typed operations and a closed transport-safe value
algebra. The build's reachability graph may remove unused operations, but an
explicit policy grants authority. Raw pointers and implicit shared object
identity never cross a domain boundary.

### Builds are artifact graphs

A native application build is not a single compiler invocation. It is a
deterministic directed acyclic graph of language IR, native IR, objects,
archives, generated adapter sources, metadata, resources, platform compilation,
linking, signing, and packaging.

### Compatibility is measured

Claims such as Node compatibility, React compatibility, or DOM compatibility
must name a version and a conformance suite. Source-level similarity alone is
not compatibility.

## Compilation model

```text
source graph
    │
    ▼
TypeScript parse, bind, and type check
    │
    ▼
ScriptC language IR
    │   JavaScript/TypeScript semantics only
    ▼
whole-program analysis
    │   reachability, specialization, effects, ownership, partitions
    ▼
Native IR
    │   generic calls, layouts, handles, callbacks, scheduling, transport
    ├───────────────┬──────────────────┬────────────────────┐
    ▼               ▼                  ▼                    ▼
LLVM/C lowering  native adapters   domain interfaces   build resources
    └───────────────┴──────────────────┴────────────────────┘
                            │
                            ▼
                       artifact graph
                            │
                            ▼
             executable / library / application / SDK
```

### Source graph

The source graph contains application modules, statically compiled dependency
modules, type declarations, platform-selected modules, and explicit dynamic
realm boundaries. Platform resolution is complete before semantic lowering.

### Language IR

Language IR represents supported TypeScript and JavaScript behavior without
embedding a particular native toolkit. Existing scriptc host operations must be
progressively separated from the language value model where necessary.

The language IR must remain serializable, validated, and source-located.
Changes to its schema require deterministic cache invalidation.

### Whole-program analysis

Analysis computes:

- reachable functions, types, bindings, and adapters;
- generic specializations;
- effects and required schedulers;
- ownership transitions and escaping borrows;
- partition membership and cross-domain interfaces;
- required runtime features;
- static versus dynamic coverage.

Analysis results are immutable inputs to lowering. A target may describe the
effects and constraints of its bindings, but may not mutate the program graph.

### Native IR

Native IR is a target-independent contract for native semantics. Its operation
families include:

- exact scalar values and explicit conversions;
- native aggregate construction, access, and copying;
- statically identified native calls;
- statically identified C-callable library exports;
- opaque handle creation, retain, release, weak upgrade, and disposal;
- host-created native peer attachment, virtual override entry, and exact native
  base calls;
- call-scoped and retained callbacks;
- scheduler hops and callback delivery;
- remote calls, remote handles, transferable buffers, and streams;
- explicit unsafe pointer operations.

Native IR is closed and versioned inside the compiler. Targets lower these
operations; they do not inject unvalidated arbitrary IR. When a platform needs
a genuinely new semantic category, Native IR is extended with validation,
analysis, and backend tests first.

A native call separates logical source arguments from physical ABI parameters.
Each source argument is evaluated exactly once; validated parameter projections
then select or derive the ABI slots in declaration order. Implemented
one-to-many projections map either a ScriptC UTF-8 string or an exact
`Uint8Array` view to a borrowed const data pointer and byte length. The byte
projection reads the view's current pointer and length directly, including a
nonzero offset into a retained owner; the logical argument remains alive through
the call and is released immediately afterward. A call-scoped callback uses the
same logical-to-physical rule: one exact compiled function argument projects to
a C function pointer and a required trailing context pointer. The context is the
borrowed closure itself, so captures and nested/reentrant native calls preserve
identity without thread-local state. The callback may run synchronously only on
the native call's caller, and both physical values expire when that call
returns. A thrown callback exception stays in ScriptC's pending-exception cell;
the trampoline returns an ABI-zero placeholder and the outer native call enters
ordinary compiler-generated unwinding. Physical foreign-pointer, callback, and
context types are ABI-only and are not members of the TypeScript/language-IR
value model.

A projection may also change a slot's source carrier without changing the slot.
A position over an integer of at most 32 bits may declare that its source
carrier is an ordinary `number`: an argument is checked into the exact slot at
the boundary and raises a catchable `TypeError` when the value is not finite,
integral, and in range. The declaration is data in the manifest — no analysis
may infer it — and the width bound is enforced by validation, because a double
carries wider integers non-injectively.

Results make the logical/physical separation explicit too. Direct results
preserve their exact native value type. A checked-number result widens its
exact slot into a plain number, which cannot fail and therefore requires a
non-failing binding. A borrowed C-string result instead records a physical
const pointer, a named receiver lifetime anchor, and a UTF-8 projection to
logical `string` or `string | null`. Both backends copy the bytes before
releasing logical arguments, so no foreign pointer becomes a TypeScript
value.

Applications compose independently translated SCABI packages before invoking
the compiler. Composition requires one exact target, canonicalizes ordering,
coalesces only structurally identical source/type/binding/export identities,
and carries the union of link and adapter requirements beside the merged
frontend input. Identity conflicts therefore fail before frontend map
construction or artifact planning can become order-dependent.

Target independence does not mean target facts are implicit. A module that
reaches target-dependent Native IR records the validated ABI facts needed to
interpret generic operations. For example, `isize` and `usize` remain distinct
Native IR types while the module's pointer width determines their bounds and
backend representation. Nominal aggregate definitions carry authoritative
size, alignment, field offsets, and the target compiler's complete physical
identity-function signature. ScriptC therefore lowers direct registers,
expanded values, ordinary indirect pointers, copied `byval` parameters, and
hidden `sret` storage without reproducing platform size heuristics. The
compiler rejects disagreement between those facts and the selected
code-generation target.

### Artifact graph

Lowering produces typed artifact nodes rather than writing files as a side
effect. The build planner validates the complete graph before the executor runs
external tools. See [Build artifacts](build-artifacts.md).

## Component boundaries

### scriptc fork

The fork owns generally reusable compiler and runtime capability:

- frontend and language IR changes;
- Native IR and validation;
- exact native scalar support;
- ownership and callback operations;
- runtime instance and scheduler gateway primitives;
- backend support;
- static coverage and conformance diagnostics;
- the stable integration hooks required by target providers.

Changes should be independently reviewable and upstreamable when they benefit
scriptc generally. Current scriptc limitations are evidence, not permanent
requirements. See [scriptc evolution](scriptc-evolution.md).

### Native TypeScript workspace

This repository owns platform composition:

- target provider contracts;
- SCABI schemas and generators;
- target packages and SDK projections;
- application build planning;
- platform runtime adapters;
- generated native subclasses, protocol/interface adapters, and application
  lifecycle registration;
- packaging;
- framework renderers;
- capability policy and domain planning;
- cross-target conformance suites.

### Package roles

The initial workspace roles are:

- `@native-typescript/bindgen-c`: target-neutral structured C candidates,
  combined function/record Clang probe generation, authoritative selected
  record layout and calling classification, and canonical ABI evidence;
- `@native-typescript/scriptc`: typed integration with the pinned compiler fork;
- `@native-typescript/target-api`: provider contracts and immutable target
  descriptions;
- `@native-typescript/scabi`: the closed binding model, canonical serializer,
  schema validation, and semantic validation;
- `@native-typescript/core`: target-neutral build planning, validation, and
  orchestration — the artifact graph, its sandboxed executor, and the action
  cache, including the record of undeclared files an action read that decides
  whether a cached result may be reused;
- `@native-typescript/cli`: user-facing commands and reports. `build` reads a
  project description and produces an executable; everything it knows about a
  target it gets from that target's package;
- `@native-typescript/bindgen-gir`: the GObject-introspection binding family —
  GIR ingestion, GObject adapter generation, and the GObject SCABI/declaration
  projection. It is a binding family rather than a toolkit: GIR describes Gio,
  GLib, GObject, GStreamer, and every other introspected library, so nothing in
  it may depend on GTK;
- `@native-typescript/target-gtk`: the GTK target itself — the GLib
  main-context runtime adapter, the process bootstrap that initialises GTK and
  attaches that runtime, the target's own binding package for both, its native
  object fragment, provider and packaging metadata, the GTK project
  description, and the application build pipeline that turns one into an
  executable.

  The pipeline lives here because every decision in it is a GTK decision:
  which namespaces to generate, which objects to link, what the bootstrap
  requires of the compiler. The cost is that the command line names this
  package directly, which is the same gap recorded as the Target SPI carrying
  no planning behavior — a second target is what would force the seam, and
  inventing it before then would be guessing at its shape.

Future packages should be created around stable ownership boundaries, not one
package per small type. Likely additional boundaries include the runtime ABI,
other binding families, individual targets, the terminal engine, a direct TUI,
and framework renderers.

## Target composition

A target is a composition of providers, not one mutable plugin object:

```text
TargetDescriptor
BindingProvider[]
NativeLoweringProvider
RuntimeProvider
ArtifactProvider[]
Packager
```

Providers declare capabilities and version requirements. The planner resolves
them once, rejects conflicts, and freezes a target plan. Details are defined in
[Target SPI](target-spi.md).

An application-environment profile may add public package roots, runtime
features, transport adapters, and artifacts to an OS target. It does not create
a second ABI identity or runtime provider. Terminal applications use this
composition: `linux-x86_64`, `darwin-arm64`, or `windows-x86_64` remains the
target, while the terminal profile adds the relevant session transport and TUI
surface.

## Framework position

Framework integrations consume public compiler/runtime capabilities:

```text
application
    ↓ optional
React / renderer / framework package, or direct TUI
    ↓
target declarations and native bindings
    ↓
Native IR and target runtime
```

A renderer must not gain privileged compiler hooks unavailable to ordinary
target packages. Compiler changes required by React must be justified as
general language compatibility work.

## Platform direction

### C and native libraries

The C ABI is the first conformance target because it validates layouts, calls,
errors, exported functions, callbacks, and ownership without adding a managed
platform runtime.

### Native desktop and mobile

GTK/GObject, Windows/COM/WinRT, Android/JNI, and Apple/Objective-C use the same
Native IR while providing platform-specific binding schemas and runtime
adapters. Generated Java or Objective-C++ is compiled by the platform's normal
toolchain.

When the native application model is subclass-based, the public TypeScript
model is subclass-based. Android activities, Apple controllers/delegates, and
Windows application lifecycle objects use ordinary `extends`, `override`, and
`super` syntax. Generated native subclasses attach platform-owned instances to
managed peers and implement exact override/base-call dispatch; adapter ingress
functions are not exposed as the application API. See
[Native subclassing and platform lifecycle](native-subclassing.md).

### Terminal applications

A terminal is an application environment over an OS executable target, not an
ABI target. The public terminal engine owns transactional session state,
capability negotiation, bounded input parsing, Unicode cell semantics, screen
diffing, and platform transport normalization. A direct TUI and an optional
React renderer share one headless scene/layout contract above it. POSIX and
Windows transport details remain target integrations, and curses remains an
optional raw binding rather than the portable semantic layer. See
[Terminal application environment](terminal.md).

### React

Actual React and a pinned reconciler build are compatibility targets. They must
pass a static-coverage and behavioral conformance gate before a renderer is
declared supported. React is not required to validate the base ABI.

### DOM and Chromium

Direct Blink access remains an intended research direction, not a committed
foundation dependency. A feasibility program must first demonstrate execution
contexts, wrapper identity, lifetime, exceptions, events, promises, and task
ordering with no application JavaScript. The core architecture must remain
useful if this research concludes that direct Blink maintenance is not viable.

## Performance principles

- Native calls should lower to direct calls or the minimum platform-required
  transition after compile-time resolution.
- Ownership bookkeeping must be explicit and measurable.
- No generic reflection registry is shipped when reachability can specialize it.
- Cross-domain latency is visible in types, diagnostics, and traces.
- Release behavior is deterministic; optimization level must not change
  language semantics.
- Clean release builds may be expensive, but incremental builds reuse validated
  artifacts at the narrowest sound boundary.
- Performance claims require representative benchmarks and comparison against
  the relevant platform implementation.

## Security principles

- Native UI applications run in the platform application sandbox unless they
  opt into additional isolation.
- Untrusted or browser-facing domains are separate processes by default.
- Capability interfaces are finite, typed, authenticated to a caller, scoped,
  and validated by the privileged receiver.
- Generated code and prebuilt SDKs carry provenance.
- Unsafe pointer access is never implied by importing a normal binding package.
- Dynamic compatibility realms receive no authority not explicitly granted to
  their enclosing domain.

## Pre-1.0 refactor policy

The repository has no public compatibility obligation before 1.0. When an
internal contract changes:

1. update all producers and consumers in the same change;
2. delete the replaced representation and tests;
3. invalidate incompatible caches and manifests;
4. do not add deprecated aliases, dual readers, or silent migrations;
5. record the architectural reason in the affected specification.

Git history is the archive. The active tree contains only the current model.

## Decision rule

When choosing between a local shortcut and a generally correct primitive, use
the primitive if it is required by more than one credible target or corrects a
language/runtime invariant. A feature may be deferred, but the architecture
must not make it impossible or require platform-specific compiler forks later.
