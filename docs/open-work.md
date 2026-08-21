# Open work

Status: living index, not normative
Last revised: 2026-08-20

Everything deferred with a reason, so a reason is never lost by being
remembered only in a conversation. [The roadmap](roadmap.md) owns sequencing
and exit gates; this file owns the smaller decisions that would otherwise
survive nowhere.

Each entry says what it is, WHERE it lives, and what would admit it. An item
with no admitting condition is not ready to be built, and saying so is the
point — this project admits a feature when a real program needs it, so an
entry that cannot name its program is an entry that must wait.

## In the compiler fork

These need `third_party/scriptc` changes and reach the parent through the
embedder contract.

### Library caching adoption — DONE (fork 6d212d0c)

Both tiers wired into `compileLibrary`. The planner deliberately consults
neither: its product is a path-free plan the artifact graph content-addresses
itself, so a file cache beneath it would be a second answer to a settled
question.

Two things worth keeping from the adoption. The cache entry carries the
archive SETTINGS rather than upstream's reached-feature set, because three of
this fork's settings are read off the lowered module or the embedder request
and a hit has no module to read. And the cache key had to gain
`nativeRuntimeRequires` — without it two builds of one profile differing only
in requested services collided, and the loser linked against an archive
missing the units behind its own request. The PIC/symbol gate caught that,
and removing the key input reproduces it.

### Planning the producers a library archive still cannot describe

`compileLibArchive` refuses three producers when handed a `commandExecutor`
(`backend/cc.ts`, the `unplanned` list): the vendored regex engine, vendored
zlib, and symbol localization. Each would materialize an artifact the
embedder's graph never declared.

**These are not one item, and that is the finding.** The vendored pair is
ordinary work: `ensureLreObjects`/`ensureZlibObjects` compile a fixed source
list through the driver, so routing them through the existing
`runLibraryCommand` seam and declaring the vendor directory as an artifact
beside the runtime directory would make them plannable with no new concepts.
`planLibraryExternalCBuild`'s loop already handles compile-then-archive
generally; the only blocker is `planExternalCCommand` refusing an absolute
path that resolves under no declared artifact.

Symbol localization is different and may not be plannable in this shape at
all. It rewrites objects through four platform arms, and only two of them
shell out: native Linux uses host binutils and darwin uses the host linker,
but cross-ELF and COFF are rebuilt IN PROCESS by `object-localize.ts`. There
is no command to hand a graph for half the matrix, so making it plannable is
a design question — expose localization as a tool, or let a plan name the
compiler itself as a build step — not a matter of doing the work.

**What would admit it:** the vendored pair is admitted by any library a real
embedder plans that uses a regex literal or zlib, which is most of them.
Localization is admitted only by an embedder that plans a multi-instance
library, and should not be attempted before someone answers the design
question above.

**Ordering constraint, and it is easy to miss.** Vendored objects are not PIC
(below), and a planned archive is uniformly position-independent today ONLY
because the planner refuses every vendored case. Landing vendor planning
without landing vendored PIC first would quietly produce planned archives that
cannot enter a shared object — the exact defect the PIC gate was written for,
reintroduced through the door that was holding it shut. The two are one slice,
in that order.

### C and LLVM throw-checkpoint divergence — FIXED (fork 804e8cd1)

Kept here because the SHAPE recurs. C treated any callback argument as a throw
checkpoint; LLVM additionally required call-scoped ownership, so the two
disagreed about where an unwind belongs for every owner-scoped retained
callback — a signal connected to a handle. The predicate gates 8 of 20
pending-check sites.

It survived because the decision was never given a type. The exhaustiveness
guards only see arms of `NativeResultForm`/`NativeArgumentForm`; a decision
read straight off the binding in both files is outside the mechanism entirely.
The survey that found it counted three of six shared vocabularies guarded on
both backends, one on a single backend, and two on neither —
`NativeTrampolineShape`, `NativeClosureSource` and `NativeCallSetup` all fall
through to a default in at least one emitter.

`nativeCallIsThrowCheckpoint` now lives in `native-call-plan.ts`, and the fix
carried the first test that imports that module directly. Everything there had
been covered end-to-end only, which catches a decision that is WRONG and is
useless against one that is merely DIFFERENT on the two sides — both emit a
working program, just not the same one.

