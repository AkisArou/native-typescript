# 0062 — Place proven synchronous callback contexts in the native frame

Status: implementation and browser correctness complete; measurement pending  
Recorded: 2026-08-26

Record 0061 removed the stable native-handle cell and standalone callback
wrapper from a compiler-proven local Blink event registration. Its callback
context was still an ordinary ScriptC closure, however, and a mutable scalar
capture still required an ordinary ScriptC box. The application matrix creates
and disposes that listener once per exported call, so those two heap objects and
their reference-count/cycle bookkeeping remained directly in the path whose
baseline was 2.286–2.333x handwritten C++.

This record removes that known work without changing the callback ABI or
weakening the lifetime contract. It does not yet claim a speedup.

After that lowering was visible in the release artifacts, a static comparison
found one more structural asymmetry. Handwritten C++ allocated one Oilpan
`NativeEventListener`; the frame entry called the stable registry path, which
allocated the same Oilpan listener plus an off-heap subscription carrying two
`Persistent` roots. This record also gives the already-proven frame result a
separate representation that removes that extra allocation and root pair.

## Proof, not a Chromium heuristic

Native IR now has optional `nativeFrameContext` and `nativeFrameCapture`
annotations. They are selected only when a recomputed whole-function proof can
show all of the following:

- the declaring function and callback target are synchronous and
  non-generators;
- the native binding has a frame-bounded owned result, a result-owned callback
  context, an exact context-release slot, synchronous return, and only
  same-as-caller delivery;
- the callback argument is a direct closure and the registration follows the
  already-proven terminal-disposal shape from record 0061;
- every capture is a direct top-level mutable `number` or `boolean` local, not
  a parameter, inherited capture, temporal-dead-zone box, self-reference, or
  object requiring tracing or destruction;
- no nested closure exposes a selected box; and
- no ordinary heap closure in the function shares any selected capture.

The last condition is computed to a fixpoint: if one sibling closure still
needs a heap lifetime, every frame candidate sharing its box is rejected. IR
validation independently recomputes the proof and rejects annotations that do
not match it. Failure to prove any condition keeps the existing heap closure
and box representation.

The proof is deliberately narrower than what may eventually be possible. In
particular, it does not infer that arbitrary captured references are borrowed,
and it cannot select an asynchronous, foreign-thread, escaping, or persistent
listener.

## One ABI, two storage classes

`scr_box_init_frame` initializes caller-provided scalar-box storage and
`scr_closure_init_frame` initializes caller-provided closure storage. Both use
the ordinary `ScrBox` and `ScrClosure` layouts and set their reference count to
`SIZE_MAX`. Existing retain and release operations are consequently no-ops for
these values, while the same operations retain their normal behavior for heap
values. The Blink subscription may therefore continue to own and release the
opaque callback context through the exact ABI established in record 0061.

The stack storage remains valid because Blink can admit the callback only
during the proven synchronous registration interval. Terminal subscription
release unregisters the listener and invokes the context-release hook before
the declaring function returns. A temporary retain around callback invocation
still protects reentrant cancellation. No frame object participates in cycle
collection and no raw Blink or Oilpan pointer is stored in it.

## Backend lowering and loop safety

The C and LLVM backends consume the same annotated Native IR:

- C reserves each syntactic closure slot with `SCR_STACK_ALLOC` in the
  declaring function prologue and declares scalar `ScrBox` storage there;
- LLVM emits the corresponding entry-block `%ScrBox` and fixed closure-array
  `alloca` instructions; and
- evaluating the closure reinitializes the reserved storage and assigns direct
  capture pointers without retaining them.

Reserving C storage at the closure expression itself was rejected during
implementation. An `alloca` executed on every loop iteration can grow the
native stack until function return even though each logical closure is dead.
Prologue allocation gives C the same one-slot-per-syntactic-site behavior as
LLVM and allows safe reuse after each proven synchronous lifetime ends.

