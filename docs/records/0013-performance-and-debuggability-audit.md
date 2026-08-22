# 0013 — What the performance and debuggability audit changes

Status: evaluated proposal; implementation order recommended below, pending
maintainer decision
Last revised: 2026-08-22

An external audit reviewed the current parent, the ScriptC fork, the JVM
generator and target, the Android acceptance application, and the project's
own performance records. It proposed a source-provenance foundation, a
completed foreign-boundary legalizer, escape-selected JNI reference domains,
native peers, generated Android ergonomics, native debugging, and then
measured optimizations.

This record separates the findings that match the current tree from proposals
that are stale, conflict with a settled design, or need evidence before they
become work. It is not normative. [Architecture](../architecture.md),
[the foreign boundary](../foreign-boundary.md), and
[native subclassing](../native-subclassing.md) remain the contracts.

## Vantage point

The evaluation was made at parent `f32f7d2b` and fork `4e8a7adb`. The fork is
merged through the current upstream tip: `upstream/main...HEAD` reports zero
commits behind and 188 ahead. The only dirty fork files are the four-file
native-peer observer described in the instance-fields handoff.

That matters for two recommendations. There is no upstream synchronization to
perform before the current peer slice, and the backend-neutral native-call
planner is much further along than a survey of an older fork would show.

## Accepted findings

### Source provenance has a correctness defect before it has a debugger gap

`SrcLoc.start` and `SrcLoc.end` are documented as byte offsets. The frontend
populates them with TypeScript `getStart()`/`getEnd()` positions, which are
UTF-16 code-unit offsets. The C emitter happens to index a JavaScript string,
so its entry-file line calculation uses the same unit despite the false
comment. It does not, however, use the location's file: it receives one source
text, computes one line-start table, and prints `mod.sourceFile` for every
location. A function lowered from an imported file can therefore be labelled
with the entry file and a line derived from the wrong text.

The LLVM backend emits no `DIFile`, `DISubprogram`, `DILocation`, or `!dbg`
metadata. The artifact graph names no debug-symbol, line-table, source-map, or
symbol-index artifact, although [build artifacts](../build-artifacts.md)
already promises those products conceptually.

The audit is right that this should be fixed before transformations start
inventing promotion, cleanup, inlining, or fused-call operations whose source
origin is no longer one plain span. The immediate correction is narrower than
the proposed debugger stack:

1. state UTF-16 code-unit offsets truthfully and version the wire contract;
2. make source identity and line tables multi-file and deterministic;
3. falsify them with non-ASCII, CRLF, and imported-file fixtures;
4. establish an interned origin mechanism before the first transformation that
   needs parent/inlined/generated attribution;
5. then materialize C line directives, LLVM debug metadata, symbol artifacts,
   Java bridge mappings, symbolication, and DAP support in observable slices.

A full `DebugOrigin` graph, `.ntsmap` schema, and DAP object model are useful
design sketches, not accepted schemas. Their fields should be admitted by the
first debugger fixture that needs each one.

### JNI local-versus-stable selection is the largest demonstrated performance win

The audit's central performance conclusion agrees with this project's own
[linker falsifier](0008-what-the-linker-will-not-refund.md). A non-escaping
returned JVM object measured 144.1 ns through the conservative adapter and
60.9 ns in the compiler-informed shape. Full LTO did not refund
`PushLocalFrame`, `PopLocalFrame`, `NewGlobalRef`, or `DeleteGlobalRef` because
they remain opaque JVM function-table calls.

This licenses compiler-owned resource domains, liveness, and escape-selected
promotion. It does not license the audit's whole optimization horizon at once.
The stored-object and detailed-failure cases measured at parity, so outcome
machinery, call fusion, explicit execution capabilities, and ThinLTO still
need their own correctness trigger or measurement.

The contract should describe neutral resource properties—frame-bounded,
stable, and weak/non-owning—while the JVM capsule spells JNI operations. A
TypeScript `TextView` should not expose a `jni-local` type. On the first JVM
slice, the names may still be JVM-specific internally if that is the smallest
honest program; they must not become language semantics.

