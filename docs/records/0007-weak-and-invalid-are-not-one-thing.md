# 0007 — Weak and invalid are not one thing

Status: accepted finding, nothing built; the invalidation half revised below
Last revised: 2026-08-19

This is an investigation record under the policy in
[scriptc evolution](../scriptc-evolution.md). It records why "weak handles and
native invalidation" was one open item and is two, why one of them has no
program and the other belongs to a dimension already under construction, and
what would make either reachable. It is not normative.

## Feature or behavior

[Status](../status.md) carried a single line — *"weak handles and native
invalidation have no policy yet"* — which reads as one gap somebody should
fill. Designing it meant asking what would use it, and the answer split in two.

## Real motivating program/test

**Weak references: none.** Counted over the introspectable surface of
Gtk-4.0, Gio-2.0 and GObject-2.0, the number of methods or functions whose
name carries `weak` is **zero**. `g_object_add_weak_pointer` and `GWeakRef`
exist in C and are not introspectable, so no generator can reach them and no
binding can declare one.

That is not an accident of introspection. GObject is reference counted, so a
handle this runtime owns keeps its object allocated; nothing can be freed
underneath a live handle. The hazard weak references answer — a reference that
outlives its object — does not arise. And the hazard they are usually reached
for, a reference cycle, is already answered: a handle type declares
`cycleCollection: "traceable"`, and receiver-owned callback lifecycles are
collected by tracing rather than by weakening an edge.

**Invalidation: yes, and it is a different shape.** Gtk-4.0's own
documentation says "invalidate" 32 times, and the shape is consistent:

> `gtk_bitset_iter_next` — *"Moves `iter` to the next value in the set. If it
> was already pointing to the last value in the set, `FALSE` is returned and
> `iter` is invalidated."*

The object is not gone. Nothing was freed. What happened is that **one output
became meaningless, and the call said so in its answer.** That is a rule
relating an outcome to an output, which is the *output validity* half of the
outcome protocol [the foreign boundary](../foreign-boundary.md) describes —
not a lifetime domain, and not something a weak reference could express.

Answer-as-a-field landed this week, so a member that fills storage and
separately says whether it worked now projects; all **31** live GTK 4 methods
with out-parameters that answer `gboolean` are in that shape. For every one of
them the relationship between the answer and the outputs is stated in prose and
stated nowhere the compiler can see it — **and, as *Required observable
semantics* below records, nowhere GIR could state it either.** So GTK exhibits
the shape without being able to declare it, which makes it a demonstration
rather than a motivating program.

## Current scriptc revision and result

Measured at fork `cb0b8abc`, parent `5101ae2`. A handle carries thread safety,
identity, cycle collection and upcasts; there is no weak arm and nothing has
asked for one. A record carries fields; there is no rule saying a field is
readable only on some outcomes.

## Classification

Two different ones, which is the finding.

- **Weak references — product-scope boundary, not missing coverage.** The
  capability is real and belongs to platforms this project has not reached.
  Building it now would put a lifetime domain in the manifest that nothing
  lowers and no binding declares, which is precisely the 51-declared/23-lowered
  failure [0003](0003-vocabulary-narrowing.md) amputated.
- **Invalidation — missing coverage within a dimension already designed, and
  blocked on metadata rather than on effort.** Output validity is one of the
  five things the outcome protocol settles and the other pieces are landing;
  what is missing is any SDK able to say which outputs an outcome invalidates.

## Required observable semantics

None yet for weak references; that is the decision.

**Revised for invalidation.** This record first said output validity "should
not wait for a platform" because the 31 GTK members were its program. That was
wrong, and the measurement that refutes it is one attribute list.

GIR puts exactly these on a `<parameter>`: `name`, `transfer-ownership`,
`allow-none`, `nullable`, `direction`, `caller-allocates`, `optional`, `scope`,
`closure`, `destroy`. **None of them says an output's validity depends on the
outcome.** `optional` is the near miss and means something else — that the
caller may decline to receive the output at all.

