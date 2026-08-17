# Roadmap

Status: normative sequencing; scope changes require architecture review  
Last revised: 2026-08-15

The roadmap is a sequence of permanent vertical slices. A phase exists to prove
and ship reusable architecture, not to create a disposable demo. Dates are set
only when the preceding exit gate is satisfied.

## Delivery rules

- No phase begins by bypassing an unfinished foundation from an earlier phase.
- Each slice includes implementation, diagnostics, conformance tests,
  documentation, and representative benchmarks.
- A target-specific need that reveals a missing general primitive returns to the
  owning foundation; it is not patched into the target.
- Generated adapters and packaging use the same artifact graph intended for
  production.
- Unsupported behavior fails precisely. A demo may be narrow, but never relies
  on silent stubs or leaks.
- Performance budgets are measured from the first executable fixture.
- The active tree contains one architecture. Refactors remove superseded paths.

## Phase 0: architecture baseline

### Deliverables

- Normative architecture and focused specifications.
- Clear ownership between the scriptc fork and this repository.
- Pre-1.0 refactor and schema policy.
- Initial scriptc compatibility register.
- Replacement of the previous combined Milestone 1 with gated phases.

### Exit gate

- Every compiler/runtime/build value has an identified owner, lifetime, thread,
  process/domain, and serialization rule where applicable.
- Target, SCABI, runtime, ownership, partition, and artifact specifications agree.
- No implementation package claims an API that contradicts the documents.

## Phase 1: compiler and C ABI foundation

This phase creates the reusable platform substrate.

### Compiler fork

- Establish immutable compiler phase hooks required by target planning.
- Define and validate generic Native IR.
- Separate native operations from closed Node/runtime-specific operation tables
  where required by the new boundary.
- Implement exact native scalar values and conversions in frontend, IR, C, and
  LLVM backends.
- Implement native aggregate/layout values.
- Implement native handles and ownership operations.
- Implement callback-table and owner-scheduler gateway primitives.
- Implement one generic owner wait-set/event-source contract shared by host
  dispatchers, timers, terminal/file-descriptor readiness, signals, sockets,
  pipes, child processes, filesystem watches, and gateway wakes.
- Extend coverage diagnostics and IR/cache versioning.

### Native TypeScript workspace

- Implement the provider-based Target SPI.
- Implement SCABI v1 schema, canonicalization, validation, and declaration
  agreement checks.
- Implement a Clang-backed C header binding generator.
- Implement C native lowering and adapter planning.
- Implement artifact-graph planning/execution for host C builds.
- Implement native executable and C-callable static/shared library products.
- Emit build, binding, ownership, callback, and cache reports.

### Permanent conformance fixture

One fixture library exercises:

- exact integer and floating-point values;
- padded structs passed and returned by value;
- borrowed strings and bytes;
- owned native returns and exact destruction;
- call-scoped and retained callbacks;
- a `void` callback arriving concurrently from a foreign native thread;
- owner-thread delivery and promise ordering;
- native error conversion;
- TypeScript functions exported through the C ABI.

The fixture remains the cross-backend and sanitizer regression suite.

### Current implementation boundary

Recorded in [Implementation status](status.md). The exit gate below is the
normative bar; the status document tracks how far the implementation has got
against it.

### Exit gate

- C and LLVM backends have equivalent observable results.
- Checked/sanitizer builds report no leaks, races at the gateway, stale handles,
  or use-after-free.
- A target is implemented without adding target-specific cases throughout the
  compiler pipeline.
- Clean and cached builds produce identical unsigned artifacts.
- SCABI/layout mismatches fail before native code executes.
- The resulting interfaces are accepted as the foundation for the next target;
  placeholders and experimental duplicate paths are removed.

## Phase 2: GTK native application

GTK/GObject is the first UI consumer because it exercises metadata generation,
object identity, floating references, signals, callbacks, thread affinity, an
external event loop, resources, and packaging through a broadly C-compatible
stack.

### Deliverables

- GIR plus authoritative header/layout binding ingestion.
- GObject handle and identity rules.
- GLib main-context runtime provider.
- Signal registration and deterministic disconnection.
- GTK application lifecycle and packaging.
- Raw TypeScript access to a deliberately narrow but real GTK surface.

### Current implementation boundary

Recorded in [Implementation status](status.md).

### Next slices

The application lifecycle generates, runs, and no longer depends on
hand-authored C. Two findings came out of running it, both fixed:

- A package that reached an imported flags type synthesised a second
  `combine` for it, so two packages declared the same member and composition
  refused the program. The owner declares it; an importer does not.
- Collector visibility is derived per package but the invariant is global.
  A derived handle in one package and its base in another disagreed about
  whether the collector traces them, which the compiler rejected as an invalid
  identity upcast. Composition reconciles it now, because it is a conclusion
  rather than a declared contract.

**Where the bootstrap belongs.** Done. `gtk_init` and attaching the GLib owner
runtime are what a GTK target does before any TypeScript runs, not application
code, so they live in `packages/target-gtk/runtime/nts_gtk_application.c` beside
`nts_glib_runtime.c` and reach TypeScript through `target-gtk`'s own SCABI
package. An application composes three packages — toolkit, target runtime, and
its own native code — rather than standing one in for another.

