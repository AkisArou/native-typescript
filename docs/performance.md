# Performance program

Status: proposal  
Last revised: 2026-08-23

This document turns the performance half of
[record 0013](records/0013-performance-and-debuggability-audit.md) into an
implementation program for the current tree. Debuggers, source maps, DWARF,
and the source-provenance redesign are deliberately out of scope here.

The peer prerequisite is complete at parent `70edc275` and ScriptC fork
`485b9ded`. A native subclass can now carry ordinary TypeScript instance
fields, preserves one managed identity across repeated platform deliveries,
and releases that peer at its declared terminal event. That gives performance
work the application shape it needs; it is no longer a reason to postpone it.

## Recommendation

Do not begin with `JNIEnv *` propagation, ThinLTO, call fusion, or a broad
optimizer framework. Build one end-to-end resource specialization first:

> A JVM object result that cannot escape its current synchronous native
> boundary remains a frame-bounded JNI reference. It is never promoted to a
> global reference and never enters a managed native-handle cell. A value that
> escapes is promoted exactly once at the escape point and then uses the
> existing stable-handle machinery.

This is the only proposed optimization for which the repository already has
structural evidence. [The linker falsifier](records/0008-what-the-linker-will-not-refund.md)
measured a non-escaping result at 144.1 ns through the conservative adapter
and 60.9 ns in the compiler-informed shape. Full LTO did not remove the opaque
JNI resource operations. Stored objects and fallible scalar calls measured at
parity, so they do not justify widening this first slice.

The shortest honest route is:

1. add a failing operation-count observer for one non-escaping object result;
2. extend the existing native-call planner with the cleanup/resource facts
   that observer requires;
3. add a frame-bounded internal representation and deterministic release;
4. add explicit frame-to-stable promotion;
5. prove both representations on the C and LLVM backends;
6. measure the resulting Android application before admitting the next
   optimization.

This is a vertical slice, not a request to implement every resource domain or
every foreign-boundary dimension in advance.

The present architecture is a baseline, not a protected artifact. The first
recommended slice itself changes the Native IR resource model, the adapter
ABI, and cleanup planning because the existing stable-handle-only boundary
cannot express the measured fast path. Larger changes to the compiler,
runtime, target SPI, ownership model, generated adapters, or artifact graph
are in scope when evidence says they are the simplest way to remove a
material cost.

## The baseline worth preserving

The steady-state JVM path is already static:

- selected classes and method IDs are resolved during bind;
- calls use generated typed adapters and cached `jmethodID`s;
- callbacks use `RegisterNatives` rather than runtime name dispatch;
- the runtime has one owner executor and same-owner synchronous callbacks run
  directly;
- unused platform surface is not a runtime metadata graph;
- C and LLVM consume the same resolved native-call and callback decisions.

Consequently, “remove reflection” and “cache method IDs” are not performance
work. They are properties the current implementation already has.

The demonstrated waste is narrower. An object constructor or object-returning
method currently produces a JNI local reference, immediately calls
`NewGlobalRef`, deletes the local, and returns the global reference. ScriptC
then wraps that reference in its ordinary refcounted native-handle cell, and
the cell eventually calls `DeleteGlobalRef`. That is necessary when the value
escapes. It is pure overhead when the value is only used synchronously and
then dies.

For example:

```ts
const layout = new LinearLayout(this);
layout.setOrientation(LinearLayout.VERTICAL);
this.setContentView(layout);
```

`layout` need not become stable merely because it is a TypeScript local. Java
owns the view graph after `setContentView`, and TypeScript has no later use.

## When to change the architecture

An architectural boundary should move when all of these are true:

1. a fixture or profile names a material cost the current boundary forces;
2. the proposed owner has information the current owner cannot have—for
   example, only the compiler sees escape and liveness;
3. the replacement preserves language behavior, platform lifecycle, cleanup,
   exception order, and owner/thread rules;
4. a disagreeing test proves the new mechanism rather than merely accepting
   either implementation;
5. the change has one semantic owner and both backends consume that decision,
   unless the capability is explicitly target-only mechanics;
6. the superseded path and vocabulary are removed after migration instead of
   becoming a permanent second architecture.