### The Android end-state is right

Ordinary imports, an ordinary native subclass, instance fields, `super`, a
listener lambda, generated lifecycle cleanup, and no module-level retention
arrays are the right application surface. Most of that conclusion already
lives in [Working with Android from TypeScript](../jvm-ergonomics.md), whose
before/after program is effectively the audit's target program.

The current instance-field peer is not merely ergonomic work. It restores
managed object identity across repeated deliveries whose JNI references have
`identity: "none"`; it creates the owner to which later listener registrations
and fields can belong; and it supplies a realistic Android program for later
resource-domain and debugging measurements.

### Application-level measurements and structural counters are required

Operation counts belong in checked/profile builds, and an Android comparison
against an equivalent Kotlin application is the right admission gate for
runtime optimizations. The existing desktop JNI falsifier proves a mechanism,
not ART magnitudes. Startup, interaction, idle work, reference counts, callback
delivery, and teardown should be measured on a device before `GetEnv`
propagation, call fusion, foreign-resident strings, or `@FastNative` becomes a
priority.

The application-measurement half has since become executable. The three-way
Kotlin and plain-NativeScript harness began in
[record 0015](0015-first-android-nativescript-baseline.md), admitted the first
resource optimization in [record 0016](0016-frame-bounded-native-results.md),
and now declares strings, primitive arrays, returned handles, callback
payloads, real text mutation, and a composite screen separately in
[record 0017](0017-android-hotspot-matrix.md). Structural JNI counters remain
the missing half; device ratios still do not prove which resource operation
caused them.

## Findings accepted with modification

### The foreign-boundary legalizer is in progress, not absent

`native-call-plan.ts` and `native-callbacks.ts` already decide result forms,
argument forms, failure forms, handle disposal, throw checkpoints, callback
payloads, trampoline forms, and call lifecycle once for both backends.
[Implementation status](../status.md) records the measured result: no native
call decision is now made twice. What remains is the hard physical half—shared
structured cleanup and trampoline regions whose unwind points currently depend
on backend-owned scope and basic-block state.

The next work should extend that seam rather than introduce a second
`ForeignCallPlan` beside it. Resource domains will need the missing cleanup
representation, so completing that part immediately before the first local
reference slice is justified. It is not a reason to stop the peer, whose
lowering uses ordinary managed ownership and a pair of platform accessors.

### Build modes exist in one layer and disagree across the product

ScriptC already distinguishes a `dev` optimization from its optimized default
and has a separate sanitizer choice. The JVM and GTK target objects and JVM
adapter objects nevertheless hardcode `-O2`, and the artifact plan has no one
mode that every producer consumes. The audit therefore found a composition
gap, not a wholly absent concept.

The eventual input should be coherent across the program, runtime, generated
adapters, Java compilation, link, stripping, and debug products. Whether the
public names are exactly `dev | profile | release` should be decided with the
first debug-symbol/profile artifact rather than added as three labels whose
producers still disagree.

### Declaration-driven SDK reachability needs a bootstrap design

Emitting only reached adapters is correct. Replacing the selection file with
"the checker discovers the declarations it used" omits how those declarations
exist before the checker can resolve an import. A viable design needs one of:

- a cached broad declaration/index product with adapter emission still narrow;
- an iterative declaration-selection/checking protocol;
- package-shaped generated SDK declarations distributed ahead of the app
  build.

Until that is chosen and measured, bounded selection remains an honest
conformance and reproducibility mechanism. Package-shaped modules and automatic
ancestor/member closure can land independently; several of those ergonomic
slices already have.

### Generation-checked tokens are a hardening option, not the peer policy

Opaque generation tokens are already the runtime's transport for callbacks
that may outlive or cross a turn. A generated Java object's peer slot may
eventually store such a token if stale platform delivery demonstrates the
need. The compiler observer should continue to state only the semantic
operation—read or write the peer association—rather than require Java's
physical representation.