Teardown stayed split rather than moving wholesale. `nts_gtk_application_shutdown`
stops accepting retained callbacks, destroys the service, and detaches the
runtime, returning whether the service was idle when it was asked to stop. The
application runs its own checks first and calls shutdown after them, so a
failure in application state is never reported as a runtime failure.

The two objects share one source tree but not one dialect: the owner runtime is
portable C held to `-std=c11 -pedantic`, while the bootstrap reaches GNU
extensions through the GTK headers and compiles as `-std=gnu11`.

**Finishing the numeric model.** The GIR surface is done: every integer of at
most 32 bits crosses as a plain `number` under the declared conversion policy,
checked on the way in and widened on the way out, with literals decided at
compile time. That dissolved the usability gap — ordering, printing, `Math`,
and arithmetic all work on GTK values — and it dissolved the `gint`/`gint32`
defect at the source: both spellings are transparent aliases for `number`, so
mixing them is no longer a type error a caller cannot act on. The two SCABI
types remain, correctly, as distinct names for one proven ABI type.

Two tracks remain, in this order.

*Making the checked boundary free where it is provably unnecessary.* Done for
the shapes that matter. The abstract-value domain `int-infer` implemented for
the library lane now lives in `ir/number-facts.ts` and serves both consumers;
a pass over validated IR certifies the crossings that need no check, and both
backends consult it. A widened egress value seeds the facts, so a round-trip
such as `sender.setContentWidth(width)` inside a resize handler costs nothing,
and a provably failing crossing is a diagnostic rather than a call that can
only throw.

What remains on this side is machine-integer specialization: representing a
provably-integer value as a machine integer inside compiled code, for the
shapes where it pays — loop inductions, and guarded add/sub/mul through the
overflow intrinsics with an f64 fallback. That is a Layer-1 optimization with
no semantic content: `number` stays f64, byte-exact to Node. It needs a
benchmark harness before it needs an implementation, because its whole
justification is a measurement.

*The exact family that remains.* [Language profile](language-profile.md)
specifies a whole numeric contract for it, and all of it is implemented except
the helper families: same-type wrapping `+`, `-`, `*`, the three bitwise
operations, all four orderings at the declared width and signedness, literal
construction with a compile-time range check, division, remainder, and both
shifts with the traps the profile specifies, and — as declared operations —
the conversions to and from an ordinary number.

What remains: **the checked, saturating, and explicitly wrapping helper
families**, which name an overflow policy the primitives do not have, and
converting between two exact widths without going through a number. Both were
held for a written comparison rather than built, on the grounds that they
would add members to `i64.…` and that surface had already been half wrong
once. Here is the comparison. **The answer is to build neither.**

*Would a real binding reach them?* Measured against GTK 4: no. Everything
narrower than 64 bits carries the number conversion, so the only exact family
a GIR binding reaches is 64-bit — and `gint64` appears on **five live
members**, all of them `GtkMediaStream`: `get_duration`, `get_timestamp`,
`seek`, `stream_prepared`, `update`. They pass microsecond timestamps through.
Every expression such a caller needs already compiles: `(stream.timestamp +
5_000_000n) as gint64` to seek forward, `(t / 1_000_000n) as gint64` to reach
seconds, `gint64.toNumber(t)` to print one. A media timeline does not overflow
an `i64`, and none of the five converts between widths.

*Does an overflow policy belong on the operation or on the type?* On the
operation if anywhere — but at 32 bits and below it belongs on neither,
because it is already there. `fromNumber` is checked, and `number` is exact
for every sum, difference and product of two 32-bit integers, so
`i32.fromNumber(i32.toNumber(a) + i32.toNumber(b))` *is* the checked add, and
clamping before the conversion is the saturating one. Only 64-bit would need a
primitive, and 64-bit has no caller. Putting the policy on the type is the
tempting shape and is wrong twice: `(a + b) as i32` would mean different
things depending on a manifest the reader is not looking at, and a checked `+`
would make every arithmetic site a throwing site — a cost every user of the
type pays so that a few can skip a conversion.

*Is a width conversion a member of the source type or the destination?* The
destination. `i32.from(v)` reads as construction, the check it performs is the
destination's — does this fit in an `i32` — and it is one member per type
rather than one per ordered pair, where `i64.toI32` and its ninety siblings do
not scale. But it is a refinement rather than a capability:
`i32.fromNumber(i64.toNumber(v))` already produces the right value or throws,
and differs only in which error a large `i64` fails with.

**Decision: build neither. The trigger to revisit is a manifest that reaches a
64-bit exact scalar a caller must compute with rather than pass through** —
Phase 3's terminal surface or Phase 4's platform SDKs may bring one, and the
answers above say what to build when it arrives.

**And the surface question has a third answer neither item reaches.** What
started the reevaluation was a cast — `(a + b) as gint64` — and neither
building helper families nor adding width conversions removes it. The cast is
there because the type is *branded*: TypeScript types the sum of two branded
bigints as a plain `bigint`, dropping the brand, so the `as` is where the exact
type is reasserted. That is a TypeScript limitation rather than one of ours,
and no amount of declared operations touches it.

