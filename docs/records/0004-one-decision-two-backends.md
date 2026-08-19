# 0004 — One decision, two backends

Status: accepted finding, extended — see the legalizer slices below
Last revised: 2026-08-19

This is an investigation record under the policy in
[scriptc evolution](../scriptc-evolution.md). It records why the outbound
native-call lowering is being pulled out of the two backends and into one
shared decision layer, what evidence forced it, and how far that has gone. It
is not normative.

It is the first move toward the legalizer
[the foreign boundary](../foreign-boundary.md) requires — one pass lowering a
foreign call into ordinary calls plus explicit cleanup before either backend
sees it — and this record is the measurement that turned that proposal into a
scheduled change. [0006](0006-one-vocabulary-one-owner.md) later found this
landed out of order: the vocabulary the legalizer would share is still
declared in two repositories, so the decision layer shares a decision without
sharing its declaration.

## Feature or behavior

The C and LLVM backends each lower a `nativeCall` and each emit the callback
trampolines it needs. They share the IR and nothing else: every decision about
what a payload becomes, which trampoline shape a contract calls for, and what
happens around the call is made twice, in parallel code, kept in agreement by
review.

## Real motivating program/test

Not a program — a defect pattern. Every one of these was introduced and found
while implementing the retained-registration work in this repository's own
history, and every one is the same mistake:

| Defect | Shape |
| --- | --- |
| `.wide` payload name asked for but never produced | condition changed in C, not LLVM |
| `callbackRelease` projection had no LLVM case | case added to C, not LLVM |
| callback slot global emitted twice | new emission added, old one not removed |
| owner-scoped arm guard narrowed in C only | a process registration reached owner-side token machinery |
| `ffiHasRetainedCallback` updated in C only | exit-listener ordering diverged between backends |

Five defects, one cause. None was caught by reading the diff; each cost a
build failure or a red test. The last one is the most telling — it was not in
the emission at all but in a module-level flag, which shows the duplication is
not confined to the code that writes strings.

## Current scriptc revision and result

Measured at fork commit `4a442a6a`, before the first slice landed.

The comment `kept in lockstep with the C backend` appears **six times** in the
LLVM emitter, all in native-call lowering. It is an instruction to a future
reader to do by hand what a compiler should do by construction.

Counting the structures that exist in both backends for one feature:

| Structure | C | LLVM |
| --- | --- | --- |
| `retainedTokens` | 9 | 9 |
| `copiedStrings` | 7 | 8 |
| `ownedHandles` | 7 | 9 |
| `processRegistrations` / `processReleases` | 3 / 3 | 3 / 3 |
| `rawContexts`, `afterCall` | 2 / 3 | 2 / 3 |
| span and release projections | 2 / 2 | 2 / 2 |

The symmetry is the finding. These are not two implementations that happen to
overlap; they are one design transcribed twice.

## Classification

**Architectural constraint.** The duplication is not a style problem, it is a
correctness surface: the number of places a decision can be made is the number
of places it can be made differently, and the measured defect rate is what
that costs.

It is also a *prerequisite*, which is why it is worth paying for now rather
than later. Every dimension
[the foreign boundary](../foreign-boundary.md) names — lifetime regions,
resource domains, outcome protocols, reentrancy — is cross-cutting. Adding one to two independent lowerings doubles both the work
and the failure surface, and the five defects above are what that already
looks like at the current, much smaller, scale.

## Required observable semantics

None. The whole refactor is required to be observationally inert: upstream's
48-test conformance suite, the native-IR suite, the differential lane against
Node, and the parent's application gates must all be unchanged at every step.
That is the only property that makes a refactor of this size verifiable.

## Language/IR/runtime implications

The shape is a **decision layer**, not a new IR. A shared function reads the
binding and contract and returns typed data describing what must happen; each
backend maps that data to its own primitives and to nothing else. No IR node
is added, no serialized shape changes, and the plan is not persisted — it is
derived at emission time from facts the IR already carries.

This is deliberately weaker than the legalizer
[the foreign boundary](../foreign-boundary.md) specifies, which lowers a
foreign call into ordinary calls plus explicit cleanup regions before either
backend sees it. That remains the target. Starting with a decision layer gets the correctness benefit
immediately, at a fraction of the risk, and each slice is independently
verifiable.

## Chosen decision and rejected alternatives

**Chosen.** Extract the decisions in slices, ordered by measured defect
density, each landing green. All three landed, each observationally inert.

1. **Payload reads**, in `04240e17`. `nativeCallbackPayloads` names what each
   source argument becomes — direct, widened number, boolean over declared
   storage, C string, span, owned handle, injected owner. Two duplicated
   derivations (the slots whose pointers must not be stored, the handle
   payloads and their destructors) became filters over that one list. Three of
   the five defects above were in this code.