### `validate.ts` restates manifest unions instead of importing them

The `utf8Span` arm shipped with one of its two check sites widened and the
other not, so the compiler accepted a binding and then refused every call to
it. Both sites are now correct and an audit confirms no cast is missing an arm
today, but the SHAPE that allowed it is untouched.

Three places restate the nine-arm result-projection union by hand:
`ir/validate.ts` around 2671 and 4997 cast to a locally spelled union, and
around 5119 a terminal `kind !== ... && kind !== ...` whitelist must be
edited in lockstep with them. TypeScript cannot object, because a local union
whose arms are a subset with payloads widened to `unknown` is comparable in
both directions — omitting an arm silently shrinks the compile-time domain.

The distinction that matters: the FIELD-loosening half is legitimate defence,
since bindings are materialized from a document an embedder hands over, and
`typeof x.nullable !== "boolean"` has to be reachable to mean anything. The
ARM list is pure restatement with no defensive value — an embedder cannot
produce an unlisted `kind` without the enumeration, and an exhaustive
`default` rejects it at runtime just as well while also failing at compile
time. The parameter side of the same function already validates through the
published type with no cast, which is the proof it can be done.

The fix is an `Untrusted<T>` mapped type derived FROM the published union, so
arms cannot be forgotten, plus `switch` with `default: { const _: never = x }`
at both sites — the repo's existing idiom. That deletes the 5119 whitelist
outright. Two adjacent items belong in the same pass: the parameter switch
covers 12 of 14 arms with no `default`, so a new arm gets no validation and a
misleading "incomplete or ambiguous ABI projection" message; and one
`release` shape check is copied identically four times.

**Mostly landed** in fork 56ea70ce. `Untrusted<T>` derives the loosened view
from the published union, so neither result-side site enumerates arms any
more and omission is structurally impossible. The parameter switch gained the
`default` it never had, binding `never`, so a new parameter arm upstream stops
the file compiling. The four identical release checks are one function.

**What remains:** the terminal `kind !== ... && kind !== ...` whitelist in the
call-site chain still restates the arms handled above it. Removing it means
turning a long if/else ladder into a switch — a restructure, not a correctness
fix, and a new arm reaching it now fails loudly rather than silently. Worth
folding into the legalizer work rather than doing alone, since that pass
rewrites the same ladder.

### Backend-neutral foreign-boundary legalizer — IN PROGRESS

The audit's P1 and [0004](records/0004-one-decision-two-backends.md)'s
conclusion. Four slices have landed; see
[the foreign boundary](foreign-boundary.md) for what is described rather than
laddered, and 0004's second addendum for what each slice found.

**What remains is the hard half.** Trampoline emission is duplicated in SHAPE
rather than in decision — the queued-invocation record, its destroy/invoke/
admit trio, and the token bail ladder are written twice, roughly 320 lines in
the C backend and 600 in LLVM. Collapsing it means answering the question the
first four slices did not have to: what does a plan say about WHERE an unwind
happens, when `emitPendingCheck` and `emitUnwind` are called 20 and 25 times
inside these lowerings and their mechanism is backend-owned scope bookkeeping?
C walks a live-temporary scope stack and manages indentation; LLVM manipulates
basic-block state and entry allocas and short-circuits on termination. A plan
that says "unwind here" has to say it without knowing what a scope is on either
side, and designing that without leaking one backend's model into the plan is
the pass/fail question for the extraction.

**Merge upstream immediately before starting it.** It rewrites both emitters,
which are the two files with the largest overlap against upstream, and it is
the one change that would spend the additive-divergence property that has kept
merges cheap. Upstream shipped four commits into these files this week.

**A method worth keeping.** Each slice is verified by emitting the whole
native-ir suite before and after and diffing byte for byte, in both backends,
rather than by a passing suite. The scratch cleanup is gated on `AB_KEEP=1` for
exactly this. The first such comparison covered one of four changed families
and was therefore evidence of nothing; widening it found a real difference. A
green suite does not distinguish a refactor that preserved behaviour from one
that changed output nobody asserts on.

**Not everything is a slice.** The seven number-conversion arms were examined
and left alone: seven genuinely different conversions whose decisions already
live in the form. Uniformity is not the target; one decision in one place is.

### JNI resource domains: local, stable, weak

