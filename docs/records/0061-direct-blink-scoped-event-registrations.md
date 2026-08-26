# 0061 — Lower scoped Blink event registrations without stable handles

Status: implementation and browser correctness complete; measurement pending  
Recorded: 2026-08-25

Record 0058 separated two event costs. Reusing one listener for a compiled
event loop was already within 1.042–1.062x handwritten C++, while constructing,
dispatching, and disposing one listener per exported call cost 2.286–2.333x
C++. The callback invocation was therefore not the first problem. Every local
registration still constructed a stable ScriptC native handle, callback
lifecycle edge, and Oilpan-rooted subscription even when the compiler could see
its exact terminal disposal.

## Contract

SCABI v14 can mark a synchronous result-owned callback contract with
`frameBoundedContext.releaseParameter`. The named nullable physical callback
slot transfers ownership of the opaque callback context to the native result.
The native side must invoke it exactly once after closing callback admission,
whether registration fails, compiled code cancels the result, or realm teardown
cancels it.

ScriptC selects this form only when all of the following are proven in Native
IR:

- the owned result and callback contract both provide compatible frame-bounded
  entries;
- callback delivery is synchronous;
- the registration is held in one direct local binding;
- one top-level cancellation is its terminal use;
- every earlier use is a synchronous borrow;
- no later use, escape, suspension, generator, mutable/boxed alias, or
  unsupported control-flow path exists.

Absence of proof is not an error and does not select an unchecked shortcut. A
registration stored across exported `start` and `stop` calls, for example,
continues to use the stable managed lifecycle.

## C and LLVM lowering

Both backends consume one shared native-call plan. Checked argument conversions
complete before one closure retain is transferred. The frame entry then
receives an alternate generated trampoline, the retained `ScrClosure` itself,
and `scr_closure_release_v`. Blink stores that ownership edge directly inside
the subscription, so ScriptC allocates neither a `ScrDirectCallback` wrapper
nor a `ScrNativeHandle`. Terminal disposal calls the frame release entry and
clears the lexical slot, making ordinary scope cleanup a null-safe no-op. The
trampoline takes a temporary closure retain around each invocation, preserving
reentrant cancellation safety.

The stable fallback still uses
`scr_native_handle_prepare_direct_callback_fused` and the ordinary listener
entry. Regression tests inspect both C and LLVM plans and generated source: the
application-shaped local benchmark selects the frame form, while the counter's
cross-export subscription selects the stable form.

## Blink ownership

`NtsWebManagedSubscription` optionally owns the transferred callback context
and its release function. Cancellation performs this order:

1. unregister the exact Blink listener;
2. detach the listener and close callback admission;
3. clear the stored context/release hook;
4. invoke the hook once.

Failed lookup, invalid realm/target/type, native registration failure, explicit
disposal, and context destruction converge on that ownership rule. Callback and
release calls from separately compiled ScriptC archives pass through narrow
CFI-suppressed ABI wrappers; Chromium CFI remains enabled around the rest of the
renderer.

## Evidence

- SCABI validation, translation, WebIDL generation, and compiler regression
  tests pass.
- The direct-callback runtime passes ordinary, ASan/UBSan, and TSan tests,
  including reentrant owned-context release.
- Focused C and LLVM callback programs pass.
- The generated local benchmark programs call the frame listener/release
  entries and contain neither stable callback-handle preparation nor a
  standalone direct-callback allocation.
- The generated persistent counter programs use the stable fused path and do
  not call the frame listener entry.
- Both refreshed counter archives link into the pinned official
  `content_shell`.
- The real script-free C and LLVM counter lanes each pass initial DOM
  observation, native click delivery, DOMException/SecurityError projection,
  and navigation teardown.

No timing or profiling result is recorded here. The implementation removes a
specific allocation/lifecycle layer, but its performance effect remains
unproven until the controlled four-lane application matrix is repeated.

## Decision

Keep scoped event registration as a compiler-proven lifetime tier, not a
Chromium-specific heuristic. Stable handles remain required for escaping or
otherwise unproved registrations. The next measurement should first repeat the
synchronous event workload under the existing quiet-machine protocol; only
then should profiling decide whether the remaining gap is closure boxing,
closure allocation, Oilpan listener allocation, or Blink registration itself.