2. **Trampoline shape and closure source**, in `502915fc`.
   `nativeTrampolineForm` names which arm a contract calls for — call-scoped,
   direct, or queued — and where the trampoline finds its closure, which is
   one of exactly four places: the context slot itself, a thread-local, a
   token in the context slot, or a token in a replaceable global. Two of the
   five defects were here.
3. **Call-site lifecycle**, in `f68a8b30`. `nativeCallLifecycle` gives
   the ordered setup, the slots lent after argument conversion, and the
   teardown. The ORDER is the decision: registration precedes the call because
   a library may fire on subscribe; a release is validated before and unpinned
   after, because the registration must stay readable for a library that
   flushes one last time; a lent slot is armed after every conversion, because
   a conversion that throws must not leave one armed.

4. **Result legalization**, in `35160a21`. `nativeResultForm` resolves and
   validates what a call's result becomes, once. The same measurement one
   level in: 24 `emitter bug` contract checks in the C lowering and 28 in the
   LLVM one, about twenty-two the same check, three already drifted in
   wording, and a seven-arm ladder running in different orders on the two
   sides. Resolving a contract is not emission — which union arm carries the
   handle, which symbol releases it — so it moved, and each backend now ends
   its ladder with `const remaining: "direct" = resultForm.kind`, which makes
   TypeScript refuse a new arm that one backend forgot. That is the five
   defects above turned from a review obligation into a compile error.

5. **Argument legalization**, in `7c9f0b8f`. The same eleven-case switch on
   both sides, in different orders, with `number` and `boolean` swapped
   exactly as the result ladder had them. It also surfaced a real divergence:
   C tested `owned` before the nullable arm and LLVM tested it after, so a
   parameter that was both would have surrendered on one backend and passed
   NULL on the other. It cannot be both — the validator refuses ownership of
   anything that is not a required handle argument — so the disagreement was
   unreachable, and the shared form ends it rather than leaving it to be
   discovered by the first binding that made it reachable.

6. **Failure legalization**, in `93550d74`. The last drifted wording: one
   check read "sentinel failure over non-integer result" on one side and
   "errno over non-integer result" on the other. It resolves the two
   detections that are not the result; the other two stay with the result
   forms, because for those the check and the projection are one act.

**Rejected.**

- *Generate one backend from the other.* The two emit genuinely different
  things — C has expressions and declarations, LLVM has SSA names and basic
  blocks — and a generator would have to model both, which is the legalizer
  with worse ergonomics.
- *Keep the duplication and add tests.* A test can only catch a divergence
  someone thought to write. Four of the five defects above were in
  combinations no existing test reached; they were found by a build failure or
  by a fixture that happened to exercise one new payload shape.
- *Do the full legalizer first.* It is the right endpoint and the wrong first
  step: a single change large enough to reorganize both backends is one whose
  green suite proves the least, because nothing smaller was ever verified.

## Implementation repository and owner

scriptc fork; owner: project maintainer. Slices landed in `04240e17`,
`502915fc`, `f68a8b30`, `35160a21`, `7c9f0b8f`, and `93550d74`.

Measured across the legalization slices, one `nativeCall` lowering went from
704 lines and 24 `emitter bug` contract checks to 624 and 4 in the C backend,
and from 1142 and 28 to 1065 and 8 in the LLVM one — where 4 of the LLVM 8 are
genuinely physical, being aggregate classification and pointer narrowing, and
correctly stay. What remains shared is the call sequence: the binding lookup,
the owned parameter, the cancellation binding, and the conflicting owners.

Afterwards, the ten remaining `kept in lockstep with the C backend` comments
in the LLVM emitter are all outside native-call lowering — they mark the next
places worth the same treatment, and they are a usable measure of where the
duplication still is.

## Upstream issue/PR/status

None filed. Nothing is proposed upstream until the local refactor is complete;
the duplication is upstream's too, so the finding travels with it.

## Conformance tests

Unchanged, and that is the point — every slice must leave all of these exactly
as it found them:

- `tests/harness/ffi.test.ts` — upstream's 48, both backends;
- `tests/harness/native-ir.test.ts` — 127;
- `tests/harness/differential.test.ts` — at its recorded baseline on both
  shards, Node as the oracle;
- the parent's 179, including the GTK applications on a real GLib loop.

## Removal or revisit condition

Superseded when the decision layer becomes the legalizer
[the foreign boundary](../foreign-boundary.md) describes — one pass producing ordinary calls, explicit outputs, and
cleanup regions, with backend code limited to materializing call targets and
primitives. Revisit sooner if a slice cannot be made observationally inert:
that would mean the two backends had already diverged in behavior, not only in
structure, and the divergence would be the more urgent finding.