The answer is to change the carrier rather than add operations. A 64-bit
position could declare `conversion: "bigint"` the way a 32-bit one declares
`"number"`, and the crossing would be honest in both directions: egress is
total and exact, because every `i64` *is* a `bigint` with no 2⁵³ cliff, and
ingress range-checks against the width and throws, exactly as the number
ingress does. Then

```ts
stream.seek(stream.timestamp + 5_000_000n);   // no cast
const seconds = t / 1_000_000n;               // no cast; `/ 0n` already throws
if (t < deadline) …                           // ordinary comparison
```

What it gives up is wrapping. Arithmetic on plain bigints is exact and
unbounded, so an overflow is caught at the boundary instead of wrapping modulo
2⁶⁴. For a timestamp that is strictly better — a silent wrap there is a bug
either way. For genuine machine arithmetic, masking and rotating a register,
the exact branded type is what you want, and it stays: the policy is per
position, so a manifest that wants machine semantics declares nothing.

Its cost is a checked bigint ingress in both backends, beside the ≤32-bit one
that exists, and a row in the profile's policy table. Its payoff is that the
five `GtkMediaStream` members lose their casts entirely — which is more than
either declined item offers, for less surface.

**Adjacent, and worth more than either: `gsize`.** Platform-width integers are
absent from the scalar table, which refuses 17 live GTK members across
`Snapshot`, `Builder`, `EntryBuffer` and `Text` — more callers than the two
items above have between them. Two ways to admit them. Add `isize`/`usize`
exact scalars with BigInt carriers, which the compiler already has, and give a
string length the ergonomics of a bignum. Or extend the number conversion past
32 bits with a **checked egress**: a `RangeError` where the double would not
denote the same integer, which is exactly what `gint64.toNumber` already does
and what the conversion vocabulary already names. The second is the better
trade for a length — every `gsize` a real program produces fits in a double
and reads as a plain number, and one that does not fails loudly rather than
silently. Its cost is that egress stops being total: a widened result becomes
a throwing expression, which both backends must carry and `mayThrow` must
know. Measure it against the ingress checks already there before building.

Taken together the two say one thing: **the carrier should follow what the
values are.** A length that always fits in a double reads as a number and
fails loudly when it does not; a timestamp that genuinely exceeds 2⁵³ reads as
a bigint; a register you mask and rotate stays exact. All three are the same
per-position declaration, and the choice is evidence about the API rather than
a preference.

One thing is deliberately not on that list. The construction form
`(a + b) as u32` stays, and the earlier claim that it was a mere lowering seam
was wrong: TypeScript types arithmetic over two branded numbers as plain
`number`, so the bare expression does not typecheck against an exact
declaration whatever the lowering accepts. Closing it would mean the checker
tracking branded arithmetic, which is a TypeScript question rather than a
ScriptC one. Division rides the same form for the same reason, which is why
only the conversions are declared operations: an operator expression can be
rescued by a cast, and a direction cannot be spelled at all.

**Projecting an object the callee already owns.** Done, from both sides. 187
GTK methods return a borrowed same-namespace object and 19 signal payloads
carry one; before this an application could only touch objects it had
constructed itself.

Interning is what made either possible. Handles whose binding declares pointer
identity are interned, both backends consult the map before committing a cell,
and GObject handles declare it — so two projections of one widget are one
managed cell rather than two that disagree about equality. Keying that map by
pointer alone rather than by (type, pointer) is load-bearing: the same object
reached as `Box` and as `Widget` must not get two cells.

Generation had to land in one change, because the release rule and the
projection decide each other:

- A borrowed result needs a destructor to name, and the release binding was
  generated only for a class with constructors. `Widget` has none and is 78 of
  the 187 on its own; 122 of them return a class with no constructor.
- The release *symbol* comes from the constructor ownership adapter, so such a
  class had no release function in C either. Both layers treated release as
  something constructors bring.
- A release that nothing names as a destructor is refused: *general
  ownership-consuming calls are outside the exact-destructor slice*. So a class
  may not be given one speculatively. Releases were emitted for exactly the
  classes something destroys — those with constructors, plus those returned
  borrowed or delivered as a payload. (That constraint is gone: a handle type
  names its own destructor now, so every projected class has a release and
  none of them is unnamed.)

The release is the runtime's, performed when the managed cell dies. It reserves
the declaration name `Class.dispose` and emits no `dispose()` member: a
GObject class gets one only where early release is semantically useful, which
is the rule [the GTK API contract](gtk-api.md) states.

With that settled each projection is small. A result binds an adapter
returning `value == NULL ? NULL : g_object_ref(value)`, which makes it an owned
handle. A payload is referenced by the signal dispatch before it is queued, and
the trampoline turns that reference into a cell — reusing the interned one if
the object already has it. Either way the identity map releases the surplus
reference.

Across a namespace boundary the two directions came apart. **Passing** one is
done: 87 GTK methods take an object another namespace owns, and an imported
handle now crosses a signature, because the pointer is the whole
representation a signature needs — the definition stays the owner's and
composition proves it. **Returning** one is not: 179 GTK methods hand back a
Gio or Gdk object, and naming its destructor means referencing a *binding* in
another package, which SCABI has no vocabulary for. Of those 179, 64 name a
class, 54 a boxed record and 46 an interface, so this unlocks the classes and
the interfaces; the records wait on a projection that does not exist at all.