Static inspection of the official generated application artifacts confirms
the exact shape. `runSynchronousEventRoundTrips` has one frame `ScrBox` and one
frame closure slot at function entry in both backends, initializes them with
the two frame helpers, and contains no `scr_box_new` or `scr_closure_new` call.
Its event loop contains the direct Blink click entry and scalar loop update.
The generic constructors remain linked because unproved application paths
still require them; archive-wide symbol presence is not evidence of use by
this function.

## The Oilpan listener is the frame subscription

The stable and frame entries now converge on semantics but not storage:

- an escaping registration keeps `NtsWebManagedSubscription`, its off-heap
  ownership record, `Persistent<EventTarget>`, `Persistent<EventListener>`,
  claim count, and stable ScriptC callback lifecycle;
- a proven synchronous registration creates one
  `BlinkFrameEventListener`. The target's normal event-listener graph strongly
  owns that Oilpan object, and the opaque result is the listener pointer itself
  until the dedicated frame release entry casts it back and cancels it.

The frame listener traces its target and the next listener in an intrusive
realm list. The registry's list head is non-owning: every active entry is
already held by its `EventTarget`, and the raw result remains in the active
native stack covered by the same conservative Oilpan rule as frame-bounded DOM
nodes. The list exists so realm invalidation can remove every listener, close
callback admission, clear the transferred context hook, and release that hook
exactly once. Normal cancellation unlinks before the declaring function
returns. Diagnostics count both representations.

This does not put an Oilpan pointer across `await`. The compiler proof requires
a synchronous non-generator parent, same-as-caller delivery, and terminal
release. Failure of any condition continues to select the stable rooted
representation. It also does not try to stack-allocate Blink's listener:
`EventTarget` legitimately requires its normal Oilpan-managed listener object,
which handwritten C++ allocates as well.

## Build integrity

The optimized C and LLVM archives are generated outside GN's declared output
graph. GN cannot list an existing file under `root_out_dir` as an `inputs`
dependency unless a GN target generates it, so merely replacing an archive did
not make `content_shell` dirty.

After every requested archive has compiled and localized successfully, the
TypeScript archive builder now updates the modification time of the benchmark
host translation unit in the Chromium checkout. Siso then recompiles that one
object and relinks the exact new archives while retaining the rest of the
Chromium object cache. This is an explicit interim integration trigger, not a
claim that external archives have become first-class GN targets.

## Evidence

- The full Native IR C/LLVM sanitizer acceptance suite passes 179/179.
- Six proof tests cover the selected shape, unsafe fallbacks, validation, and
  exact C/LLVM storage emission.
- Focused hosted-async, frame-resource, runtime-smoke, and frame-closure ASan
  tests pass 16/16.
- The frame closure runtime gate exercises repeated callbacks and ordinary
  retain/release operations under ASan and the reference-count audit.
- All eight root Chromium integration tests pass; ScriptC lint and both
  repository builds pass.
- A structural gate proves that the frame entry constructs one
  `BlinkFrameEventListener`, returns it as the opaque result, and contains no
  off-heap `new` or `Persistent`; the stable entry and release remain distinct.
- Both optimized archives compile with pinned Chromium Clang and link into the
  official release `content_shell` through Siso. After the listener-backed
  result change, the eight affected bridge/host objects and final link rebuild
  successfully against the pinned release graph.
- An untimed script-free browser gate runs the exact exported event function 64
  times with three synchronous clicks each. C and LLVM each report checksum
  192, zero retained subscriptions, correct hosted-async FIFO order `JAEBj`,
  and teardown cancellation.

No benchmark or profiler was run while implementing or validating this change.
The previous record 0058 timings remain the only performance evidence.

## Decision

Keep callback-context stack placement as a generally reusable, validator-
enforced Native IR optimization. Do not make it an unchecked Blink fast path,
do not change ordinary closure ABI at the boundary, and do not widen it to
escaping or asynchronously admitted callbacks without a stronger lifetime
model.

The next controlled measurement should repeat the synchronous event workload
first. If the per-call gap remains material, profiling should separate the
remaining required Oilpan listener allocation, registration/removal, realm
lookup, callback checks, and exported-entry overhead before another
optimization is chosen.
