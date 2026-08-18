# Foreign boundary effects for Native TypeScript: design exploration

**Status:** design exploration; leading direction, contingent on the
adapter-plus-LTO falsifier, completion of resource-domain and outcome
semantics, and one JNI conformance spike. No decision record has been filed.

**Date:** 2026-08-18. This is the second revision, incorporating external
review. It is a discussion artifact, not a normative document; it is
deliberately kept outside `docs/`, whose documents remain authoritative and
win on any conflict.

---

## Background

**Native TypeScript** compiles TypeScript to native executables — today, real
GTK 4 applications through both a C and an LLVM backend. It builds on
**scriptc**, a TypeScript-to-native compiler originally from Vercel
(`vercel-labs/scriptc`). We maintain a pinned fork (~95 commits ahead of
upstream) with the declared goal that the fork carries no downstream
identity: everything in it should be neutral compiler capability that
upstream could accept.

Bindings are described by **SCABI**, our binding manifest. The governing
boundary rule (decision record 0001): a fact belongs to scriptc's manifest
**iff it changes the machine code the compiler emits**; it belongs to SCABI
iff it only changes what gets built, linked, composed, or proven.

### Which prerequisites exist where

This distinction matters for any upstream conversation:

- **Public upstream scriptc** has: a structured IR shared by both backends;
  FFI formats that distinguish call-scoped and retained callbacks, track
  registration/release identity, and admit foreign-thread callback delivery.
  Its outbound FFI returns are **scalar-only**: pointer/string/byte returns
  are deliberately excluded because upstream has no ownership or allocator
  contract for them.
- **Our fork only** has: managed handle cells, destructor-as-data on handle
  types, owned foreign-object returns, the `NativeFrontendInput` embedder
  seam, and the three-axis error contract. Everything below that relies on
  these presumes the fork — or presumes the unification work that proposes
  them upstream has landed.

## The problem

We want four platform object models: GObject/GTK (running today),
Objective-C/ARC (Apple), COM/WinRT (Windows), and JNI (Android). Each has
its own rules for *how* objects are acquired and released (floating
references, autorelease pools, AddRef/Release, local vs. global refs) — but
the *when* (scope exit, last reference, unwind paths) is observable only
inside the compiler.

SCABI originally declared multi-platform vocabulary for this (`retained`,
`weak`, `autoreleased`, `process-proxy`; `hresult`, `nserror`,
`jni-pending-exception`; a `PlatformObjectType`). Commit `c43f261` deleted
it — correctly — because nothing lowered it: SCABI declared 51 variants and
lowered 23, letting a generator write contracts nothing could compile
(decision record 0003). Those platform nouns should not return as
compiler-level abstractions.

The question: how do the other three platforms get implemented without
asking scriptc's maintainers to host platform-specific code?

## What already works

GTK runs with **zero platform knowledge in scriptc**. Generated C adapters
normalize acquisition (`g_object_ref_sink` for floating references) and
define one release symbol per type; scriptc's neutral machinery decides
*when* to call the destructor, treating the symbol as data. The
floating-reference model — which no compiler knows about — cost zero
compiler changes. "Concept in the compiler, instance as data" is the seed of
everything below.

## Central thesis

> scriptc should own only those foreign-boundary effects that require
> compiler knowledge of control flow, liveness, escape, or unwind. Binding
> families generate a compiler-consumed effect contract and, where the call
> is ABI-sensitive, a verified ABI capsule. The compiler schedules regions,
> resource transitions, cleanup, and failure conversion; the capsule
> materializes the exact target call. SCABI derives and proves the contract
> — parsing platform metadata, probing headers, carrying evidence and
> diagnostics vocabulary — but scriptc defines the contract's closed
> semantics and is its semantic owner.

The decisive rule, in one line:

> **Control-flow and liveness semantics belong in scriptc. Exact target ABI
> mechanics belong in generated, verified capsules. Platform metadata and
> evidence belong in SCABI.**

## Options considered

1. **Adapter normalization** — per-call generated C wrappers flattening each
   platform into the existing neutral algebra. Verified feasible for all
   three platforms (including weak references and thread affinity). Costs:
   JNI pays a per-call granularity tax (a local frame and mandatory
   global-ref promotion per call, where global refs are synchronized JVM
   structures and GC roots), and value-returning fallible calls need a
   generated TypeScript shim layer. **Right as the contingency, not the
   steady state** — only the compiler can choose a useful lifetime region or
   determine whether a value actually escapes.
