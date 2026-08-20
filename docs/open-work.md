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

### C and LLVM disagree about `callbacksMayThrow` — a live defect

Found while surveying the legalizer's scope, and it is exactly the class
[0004](records/0004-one-decision-two-backends.md) exists for.

`emit-exprs.ts` tests `argument.type.kind === "func"`. `llvm/emitter.ts`
additionally requires `argument.callback?.owner.kind === "call"`. So a binding
with an OWNER-scoped retained callback — `owner.kind` of `"result"` or
`"argument"` — inside a module with no process-scoped registration is a throw
checkpoint in C and not in LLVM. The predicate gates 8 of the 20 pending-check
sites, so the two backends unwind at different points.

A GTK signal connected to a widget handle is that shape. The exhaustiveness
guards cannot see it because the decision was never given a type — it is read
straight off the binding in both files, outside every shared form.

**What would admit it:** it is a defect, not a feature; it needs no admitting
program. What it needs is a test that can observe a backend-dependent unwind
POINT rather than a backend-dependent outcome, since both backends do
eventually unwind.

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

**What would admit it:** a defect, not a feature. It is worth doing before the
legalizer, since the legalizer's whole premise is one decision living in one
place.

### Backend-neutral foreign-boundary legalizer

The audit's P1 and [0004](records/0004-one-decision-two-backends.md)'s
conclusion: both emitters still materialize their own control flow, and five
real defects have already come from one decision living in two places.

**Merge upstream immediately before starting.** It rewrites both emitters,
which are the two files with the largest overlap against upstream, and it is
the one change that would spend the additive-divergence property that made
the last merge 31 hunks instead of a week. It is also net-negative lines in
those files, so it is the change that most REDUCES fork risk once landed.

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

### Void-synchronous callback delivery

The retained contract has answered-boolean-synchronous and void-QUEUED. A
void handler that must complete inside the caller's frame — an Android
lifecycle method — has no arm.

The JVM track holds a committed fixture that distinguishes synchronous from
queued by construction. Three design questions must be answered together:
void results, handle payloads, and WHERE A SYNCHRONOUS VOID HANDLER'S THROW
GOES, since there is no answer to carry it and no queue to drain it into.

### Vendored objects are not PIC

The archive's program and runtime objects are position-independent. Vendored
objects are built by separate cached helpers with their own flags and are
NOT, so a PLANNED archive is uniformly PIC only because the planner refuses
the vendored cases above. Widening those helpers touches objects the
executable lane shares, so it carries its own cache-key consequences.

### Splitting the loop's checkpoint from its fibers

`attached-loop` pulls in `scr_async.c` AND `scr_child.c`, so a library that
pumps carries fibers, timers, and child-process support it never enters. The
attached-source registration is trivially separable; `scr_loop_checkpoint`
is not, because it delegates to the tick and microtask drain.

A refactor of the runtime's loop rather than a packaging decision.

## In the parent

Nothing here needs the compiler.

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