**Done: a handle type names its own destructor.** Three shapes were
considered.

*An importer references the owner's release binding* — the symmetric move to
a type import, and the obvious one. It fails on its own, because the owner
emits a release only for a class it destroys itself, and a class the owner
never constructs and never hands back has none to reference. Making the owner
emit one anyway needs the rule that a release nothing names is refused to be
relaxed, and telling the owner what its importers need inverts the generation
graph. So this shape needs a second change before it works, and the second
change is the third shape below.

*An importer emits its own release* — refused. The release binding declares
`Display.dispose`, and the importing package does not declare `Display`; two
packages declaring one member is exactly what composition already rejects,
for the reason the imported-flags finding recorded above.

*The handle type names its destructor* — chosen. How to release a GdkDisplay
is a property of GdkDisplay, not of the call that produced one, which is why
every manifest in the tree already names the same binding at every position
of a given handle type. Moving the field where the fact lives dissolves both
problems rather than working around either: a release is never unnamed,
because its type names it, so every selected class may have one; and an
importer needs no new vocabulary, because importing the type imports its
destructor. The per-position `ownership.destructor` stays for owned *pointer*
results, where it is genuinely per-position — one `u8*` is freed by the
allocator that produced it and another is not — so the rule is that an owned
handle position must not name a destructor and an owned pointer position
must.

It cost an atomic refactor of one field — SCABI's model, schema and
validation, both hand-written fixture manifests, the generator, the
translator, and their tests — and no compiler change at all: the translator
already resolved a destructor to a qualified binding ID before the fork saw
one, and it resolves this one the same way. The widget gate reads a
`Gdk.Display` off a widget and asks whether it is closed, which is an object
one package declares, another package's method hands back, and a third thing
entirely releases.

**Projecting a GObject interface.** Done. GTK declares 196 methods on its own
29 interfaces, and a class carried only the members it declared, so none were
reachable: `orientation` belongs to GtkOrientable and 24 widgets implement it,
`Editable` holds the text of every entry, `Buildable` is on 120 classes.

An interface is a class-shaped declaration minus construction, so it ingests
through the same path and becomes the same kind of handle. The relationship is
the new part: a class implementing one gains an identity upcast to it — the
same pointer under another nominal type, which is what implementing means at
the ABI — and TypeScript learns it by declaration merging, so the member keeps
one declaration and one binding over the interface's own handle. Redeclaring
the members per class would have meant a binding each and an adapter each, to
cast a class pointer into the interface's.

What remains here is the rest of the member algebra on an interface: its
signals and observed properties ride the same path already, but an interface
another namespace owns is reachable only as a parameter, for the same
destructor reason a class is.

**Splitting the ScriptC runtime out of the link.** Done. The runtime was
4253 ms of a 7.2 s build because one Clang invocation compiled 19 runtime
sources and the emitted program together, and nothing about that command could
be reused while the program changed. `planExecutableExternalCBuild` now yields
one compile plan per runtime source plus the link, each a cacheable action that
records what it read, so the runtime depends on the pinned checkout and the
toolchain rather than on the application. Measured on the single-namespace
fixture: 6.7 s cold, 2.9 s after an application edit, against 7.6 s for either
before.

What remains is the link itself, which is one action by nature: its inputs
include the program, so it re-runs whenever the application changes. That is
correct, and it is also the whole remaining cost.

**Answering a signal that asks a question.** Done. GTK's 57
`gboolean`-returning signals — `close-request`, `key-pressed`, `scroll` —
consume their answer while the emission is still running, so a queued handler
could never supply one. Retained callbacks gained a second delivery:
same-caller, synchronous, answering with the handler's own `boolean`. It is
admissible because the invocation is on the thread that owns the runtime and
nothing foreign may read a closure; it carries values only, because nothing
outlives the call; and an exception it leaves pending is reported by the next
turn rather than thrown into the toolkit's frame.

**Taking ownership of a handle argument.** Done. GIR's `transfer-ownership`
was projected only as `none`, which left every event controller unreachable:
`gtk_widget_add_controller` takes the reference, so keyboard, scroll, and
gesture handling were out regardless of what else worked. A transfer is now a
disposal the callee performs — the runtime's own teardown minus freeing the
object — and the handle is spent afterwards, with the same use-after-dispose
guarantee an explicit disposal gives.

**A GError error convention.** Done, contract and generation both. A member
that reports failure through a GError projects as a throwing method: a
generated adapter absorbs the `GError **`, one accessor pair per namespace
reads the message and releases the object, and both backends release on the
throwing and already-pending paths alike.

Two constraints hold it to a sound subset. A `throws=1` callable is not a
direct probe candidate, because GIR omits the trailing `GError **` and
asserting its parameter list against the header is a guaranteed ABI mismatch;
the adapter is the probed entry instead. And the adapter discards the wrapped
call's own result, so only members returning `gboolean` or `void` project.

`gtk_application_new()`, `g_application_activate()`,
`g_application_quit()`, `g_application_get_is_remote()`, and the `activate`
signal are already inside the implemented algebra and need no new contract.