## Findings declined or deferred

### A weak peer receiver conflicts with the settled lifetime design

The audit proposes a weak JVM reference from the TypeScript peer by default,
promoted only when asynchronous code retains `this`. That is not the design in
[native subclassing](../native-subclassing.md). A closure created in
`onCreate` and invoked later may call `this.finish()` when no delivered
receiver exists, so peer to handle is strong. The cycle is resolved by three
different edges:

```text
registration -> peer   strong
handle -> peer         weak association
peer -> handle         strong
```

The platform terminal event cuts the registration root and releases the
handle at a stated time. Replacing that with weak-upgrade semantics would make
valid inherited calls depend on reachability and could reset or invalidate
state without the platform ending the object. The current peer slice follows
the settled policy.

### `JNIEnv *` propagation is not admitted on performance grounds

The audit orders it after resource domains, which is correct. The existing
[open-work entry](../open-work.md) goes further: it bounds the likely win below
the measured promotion tax, names a cheaper thread-local alternative and its
correctness cost, and requires a fourth falsifier case with a threshold stated
before measurement. No implementation should begin until that test admits it.

### Call fusion, foreign-resident strings, direct buffers, ThinLTO, and PGO wait

Each has a plausible mechanism. None except reference promotion has a current
application-level measurement. Direct buffers are additionally an API-family
choice rather than a replacement for Java arrays, and foreign-resident strings
need a language/runtime representation whose memory cost must be measured.
They remain candidates, not roadmap stages with implied commitment.

### A debugger is an end-to-end product, not the first source-location patch

C `#line`, LLVM DWARF, Java source-debug mappings, separate symbols,
symbolication, TypeScript stack traces, and DAP build on one another, but they
do not need to land atomically. The permanent gate should grow one observable
capability at a time: correct file/line, native stack symbolication, mapped
foreign frames, breakpoints, locals, then ownership inspection. A proposed
debug-map structure should not be frozen before the first two consumers can
contradict it.

## Recommended implementation order

1. **Finish the native peer now.** Its design is settled, its disagreeing
   observer is already red for the intended reason, and no implementation edit
   has yet been made. It is the final large gap in the current native-subclass
   contract and creates the application shape later work should measure.
2. **Correct the source-position contract next.** Land the UTF-16 and
   multi-file source-table truth with non-ASCII/imported-file falsifiers. This
   is bounded correctness work and should precede resource/promotion
   transformations.
3. **Introduce the minimum transformation-aware origin contract.** Attribute
   ordinary source, generated cleanup, foreign calls, and promotion sites;
   avoid designing inlining and async ancestry until a lowering produces them.
4. **Finish the legalizer's structured cleanup seam.** Preserve emitted output
   byte-for-byte across both backends before using the seam for new behavior.
5. **Build one local-result resource slice.** The observer is a non-escaping
   JVM object result; the gate counts zero global promotions and zero managed
   handle cells, with exact local cleanup on normal and exceptional paths in
   both backends. Re-run the measurement on ART.
6. **Add coherent mode/debug artifacts in executable slices.** Start with
   source/line mapping and separate symbols; progress toward Java mapping,
   stack symbolication, and DAP only as each has an end-to-end fixture.
7. **Use the peer-based Android app for DX and performance work.** Listener
   inference, package modules, generated bootstrap, reference explanations,
   and app-level counters now have a real owner/lifecycle to attach to.
8. **Admit later optimizations by device evidence.** Measure first and keep
   source stepping, ownership, cleanup, and C/LLVM equivalence in every gate.

The key sequencing conclusion is that source provenance should precede the
*new optimization transformations*, not the already-admitted peer. Stopping a
load-bearing, fully observed identity/lifetime slice to design a complete
debugger would increase project risk: it would leave the application without
the state owner that both the debugging and performance proposals expect to
inspect.
