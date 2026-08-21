# The Foreign Boundary

Status: normative direction; the legalizer and three of five dimensions are
partly implemented
Last revised: 2026-08-21

This document defines what the compiler knows about a call that leaves
TypeScript, and what it deliberately does not. It is the contract every
binding family targets — GObject today, JNI, COM and Objective-C next — and
it is written so that adding the second, third and fourth costs no
platform-specific compiler code.

[Architecture](architecture.md) owns system invariants and wins on conflict.
[Record 0006](records/0006-one-vocabulary-one-owner.md) records why this
document exists and what it replaced.

## Decision

> The compiler owns only those foreign-boundary effects that require
> knowledge of control flow, liveness, escape, or unwind. Binding families
> generate a compiler-consumed effect contract and, where the call is
> ABI-sensitive, a verified ABI capsule. The compiler schedules regions,
> resource transitions, cleanup, and failure conversion; the capsule
> materializes the exact target call. SCABI derives and proves the contract —
> parsing platform metadata, probing headers, carrying evidence and a
> diagnostic vocabulary — but the compiler defines the contract's closed
> semantics and is its semantic owner.

In one line:

> **Control-flow and liveness semantics belong to the compiler. Exact target
> ABI mechanics belong to generated, verified capsules. Platform metadata and
> evidence belong to SCABI.**

## Why the compiler needs any of it

Four platform object models are in scope: GObject/GTK, Objective-C/ARC,
COM/WinRT, and JNI. Each has its own rules for *how* an object is acquired
and released — floating references, autorelease pools, `AddRef`/`Release`,
local versus global references. Those are expressible in generated code.

The *when* is not. Scope exit, last use, unwind paths, and whether a value
escapes are observable only inside a compiler. A generated adapter that
cannot see them must be conservative at every call: promote everything,
open a frame per call, release on a schedule it guesses. That is correct and
it is the measured price of needing nothing from the compiler.

GTK is the proof that the split works. It runs with **zero platform knowledge
in the compiler**: generated C normalizes acquisition (`g_object_ref_sink`
for floating references) and names one release symbol per type, and neutral
machinery decides *when* to call it, treating the symbol as data. The
floating-reference model — which no compiler knows about — cost zero compiler
changes. *Concept in the compiler, instance as data* is the rule the rest of
this document elaborates.

## The five dimensions

The compiler-consumed contract has five dimensions and no others.

| Dimension | What it settles |
| --- | --- |
| **Call target** | How the exact ABI call is materialized — descriptor or capsule |
| **Execution context** | Thread/apartment capability, ambient acquisition, structured regions |
| **Resource protocol** | Ownership, lifetime domains and transitions, release, affinity, weak behaviour, identity |
| **Outcome protocol** | Returns, out-slots, success classification, error capture and clear, output validity |
| **Call effects** | Reentrancy (`none` / `may-callback` / `may-pump`), suspension constraints |

The schema is a **closed algebra**. An operation reference names a typed
operation whose semantics the compiler knows. The manifest never becomes a
programming language, and neither a capsule nor a profile may introduce
opaque IR semantics.

## The admission rule

**No field without a lowering behind it, and no dimension admitted ahead of a
real failing program.**

This is not advice. SCABI once declared 51 platform variants and lowered 23,
which let a generator write contracts nothing could compile; commit
`c43f261` amputated it and [record 0003](records/0003-vocabulary-narrowing.md)
records why. The five dimensions above are this document's *horizon*, not its
backlog. Each arrives as an independent manifest and IR revision carried by
the slice that needs it — never as one platform-object subsystem.

### Designed whole, shipped by slices

An earlier revision of this material said the outcome protocol "ships whole",
and that a narrow first slice "would be redesigned immediately". Measured
against what happened, that was wrong in its conclusion and right in its
concern.

[Record 0005](records/0005-failure-beside-the-result.md) shipped one detection
arm of the outcome protocol against 415 real failable members. It was not
redesigned; it was extended, and the extension — narrowing the rule that
governs which projections may sit beside a failure — was found *because* a
real binding exercised the arm. A whole-protocol first slice would have had
none of that evidence.

What the concern was really about is foreclosure: a slice that ships without
its dimension being designed can paint the rest of the dimension into a
corner. So the rule is:

> A dimension is **designed whole before its first slice ships** — every axis
> named, every admissible combination stated — and then **shipped by slices**,
> each carried by a program that needs exactly it.

0005 did that: it named the detection, message and release axes, stated the
admissible-combination table, and shipped one row of it. Where the two
principles appear to conflict, the admission rule governs.

## Structured regions, not paired operations