The largest measured performance win available, from this project's own
falsifier: a non-escaping JNI object result pays 2.4× because the adapter
promotes a local reference to a global one and LTO cannot remove opaque JVM
calls. Escape analysis deciding promotion is what removes it.

Blocked on nothing technical; sequenced after vocabulary consolidation
because it is a contract change and the contract should have one owner first.

### Hidden execution-context capability

`JNIEnv *` acquired once per boundary rather than per call, modelled as a
hidden capability operand. Removes a `GetEnv` from every adapter call — one
per adapter entry, plus one per handle release; nothing pays twice.

**Do not build this on performance grounds.** Bounding the cost from the
falsifier's own data: its four measured table operations average ~21ns each
and all of them allocate or take a lock, which `GetEnv` does neither of. So
~21ns is a hard ceiling and low single digits is the expectation — 2-10% of
the cheapest measured call, against 58% for the promotion tax that resource
domains address. The cost is ~18 files across two repositories and two schema
bumps, and unlike `bytesLengthOut`/`errorOut` it is not a compiler-owned slot:
it needs an acquisition that can FAIL, a value that outlives one call site,
and a scope over which it stays valid. The compiler has no capability-scope
concept at all.

Two things follow. **Sequence it after resource domains**, because removing
the 83ns promotion tax roughly doubles `GetEnv`'s relative share and measuring
before then measures the wrong denominator. And **weigh the cheap alternative
first**: the runtime attaches the owner thread once and never detaches
(`nts_jvm_runtime.c`), so a `_Thread_local JNIEnv *` in the adapter would
remove all but the first acquisition per thread with zero compiler changes.
Its cost is real and belongs in the record — an embedder that detaches a
thread it previously called from gets a precise diagnostic today and would get
a dangling pointer instead — which may well make it the wrong answer, but it
is the baseline any capability-operand proposal must beat.

**What would admit it:** a fourth case in `scripts/adapter-lto-falsifier` —
one kernel pair identical except that A' calls `pkg_env()` per call as
generated while A takes the env as a parameter. State the threshold before
running: under ~5ns/op is inside the stored case's own noise floor, and the
performance argument is then dead. If it is built anyway, it should be
justified as closing the JVM package's only declared `gap` and moving
"thread is not attached" from a per-call to a per-boundary failure, with the
performance claim dropped rather than assumed.

### utf8Span as an ARGUMENT

The result arm shipped. The argument arm is the shape that would let a
TypeScript string containing U+0000 flow INWARD.

No trigger: the compiler already raises catchably on such a string before the
call, which is honest today. Admitted by a program that needs one to cross.

### Nullable byte-span result

The string span gained a null arm because three committed programs demanded
it. The byte span has evidence — `getByteArrayExtra` returns null for an
absent extra, recorded in the JVM capstone — but nothing is blocked on it.

Admitted when a byte-span null blocks a lane, on exactly the terms the string
arm was.

### Void-synchronous callback delivery — DONE (fork 3c33818a)

Owner-scoped synchronous delivery may now answer nothing. The compiler needed
one validator condition removed: its synchronous trampoline had always branched
on a void result, and the contract had already settled where a synchronous
throw goes. The JVM suite's committed `Lifecycle` fixture is what made it
admissible — the refusal's reasoning was sound and its premise, that
void-synchronous and void-queued are two spellings of one delivery, is false
for a lifecycle method that is invoked and then observed.

### Handle payloads on synchronous delivery — DONE (fork 0309d850)

Both arms Android forces are live. Synchronous delivery admits an owned handle
payload beside its scalars, through promotion rather than a borrowed form: the
payload arrives owned, the reference moves into a managed cell through the same
intern-or-prepare construction the queued thunk uses, and the cell's destructor
gives it back. A JNI local reference dies with the native frame, so the adapter
promotes before the payload crosses — which the JVM track confirms is the only
spelling JNI has.

The program is what earned it. `tests/native-ir/synchronous-payload.ts`
inhabits the intersection rather than either list: a handler TOLD while holding
an object, and a handler that ANSWERS while holding a scalar and an object. It
found three defects no unit assertion would have — an unreached payload
destructor, a C bail that was a dangling statement, and a bail that needed a
release at all. See [0012](records/0012-checks-that-cannot-fail.md).

