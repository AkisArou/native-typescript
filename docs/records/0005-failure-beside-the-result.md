# 0005 — Failure beside the result, not instead of it

Status: accepted finding, compiler slice implemented
Last revised: 2026-08-19

This is an investigation record under the policy in
[scriptc evolution](../scriptc-evolution.md). It records why the error-object
contract grew a second shape, what measurement forced it, and what is left
before a binding can use it. It is not normative.

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

Counted straight from the installed GIRs, over `method`, `function`, and
`constructor` elements carrying `throws="1"`:

| Namespace | Failable callables | Return only a success flag | Return a real value |
| --- | --- | --- | --- |
| Gtk-4.0 | 45 | 24 | 21 |
| Gio-2.0 | 349 | 134 | 215 |
| GLib-2.0 | 87 | 34 | 53 |
| **total** | **481** | **192** | **289** |

"Success flag" counts `gboolean` and `void`; everything else carries something
back. The 289 are not exotic: `Gio.File`, `FileInfo`, `GLib.Bytes`,
`GLib.Variant`, input and output streams, `gssize`, `utf8`. Opening a file,
reading its contents, resolving an address, and building a D-Bus proxy are all
in that column.

95 of the 481 also have out-parameters, which is a further slice and not this
one.

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

scriptc fork; owner: project maintainer. Landed in `a0bac491`.

Not yet consumed: `bindgen-gir` still generates absorbing adapters, so no GTK
binding uses this. Adopting it is the next slice, and it is where the 289
become reachable — the adapter stops discarding, and a throwing member's
declared result becomes its real one.

## Upstream issue/PR/status

None filed. The shape is neutral compiler capability and the measurement is
about GNOME only because that is the SDK installed here; the same table would
come out of any C SDK with an error-out convention.

## Conformance tests

- `tests/harness/native-ir.test.ts`, the error-object case on both backends —
  it now covers both shapes, including that the result is not projected on
  failure and that the object is released exactly once on the throwing path.
- The sanitized lane, which is what caught the LLVM release landing on neither
  branch of its pending check.

## Removal or revisit condition

Superseded when the outcome protocol proper lands — success classification
independent of the result, out-parameters as ordinary outputs, and validity
rules saying which outputs are readable on which outcome. Revisit sooner if a
second SDK wants a failure indicator that is neither the result nor a slot,
since that would make this a special case of something more general rather
than the general thing it currently is.
