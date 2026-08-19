# 0005 — Failure beside the result, not instead of it

Status: accepted finding, implemented and consumed
Last revised: 2026-08-19

This is an investigation record under the policy in
[scriptc evolution](../scriptc-evolution.md). It records why the error-object
contract grew a second shape, what measurement forced it, and what it cost the
generator to adopt. It is not normative.

It is the first piece of the outcome protocol
[foreign boundary effects](../../foreign-boundary-effects.md) sequences at step
4, and it lifts the restriction that document names: "it retires the current
'throwing adapters limited to info-free results' restriction."

## Feature or behavior

A native operation that can fail reports the failure somehow, and the compiler
has to know how in order to raise a catchable error. It knew four ways: never,
a sentinel result with `errno`, a null result, and an error OBJECT that arrives
**as** the result — non-null means failure.

That last one is the shape a generated C adapter produces when it absorbs a
trailing `GError **` and returns the error pointer. It works, and it costs the
call's own result: if the error is the result, there is nowhere for a real
value to go.

## Real motivating program/test

`scripts/measure-failable-callables.py` counts them from the installed GIRs, so
the table below can be re-derived rather than trusted — an SDK upgrade moves
these numbers. It reads `method` and `constructor` children of a `class` or
`interface` carrying `throws="1"` and not `introspectable="0"`: the surface a
GIR snapshot here can hold. Namespace-level `function` elements are excluded
because they are outside the algebra for reasons unrelated to failure, and
counting them would inflate the case.

| What the result carries | Gtk-4.0 | Gio-2.0 | total |
| --- | --- | --- | --- |
| `gboolean` or `void` — a success flag | 30 | 157 | 187 |
| an object the callee transferred (`full`) | 19 | 129 | 148 |
| a numeric scalar | 2 | 45 | 47 |
| an object the callee kept (`none`) | 3 | 13 | 16 |
| a UTF-8 string | 0 | 9 | 9 |
| an array or a container | 1 | 7 | 8 |
| **total** | **55** | **360** | **415** |

GLib-2.0 contributes none: its 152 failable callables are all namespace-level
functions on records, which is a different missing piece.

**228 of the 415 carry a real value**, and they are not exotic: `Gio.File`,
`FileInfo`, `GLib.Bytes`, `GLib.Variant`, input and output streams, `gssize`,
`utf8`. Opening a file, reading its contents, resolving an address, and
building a D-Bus proxy are all in that group.

The success-flag column is not free either, and that is the part the first
measurement missed. A flag is a result too. Under the old shape those 187 could
only be projected by throwing their flag away, which is why
`g_application_register` — the one this repository's own GTK applications call
— declared `void` and had no way to say whether it had registered.

`tests/native-ir/error-handle.ts` is the conformance program: it divides
through a call whose error arrives in a slot, checks the quotient on success,
and — on failure — checks both that the message is raised and that the value
the callee still returned never reaches the program.

## Current scriptc revision and result

Investigated at fork commit `87d15ef6`. The GObject adapter says the
restriction out loud, which is what pointed at the measurement:

> The adapter absorbs the trailing `GError **` so the boundary sees a pointer
> that is null on success … The wrapped call's own result is discarded, so this
> is limited to members whose result carries no information beyond success.

## Classification

**Missing general primitive**, not a platform feature. "The failure indicator
and the useful result occupy different places" is true of `GError **`, of
`NSError **`, of COM's `HRESULT` beside its out-slots, and of every POSIX
function that returns a count and sets `errno`. Nothing about the shape names
a platform, which is why it belongs in the compiler rather than behind an
adapter.

## Required observable semantics

- The slot is the compiler's: it allocates the pointer, initialises it to
  null, and passes its address. Nothing in the program supplies or reads it.
- Non-null after the call is failure. The message comes from the contract's
  named accessor, the object is released by the contract's named releaser, and
  both run whether or not a callback had already thrown — a pending exception
  wins, but it must not strand the object.
- **The result is never projected on failure.** The unwind happens between the
  error check and the projection, so every projection may assume it is looking
  at a success. The fixture returns a deliberately wrong number on failure and
  the program asserts that number never arrives.

## Language/IR/runtime implications

- `IrNativeErrorOutType` — a compiler-supplied ABI slot beside the closure
  context, and opaque for the same reason.
- `outParameterIsNotNull` — a fourth detection arm, naming the slot.
- `errorOut` — a parameter projection that names no source argument, because
  there is no source value at either end.
- Nothing in the runtime. The message and release symbols were already how the
  error-object contract reads a foreign error, and the throw helper already
  exists.

The admissible-combination table gains one row,
`outParameterIsNotNull/symbol/symbol`, tied to its slot: the named parameter
must BE the error slot, and a binding may not claim both that its result is
the error and that a slot is.