**The withheld payload landed on 2026-08-21**, and the prediction above held:
it was a nullable POSITION rather than a new delivery. The handler receives
`T | null`, the physical slot is the same pointer either way, and the union it
arrives as is resolved from the module's own table by its arms — the division a
nullable handle RESULT already lives under, since neither an embedder's input
nor a published declaration can name a union id. `tests/native-ir/
payload-absent.ts` takes both arms through one registration, because a handler
that only ever receives an object proves nothing about absence and one that
only ever receives null proves nothing about the reference.

**It shipped admitted in one of the two synchronous branches**, and the JVM
session found the other within hours. Three rules each asked "is this payload
an object" in their own words — what a callback type may DECLARE, which arm
carries a DESTRUCTOR, and what a synchronous delivery ADMITS — and the new arm
reached the first two. So a process-owned withheld payload was accepted while
the identical receiver-anchored one was refused as an invalid contract, on a
distinction that does not exist: the owner never bore on whether a payload may
be absent, and the branch is already gated on `synchronousReturn` for the
reason that does. One predicate, `handlePayloadArm`, now answers for all
three, and `payload-absent-answered.ts` covers the arm beside the arm — an
answering receiver-anchored handler, which is the shape a toolkit's
`onMeasure` takes.

**What remains of it is the QUEUED arm, refused by name in both layers.** A
queued delivery stores the payload's pointer in an invocation record whose
shutdown cleanup reads the same slot, so absence there is a state of the record
rather than a branch in one trampoline — and the cleanup would call a
destructor on a pointer the library never gave. The compiler refuses a nullable
payload that is not synchronously delivered, and `withheldHandlePosition` in
the SCABI translator admits it only in the synchronous branch. Two layers
refusing the same shape for the same reason is what keeps them from drifting;
neither is waiting on the other. A program is what would earn it, and a
framework lifecycle is not one — that dispatch runs in the caller's frame.

### A TypeScript class extending a NATIVE class — named, not queued

The README sketch for an Android application is `class MainActivity extends
Activity` with `override onCreate` and `this` as the receiver. What ships
instead is `MainActivity.onCreate(callback)`, where the receiver arrives as the
handler's first argument. The lowerer knows `extends` for mixin functions only,
so the sketch needs a real compiler capability: a managed class whose base is a
native declared class.

**The capability is bounded work. The design question is not, and it comes
first.** The current spelling is not a workaround for missing sugar — it is an
accurate statement of what happens: the platform constructs the Activity, at
the moment a program could register no instance exists, and the registration
outlives every instance because the class does.

The `extends` spelling is not less accurate about the CLASS, which was this
note's first objection and does not survive contact with the JVM side: the
subclass generator emits a real Java class extending Activity, so a program
declaring one genuinely does define it. What the two spellings differ about is
narrower, and it is below.

**The lifetime worry this note first recorded was wrong**, and the correction
is worth keeping because it changes what the capability has to solve. A `this`
stored past its dispatch is NOT a use-after-free: the receiver crosses as
`owned` / `transfer: to-runtime`, so the thunk interns it into a managed cell
whose destructor is the class-blind global-reference release. A program that
keeps it keeps the cell, the cell keeps the reference, the reference keeps the
object. Storing it is memory-safe by construction — the same construction that
made the payload arm small.

What remains is the ANDROID leak: an Activity held past `onDestroy` pins its
view hierarchy. That is real, but it is a hazard every Android program has in
Java with a static field, it is not a boundary defect, and no type system can
fix it — whether a program may keep a receiver depends on what it means to do,
not on the reference's shape.

**The sharper question is whether `this` is the SAME cell the payload arm
already hands over.** If it is, the sugar is honest about lifetime and the
capability is a spelling rather than a mechanism. If `extends` introduces a
SECOND receiver spelling with its own lifetime story, that is one fact
described twice — the shape that produced most of this file — and the hazard
would enter by construction rather than by misuse. So the design constraint is
`this` IS the payload cell, and an override IS the class-anchored registration
with the receiver bound.

**And that is where the two spellings actually differ: instance FIELDS.**
`this` is a handle to a JAVA object, not a TypeScript one. If such a class may
declare TypeScript fields,
they need somewhere to live across dispatches — the Java object, or a side
table keyed by the handle — and that is the part with a real cost. If it may
not, the capability is a class-shaped way to write registrations and should say
so, because a `class` that cannot hold state is a surprise worth naming.