**Where the GTK surface actually stands.** Measured by selecting every class,
interface, enumeration and layout-projectable record GTK 4 declares — 268
classes, 29 interfaces, 81 records — and generating until the diagnostics
stop: **2245 of 3006 methods project**, three quarters of the toolkit. The
number describes the algebra's reach rather than any project's, since no
application selects everything, but what it refuses is the ordered list of
what to build next:

*(Re-measured after the cross-namespace work below landed, and with the five
namespaces GTK references supplied as imports: **2389 of 3006**. The bucket
list that follows is from the earlier run and its shares are unchanged; what
moved is the cross-namespace item.)*

The largest bucket by raw count is misleading, so it is worth stating what it
is: `TreePath` blocks 47 methods, `TreeIter` 42, and `TreeModel` 46 — and GTK
deprecated every one of them. Counting only members neither the class nor the
method marks deprecated, the order is:

- **Types another namespace owns** — `Gio.ListModel` on 34 live members,
  `Gio.MenuModel` on 22, `Gio.File` on 22, `Gio.Cancellable` on 20,
  `Gdk.Rectangle` on 10. Classes and interfaces now cross in both directions.
  The records among them do not, and wait on a different question: an
  enumeration lowers to a bare scalar and needs no identity, while a struct's
  layout would have to be proven in one package and named in another.
- **User data and the callbacks that carry it** — `gpointer` on 41 live
  members, `Gio.AsyncReadyCallback` on 20, `GLib.DestroyNotify` on 17. The
  async ones need the asynchronous story; the rest are sort, filter and
  foreach functions, and the retained and call-scoped contracts they need
  already exist.
- **`GtkTextIter`, on 50 live members** — the one boxed record the live
  surface leans on. A record projects today only when every field is an exact
  scalar, and this one carries pointers, so it is refused as a layout rather
  than as the opaque value GTK treats it as. What it wants is the boxed
  projection: a value with a declared copy and free, which is a different
  thing from a struct that crosses in registers.
- **The out-parameter families** — 65 methods have an output outside
  caller-allocated records and exact scalars, 47 an input outside the
  families a plain parameter accepts, and 60 answer `gboolean` alongside
  their outputs rather than `void`. That last is the most idiomatic shape GTK
  has for "did it work, and here is the value", and it needs the answer to
  become a field of the returned record, which needs a boolean projection
  over a struct field the IR does not have. On its own it unlocks 10 of the
  60; the other 50 also name a boxed record, so that work comes first.

Two things are deliberately absent from that list. `filename` (17 live
members) is a distinct GIR type from `utf8` and needs a decision about path
encoding rather than a projection. Arrays and lists are not counted at all,
because the selection above cannot reach them.

**Proposed: a boxed record projects as an owned handle.** Counting only live
members, records the projection refuses divide cleanly by what their fields
are, and the fields should decide the shape:

- *Every field an exact scalar* — a **value record**, which is what
  `Gdk.Rectangle`, `Gdk.RGBA` and `GtkRequisition` are, and what already
  projects. Having a `copy`/`free` pair does not change that: `rgba.red` is a
  field read and a colour is a literal, and hiding either behind a handle
  would be a poor trade.
- *Anything else* — a **boxed handle**: an owned pointer whose destructor is
  the record's own `free`. This is 79 live members, led by `GtkTextIter` on
  48, `PangoTabArray` on 8, `PangoFontDescription` and `GtkPaperSize` on 6
  each, `GLib.Error` on 5. What these have instead of readable fields is a
  `copy` that hands back a full transfer of itself and a `free` that consumes
  one, which GIR states and the generator can check.

`GtkTextIter` becomes a nominal type with methods; a mutating method mutates
the object the handle names, which is what the C does; identity is `none`,
because two copies are two objects, and `gtk_text_iter_equal` answers the
question reference equality would answer wrongly.

The case for it is that it needs no new compiler concept. A boxed handle is an
owned handle, and owned handles have everything they need: a type-level
destructor, nullable inputs, and crossing a package boundary in both
directions. Most of the 79 name a record another namespace owns, so they
arrive through the import path rather than through anything new. The one piece
of real work is the caller-allocated output — GTK fills storage the caller
reserves, so the adapter reserves it on the stack, calls, and hands back
`gtk_text_iter_copy` of the result: one allocation, freed by the function that
pairs with the one that made it. A transfer-full result is already an owned
handle with no wrapper; an input is a borrowed one.

The cost, stated plainly: one heap allocation per iterator where GTK allocates
none. It is per iterator rather than per step — a loop that advances one
iterator allocates once — but it is real, and it is why the alternative
exists. SCABI already has an `opaque-value` type with a proven layout, and the
honest projection of a stack iterator is that: caller-allocated storage of a
known size with no readable fields. Nothing lowers it. The compiler has no
value kind for a fixed-size blob — a struct's fields are scalars or structs,
and neither an array nor an opaque field is expressible — so it would be a new
IR value with storage, copy and address-of in both backends. The boxed handle
is what landed; the opaque value waits on a measurement that shows the
allocation matters, because the source surface barely differs between them — a
nominal `TextIter` with methods either way.

