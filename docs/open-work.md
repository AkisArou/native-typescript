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

### Library caching adoption — IN FLIGHT

Upstream's four library-caching commits merged as modules and are present but
unwired, because their `compileLibrary` restructure conflicted with this
fork's prepare/plan extraction and a hand-merged hybrid was not something
anyone could vouch for.

Two tiers, and they split by what they return. `EarlyLibraryCacheHit` yields
PATHS — a short-circuit to files, useless to a planner that produces none.
`SemanticLibraryCacheHit` yields an `IrModule`, which is what
`prepareLibraryCompilation` produces, so it can serve BOTH entry points.

The value is specific to this project's shape: emission and archiving are
already cached by the artifact graph, but the frontend runs in-process inside
the planner and is cached by nothing.

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
hidden capability operand. Removes a `GetEnv` from every adapter call.

Unlike resource domains, its performance value is NOT established — the
falsifier measured promotion, not context acquisition. Measure before
building.

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

### Vendored objects and localization in a library PLAN

`planLibraryExternalCBuild` refuses a library needing the regex engine, zlib,
or symbol localization: each builds artifacts of its own through its own
cached helpers, which an external graph must declare before anything produces
them.

Admitted when a library plan needs one. A regex literal in library mode is
the likely first.

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