A region is a structured IR construct with cleanup attached to its body, like
a compiler-internal `try`/`finally`:

```text
foreignRegion context, capacity {
    ...
}
```

Balancing is correct by construction. Return, break, throw, and callback
failure share one cleanup mechanism, and the validator stays small.

The extent is chosen by **liveness analysis, not lexical scope** — a basic
block interval, a loop iteration, a function invocation, or a larger
non-suspending segment, whichever liveness supports. This is the whole reason
the compiler is involved: a generated adapter must open a region per call
because it cannot see the interval.

What a region carries today is cleanup. A platform can also RESTRICT one —
JNI's critical regions forbid foreign calls outright between acquire and
release, which bounds the extent liveness is allowed to choose rather than
merely being checked inside one already chosen. Nothing here expresses that
yet, and [0009](records/0009-a-region-with-the-boundary-closed.md) records why
it waits: the surface that needs it is empty until a zero-copy program exists,
and a restriction designed against one platform's wording would be that
platform's restriction under a neutral name.

## The legalizer

Both backends must receive the same plan. One pass legalizes a foreign call
before either sees it:

```text
foreign call + boundary contract
            ↓
structured boundary legalization
            ↓
ordinary calls, explicit outputs, cleanup regions, unwind edges
            ↓
C or LLVM backend
```

Backend-specific code is limited to materializing call targets and primitive
operations.

Whether this pass exists determines whether the implementation stays near its
estimate or expands into two duplicated backend state machines. That is not a
prediction: [record 0004](records/0004-one-decision-two-backends.md) measured
five defects in this repository's own history, every one of them a decision
made in the C backend and not the LLVM one. Every dimension above is
cross-cutting, so each one added ahead of the legalizer is added twice.

**Current state.** Four legalization slices have landed on top of the decision
layer, and the distinction between the two is worth keeping sharp. The decision
layer answers questions both backends were answering separately. A legalization
slice goes further: it collapses arms that were only ever one shape, so a new
member of that family arrives as a row rather than as two more hand-written
ladders.

What is described rather than laddered, as of 2026-08-21:

- **Copying result projections** (`nativeResultCopy`). Four families crossed
  with absence — byte spans, UTF-8 spans, C strings, C-string vectors — were
  eight arms in each backend and are now one description with two
  materializations.
- **Owned handle results** (`nativeResultHandle`). Two arms whose control flow
  genuinely differs, so the decisions are shared and the shapes are not.
- **Borrowed arguments** (`nativeArgumentBorrow`) and **handle arguments**
  (`nativeArgumentHandle`), over a shared `NativeArgumentSource` — the three
  nullabilities every value family crosses, said once.

Each slice was verified by emitting the whole `native-ir` suite before and
after and comparing byte for byte, in both backends. Every one is inert except
a single redundant local in one family, noted where it happens.

**What the slices found is the part worth recording.** Four facts were
load-bearing, unwritten, and correct only because two independently written
ladders happened to agree:

1. A byte span's non-null check must precede the copy, because the copy reads a
   length slot describing that pointer. A C string's must follow the release,
   because the copy answers null for null and the pointer still has to be
   freed.
2. A non-nullable handle prepares its cell BEFORE the call, so a registration
   owner and retained tokens attach while the callee might still fire a
   callback. The nullable arm prepares lazily, having nothing to attach.
3. A borrowed vector is BUILT for the call and must be released on the throwing
   path; a borrowed C string points into storage the managed string already
   owns and has nothing to give back.
4. A surrendered handle has no nullable arm, because a call that may be handed
   nothing cannot also be the call that takes ownership of it. As four
   independent cases that read as a gap.

**What is not a slice.** The seven number-conversion arms stay as they are:
they are seven different conversions whose decisions already live in the form,
and a description over them would be indirection bought with nothing. Saying so
is part of the work — the target is one decision in one place, not uniformity
for its own sake.

**Still ahead, and still the target.** Trampoline emission remains duplicated
in SHAPE rather than merely in decision — the queued-invocation record, its
destroy/invoke/admit trio, and the token bail ladder are written twice. That is
also the region entangled with `emitPendingCheck`/`emitUnwind` placement, where
the decision is WHERE the call happens and the mechanism is backend-owned scope
bookkeeping. Designing that interface without leaking one backend's model into
the plan is the pass/fail question for the legalizer, and it is unanswered.

The lesson from the divergences remains narrower than "share more". The
exhaustiveness guards catch a missing arm of a shared TYPE; they cannot see a
decision that was never given one. Three vocabularies that had no guard at all
now have one, which is why a fourth trampoline shape is a build failure rather
than a silent call-scoped emission.