Two things the slice does not do, both refused precisely. A method that answers
`gboolean` alongside its output stays out: `gtk_text_buffer_get_iter_at_line`
answers whether the exact line was found and fills the iterator either way, so
turning the answer into absence would discard a usable value and misstate why.
And a method with two boxed outputs — `get_bounds` — has nowhere to put them,
because a value-return record's fields cannot be handles. Both wait on the
answer-as-a-field shape the out-parameter bullet above describes.

**Corrected, and not built: a value record another namespace owns.** The
proposal called this 24 live members and one manifest field. Measured by
direction, that was optimistic twice over, and the correction is the useful
part.

The 24 split into 14 members that take one as an argument and 7 that fill a
caller-allocated one — and **neither shape exists even for a record this
namespace owns**. A record-typed parameter is refused everywhere: the input
families are exact scalars, booleans, borrowed UTF-8, enumerations and handles,
and a struct crossing by value is not among them. So the typed import unlocks
nothing on its own; it needs records-as-arguments first, and that capability is
worth about one member locally.

The output half is worse. A caller-allocated record output becomes a field of
the value-return record, so an imported one would be a struct field of an
imported struct type — and a field needs its type's size to validate the
layout, which is exactly what an importer does not have. That is the case the
enumeration precedent cannot reach and the handle precedent cannot either.

And of the 14 argument members, 8 are `GtkSnapshot` drawing calls that also
take a `Graphene.Rect` or a `Gsk.RoundedRect`, so they do not land until those
namespaces project too. What would actually land is four:
`gtk_popover_set_pointing_to`, `gtk_tooltip_set_tip_area`,
`gtk_im_context_set_cursor_location`, and `gtk_color_dialog_button_set_rgba`.

So the order is: records as by-value arguments first, then the typed import,
and the nested-imported-field question needs its own answer before the output
half is reachable at all. Four members is not a reason to start.

The enumeration precedent does not transfer, and it is worth saying why,
because the two look alike. An enumeration lowers to a **bare scalar**: the
importing package defines it locally for its ABI, declares it as the owner's
for its identity, and the two packages agree because a scalar's compiler
identity is structural — both write `{kind: "nativeScalar", scalar: "u32"}`
and composition finds one declaration mapped to one type. A struct's identity
is nominal, `<owner instance>#type:<id>`, so two packages that each defined
`Gdk.Rectangle` would register one declaration against two types, which
composition refuses — correctly, since a caller passing one to the other would
otherwise be passing an unrelated type that happens to have the same layout.

So a value record crosses the way a handle does: imported by identity, defined
once by its owner, and named through `import type { Rectangle as GdkRectangle }`.
The addition is that an import must say what kind of type it is. `lowerType`
builds every imported reference as a native handle today, because a handle was
all that could be imported; `TypeImport` gains a `kind`, the importer states
what it assumed, and composition proves it against the definition — the same
trust model the imported type ID and destructor already have. What an imported
struct does not get is the local Clang proof an imported enumeration gets: its
layout is the owner's evidence. That is the honest trade rather than a gap. A
struct has one layout, and proving it twice would only give composition a
second thing to reconcile.

**Sequence.** Boxed records landed first, and the measurement after them says
what the sequence should have been all along: an opaque record needs no field
selection at all, so `PangoTabArray`, `PangoFontDescription`, `GtkPaperSize`,
`GskStroke`, `GLib.Error` and `GLib.String` come with the same mechanism — 27
live members beyond `GtkTextIter`'s 48 — and reading the duplicate and release
pair GIR states on the record adds `GLib.Variant` and `GLib.Bytes`. The value
record's cross-namespace question waits behind a capability the proposal
assumed it already had.

### Acceptance application

A native counter application:

- creates real GTK widgets from TypeScript;
- handles a retained signal callback;
- updates UI only on the owning main context;
- performs asynchronous work without blocking UI delivery;
- disposes the window, signal, and runtime with zero unexplained roots;
- ships no JavaScript engine.

### Exit gate

- No GTK-specific ownership or callback primitive exists outside the target
  adapter/SCABI extension.
- The event-loop integration passes common runtime conformance tests.
- Incremental rebuilds reuse unchanged generated bindings and native objects.
- Raw toolkit access is usable without React.

## Phase 3: terminal application environment and direct TUI

The terminal phase validates a non-widget host environment, generic readiness
integration, pure statically compiled TypeScript rendering code, Unicode cell
semantics, and deterministic restoration before mobile adds another managed
platform runtime. The first gate is POSIX; Windows transport follows the
Windows target while preserving the same public terminal contract.

### Deliverables

- `@native-typescript/terminal` with transactional `TerminalSession`, explicit
  endpoint and presentation modes, immutable capabilities, bounded input, and
  screen presentation;
- POSIX transport over authoritative termios, descriptor I/O, size query,
  resize/job-control signals, and the generic owner wait set;
- a conservative ECMA-48/VT-family baseline, reviewed terminal profiles, and
  explicit capability negotiation for reached extensions;
- pinned Unicode extended-grapheme and terminal-width data, continuation-cell
  semantics, and matching conformance fixtures;
- safe application-text rendering, style/cursor state, resize invalidation,
  partial output, and deterministic frame diffing;
- `@native-typescript/tui` with a headless scene tree, layout, focus, input
  routing, widgets, and lifecycle usable without React;