Recorded rather than started: it is a product-shape decision, and it should
land with an answer to the fields question rather than ahead of one. The JVM
session owns the platform half of this write-up.

### Vendored objects are not PIC

The archive's program and runtime objects are position-independent. Vendored
objects are built by separate cached helpers with their own flags and are
NOT, so a PLANNED archive is uniformly PIC only because the planner refuses
the vendored cases above. Widening those helpers touches objects the
executable lane shares, so it carries its own cache-key consequences.

### Splitting the loop's checkpoint from its fibers — NOW BLOCKING ANDROID

The Android crossing has exactly one gap in the compiler's box, and it is
narrower than a port. Bionic declares `ucontext_t` for signals and ships none
of `getcontext`/`makecontext`/`swapcontext` — they exist in no Android libc
version. Everything else in the runtime set compiles clean for bionic under the
NDK's clang.

**The target is smaller than "scr_async.c on Android".** `LIB_RUNTIME_SOURCES`
already excludes `scr_async.c`, so a library build never sees those functions.
What pulls the file back in is the `attachedLoop` gate in `cc.ts` — added when
a host that owns its loop needed the service — and a hosted JVM product
requires exactly that. So the question is not how to port fibers to bionic; it
is what the attached loop actually needs, which is the checkpoint and the queue
drain rather than the fiber machinery. Library emission requires an async-free
module graph, so no hosted product can reach a fiber at all: the gap is
entirely in code the Android `.so` links and can never run.

Three shapes, with what each costs.

**Reuse the existing musl asm.** `scr_musl.c` already implements all three in
assembly for x86_64 and AArch64. It is excluded from library builds by
`#ifndef SCR_LIB`, and that guard's reason is symbol collision with a host libc
that has these functions — which bionic does not, so the rationale does not
apply. **But the asm writes at hardcoded offsets into the libc's `ucontext_t`**
(`SCR_UC_GREG(reg)` is `40 + reg * 8`), and bionic's layout is not musl's until
something proves it is. That is an ABI fact, so it needs a Clang probe against
the real headers rather than an assumption, and getting it wrong is silent
stack corruption rather than a diagnostic.

**A fourth `ScrCtx` arm with our own context struct.** The seam at
`scr_async.c:291` is already three-armed — Windows fibers, WASI stackless,
POSIX ucontext — and a fourth arm could save into a struct THIS project
defines, with save/restore named `scr_ctx_*` rather than the libc's. That
removes both hazards at once: no layout to probe, because the layout is ours,
and no collision, because the symbols are ours. It is the cleanest of the
three and it is roughly sixty lines of new context-switch assembly across two
architectures — the kind of code where a mistake is silent stack corruption,
so it wants a rested author and its own falsification.

**Split the checkpoint from the fibers.** Architecturally the best answer and
the one this entry was originally about. Measured rather than assumed: only
~102 lines of the 3369 mention a fiber, but they are THREADED through the file
rather than sitting in a block, and the checkpoint's fiber contact is a single
step — draining `scr_ready` — that an async-free build never enters. So it is
restructuring rather than carving, and the honest estimate is that it is the
largest of the three.

**Recommendation:** the fourth `ScrCtx` arm. It needs no ABI evidence about
bionic, leaves the fiber path working rather than excluded-and-unreachable,
introduces no second runtime configuration, and is bounded work with a clear
falsification. The split remains worth doing on its own merits, but Android
should not wait behind a 3369-line restructuring when sixty lines of assembly
under our own names settles it.

### Target planner and staged build pipeline

The audit's largest structural finding. `planTarget` validates composition
but plans nothing: GTK and JVM both call `build…Application()` directly and
duplicate the pipeline shell.

It is also what makes the reachability-driven ingress rule load-bearing
rather than paper — neither target has a binding provider to carry the
declaration until this exists.

### Three-way target identity

Execution platform, ABI target, and application environment are one
`TargetDescriptor` today, which is why the JVM build accepts an arbitrary
triple over hardcoded x86-64/ELF/glibc facts. Follows the target planner.

### Declined as premature

Package splitting, an execution-backend abstraction for macOS and Windows,
remote execution, and capsule manifests. All sound at the scale the audit
describes; none justified at one execution platform and zero capsules.