## ABI capsules

**Descriptor capsule** — ordinary C calls, JNI table calls, most COM vtable
calls. It carries target kind, typed signature, calling convention,
base/context source, slot or symbol, and target-triple constraints. The
compiler emits the call itself.

**Typed code capsule** — for cases where exact ABI knowledge belongs to the
platform's own compiler: Objective-C message-send variants, the ARC
return-value handshake, complex aggregate conventions. The binding family
generates a small typed source unit, compiles it with the platform's Clang,
and supplies bitcode (LTO-inlined by the LLVM backend) or an object file
(separately compiled by the readable C backend).

A capsule is **forbidden** from deciding lifetime regions, forcing per-call
promotion, introducing local pools, or converting script-level exceptions. It
performs exact calling mechanics and nothing else. That prohibition is what
separates a capsule from a conservative adapter, and it must be validated
rather than merely documented.

Objective-C is why capsules exist at all: the `retainAutoreleasedReturnValue`
elision handshake requires Clang's codegen cooperation — LLVM's
`clang.arc.attachedcall` operand bundle, and a marker instruction on arm64.
Source- or IR-level adjacency is not sufficient, and reproducing Clang's ARC
lowering here would be a substantial, fragile, platform-specific undertaking.

## Outcome protocol

A call can have a native return, out-parameters, a success discriminator
independent of both, an error payload that must be captured before any other
operation, a required clear action, and rules for which outputs are valid on
which outcome.

- **JNI** — a null object result can be a *successful* result; failure is a
  pending-exception flag, and only a restricted set of JNI operations is legal
  until it is captured or cleared. Cleanup while an error is pending therefore
  needs pending-error-safe classification, not "call every destructor".
- **COM** — status through `HRESULT`, where only negative values are failure
  (`S_FALSE` is success); useful values through out-slots.
- **Cocoa** — a useful return plus an `NSError **` out-parameter with
  method-specific failure predicates, and ARC writeback rules on certain
  out-parameters.
- **GObject** — a useful return plus a `GError **` out-parameter. Implemented;
  see [record 0005](records/0005-failure-beside-the-result.md).

The dimension is designed whole and shipped by slices, per the rule above.
Landed: a failure indicator in a compiler-owned slot beside the result,
with message and release named by the contract, and the ordering rule that
the unwind happens between the failure check and the result projection.
Outstanding: out-slots as ordinary outputs, success classification
independent of the result, error capture and clear as distinct operations,
and output-validity rules.

## Resource protocol

Ownership plus **lifetime domains and transitions**, which replace a single
promote/demote pair:

- JNI — local frame → parent frame (`PopLocalFrame(result)`), local → stable
  (`NewGlobalRef`), stable → released (`DeleteGlobalRef`, thread-context
  aware), and weak-global as a distinct domain with a fallible upgrade.
- Affinity — none, current-thread, or a named context.
- Identity as a protocol on the resource type: `pointer`, `projection(op)`
  (COM projects to the stable `IUnknown` identity, itself an owned
  reference), or `equivalence(op)` (JNI's `IsSameObject`; raw `jobject`
  pointer comparison is meaningless under a moving collector). Intern tables
  may stay in the binding runtime — the compiler needs identity only where it
  affects optimization or release scheduling.

Landed: managed handle cells, destructor-as-data on the handle type, owned
foreign-object returns, identity by pointer with an intern table, identity
upcasts. Outstanding: domains and transitions, weak resources, affinity, and
context-aware destruction.

## Execution context and call effects

`JNIEnv *` is a **thread capability**, not a per-region value: valid for the
current attached thread, with acquisition boundaries, foreign-thread entry
rules, and conditional cleanup — only a thread the native runtime attached
should be detached by it. Regions and capabilities are different concepts and
the contract keeps them apart.

Call effects are first-class because a resource can be live and correctly
counted yet illegal to use at a given point. COM STA calls can pump messages
and re-enter application code mid-call; a JNI local reference must not cross
an `await`. The contract states reentrancy (`none` / `may-callback` /
`may-pump`) and suspension crossing (`forbidden` / `allowed`), and the
compiler uses them to decide whether a ledger transaction may stay open
across a call and whether a value may live across a suspension point.

## The threading model underneath

1. **Owner-confined execution.** Runtime heaps are owner-confined; every
   script turn runs on the owning thread.
2. **The owner executor *is* the platform's affine context.** The GTK main
   context, the Android main Looper, the Cocoa main run loop, and a COM STA
   apartment are the same concept wearing four names.