- PTY-backed artifact, runtime, restoration, parser, Unicode, and rendering
  conformance tests;
- terminal capability, transport, restoration, and unsupported-feature
  diagnostics in build/runtime reports.

Mouse protocols, advanced keyboard negotiation, synchronized output, graphics,
clipboard control, broad system terminfo consumption, and Windows transport are
not silently approximated by this first slice. They become later permanent
extensions with their own gates.

### Acceptance application

A direct non-React TypeScript counter application enters a real alternate
screen, receives keyboard and resize input without blocking the owner, updates
through the TUI scene/cell renderer, preserves microtask ordering, handles
suspend/resume, and restores every acquired terminal mode on normal,
exceptional, and runtime shutdown paths. C and LLVM produce equivalent
behavior and the executable ships no JavaScript engine.

### Exit gate

- Terminal is an application-environment profile over an OS target, not a
  duplicate ABI target or runtime provider.
- Terminal input, output readiness, resize, timers, and gateway wakes use one
  generic owner wait set without periodic-poll workarounds.
- Fragmented/ambiguous input, bounded paste, capability responses, partial
  output, resize, and Unicode width pass PTY-driven deterministic tests.
- Direct TUI code is usable without React, curses, or an embedded engine.
- Normal, exceptional, suspend/resume, and shutdown tests leave no unexplained
  mode, event-source, buffer, callback, or handle obligation.

Detailed semantics are in [Terminal application environment](terminal.md).

## Phase 4: hosted mobile runtime and application packaging

Android is implemented first to validate JNI and managed/native thread
boundaries. Apple follows using the same generic contracts; it is a separate
exit gate rather than a simultaneous checkbox.

### Android deliverables

- JAR/AAR/class/Kotlin metadata ingestion for a bounded API surface.
- JNI SCABI extension and generated Java/C++ registration adapters.
- generated Java subclasses for reached TypeScript activity/application
  classes, including exact override and native `super` bindings;
- runtime ownership tied to application/activity lifecycle;
- main-Looper integration, global/weak references, exception conversion;
- generated manifest/resources and Gradle/D8 packaging plan;
- platform permission metadata.

### Android acceptance application

A TypeScript `MainActivity extends Activity` is constructed by Android through
the generated manifest/subclass adapter, calls `super.onCreate()`, creates a
real view, receives a native listener, performs an asynchronous platform
operation, survives a lifecycle transition defined by the fixture, and shuts
down cleanly with no handwritten application Java/Kotlin glue.

### Apple deliverables

- framework headers, modules, and Objective-C-compatible Swift-header ingestion;
- Objective-C/ARC SCABI extension and Objective-C++ adapters;
- generated Objective-C-compatible controller/delegate subclasses and protocol
  adapters with exact override and native `super` bindings;
- runtime ownership tied to application/scene lifecycle;
- main-run-loop/dispatch integration, autorelease, weak delegates, errors;
- generated property lists/resources and Xcode packaging plan;
- an explicit adapter path for pure-Swift-only surfaces.

### Apple acceptance application

The equivalent TypeScript controller/delegate subclass is constructed or
registered by the platform adapter, receives its idiomatic UIKit lifecycle
override, calls the required native base implementation, creates a real view,
receives a native target/delegate callback, performs an asynchronous platform
operation, handles lifecycle, and shuts down cleanly without handwritten
application Swift or Objective-C glue.

### Exit gate

Each target independently passes common SCABI, ownership, callback, scheduler,
native-subclass, artifact, and packaging tests. Supporting one platform may not
introduce conditional semantics into the generic compiler for the next.

## Phase 5: React compatibility and one renderer

React work begins as a compiler compatibility program, not a renderer demo.

### Compatibility gate

- Pin an upstream React and reconciler revision.
- Record static coverage and reduce every reachable fence.
- Implement generally sound missing language/runtime behavior in scriptc.
- Document any preprocessing transform by semantic purpose.
- Avoid a React fork unless a minimal, maintained patch is the only sound option.
- Differentially test hooks, effects, updates, errors, scheduling, suspense
  behavior in the promised surface, and teardown.

The gate passes only with zero unexplained reachable dynamic fences in AOT-only
mode.

### Renderer

Implement one renderer against an already-conformant environment, choosing the
terminal TUI or GTK according to measured conformance maturity at that time.
The renderer uses the same public scene/bindings, handles, callbacks, scheduler,
and artifact graph as ordinary direct code.

The first API is a Native TypeScript renderer package. It does not claim the
full `react-native` or `react-dom` surface.

### Exit gate

- Actual pinned React and reconciler execute as native code without an engine.
- A counter and lifecycle fixture exercise `useState`, effects, native events,
  scheduling, unmount, and cleanup.
- Framework-specific compiler changes have general language tests.
- Renderer API/version instability is contained inside the integration package.

## Phase 6: partitions and secure capabilities

### Deliverables

- explicit multi-entry domain configuration;
- program partition validation and Native IR;
- generated request/response and stream protocols;
- policy schema and build-time authority checks;
- remote handles, cancellation, transferable buffers, and backpressure;
- process and trusted-loopback transports;
- cross-domain tracing and failure diagnostics;
- an initial asynchronous `node:fs/promises` capability surface.