So GTK cannot declare it. `gtk_bitset_iter_next` invalidates its iterator and
`gtk_text_buffer_get_iter_at_line` does not, and nothing in the metadata
separates them; only the prose does. Building it for GTK would mean a
hand-maintained table of which members invalidate — inference where this
project requires evidence, and a table that rots silently as an SDK moves.

That relocates the program rather than removing it. Where the rule is
DERIVABLE it is uniform and comes from a profile written here rather than from
an SDK: JNI restricts almost every operation while an exception is pending, and
COM leaves its out-slots undefined on a negative `HRESULT`. Both are one rule
for a whole platform, stated once.

And the GTK members are not left unsafe by the deferral. A C program using
`gtk_bitset_iter_next` has exactly the same obligation — read the answer, then
read the outputs — because GTK's own API does not distinguish the two cases
either. The binding gives what C gives, which is the honest ceiling until a
platform makes the rule expressible.

What it must NOT become, whenever it is built, is absence. A call like
`gtk_text_buffer_get_iter_at_line` fills the iterator whether or not it found
the exact line, so turning a false answer into a null result would throw away a
usable value and misstate why — the same reasoning that made the answer a field
rather than an absence in the first place.

## Language/IR/runtime implications

None, today. When output validity is built it is a rule over an existing
record shape rather than a new value kind, which is what makes it a slice of
the outcome protocol rather than a new dimension.

A weak arm, if a platform ever needs one, is a lifetime DOMAIN in the resource
protocol — JNI's weak-global with its fallible upgrade, Objective-C's zeroing
`__weak`, WinRT's `IWeakReference`. The fallible upgrade is the part that
makes it a domain rather than a flag: reading through a weak reference is an
operation that can answer "gone", and that answer is a value the program
handles rather than a failure.

## Chosen decision and rejected alternatives

**Chosen.** Split the item. Weak references are deferred with a named trigger.
Invalidation is reassigned to the outcome protocol, where output validity
already has a home.

**Rejected.**

- *Design a weak handle now, because platforms will want one.* Three platforms
  will, and they will want three different things — a fallible upgrade, a
  zeroing reference, a separately-acquired interface. Designing against none of
  them produces a fourth. The admission rule exists for exactly this, and
  [the foreign boundary](../foreign-boundary.md) states it as a first-class
  constraint: no dimension admitted ahead of a real failing program.
- *Treat invalidation as a lifetime problem.* It reads like one and is not.
  Nothing is freed, no reference is dropped, and no ownership changes hands;
  a value that was meaningful stops being meaningful because of what the call
  answered. Modelling that as a lifetime would put a rule about outcomes into
  the resource protocol, where the piece that has to check it — the outcome —
  is not.
- *Say nothing and leave the line as it stood.* "No policy yet" invites
  somebody to supply one, and the useful information is that one of the two
  needs no policy at all while the other already has a home.

## Implementation repository and owner

Nothing to implement. Owner: project maintainer.

## Upstream issue/PR/status

None. A weak lifetime domain would be neutral compiler capability when a
platform needs it; output validity likewise. Neither is proposed against no
program.

## Conformance tests

None added. The measurements are reproducible from the installed GIRs: the
weak surface is empty, and `grep -c invalidat` over `Gtk-4.0.gir` is the other
half.

## Removal or revisit condition

**Weak references** become live when a binding family declares one — JNI's
weak globals are the first, and the trigger is a real Android program holding a
reference that must not keep an activity alive. Revisit immediately if a GTK
binding ever needs `GWeakRef`, which would mean the introspectable surface
grew one.

**Invalidation** is superseded when the outcome protocol's output-validity
slice lands, and that slice waits for a platform after all — one whose profile
states the rule uniformly, JNI's pending-exception restriction being the first.
Revisit for GTK only if GIR grows an annotation for it, which would mean the
metadata could finally say what today only the prose does.