3. **Foreign-thread callbacks enter through the ingress gateway**, which
   copies the payload where it is raised and queues the invocation.
4. **Multi-affinity applications use multiple runtime instances**, one per
   affine context, with explicit transport between them. Heap confinement is
   preserved rather than relaxed.
5. **Thread capabilities absorb the remainder** — `JNIEnv` acquisition,
   attach and detach discipline, and context-aware destruction, which
   owner-confined destruction already guarantees runs on an attached thread.

What stays platform work rather than contract work: blocking calls that would
starve the owner loop (declared blocking, then refused or dispatched),
worker-owned instances calling main-thread APIs through an explicit dispatch
escape hatch with documented deadlock discipline, and COM cross-apartment
marshalling through the reserved agile-reference path.

## Verification

- **Validator** — structural correctness largely by construction, through
  structured regions, plus domain-transition and outcome-ordering rules.
- **Clang probe** — profiles and capsule signatures verified against the real
  platform headers at generation time. Evidence, not inference. A profile is
  generated by parsing the platform's own header and probed against it; it is
  never hand-authored. The first draft of this material hand-wrote JNI slot
  numbers and got `ExceptionClear` wrong, which is the rule made flesh.
- **C type checking** — emitted calls go through prototypes synthesized from
  the contract.
- **Conformance** — the core compiler suite exercises the algebra against a
  synthetic library with no SDK. Each binding family additionally runs profile
  and semantic conformance tests against its real SDK and runtime. SDK-free
  core CI is a property of the compiler, not a substitute for platform
  testing.
- **Diagnostics** — the contract carries a diagnostic vocabulary (display
  names, documentation links, message templates), so a message reads "JNI
  local reference escaped its frame" from a compiler that has never heard of
  JNI.

## Platform mapping

- **JNI** exercises nearly every dimension and is the first real vertical
  slice, deliberately constrained at first: already-attached threads only.
- **COM** follows — `HRESULT` beside out-slots, agile and MTA objects. STA is
  gated on the reentrancy fixture.
- **Objective-C** goes through typed capsules; direct ARC lowering only after
  assembly-parity fixtures pass.

## Claims, stated carefully

- **Performance.** The design is *intended to permit* code generation
  equivalent to direct in-compiler platform support, because lifetime-region
  and escape decisions remain in the compiler. This must be demonstrated with
  final-assembly inspection, retain/release and frame-operation counts, and
  representative benchmarks — never asserted from IR shape. Demonstrated for
  JNI by the falsifier below, with a result that is narrower than the claim:
  the equivalence is worth having for lifetimes and worth nothing for
  outcomes, because the adapter was already at parity there.
- **Marginal platform cost.** Once the primitive set stabilizes, a new
  platform should not require a platform-specific compiler branch. New
  platform semantics may still reveal missing general primitives.
- **Size.** Earlier estimates of 4–6k lines in the compiler are an MVP figure
  for the neutral IR, validator and legalizer. They exclude out-slot lowering,
  context-aware destruction, weak resources, affinity, suspension analysis,
  reentrancy barriers, capsule ingestion, and platform conformance
  infrastructure.

## Open risks

1. **The floor.** All of this presumes the neutral machinery — handle cells,
   destructor-as-data, scope- and unwind-owned cleanup — exists and remains.
   Below that floor no embedder arrangement is correct, because embedder code
   never observes a scope exit.
2. **STA reentrancy is unverified.** Message pumping mid-call inside a runtime
   ledger transaction has never been exercised. The fixture gates WinRT work;
   if it breaks, the fix is compiler and runtime scheduling work.
3. **Suspension semantics are new ground.** "May this value cross `await`" has
   no precedent in the current IR and must be designed with the async
   machinery rather than bolted onto it.
4. **Capsule discipline.** A capsule that quietly acquires ownership or opens a
   pool recreates a conservative adapter's costs invisibly. The prohibition
   list is a validation obligation.
5. **Width discipline.** The five-dimension contract, adopted eagerly,
   recreates the 51-declared/23-lowered failure record 0003 amputated. The
   admission rule exists to prevent that and is enforced in review.

## The contingency

Adapter normalization remains fully specified and feasible for all four
platforms, including weak references and thread affinity: per-call generated
wrappers flattening each platform into the existing neutral algebra,
owner-thread-local error stashes, generated TypeScript shims, and
`identity: "none"` plus equivalence bindings.

Its costs are known — JNI pays a per-call granularity tax, since a local frame
and a mandatory global-reference promotion per call are synchronized JVM
structures and collector roots, and value-returning fallible calls need a
generated shim layer. It is the right contingency and the wrong steady state,
because only the compiler can choose a useful lifetime region or determine
whether a value actually escapes.