2. **Direct platform knowledge in scriptc** — roughly double the compiler
   code, platform tables inside the compiler, a JVM/macOS/Windows CI matrix,
   and every platform SDK release potentially in the maintainers' bug queue.
   Its real advantages are operational (one-layer trust, edge-case agility),
   not performance. Not pursued.
3. **Foreign boundary effects + ABI capsules** — recommended, detailed
   below.

## The design

### Five coordinated dimensions

The compiler-consumed foreign-boundary contract has five dimensions:

| Dimension | Meaning |
|---|---|
| **Call target** | How the exact ABI call is materialized (descriptor or capsule) |
| **Execution context** | Thread/apartment capability, ambient acquisition, structured regions |
| **Resource protocol** | Ownership, lifetime domains and transitions, release, affinity, weak behavior, identity |
| **Outcome protocol** | Returns, out-slots, success classification, error capture/clear, output validity |
| **Call effects** | Reentrancy (none / may-callback / may-pump), suspension constraints |

The schema is a **closed algebra**: an operation reference names a typed
operation whose semantics scriptc knows; the manifest never becomes a
programming language, and no capsule or profile may introduce opaque IR
semantics.

**Admission rule** (the hard-won lesson of record 0003, stated as a
first-class constraint): *no field without a lowering behind it, and no
dimension admitted ahead of a real failing program.* The five dimensions are
the design's horizon; each arrives as an independent manifest/IR revision
carried by the platform slice that needs it — never as one large
platform-object subsystem.

### Structured regions, not paired operations

Regions are a structured IR construct — cleanup attached to the body, like a
compiler-internal try/finally:

```text
foreignRegion context, capacity {
    ...
}
```

Balancing is correct by construction; return, break, throw, and callback
failure share one cleanup mechanism; the validator stays small. The region
is chosen by **liveness analysis, not lexical scope** — a basic-block
interval, a loop iteration, a function invocation, or a larger
non-suspending segment, whichever liveness supports.

### A backend-neutral legalizer

Today's FFI lowering materializes lifecycle work independently in the C and
LLVM backends. Before adding cross-cutting effects, one pass legalizes them
once:

```text
foreign call + boundary contract
            ↓
structured boundary legalization
            ↓
ordinary calls, explicit outputs, cleanup regions, unwind edges
            ↓
C or LLVM backend
```

Both backends receive the same legalized plan; backend-specific code is
limited to materializing call targets and primitive operations. Whether this
pass exists likely determines whether the implementation stays near its
estimate or expands into duplicated backend state machines.

### ABI capsules

**Descriptor capsule** — ordinary C calls, JNI table calls, most COM vtable
calls: target kind, typed signature, calling convention, base/context
source, slot or symbol, target-triple constraints. The compiler emits the
call itself.

**Typed code capsule** — when exact ABI knowledge belongs to the platform's
own compiler: Objective-C message-send variants, the ARC return-value
handshake, complex aggregate conventions. The binding family generates a
small typed source unit, compiles it with the platform's Clang, and supplies
bitcode (LTO-inlined in the LLVM backend) or an object file (separately
compiled call in the readable C backend).

A capsule is **forbidden** from deciding TypeScript lifetime regions,
forcing per-call promotion, introducing local pools, or converting
script-level exceptions. It performs exact calling mechanics; compiler-owned
effects schedule lifetime and cleanup. This is what distinguishes capsules
from option 1's adapters.

The Objective-C case is why capsules exist at all: the
`retainAutoreleasedReturnValue` elision handshake requires Clang's codegen
cooperation (LLVM's `clang.arc.attachedcall` operand bundle, a marker
instruction on arm64) — source- or IR-level adjacency is not sufficient, and
reproducing Clang's ARC lowering in scriptc would be a substantial, fragile,
platform-specific undertaking.

### Outcome protocol

A call can have a native return, out-parameters, an independent
success/failure discriminator, an error payload that must be captured before
other operations, a required clear action, and rules for which outputs are
valid on which outcome. The contract models all of it:

- **JNI**: a null object result can be a *successful* result; failure is a
  pending-exception flag, and only a restricted set of JNI operations is
  legal until it is captured or cleared — so cleanup while an error is
  pending needs pending-error-safe classification, not "call every
  destructor."