### Acceptance application

A sandboxed renderer requests an authorized file through a scoped capability,
streams or transfers its data, rejects unauthorized paths and malformed
messages in the privileged process, and releases all resources when either
process exits.

### Exit gate

- Renderer-compromise fixtures cannot exceed declared authority.
- Process and loopback transports pass the same semantic suite.
- No raw pointer, closure, or arbitrary object crosses the boundary.
- Cross-domain latency and authority are visible in reports and traces.

## Phase 7: additional native targets and renderer portability

Windows/COM/WinRT/WinUI and AppKit-specific desktop work validate that the
foundation is genuinely portable. React renderers may follow raw target access,
not precede it.

The Windows target also supplies the second terminal transport gate: attached
console mode may normalize `ReadConsoleInputW` records while ConPTY/pipe mode
uses VT-family byte streams. Both consume the same `TerminalSession`, input,
screen, Unicode, TUI, and React-terminal semantics proven by the POSIX slice.

Each target receives its own bounded vertical slice and exit gate. Broad SDK
coverage grows only after ownership, error, thread, packaging, and conformance
behavior are correct for the initial surface.

## Phase 8: DOM/Chromium feasibility program

This is an explicit research gate with production-quality fixtures. It does not
change the core architecture unless a generally reusable primitive is proven.

### Stage A: embedding

- Build and package a pinned Chromium Content runtime SDK.
- Host one sandboxed Native TypeScript runtime instance on the correct Chromium
  sequence.
- Demonstrate process lifecycle, task scheduling, shutdown, and diagnostics.

### Stage B: direct Blink projection

- Ingest a minimal Web IDL/extended-attribute surface.
- Create/read/mutate one real DOM element directly from compiled TypeScript.
- Preserve wrapper identity and document/execution-context invalidation.
- Deliver an event through the callback gateway.
- Adapt one Blink promise into ScriptC promise ordering.
- Translate one DOM exception correctly.

### Stage C: coexistence decision

Evaluate:

- maintenance against Chromium updates;
- ScriptC/Blink/Oilpan wrapper and cycle behavior;
- optional V8 realm identity and lifetime;
- performance against a conventional renderer bridge;
- security and binary/update costs.

Only after these stages do we decide whether to maintain `scriptc-dom`, use a
system WebView/bridge target, or support both. The project remains successful as
a native TypeScript platform even if direct Blink is rejected.

## Continuous work

Every phase maintains:

- upstream scriptc synchronization and patch review;
- compatibility register updates;
- compiler/runtime differential tests;
- size, startup, call-overhead, callback-latency, and build benchmarks;
- sanitizer, leak, and security suites;
- reproducible toolchain/SDK provenance;
- deletion of superseded pre-1.0 contracts.

## Implementation starting point

After Phase 0 review, implementation begins with the smallest part of Phase 1
that establishes a permanent seam:

1. model compiler capabilities and immutable target planning (**implemented**);
2. ratify the first SCABI C fixture (**implemented**);
3. add the generic Native IR required by that fixture to the scriptc fork
   (**implemented**);
4. lower and validate one exact scalar C call through both backends
   (**implemented**);
5. resolve exact declaration symbols and translate reached SCABI bindings into
   the compiler frontend (**implemented**);
6. extend the exact direct-call path across signed and unsigned 8-, 16-, and
   32-bit integers, including C ABI extension rules and an IR version fence
   (**implemented**);
7. define the fixed 64-bit BigInt-literal boundary and lower `i64`/`u64`
   through C and LLVM without adding general BigInt (**implemented**);
8. define pointer-width identity and lower `isize`/`usize` using explicit
   target ABI facts (**implemented**);
9. lower nominal structs, typed field reads, and authoritative direct,
   expanded, plain-indirect, `byval`, and `sret` ABI passing through C and LLVM
   (**implemented**);
10. lower nominal owned opaque handles, method receiver bindings, checked
    borrowed calls, alias-safe explicit disposal, and automatic exact-once
    destruction through C and LLVM (**implemented**);
11. project one borrowed TypeScript UTF-8 string into const data and byte-length
    ABI slots with single evaluation and no copy (**implemented**);
12. project borrowed `Uint8Array`/Buffer views into const data and byte-length
    ABI slots with exact offsets, single evaluation, no copy, and prompt
    post-call release (**implemented**);
13. add exact call-scoped callback projection and exception propagation
    (**implemented**);
14. add `until-cancelled` retained callbacks with transactional result
    ownership, foreign-thread ingress, copied exact-scalar and UTF-8 payloads,
    owned handle payloads, and one-turn owner dispatch (**implemented**);
15. attach the owner-turn contract to a real GLib main context without inline
    native-call reentrancy (**implemented**);
16. materialize the runtime adapter and native products through the artifact
    graph, then extend the fixture toward the GTK acceptance application
    (**in progress: canonical host-C planning, sandboxed execution, SDK include
    trees, GTK native objects, ScriptC runtime inputs, and final executable
    linking are implemented; compiler-emission actions, complete toolchain
    identity, and cache enablement for native actions remain**).

No separate prototype API is created. Each increment extends the conformance
fixture and the production path.