No compatibility promise is made to an internal IR or generated ABI that
prevents a demonstrated gain. Published schemas still require a protocol
revision and a coordinated parent/fork change. Conversely, benchmark novelty
alone is not enough: a faster design that weakens deterministic cleanup,
native identity, or terminal lifecycle behavior is a semantic regression.

## Performance contract

### Source types do not expose resource domains

A `TextView` remains a `TextView`. Frame-bounded, stable, and eventually weak
are compiler representations, not TypeScript types and not Android-specific
syntax.

### The compiler decides when; the generated capsule decides how

The compiler owns escape, liveness, control-flow exits, promotion points, and
cleanup scheduling. A binding family supplies the mechanics that implement a
declared transition:

| Neutral operation | JVM mechanics |
| --- | --- |
| acquire frame-bounded object | return the JNI local reference |
| promote to stable | `NewGlobalRef` |
| release frame-bounded object | `DeleteLocalRef` or boundary-frame end |
| release stable object | existing `DeleteGlobalRef` binding |

The manifest must not decide that a particular call site escapes. The C and
LLVM backends must not rediscover it independently.

### A frame-bounded value is not an ordinary native handle

Today `nativeHandle` means a managed, refcounted cell; backend retain/release,
locals, unions, fields, containers, and cleanup all rely on that fact. A raw
JNI local reference cannot be smuggled through that type without making a
managed cell whose allocation is part of the cost being removed.

The optimized representation therefore needs an explicit internal IR fact,
whether implemented as a distinct internal type or a validated storage class.
It carries at least:

- the nominal native type;
- the resource region in which it is valid;
- the release operation;
- the promotion operation that produces the existing stable handle form.

The exact schema should be admitted by the first observer. What is not
optional is that validators and both backends can distinguish the two forms.

### The resource region is a native boundary, not a lexical block

On Android, a lifecycle or listener callback enters native code with a JNI
local-reference frame. Calls nested inside that delivery may use locals until
the delivery returns. On an attached native owner thread, local references
must be deleted explicitly or bounded by an explicit JNI frame.

A frame-bounded value may not cross:

- return to Java or the embedding caller;
- `await`, generator suspension, or queued continuation;
- another runtime instance, thread, or owner executor;
- a field, global, heap object, union, array, map, set, or unknown container;
- a retained callback capture;
- a call whose contract may retain the argument;
- any path on which its release cannot be proved.

The first implementation should be conservative. Unsupported or unproved
shapes remain stable; they must not receive a speculative local lowering.

### Cleanup is exact on every exit

A local result is released after its last use on normal and exceptional paths.
Loops must not accumulate one local per iteration. If precise last-use cleanup
is not yet available for a control-flow shape, that shape remains on the
stable path until it is.

Promotion is a resource transition, not a second acquisition:

```text
local acquired
      |
      +-- no escape --> DeleteLocalRef exactly once
      |
      `-- escape ----> NewGlobalRef exactly once
                       DeleteLocalRef exactly once
                       allocate one managed handle cell
                       DeleteGlobalRef at stable-owner teardown