It also removes a restriction, which the adoption is what found. Five result
projections each required the detection to be `never`, written five times. The
rule they meant is that a projection which TRANSFORMS the result cannot sit
beside a detection that READS it — the two look at the same slot and disagree
about what it holds. `never` satisfies that by reading nothing, so the guard
looked right. `outParameterIsNotNull` satisfies it too and was refused, which
would have left the 187 flags and the 47 numeric scalars unreachable by a rule
about sentinels. `nativeFailureReadsResult` and `errorContractReadsResult` name
the question once on each side of the manifest.

## Chosen decision and rejected alternatives

**Chosen.** Let the failure indicator live beside the result.

**Rejected.**

- *Keep absorbing the out-parameter in a generated adapter and return the
  error.* This is what exists, and the 289 callables are what it costs. It also
  puts a decision about how failure is reported into generated C, where the
  compiler cannot see it — the adapter has to pick between the error and the
  result, and only the caller knows which was wanted.
- *Return a tuple of (result, error) and destructure in TypeScript.* It makes
  failure ordinary control flow at every call site, which is the opposite of
  what a catchable error is for, and it has no answer for a call whose result
  is meaningless on failure.
- *Do the whole outcome protocol at once* — out-slots, success classification,
  output validity. The exploration document argues for shipping it whole, and
  the admission rule argues back: 289 named callables need exactly this piece,
  and the 95 with out-parameters need the next one. Building both together
  means neither is verified against a program that wanted only one.

## Implementation repository and owner

Both repositories; owner: project maintainer.

- The compiler shape landed in fork `a0bac491`.
- SCABI's `error-out` arm, the translator, and the end-to-end conformance
  binding landed in `0331f52`. A manifest declares that failure arrives in a
  slot; the translator appends the slot itself, last, because that is where a
  `GError **` sits — the author states the contract, not the plumbing.
- The projection restriction was narrowed in fork `3763c41c`.
- `bindgen-gir` adopted it in `de190ba`, and the adoption was a net deletion:
  107 lines of absorbing-adapter machinery and the per-method wrapper for every
  throwing member. What remains is the per-namespace message and release pair,
  which was always the only part the compiler needed.

Three things fell out of the adoption rather than being built.

**The probe covers throwing callables for the first time.** It had skipped them
because GIR omits the trailing `GError **` and the shorter arity reads as an
ABI mismatch; the fix is to put the parameter back, since the header declares
it. Before, selecting a class whose only selected method throws failed with "a
Clang ABI probe requires a function, record, or enum" — there were no
candidates at all. Measured over GTK 4's 51 introspectable throwing methods,
selecting each one alone: none projected before (20 refused for their result,
26 for the empty probe, 5 for unrelated selection reasons); eight do now, and
the remaining refusals are about unsupplied imports, `filename`, and
out-parameters rather than about failure.

**A member is keyed by its own symbol.** `gio_application_register` was a
synthesized id naming a wrapper; it is `g_application_register` now, because
that is what it binds.

**Two shapes still refuse, and say which slice they need.** A throwing
constructor needs its adopting adapter to FORWARD the compiler's slot rather
than own it — 31 across GTK and Gio. A throwing member with out-parameters
needs the outputs half of the outcome protocol: its failure has a shape and its
outputs do not.

## Upstream issue/PR/status

None filed. The shape is neutral compiler capability and the measurement is
about GNOME only because that is the SDK installed here; the same table would
come out of any C SDK with an error-out convention.

## Conformance tests

- `tests/harness/native-ir.test.ts`, the error-object case on both backends —
  it covers both shapes, including that the result is not projected on failure
  and that the object is released exactly once on the throwing path.
- The sanitized lane, which is what caught the LLVM release landing on neither
  branch of its pending check.
- `tests/gtk-scabi.test.ts`, "a throwing member keeps its own result and binds
  its own symbol" — `gtk_recent_manager_purge_items` returns a count and
  reports failure through a GError, so it exercises the widened number, the
  slot, and the narrowed restriction in one member, through generation and
  translation.
- `tests/gtk-bindgen.test.ts`, which asserts the probe puts the omitted
  parameter back and adds it nowhere else.
- `tests/gtk-application.test.ts`, where a real GTK application's generated
  `register()` declares `boolean` and the binary still runs.

## Removal or revisit condition

Superseded when the outcome protocol proper lands — success classification
independent of the result, out-parameters as ordinary outputs, and validity
rules saying which outputs are readable on which outcome. Revisit sooner if a
second SDK wants a failure indicator that is neither the result nor a slot,
since that would make this a special case of something more general rather
than the general thing it currently is.