Before expanding the compiler for any platform, the **adapter-plus-LTO
falsifier** was to measure how much of that price link-time optimization
already refunds, on the principle that whatever adapters already achieve, the
compiler need not absorb. It has been run, and its answer narrows what follows
from "expand the compiler for platforms" to something much smaller.

## What the falsifier measured

`scripts/adapter-lto-falsifier` builds the three named cases against a real
JVM through the invocation API. **Variant A** is the contingency adapter
described above, verbatim: a per-call wrapper in its own translation unit that
cannot see escape or liveness, so it opens a local frame and promotes every
returned object to a global reference, handing back the neutral algebra's
handle. **Variant B** is what an escape- and liveness-aware compiler would
emit for the same programs. A is built twice, with and without `-flto=full`.

All four legs the *Performance* claim above demands, and no others: steady-state
medians, exact dynamic counts of reference and frame operations through an
interposed JNI function table where every unwrapped slot traps, final-assembly
call sites with indirect calls labelled from offsets probed out of the real
`jni.h`, and identical-work checksums including the failure path's message.
Never intermediate IR.

Corretto 21, clang 22, x86-64. Median nanoseconds per operation:

| case | adapter | adapter + LTO | compiler-informed |
| --- | --- | --- | --- |
| non-escaping returned object | 144.1 | 145.5 | 60.9 |
| object stored beyond the call | 157.5 | 157.7 | parity |
| useful result, detailed failure channel | 51.6 | 52.7 | 51.7 |

## What it settled: LTO refunds nothing structural

**The non-escaping case pays 83 ns/op — 2.4× — and link-time optimization
returns none of it** (−2%, inside noise, stable across two full runs). The
operation counts say why. Variant A performs four operations per iteration
that B does not: `PushLocalFrame`, `PopLocalFrame`, `NewGlobalRef`,
`DeleteGlobalRef`. Every one is a call through the JVM's function table, which
no linker can see through and therefore no linker can delete. B performs one
`DeleteLocalRef`.

The assembly rules out the obvious alternative explanation. Inlining was
partial — `nt_adp_make` and `nt_adp_capture` survive as calls in the optimized
binary — but where it fully succeeded it bought nothing: `nt_adp_checked_add`
disappears into its caller under LTO and that case's timing does not move.
The adapter's price is not the cost of calling the adapter. It is the
operations the adapter performs, and those are opaque by construction.

**The other two cases were never paying.** For a value that genuinely outlives
the call, promotion is required and the adapter is already doing the right
thing. For a fallible call with a detailed failure channel, an inline
`ExceptionCheck` with a cold outlined capture matches compiler emission — and
matches it *without* LTO, so the conclusion does not even depend on the linker.

The stored case deserves its noise stated rather than a number. Within a single
run the same logical B code measured 159.1 and 142.9 in the two binaries; that
16 ns/op spread against a ~150 ns/op absolute is the resolvable floor for this
case, and A at 157.5/157.7 sits inside it. The finding is parity, not a
measured tax.

## What that licenses, and what it does not

**Licensed.** Resource-protocol lifetime domains, and escape-driven promotion
and frame *elision*. That is the 2.4× case, it is the only case with a
structural price, and nothing but compiler-side knowledge of escape and
liveness can remove it — the operations are opaque to every other layer.

**Not licensed: the outcome protocol, on performance grounds.** This is the
load-bearing half of the result and the easiest to skip past. The fallible case
is at parity, so no remaining slice of the outcome protocol — output validity
included — may be justified by what it would make faster. Each must earn its
place on correctness or expressibility alone. Record
[0007](records/0007-weak-and-invalid-are-not-one-thing.md) already deferred
output validity for a metadata reason; this removes the other argument that
might have overridden that deferral.

**Not licensed: a batched-region primitive.** Batching local frames at 512 per
region beat per-iteration `DeleteLocalRef` by roughly 5 ns/op. Region *extent*
is marginal; the win is *elision*. A primitive for choosing region size would
be machinery for a rounding error.

## Why the result is a floor rather than a ceiling

Three things are unmeasured, and all three cut the same way. This is HotSpot on
a desktop, not ART. Everything is single-threaded, so contention on the
global-reference lock never appears. The GC-root pressure that a population of
global references creates never appears either. Each of these makes the
conservative adapter *worse*, not better, and the mechanism generalizes: the
unrefundable operations are calls through a function table, which is true of
every JVM. So the licensed scope is a lower bound on the JNI case, and the
structural finding transfers even though the magnitudes will not.
