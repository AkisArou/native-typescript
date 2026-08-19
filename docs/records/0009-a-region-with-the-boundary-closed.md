# 0009 — A region with the boundary closed

Status: accepted finding, nothing built
Last revised: 2026-08-20

This is an investigation record under the policy in
[scriptc evolution](../scriptc-evolution.md). It records the first platform
constraint this project has met that no probe can establish, why the resource
protocol has nowhere to put it, and what would make it buildable. It is not
normative.

## Feature or behavior

[The foreign boundary](../foreign-boundary.md) describes a resource protocol
whose lifetime domains cover what a platform does to a value: acquired,
transferred, released, collected. Every domain it names is about **one value**
and **who ends it**.

JNI has two operations that are not about a value at all. They open a *region*
— a span of native code between an acquire and a release — inside which the
platform forbids operations that are legal everywhere else.

The region CONSTRUCT is not the gap. The same document already describes
structured regions with cleanup attached to the body and — importantly — an
extent chosen by liveness rather than lexical scope, which is exactly the
shape an acquire/release pair wants. What has no expression anywhere is a
**restriction over** such a region. A region says what happens when the body
ends; nothing says what the body may not contain.

## Real motivating program/test

**Not yet, and that is deliberate.** The measurement that found this
(`scripts/jni-pair-census.ts`, over the real `jni.h`, 231 table members) also
found that the surface needing it is empty today:

- Every one of the 12 carried-state acquire/release pairs has a **Region copy
  accessor beside it** — 18 members, `Get`/`Set<Prim>ArrayRegion`,
  `GetStringRegion`, `GetStringUTFRegion` — with no release at all.
- All 1,333 array-returning methods measured across `android.jar` are served
  by that copy path, which is a straight analogue of the string-vector result
  projection this project already has.

So the borrow pair, and therefore the critical region, waits for a program
that needs **zero copy** — predictably large `byte[]` I/O, since `byte[]`
dominates both archives measured (735 parameters and 324 results in
`android.jar` alone).

## Current scriptc revision and result

Measured at parent `f2ee206`. The resource protocol has lifetime domains over
values, and the design has structured regions that carry cleanup. Neither the
manifest, the IR, nor either backend can express "inside this span, these
operations are forbidden" — cleanup is what a region attaches, and a
prohibition is not cleanup.

## Classification

**Missing coverage in a dimension the design describes.** Narrower than it
first looked: the region construct exists and its liveness-chosen extent is
already right for this. What is missing is one property OF a region, and it is
not a lifetime domain — putting it there would place a rule about a span in a
vocabulary whose every member is about a value.

## Required observable semantics

The constraint is stated by the JNI Specification (Java SE 21) and quoted here
rather than paraphrased, because two neighbouring operations word it
differently and the difference is the finding.

`GetPrimitiveArrayCritical`:

> After calling GetPrimitiveArrayCritical, the native code should not run for
> an extended period of time before it calls ReleasePrimitiveArrayCritical. We
> must treat the code inside this pair of functions as running in a "critical
> region." Inside a critical region, native code must not call other JNI
> functions, or any system call that may cause the current thread to block and
> wait for another Java thread. (For example, the current thread must not call
> read on a stream being written by another Java thread.)

`GetStringCritical`:

> In a code segment enclosed by Get/ReleaseStringCritical calls, the native
> code must not issue arbitrary JNI calls, or cause the current thread to
> block.

Three distinctions a specification-shaped contract must keep, and which a
paraphrase would erase:

1. **The foreign-call clause is unqualified in both.** "must not call other
   JNI functions" and "must not issue arbitrary JNI calls" differ in wording
   and not in effect: inside the region the boundary is closed.
2. **The blocking clauses differ in scope.** The array form bars a system call
   that may block *waiting for another Java thread*; the string form bars
   causing the current thread *to block*, unqualified. The second is strictly
   broader, and treating them as one would either over-restrict arrays or
   under-restrict strings.
3. **Duration is advisory and nesting is licensed.** "should not run for an
   extended period of time" is a *should*, not a *must*, and belongs in
   guidance rather than in a checked contract. Nesting is explicitly allowed —
   *"Multiple pairs of GetPrimtiveArrayCritical and
   ReleasePrimitiveArrayCritical may be nested."* (the spelling is the
   published text's) — which means a region primitive must be reentrant.

The spec also states the purpose, which is why the restriction is this sharp:

> These restrictions make it more likely that the native code will obtain an
> uncopied version of the array, even if the VM does not support pinning. For
> example, a VM may temporarily disable garbage collection when the native
> code is holding a pointer to an array obtained via GetPrimitiveArrayCritical.

## Language/IR/runtime implications

The honest contract this licenses is narrower than the prose, because two of
the three clauses are not checkable:

- **No foreign operations inside the region.** This one the compiler can
  enforce outright, and it subsumes several others by construction — no local
  reference is allocated, no exception is captured, nothing is scheduled. It
  also constrains the analysis rather than only the body: liveness may widen a
  critical region only to a span that makes no foreign calls, so the
  restriction bounds the extent it is allowed to choose.
- **Suspension forbidden.** A region that cannot make foreign calls certainly
  cannot survive an `await`, and this is decidable where the blocking clause
  is not.
- **The blocking clause is declared, not verified.** Whether user code inside
  the region calls something that blocks on another Java thread is not
  generally provable. It belongs in the contract as a stated obligation, in
  the same way a thread-affinity declaration is.

The acquire/release pair underneath it is its own shape and is not
destructor-as-data. The token is two values — the array and the elements
pointer — held across a liveness region. That is closer to the callback
registration lifecycle, where a thing is acquired, held across a span, and
released with what acquired it, than to any result projection.

**The mode argument is not a runtime disposal flavour and must not be modelled
as one.** `Release<Prim>ArrayElements` takes a mode that is a function of the
borrow's declared mutability: a read-only borrow releases `JNI_ABORT`, a
mutable one commits. That is contract data plus a compiler-visible fact, which
is the same reduction that turned GIR's three transfer annotations into one
named symbol — and it is worth stating explicitly, because a reduction left
implicit gets re-derived expensively.

## Reference implementations and findings

**The finding that matters most is where the constraint is not.** It is not in
`jni.h`. The header carries bare declarations for both critical pairs with no
comment and no prose. A Clang probe can prove their signatures — including
that `ReleaseStringCritical` takes **no** mode argument where
`ReleasePrimitiveArrayCritical` does, which follows from Java strings being
immutable and therefore having no write-back — and can prove nothing about the
region.

That is the first time this project has met a contract fact with no compiled
surface to derive it from, and it does **not** weaken the evidence rule; it
locates its edge. *Layout, calling convention, enum storage, and signedness*
are properties of compiled code and must come from a probe. A region
restriction is a property of the platform's specification, and the only honest
source is the specification, carried as contract vocabulary written here.

[Record 0007](0007-weak-and-invalid-are-not-one-thing.md) predicted exactly
this shape from the other side. It deferred output validity because no SDK's
metadata could express it, and observed that where such a rule *is* derivable
it is uniform and comes from a profile written here rather than from an SDK,
naming JNI's pending-exception restriction as the first. The critical region
is the second, arrived at independently, and it makes the profile a place two
unrelated findings now need.

## Chosen decision and rejected alternatives

**Chosen.** Record the shape and defer it behind the borrow domain, which is
itself deferred behind a zero-copy program. Build the copy projection first:
it covers everything measured, and the pair never enters it.

**Rejected.**

- *Model the region as a lifetime domain.* Every domain answers "what ends
  this value." The region answers "what may not happen while this is open,"
  which is a different question about a different subject, and answering it in
  the resource protocol would put a rule about spans where nothing checks
  spans.
- *Add the restriction now, since the region construct already exists and the
  constraint is known.* The admission rule exists for this, and the census says
  the first realistic surface does not need it. It would also be designed
  against exactly one platform's wording, which is the mistake
  [the foreign boundary](../foreign-boundary.md) names by title: a restriction
  built against JNI alone would most likely be JNI's restriction wearing a
  neutral name.
- *Merge the two critical variants into one restriction.* Their blocking
  clauses differ in scope, and one of the two is strictly broader. A merged
  rule is wrong in one direction whichever wording it takes.
- *Treat "should not run for an extended period" as a contract.* It is a
  *should* in the source and unmeasurable in general. Promoting advice to a
  checked rule invents a constraint the platform did not state.
- *Reach for the pair because it avoids a copy.* [Record
  0008](0008-what-the-linker-will-not-refund.md) is the standing warning
  against exactly this: a cost that has not been measured is not a
  justification. When a zero-copy program exists, its copy cost is the
  measurement that admits the domain.

## Implementation repository and owner

Nothing to implement. When it arrives: the region primitive is compiler and
manifest work, and the JNI profile that states the restriction is a document
here. Owner: project maintainer.

## Upstream issue/PR/status

None. A region primitive would be neutral compiler capability once a platform
needs it, and is not proposed against no program.

## Conformance tests

None added. `scripts/jni-pair-census.ts` re-derives the taxonomy from any
`jni.h`: three release shapes, not one — the three `Delete*` reference
members, which destructor-as-data already expresses; the bare symbol consumed
inside a projection, which the string-vector result already uses; and the
twelve carried-state pairs, which nothing expresses.

## Removal or revisit condition

Live when a real Android program needs zero-copy access to a large primitive
array and the copy is measured to cost enough to matter. `byte[]` I/O is the
predicted first case.

Revisit sooner if a second platform brings a region restriction of its own,
since two would establish the shape as general rather than JNI-specific — and
a primitive designed against one platform is the mistake
[the foreign boundary](../foreign-boundary.md) warns about by name.