```

Failure during promotion must follow the existing foreign failure channel and
must not leak the local reference.

### Native-subclass peers remain stable

The completed peer design is not a candidate for this optimization. Its
settled edges are registration-to-peer strong, handle-to-peer weak for
association, and peer-to-handle strong; the terminal lifecycle dispatch cuts
the registration root. `this` must continue to work from a closure invoked on
a later turn. Replacing the peer's receiver with a weak reference would change
that contract rather than optimize it.

## Implementation sequence

### Slice 1: prove a frame-bounded object result

Add one disagreeing observer before changing the contract. It should execute
the same logical program in two cases:

- a constructor result used only by synchronous native calls and then dead;
- the same result stored or captured so it must survive the boundary.

The observer must count resource operations, not inspect generated text or
assert elapsed time. Required outcomes:

| Case | Global promotions | Managed handle cells | Local releases |
| --- | ---: | ---: | ---: |
| non-escaping | 0 | 0 | exactly 1 |
| escaping | exactly 1 | exactly 1 | exactly 1 |

The stable case should initially continue through the current path. That
keeps the first change focused and gives the observer a control arm that
cannot agree accidentally.

Start with a non-null, straight-line constructor result. Nullable unions,
mutable reassignments, loops, returns, and callback payloads should be added
only with their own disagreeing cases.

### Slice 2: extend the existing legalizer seam

`native-call-plan.ts` and `native-callbacks.ts` already resolve call results,
arguments, failures, handle disposal, callback delivery, and checkpoints once
for both backends. Do not add a second `ForeignCallPlan` abstraction.

Extend that seam only far enough to express:

- frame-bounded acquisition;
- stable acquisition or promotion;
- release on normal and exceptional exits;
- argument projection from either representation;
- the exact point at which a local becomes stable.

Backend-owned scope and basic-block mechanics may remain backend-owned. The
decision to release or promote, and the resource operation selected, may not.
Before enabling the new result arm, compare both backends on existing native
programs and require no observable change.

### Slice 3: make promotion follow escape

Once the direct local path works, add conservative escape classification. A
value is stable when it is:

- assigned to an instance field, module variable, or heap container;
- returned from the resource region;
- captured by a callback that can outlive the call;
- live across suspension;
- passed to an owned/retaining parameter;
- merged into a representation that cannot preserve its resource fact.

Everything else is eligible to remain frame-bounded. The analysis should
explain why a value was promoted in a deterministic compiler report; it need
not expose a new TypeScript API.

The peer-enabled Android counter is a useful end-to-end proof:

| Value | Expected representation | Reason |
| --- | --- | --- |
| `this` | existing stable peer handle | survives lifecycle deliveries |
| `label` | promoted/stable | captured by the retained click handler |
| `button` | frame-bounded | Java retains it; TypeScript does not |
| `layout` | frame-bounded | dead after `setContentView` |
| synchronous click payload | frame-bounded if not retained | dies with delivery |

Java retaining an object is not itself a TypeScript escape. The question is
whether compiled TypeScript needs the reference after its current resource
region.

### Slice 4: specialize callback payloads

Callback payloads are a separate admission because delivery mode determines
their lifetime:

- a same-owner synchronous payload may stay local when the handler does not
  retain it;
- a captured or stored payload is promoted exactly once;
- a queued payload must be promoted or copied before the JNI frame ends.

Do not route same-owner callbacks through the general queue. The existing
direct synchronous path is part of the performance baseline.

### Slice 5: add weak resources only for a real non-owning program

Weak references belong in the neutral horizon, but neither the peer nor the
first local-result slice needs them. Add the domain when a cache or platform
relationship must observe Java collection without keeping the object alive.
That slice must include checked upgrade, absence, and teardown behavior.

## Measurement program

Measurement should accompany the vertical slices without becoming a tracing
platform that delays them.

### Permanent structural gates

CI should assert exact operations for deterministic fixtures:

- global-reference promotions and releases;
- local-reference releases;
- managed handle-cell allocations;
- callback delivery mode;
- promotion reason and source value;
- zero steady-state class or method lookup.

These gates answer whether the optimization happened. Timing gates do not:
shared runners and emulators are too noisy for nanosecond thresholds.

### On-device measurements

Keep the Android acceptance application as a correctness gate and add a
separate benchmark workload. The first comparison should be an equivalent
direct-Android Kotlin application, because it exercises the same UI APIs and
ownership graph. A React Native comparison is useful only when comparing a
renderer or framework-level product; it should not block optimization of the
direct Android boundary.

That instrument now includes a third arm: plain NativeScript TypeScript using
the same raw Android calls, with no React or XML UI. Kotlin remains the direct
platform baseline; NativeScript supplies a useful mature dynamic-runtime
comparison without changing the workload into a renderer benchmark. The
runner pins every NativeScript build input, emits an x86-64 release APK,
rotates all three orderings, and rejects a process that logs completion but
then crashes. The first three-way observation is
[record 0015](records/0015-first-android-nativescript-baseline.md).

Record at least:

- cold and warm launch to first visible frame;
- creation and configuration of a view tree;
- tap/callback latency and repeated interaction throughput;
- rotation and terminal teardown;
- peak and terminal JNI global-reference counts;
- native allocations attributable to handle cells;
- idle CPU and wakeups.

Every result must record the device, Android build, ABI, compiler mode,
artifact digest, warm-up policy, sample count, and raw observations. Desktop
HotSpot results remain mechanism evidence, not ART magnitude claims.

### Checked/profile counters

Add counters at generated mechanics seams only when a device measurement needs
them. They should compile out of release builds. Useful first counters are:

```text
adapter calls
GetEnv calls
NewGlobalRef / DeleteGlobalRef
DeleteLocalRef
managed native-handle cell allocations
same-owner direct callbacks
queued callbacks
UTF conversion units
primitive-array copied bytes
```

Expose the resulting data as a deterministic JSON report first. A polished
`native-typescript inspect performance` command can follow after the fields
prove useful.

## Build configuration

ScriptC already distinguishes development from optimized compilation, while
the JVM adapter and target objects hardcode `-O2`. That is a product
composition defect, but not the first runtime optimization.

After the local/stable slice has a device benchmark, make one build mode an
explicit artifact-plan input consumed by the ScriptC program, runtime,
generated adapters, target objects, linker, Java compilation, stripping, and
performance counters. Admit a separate `profile` mode only when it has a real
consumer. A label that leaves half the graph at `-O2` is not a mode.

ThinLTO should then be measured for code size and adapter-call overhead. It
must not be credited with removing JNI resource operations that remain visible
through the JVM function table; record 0008 already falsified that claim.

## Optimizations after resource specialization

The table distinguishes the landed JVM carrier from candidates that still
need admission evidence:

| Candidate | Admission evidence |
| --- | --- |
| scope `JNIEnv *` across a JVM callback/owner turn | **landed**: [record 0019](records/0019-scoped-jni-environment-capability.md) measured exact `GetEnv` removal and 12.8–34.1% gains in the targeted ART cases |
| keep temporary JVM string staging frame-local | **landed**: [record 0021](records/0021-frame-local-jvm-string-bridge.md) removes the unconditional outbound heap allocation and the inbound native UTF-16 allocation; isolated ART medians fell 26.8–35.8% raw and Kotlin-normalized ratios improved 10.6–16.0% |
| cache literal Java strings | device workload dominated by repeated literal conversion/allocation |
| keep Java-origin immutable strings foreign-resident | demonstrated Java-to-native-to-Java round-trip copies |
| keep exact references in ART in the direct JVM tier | **first slice landed**: [record 0027](records/0027-direct-jvm-reference-values.md) keeps strings and exact `T | null` handles unboxed; string results reached 1.00x Kotlin and nullable handle results 0.56x |
| keep exact primitive arrays in ART in the direct JVM tier | **first slice landed**: [record 0028](records/0028-direct-jvm-byte-arrays.md) keeps `bytes<u8>` as Java `byte[]`; the 256-byte Base64 workload reached 0.94x Kotlin and ran 2.14x faster than the JNI route |
| direct `ByteBuffer` paths | a reached API accepts direct buffers and copied bytes are material |
| ThinLTO/bitcode adapters | measured code-size or call overhead after resource operations are exact |
| generated call fusion | repeated boundary crossings dominate a real hot region and exception order can be preserved |
| integer specialization | **first JVM tier landed**: [record 0026](records/0026-proved-jvm-integer-locals.md) removes repeated coercions from proved int32 locals; setter median moved from 4.40x Kotlin to 0.94x in the matched run |
| `@FastNative` or platform-specific JNI annotations | supported public toolchain contract plus on-device evidence |

`GetEnv` has now been measured behind local/stable selection. Otherwise
identical real-JVM kernels measure 4.3 ns for per-call acquisition and 1.1 ns
for both the scoped TLS carrier and an explicit operand. The narrow target
mechanism therefore captures the measured lower bound without changing SCABI,
Native IR, or both compiler backends. ART then showed targeted improvements of
12.8–34.1%. [Record 0019](records/0019-scoped-jni-environment-capability.md)
records why the earlier 5 ns threshold remains evidence against a broad hidden
ABI, but not against this smaller cumulative optimization.

The string bridge then supplied the next smaller target-owned win. Short
outbound strings stage UTF-16 in the native frame, and inbound strings borrow
JNI's UTF-16 view while allocating only their final UTF-8 owner. This does not
introduce foreign-resident language strings or an adapter content cache;
[record 0021](records/0021-frame-local-jvm-string-bridge.md) records the exact
mechanics, long-input fallback, and matched ART controls.

The direct JVM route answers the broader residency question differently when
the program itself runs on ART: no bridge is needed. ScriptC strings remain
`java.lang.String`, and an exact concrete-handle-plus-null union remains one
nullable Java reference. The first two unchanged result workloads reached
Kotlin parity or better with bytecode proving the JNI and wrapper paths are
absent. [Record 0027](records/0027-direct-jvm-reference-values.md) records the
representation contract, observers, and five-round measurement.

The same rule now applies to the first primitive-array family. ScriptC
`bytes<u8>` remains Java `byte[]` across exact `[B` direct arguments and
results, and length is JVM `arraylength`. The unchanged Base64 workload
reached 0.94x Kotlin and 0.47x the JNI Native TypeScript median; element
operations remain refused until unsigned reads and writes are explicit.
[Record 0028](records/0028-direct-jvm-byte-arrays.md) records the narrow
contract, bytecode, and matched device evidence.

Strings and buffers must follow platform contracts. `java.lang.String`
cannot share native storage, while an API accepting a direct `ByteBuffer` can.
Foreign-resident strings are a lazy-conversion representation, not a promise
of zero-copy Java strings.

## Performance-facing developer experience

Optimization decisions should be inspectable without exposing JNI in source.
A build report should eventually answer:

```text
value: layout
native type: android.widget.LinearLayout
initial representation: frame-bounded
last use: Activity.setContentView
cleanup: local release after the call
global promotion: none
managed handle cell: none
```

For an escaping value:

```text
value: label
initial representation: frame-bounded
promotion reason: retained callback capture
stable owner: MainActivity peer
terminal event: MainActivity.onDestroy
```

This report is part of performance DX: it makes conservative fallbacks and
unexpected promotions actionable. It should be generated from the same
legalized facts the backends consume, never reconstructed from emitted C.

General Android ergonomics—declaration-driven SDK reachability, generated SAM
adapters, listener ownership inference, and invisible bootstrap—remain in
[Working with Android from TypeScript](jvm-ergonomics.md). They should not be
bundled into the first resource-domain change.

## Non-goals and guardrails

- No runtime reflective invocation or generic argument-array bridge.
- No unconditional global reference for an object proven not to escape.
- No blanket weak receiver for native-subclass peers.
- No periodic Android pump; an idle application performs no scheduled JNI
  work.
- No second native-call legalizer beside the existing planner.
- No resource/lifetime decision duplicated in C and LLVM.
- No whole-SDK adapter emission; declarations may be broad, emitted mechanics
  stay reachability-selected.
- No performance claim based only on generated-text inspection or desktop
  timings.
- No call fusion that changes exception order or observable side effects.
- No broad weak, string, buffer, LTO, or capability vocabulary before a
  disagreeing program admits it.
- No debugger foundation as a prerequisite for this program. Existing source
  locations must be preserved, but debugging work remains separately deferred.

## Completion gate for the first program

The local/stable program is complete when all of the following are true:

1. a non-escaping JVM object result performs no `NewGlobalRef` and allocates no
   managed native-handle cell;
2. the local reference is released exactly once on every normal and
   exceptional path;
3. an escaping version promotes exactly once and releases its global reference
   exactly once at the existing managed lifetime boundary;
4. a loop cannot exhaust the JNI local-reference table;
5. C and LLVM pass the same semantic and operation-count fixtures;
6. the full ScriptC and parent gates, including Android device acceptance,
   remain green;
7. an on-device comparison records the application-level effect without
   turning a noisy timing threshold into a correctness gate;
8. the performance report explains why each observed Android value remained
   local or became stable.

After that gate, the measurements—not the size of the remaining audit—choose
the next optimization.