- **COM**: status through `HRESULT` (only negative values are failure —
  `S_FALSE` is success), useful values through out-slots.
- **Cocoa**: useful return plus `NSError**` out-parameter with
  method-specific failure predicates, and ARC writeback rules on certain
  out-parameters.

This is why a probe-only first slice would be redesigned immediately: the
outcome protocol ships whole, and it is immediately useful for plain C and
GTK as well (it retires the current "throwing adapters limited to info-free
results" restriction).

### Resource protocol

Ownership plus **lifetime domains and transitions**, replacing a single
promote/demote pair:

- JNI: local frame → parent frame (`PopLocalFrame(result)`), local → stable
  (`NewGlobalRef`), stable → released (`DeleteGlobalRef`, thread-context-
  aware), weak-global as a distinct domain with fallible upgrade.
- Affinity: none / current-thread / a named context.
- Identity as a protocol on the resource type:
  `pointer` | `projection(op)` (COM: project to the stable `IUnknown`
  identity, itself an owned reference) | `equivalence(op)` (JNI:
  `IsSameObject`; raw `jobject` pointer comparison is meaningless under a
  moving GC). Intern tables may stay in the binding runtime; the compiler
  needs identity only where it affects optimization or release scheduling.

### Execution context and call effects

`JNIEnv*` is a **thread capability**, not a per-region value: valid for the
current attached thread, with acquisition boundaries, foreign-thread entry
rules, and conditional cleanup (only a thread the native runtime attached
should be detached by it). Regions and capabilities are different concepts
and the contract keeps them apart.

Call effects are first-class because a resource can be live and correctly
counted yet illegal to use here: COM STA calls can pump messages and
re-enter application code mid-call; local references must not cross an
`await`. The contract states reentrancy (`none` / `may-callback` /
`may-pump`) and suspension crossing (`forbidden` / `allowed`), and the
compiler uses them to decide whether a ledger transaction may stay open
across a call and whether a value may live across a suspension point.

### The threading model underneath

The dimensions above describe threading *facts about calls and resources*.
They sit on a runtime threading architecture (normative in
`docs/runtime-and-threading.md` and `docs/architecture.md`) that this
document otherwise assumes; stated here because every platform's threading
story reduces to it:

1. **Owner-confined execution.** Runtime heaps are owner-confined: every
   native call and every destructor runs on the runtime instance's owner
   executor. There is no cross-thread handle sharing to police, because
   handles never leave the owner.
2. **The owner executor *is* the platform's affine context.** The GTK main
   context, the Android main Looper, the Apple main run loop, and a COM STA
   are the same fact instantiated four ways. When the owner executor is the
   platform's affine thread, main-thread-only and apartment-affine rules are
   satisfied structurally — acquisition, use, and release all happen there.
   This is why apartment affinity appears in the contract as *data* rather
   than as a lowering.
3. **Foreign-thread callbacks enter through the ingress gateway.** Platforms
   deliver callbacks on threads the runtime does not own — JVM worker
   threads, GCD queues, COM MTA pool threads. These never run compiled
   TypeScript in place; they enqueue through the foreign-ingress seam and
   wake the owner. The wake adapter is a small target-supplied primitive:
   the GLib wake adapter exists today; Android needs an `ALooper` source,
   Apple a run-loop/dispatch source, Windows a message or APC. The contract
   distinguishes same-as-caller delivery (the platform calls on the owner)
   from queued delivery (foreign thread → owner), and queued payloads follow
   the copy/retain transport rules the callback contracts already carry.
4. **Multi-affinity applications use multiple runtime instances**, one per
   affine context, communicating by value — the architecture's existing
   answer, with nothing platform-specific in it.
5. **Thread capabilities absorb the remainder**: `JNIEnv` acquisition on the
   owner, attach only for threads the native runtime itself created (and
   detach only those), and context-aware destruction — `DeleteGlobalRef`
   requires an attached thread, which owner-confined destruction already
   guarantees.

What stays platform work rather than contract work: blocking calls that
would starve the owner loop (declared blocking, then refused or dispatched —
the current translator already refuses undeclared cases), worker-owned
instances calling main-thread APIs through an explicit dispatch escape hatch
with documented deadlock discipline, COM cross-apartment marshaling through
the reserved agile-reference path, and the reentrancy and suspension gates
listed under Risks.

## Worked example: JNI

Profile fragment — **generated by parsing `jni.h`, verified by a Clang probe
against it, never hand-authored**. (The first draft of this document
hand-wrote these numbers and got `ExceptionClear` wrong — slot 16 is
`ExceptionDescribe`; `ExceptionClear` is slot 17. External review caught it.
That error is the entire argument for the generation-plus-probe rule, made
flesh.)

```jsonc
{
  "context":  { "capability": "thread", "acquire": "scr_boundary_env" },
  "region":   { "enter": {"slot": 19, "capacity": true},   // PushLocalFrame
                "exit":  {"slot": 20} },                   // PopLocalFrame
  "target":   { "form": "context-table" },
  "outcome":  { "discriminator": {"form": "flag", "check": {"slot": 228}},  // ExceptionCheck
                "capture": {"slot": 15},                   // ExceptionOccurred
                "clear":   {"slot": 17} },                 // ExceptionClear
  "domains":  { "transitions": [
                  { "from": "region", "to": "stable",   "op": {"slot": 21} },  // NewGlobalRef
                  { "from": "stable", "to": "released", "op": {"slot": 22} }   // DeleteGlobalRef
              ] }
}
```

Intended emission for a scope that constructs a `TextView` (escapes) and
passes a temporary string (does not):

```c
void **env = scr_boundary_env();            /* thread capability, once      */
/* foreignRegion: compiler-selected extent, capacity from liveness */
TABLE(env, 19)(env, 4);
void *label = TABLE(env, SLOT_NEWOBJECT)(env, CLS_TEXTVIEW, MID_CTOR, act);
if (TABLE(env, 228)(env)) goto unwind;      /* outcome, fused with unwind   */
void *s = TABLE(env, SLOT_CALLOBJ)(env, act, MID_GETSTRING, ID);
if (TABLE(env, 228)(env)) goto unwind;
TABLE(env, SLOT_CALLVOID)(env, label, MID_SETTEXT, s);
if (TABLE(env, 228)(env)) goto unwind;      /* s: never leaves the region   */
void *label_g = TABLE(env, 21)(env, label); /* transition: region → stable,
                                               only because it escapes      */
TABLE(env, 20)(env, NULL);

unwind:                                     /* pending-error-safe pad:      */
  /* capture (15), clear (17), transition the throwable to stable,
     exit the region, convert to the script exception path — using only
     operations legal while the error is pending                            */
```

One compiler-selected region instead of one per call; one domain transition
instead of two promotions and a demotion; probes fused with the unwind edges
the handle machinery already maintains. The word "JNI" appears nowhere in
the compiler; slot numbers mean something only because probed data says so.

## Platform mapping

- **JNI** exercises nearly every dimension and is the first real vertical
  slice — deliberately constrained at first: already-attached threads only,
  local-frame regions, stable global references, pending-exception
  conversion; **no** weak-reference interning, **no** cross-`await` local
  references. JNI is a good pressure test after the generic pieces exist and
  a poor place to debug every abstraction simultaneously.
- **COM/WinRT**: typed vtable dispatch, HRESULT + out-slot outcomes,
  AddRef/Release ownership, fallible `QueryInterface` transitions,
  `IUnknown` identity projection, apartment/agility data, reentrancy
  effects. Start with agile objects or a constrained MTA subset; **gate all
  STA work on an end-to-end fixture that forces message-pump reentrancy
  while compiler-managed cleanup and identity bookkeeping are active.**
- **Objective-C**: typed capsules first (message-send variants, ARC return
  handoff), method-family-derived ownership contracts, autorelease-pool
  contexts, weak-storage operations, NSError out-slot outcomes. Objective-C
  exceptions are **prohibited from crossing scriptc-generated frames**:
  caught and converted inside a capsule, or the boundary is documented
  non-throwing. Direct LLVM ARC lowering is considered only after generated
  assembly matches Clang across return-handoff, weak-storage,
  out-parameter, stret/vector, and optimization-level fixtures.

## Verification model

- **Validator**: structural correctness largely by construction (structured
  regions), plus domain-transition and outcome-ordering rules.
- **Clang probe**: profiles and capsule signatures verified against the real
  platform headers at generation time — evidence, not inference.
- **C type checking**: emitted calls go through prototypes synthesized from
  the contract.
- **Conformance**: the core compiler suite exercises the algebra against a
  synthetic Linux test library with no SDK. **Each binding family must
  additionally run profile and semantic conformance tests against its real
  SDK and runtime** — per-boundary fixture programs in the style of the
  existing GObject adapter fixtures. SDK-free core CI is a property of the
  compiler, not a substitute for platform testing.
- **Diagnostics**: the contract carries a diagnostic vocabulary (display
  names, documentation links, message templates), so errors read
  "JNI local reference escaped its frame" from a compiler that has never
  heard of JNI.

## Claims, stated carefully

- **Performance**: the design is *intended to permit* code generation
  equivalent to direct in-compiler platform support, because lifetime-region
  and escape decisions remain in the compiler. This must be demonstrated
  with final-assembly inspection, retain/release and frame-operation counts,
  and representative benchmarks — not asserted from IR shape.
- **Marginal platform cost**: once the primitive set stabilizes, a new
  platform should not require a platform-specific compiler branch. New
  platform semantics may still reveal missing general primitives.
- **Regions**: compiler-selected local-reference regions with computed
  capacity — potentially smaller or larger than a source lexical scope.
- **Size**: earlier estimates (~4–6k lines in scriptc, ~4–6k per binding
  family) are an MVP figure for the neutral IR, validator, and legalizer.
  They exclude out-slot lowering, context-aware destruction, weak
  resources, affinity, suspension analysis, reentrancy barriers,
  capsule ingestion, and platform conformance infrastructure.

## Risks

1. **The floor.** Everything here presumes the fork's neutral machinery
   (handle cells, destructor-as-data, scope/unwind-owned cleanup) exists and
   remains. Below that floor no embedder arrangement is correct: embedder
   code never observes a scope exit.
2. **STA reentrancy is unverified.** Message pumping mid-call inside a
   runtime ledger transaction has never been exercised. The fixture gates
   WinRT work; if it breaks, the fix is compiler/runtime scheduling work.
3. **Suspension semantics are new ground.** "May this value cross `await`"
   has no precedent in the current IR; it must be designed with the async
   machinery, not bolted on.
4. **Capsule discipline.** A capsule that quietly acquires ownership or
   opens a pool recreates option 1's costs invisibly. The prohibition list
   (no lifetime decisions, no promotion, no pools, no script-exception
   conversion) must be validated, not merely documented.
5. **Width discipline.** The five-dimension contract, adopted eagerly,
   recreates the 51-declared/23-lowered failure that record 0003 amputated.
   The admission rule exists to prevent this and must be enforced in review.

## Sequencing

1. **Finish manifest unification.** One clearly versioned compiler-consumed
   boundary contract, derived by SCABI.
2. **Run the adapter-plus-LTO falsifier before expanding the compiler.**
   Three cases: a non-escaping returned object; an object stored beyond the
   call; a useful result with a detailed failure channel. Compare final
   assembly, retain/release counts, frame operations, and steady-state
   benchmarks — not intermediate IR. What the falsifier shows adapters
   already achieve, the compiler need not absorb.
3. **Refactor existing FFI into a common `ForeignCallPlan` with no
   behavioral change** — proving the legalizer architecture before any
   platform complexity arrives.
4. **Outcome protocol first** (out-slots, success classification, capture,
   clear, output validity). A probe-only slice is too narrow.
5. **Generic call targets** — symbol, context-table, and vtable-shaped
   calls, exercised against a synthetic Linux library.
6. **Structured contexts, resource domains, and transitions**, with escape
   defined across function return, heap/field storage, retained closure
   capture, retained native callback, suspension, and thread/apartment
   transfer.
7. **JNI as the first real vertical slice**, constrained as listed above.
8. **COM next** — HRESULT/out-parameters, agile/MTA objects; STA gated on
   the reentrancy fixture.
9. **Objective-C through typed capsules**; direct ARC lowering only after
   assembly-parity fixtures pass.

## Contingency

Adapter normalization (option 1) remains fully specified and feasible for
all three platforms if the compiler-side work stalls or upstream rejects
even neutral capability: per-call wrappers, owner-thread-local error
stashes, generated TypeScript shims, `identity: "none"` plus equivalence
bindings. Its costs — the JNI per-call granularity tax and the shim layer —
are the measured price of needing nothing from the compiler, and the
falsifier in step 2 quantifies exactly how much of that price LTO already
refunds.
