# 0058 — React core compiles, and what stops the rest

Status: measurement complete; two of its three compiler items are now built —
see [record 0059](0059-symbols-and-dispatch-in-the-checked-dynamic-tree.md),
after which React core stands at 9 fences rather than the 18 recorded here  
Recorded: 2026-08-25

Pinned React 19.2.8 was compiled ahead of time against the scriptc fork at
`af08cebf` to find out what a real framework costs. This records the result and,
more usefully, the exact shape of what is left, because two of the conclusions
invert what the compatibility register currently assumes.

The measurement is a probe, not a slice of Phase 5. Nothing here changes the
roadmap's sequencing; it supplies the evidence Phase 5 would otherwise have to
gather from scratch.

## What runs

React's element API executes as native code with output byte-identical to Node:
`createElement`, `cloneElement`, prop merging, reserved-key filtering, key
extraction, and nested element construction. The binary links `libc` and `libm`
and carries no interpreter.

Reaching that took nine preprocessing transforms over React's shipped build —
the documented-transform lane of the
[React compatibility workflow](../scriptc-evolution.md). Each restores a
spelling the compiler already represents rather than adding capability: the
`process.env.NODE_ENV` entry branch flattened, `Component`/`PureComponent`
returned from the ES5 prototype idiom to `class`, builtin aliases
(`var isArrayImpl = Array.isArray`) folded back to their call sites,
`arguments` replaced by rest parameters, guarded `for…in` prop copies rewritten
as `Object.keys` walks, and `Error(…)` constructed with `new`. Equivalence is
held by a differential harness against the pristine pinned build (29 cases) and
a behavioural control (a counter with an effect, a host event, and unmount).

**196 of 207 reachable statements lower statically (94%); 18 runtime fences
remain.** The fence count is the number that matters. A JavaScript statement
with no lowering does not become dynamic code — it compiles to a `runtimeFence`,
a throw naming the construct — so a "compiling" JS program is not a working one,
and the percentage says nothing about which 6% you are about to execute.

## The correction that matters

**Symbols are not the blocker.** The largest fence group reports as
`holding 'symbol' values in a runtime-keyed object literal` (SC1101) against
React's six `$$typeof` brands, which reads as "symbol dispatch is unsupported".
It is not. Measured against a minimal fixture, each of these is fully static:

- a `{ $$typeof: TAG, … }` record built and returned with typed parameters;
- that record nested inside another typed record's field;
- `switch (o.$$typeof)` with symbol cases over a typed receiver.

And each of these fences:

- the same record pushed into an **untyped array**;
- the same record assigned onto an **untyped object**.

The fence is at the consumer, not the literal. A value entering a slot with no
statically known shape takes the checked-dynamic representation, and that tree
has no symbol arm — SC1101 is, per its own registry entry, "converting typed
values to 'unknown'". Annotating all six brand factories changed the count by
zero, which is the confirming experiment.

The same correction applies to `mapIntoArray`'s `switch (children.$$typeof)`:
it fails because `children` is `unknown`, not because the cases are symbols.

## What would clear it

Three items, in descending value.

**A symbol arm in the checked-dynamic tree.** `SCR_DYN_SYMBOL` alongside the
existing kinds in `scr_runtime.h`, boxed by reference the way `SCR_DYN_HANDLE`
already is, because identity is the whole point of a brand. It owes the same
answers every other kind documents: `typeof` is `"symbol"`, truthiness is true,
JSON drops it as it drops functions, `dynCheck` unwraps against a symbol target,
and strict equality compares the reference. This clears the six brand fences and
is the precondition for the next item.

**`switch` over a dynamic discriminant.** Today `switch` requires a static
discriminant; the remedy the diagnostic offers — cast first — cannot apply to
React's children, which are heterogeneous by design (element, string, number,
array, iterable, thenable, portal, lazy). Desugaring to a chain of dynamic
strict-equality tests is the mechanical answer and needs no new representation
once symbols box.

**`.call` on a callee that provably ignores `this`.** `func.call(context, …)` in
`mapChildren` cannot become `func(…)` in general — `context` is the documented
`thisArg` of `Children.map`. But when the callee is a compiled closure whose
body never mentions `this`, the two are equivalent and the check is static.

Together these cover 11 of the 18 fences. The remainder is a `toString(36)`
lowering, `Symbol.iterator`, and two uninvestigated sites on the transition
path.

## The cost that is not React's

One fence — `invokeCallback = 0` — is a single Closure register holding a
boolean, then a string, then a number counter that is accumulated and returned.
scriptc types a binding once, so the numeric assignment contradicts the boolean
inferred earlier.

This is worth recording because it is the second sighting. Vendoring the
reconciler as ordinary program source failed earlier with 42 checker errors of
exactly this shape (`RunInRootFrame` used as both a number and an object).
Register reuse is what minifiers and Closure do to every bundle, so this is a
standing cost of consuming published JavaScript, not a React defect. The source
fix — splitting a reused register into one binding per lifetime — is ordinary
work but needs real liveness analysis; guessing corrupts the returned count.

## What this does not say

The reconciler was not measured beyond load. Class components remain out of
reach for a different reason: rendering one reads `type.prototype`, and
`.prototype` has no value form. And an ICE found on the way is recorded
separately in
[record 0057](0057-hoisted-var-slot-leaks-across-monomorphizations.md); the
`var`→`let` narrowing among the nine transforms exists only to route around it.
