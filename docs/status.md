# Implementation Status

Status: current implementation state  
Last revised: 2026-08-16

This document records what is **built and proven**, and by which gate. The
normative specifications say what must be true; this says how far the
implementation has got.

Every claim here corresponds to a passing test. "Both backends" means C and
LLVM produce equivalent observable results. "Sanitizer gate" means the case
also passes under ASan/UBSan, and under TSan where threads are involved.

The repository is not yet an application framework or a production compiler.

## Summary

| Layer | State |
| --- | --- |
| Exact scalars, aggregates, ABI classification | implemented |
| Checked JavaScript-number boundaries (≤32-bit) | implemented |
| Native handles and ownership | implemented |
| Borrowed strings and byte views | implemented |
| Call-scoped and `until-cancelled` callbacks | implemented |
| Foreign-thread ingress, owner gateway, scheduling | implemented |
| Native error conventions | `errno`, nullable handle, error object as result or in a slot |
| TypeScript → C exports | exact `i32` only |
| Outbound native-call unification | implemented; one node, profile as input dialect |
| Artifact graph, sandboxed executor, local cache | implemented |
| C ABI evidence (Clang-proven) | implemented |
| GIR ingestion and GObject projection | implemented for the narrow algebra below |
| GTK target runtime provider | implemented |
| GTK application lifecycle | generated and executed |
| GTK target runtime package | implemented |
| Application build pipeline and `build` command | implemented |
| Provider compiler requirements | read by the build |
| Cross-namespace GIR composition | implemented |
| Terminal, mobile, React, partitions, DOM | not started |

## Compiler and runtime

The ScriptC fork owns generally reusable compiler and runtime capability. See
[scriptc evolution](scriptc-evolution.md) for how limitations are classified
and changed.

### Exact scalars

Reached SCABI bindings translate into a manifest-neutral compiler input. Exact
TypeScript declaration symbols are recognized, and signed and unsigned 8-, 16-,
32-, 64-, and target-pointer-width integer literals and calls lower through
both backends with no JavaScript-number carrier.

Fixed 64-bit and `isize`/`usize` source boundaries accept only exact BigInt
literals or values already carrying that native type. Pointer-sized ranges come
from SCABI target metadata and are checked against the selected backend. This
is separate from the general `bigint` value kind described below — the exact
carriers are branded intersections and never widen into it.

Exact same-type `+`, `-`, and `*` wrap at their declared width without C
undefined behavior. `&`, `|`, and `^` operate at exact native width without
routing through JavaScript's `ToInt32`. All four orderings compare at the
declared width and signedness.

### Division, remainder, shifts, and the conversions

Division, remainder, and the two shifts are written with the operators
JavaScript spells them with, inside the construction that names the exact
type: `(a / b) as i64`. Each answers where it can and throws a catchable
`RangeError` where it cannot — a zero divisor, a signed minimum over `-1`, and
a shift count outside `[0, width)`, which is never masked. A signed minimum's
remainder over `-1` is 0, which fits, so it answers. The trapping family lives
out of line in the runtime, so both backends reach one definition of which
cases throw.

The conversions are the only declared operations: `i64.toNumber(v)` and
`i64.fromNumber(n)`, resolved by declaration identity and lowered straight to
Native IR with no symbol, module object, or runtime lookup. They are
operations because no syntax names a direction, and they are named rather than
spelled `Number(v)` and `BigInt(n)` because JavaScript's conversions mean
something else at an exact width — one rounds silently where this refuses, and
the other is arbitrary precision where the slot has a width.

Egress is a cast up to 32 bits and a checked round trip past it: 2^60 crosses
because it is exactly a double, 2^60 + 1 does not. Ingress is the same check
the boundary performs and raises a `TypeError`, the same answer for the same
reason.

### JavaScript `bigint`

The compiler carries JavaScript's own arbitrary-precision integer as a value
kind. Implemented: literals in every radix, with numeric separators and a
folded sign; `===`, `!==`, and the four orderings, exact at any magnitude;
`typeof`; truthiness, where `0n` alone is falsy; `String()`, template holes,
`toString()`, and `util.inspect`'s `n` suffix; `Number(b)`, rounded to
nearest with ties to even against the exact value; and `BigInt(x)` over
numbers, strings, and booleans, raising V8's own `RangeError` and
`SyntaxError` texts on the two failures. Bigints live in arrays, records,
class fields, union arms, capture boxes, and function signatures.

The arithmetic operators refuse by name until they are implemented, as does
mixing a bigint with a number in an operator — which JavaScript answers with
a `TypeError` rather than a conversion. `Map` keys, `Set` elements,
`.join()`, and `JSON.stringify` refuse too: the checked-dynamic tree has no
bigint tag yet. `JSON.stringify(1n)` throws in JavaScript as well, so that
one is a refusal of something that never had an answer.

The bignum itself is sign and magnitude over base-2³² limbs, refcounted, and
depends on nothing else in the runtime — its formatter writes into a
caller's buffer rather than returning a string, so it links and unit-tests as
one translation unit.

### Checked JavaScript-number boundaries

A binding position over a float, or over an integer of at most 32 bits, may
declare that its source carrier is an ordinary `number`. A 64-bit float slot
converts nothing — the double is the value; an integer slot is checked in and
widened out; a 32-bit float slot widens out exactly and rounds in, which is
the one lossy crossing in the family and the only thing its width can mean. Arguments and aggregate constructions
are checked at the boundary — finite, integral, in range, or a catchable
`TypeError` raised before the call — and results, aggregate fields, and both
callback trampolines widen exactly on the way out. The physical slot stays the
exact scalar throughout, including in a queued callback invocation, where the
widening happens when the delivery reads the stored payload.

Crossings the compiler can decide are decided at compile time. A literal the
emitter re-proves in place produces the constant with no check emitted at all,
and a literal no value of the native type can hold is refused where it is
written rather than deferred to a throw.

Inference carries that further. A flow-sensitive interval-and-wholeness
analysis over the validated IR — the same domain the library lane uses for its
declared i64/u64 slots, which is why it lives in `ir/number-facts.ts` rather
than in either consumer — proves the crossings that need no check: a widened
result fed straight back into the slot it came from, a number-projected field
read, a callback payload passed on, a value a guard has bounded, a loop
induction. Anything unmodeled reaches the top of the domain and keeps its
check, and a crossing whose every admitted value is outside the slot becomes a
diagnostic (SC5106). The sanitized lane re-enables every check, so a proof that
was wrong throws there instead of converting a value the slot cannot hold.

Measured on the generated GTK counter application: of the five crossings no
literal proof reaches — two resize-payload round-trips, two nested field reads
feeding `setDefaultSize`, and one widened `getWidth()` fed back — the analysis
proves all five, so the emitted program contains no boundary check at all, on
either backend.

Pointer-width and 64-bit slots cannot declare it. A double carries at most 53
bits of integer injectively, so the width fence is enforced structurally by IR
validation, including for callback payloads.

### Declaration-backed constants

SCABI integer, enum, and flags values are canonicalized and range-checked, and
package composition rejects identity conflicts. ScriptC lowers reached ambient
symbols directly to Native IR literals — no runtime namespace object, module
load, adapter, or C symbol.

### Aggregates and calling conventions

Nominal, default-packed, trivially copyable native structs are supported when
their fields are exact scalars or nested nominal structs, and their SCABI
metadata carries target Clang's complete physical calling signature.

Direct registers, expanded parameters, ordinary indirect pointers, `byval`, and
`sret` all lower without platform size heuristics. A direct object-literal
assertion constructs aggregate storage without reinterpreting a JavaScript
object: C verifies size, alignment, and offsets at compile time, while LLVM
emits the target's recorded physical signature.

Direct-`i64`, expanded two-`double`, padded indirect, and nested nominal
fixtures pass both backends, including statically typed field reads from
returned values.

### Handles and ownership

Owned, owner-confined opaque handles use a runtime-private managed cell with
alias-safe explicit disposal, automatic exact destruction, and checked borrowed
method ingress.

Direct, representation-preserving handle upcasts are explicit in SCABI and
Native IR, close over transitive ancestors, and preserve the same managed cell
in both backends. The runtime accepts a derived handle at a declared base call
while rejecting undeclared nominal conversions.

### Strings and bytes

| Boundary | Behavior |
| --- | --- |
| Borrowed UTF-8 input | one source string, evaluated once, projected without copying into const data and byte-length ABI slots |
| Checked C string input | one-pointer projection over the runtime's existing trailing NUL; throws before native entry on an embedded NUL |
| Nullable C string input | `string \| null` becomes the checked pointer or `NULL`, including through a runtime union |
| Borrowed C string result | copied into managed UTF-8 storage before the receiver is released; preserves declared `string \| null` |
| Borrowed typed-array input | exact view offsets and lengths, live backing-store mutation, single evaluation, prompt post-call release, no copy; `u8`, `u32`, `i32`, `f32` |
| Owned span result | copied into a managed typed array, then disposed through the symbol the binding names; the length arrives in a slot the compiler owns |
| Borrowed string-array input | a managed `string[]` as the NUL-terminated `char **` a C API takes; the elements keep owning their bytes, so only the vector is built and released |

Unicode and embedded-NUL behavior, temporary-receiver lifetime, and null
behavior pass both backends and the sanitizer gate. Foreign pointers remain
ABI-only and never enter TypeScript values.

The string array is the one argument family that leaves an allocation behind,
and one the unwind cannot see — `emitUnwind` releases managed temporaries and
a raw vector is not one. It therefore has two release sites, both emitted:
after the call whatever the call did, and on the unwind of any later argument
conversion that throws. That second path is reachable rather than theoretical,
since a binding taking a vector and then a string is ordinary and the string
conversion throws on an embedded NUL. The borrow itself fails rather than
storing the NULL that an embedded NUL converts to, which would end the vector
early and pass a shorter array than the program did.

The other direction is built too: a returned NUL-terminated `char **` copied
into a managed `string[]`. Copying is what makes the result independent of the
callee's storage, and what happens to the vector afterwards is one named
symbol — which is why two conventions GIR distinguishes need no separate arm.
`full` hands over the elements as well and names `g_strfreev`; `container`
hands over only the vector and names `g_free`; `none` hands over nothing and
is a borrow anchored to the receiver instead. Absence is a value and is not
emptiness: a NULL vector projects to null where the binding says nullable and
throws where it does not, while an empty vector is a real vector whose
terminator sits at slot zero.

A vector may also be omitted, and an absent vector is not an empty one: a C
API uses NULL for "no list at all" and a terminator at slot zero for "a list
of nothing", which `gtk_icon_theme_set_resource_path` means differently. That
is a separate source arm rather than a flag, because a flag invites the two to
collapse and the point is that they must not. The physical side is unchanged —
one slot either way, since the terminator is still the length.

The whole family reaches GTK: **21 argument positions and 12 results project**
that produced a diagnostic before.

What remains refused, measured rather than assumed:

- **2 argument positions are COUNTED vectors**, carrying a length beside them
  instead of a terminator. That contract is deliberately absent so a generator
  meeting one diagnoses rather than guessing where the vector ends.

  Measured across every element type rather than only strings, 28 live
  Gtk-4.0 members touch a counted array — and building the counting would
  move 4 of them. The other 24 are blocked by their ELEMENT types
  (`Gsk.ColorStop`, `GObject.Value`, `Expression`, `Gdk.RGBA`), not by the
  counting. On the JVM the bottleneck is inverted: every array is counted,
  no terminated variant exists, and the elements already project. The same
  arm, wanted for opposite reasons, and admitted when the platform whose
  elements already work asks for it.
- **A property whose accessors disagree about the TYPE is refused** — but not
  one that disagrees only about the C spelling. `css-classes` projects: the
  getter hands over a vector (`char **`) and the setter borrows one
  (`const char **`), and GIR names `array<utf8>` in both, so the difference is
  ownership and constness rather than type. Three GTK pairs still refuse, and
  each genuinely is not one property: two setters take a length beside their
  value, and one getter is a void method filling an out-parameter.

**A span's length says what it counts.** Both readings appear in real
signatures — a `memcpy`-shaped function takes bytes, an array-shaped one takes
elements — and for `u8` they are the same number, which is how a projection
named for bytes emitted an element count unnoticed for as long as `u8` was the
only element that crossed. The contract now requires the denomination on an
input's length; a result's arrives in the compiler's own slot and counts
elements by construction.

The elements are every one the language has. `Float64Array` and
`BigInt64Array` are absent from that set because they are absent from the
language rather than refused by this boundary, and `boolean[]` is a storage
decision rather than a translation. A fifth element would arrive as a runtime
feature and widen this by one entry in a set.

**The family delivers nothing to GTK, and that is the admission rule working.**
It was admitted entirely on JVM evidence — 1,122 measured positions across
android.jar, and a committed program that could not be written. Measured
against live Gtk-4.0 afterwards: **two members have a span-shaped array, and
neither is in the family.** `IconTheme.get_icon_sizes` returns a TERMINATED
primitive span and `Snapshot.append_border` takes a FIXED-SIZE one; both are
adjacent shapes with a demand of one apiece, and both stay unbuilt.

An arm built for the platform that needed it, delivering zero members to the
platform that did not, is the outcome the rule is for — and the measurement is
worth keeping precisely because the opposite result would have been the
argument for building it here first.

**A path crosses as a string.** GIR spells one `filename` rather than `utf8`,
and the difference is an encoding rather than a shape — both are
`const char *`. GLib's file name encoding is what `G_FILENAME_ENCODING` names,
and it is UTF-8 unless that variable says otherwise, which on
`x86_64-unknown-linux-gnu` it does not. So one projection carries both, and
the assumption is recorded beside the accepted GIR types rather than left
implicit. A target where the encoding differs would need
`g_filename_from_utf8`, and would pay for it: that conversion can fail, so
every path-taking member would become failable — including the many GTK
declares as void and non-throwing.

### Callbacks

**Call-scoped** callbacks are implemented for non-variadic C signatures with
exact scalar parameters/results and a required trailing context pointer. One
source closure projects into the physical function/context pair. Captures,
reentrancy, and callback exceptions pass both backends and the sanitizer/RC
audit.

**`until-cancelled`** callbacks are implemented for copied exact-scalar
payloads, copied UTF-8 strings, and owned handles. Generated C and LLVM thunks
admit opaque tokens from same or foreign threads without touching the ScriptC
heap, and the owner invokes the rooted closure.

An owned handle payload is the one case where the thunk allocates: the pointer
arrives already referenced, and the thunk either finds the object's existing
cell in the identity map and gives that reference back, or builds a cell for
it. The invocation's slot is cleared once the reference moves into the cell, so
a delivery dropped at shutdown releases exactly the references that never
reached one.

Broader payload families and ownership modes remain future slices.

### Foreign-thread ingress and scheduling

An instance-owned, target-wakeable MPSC gateway provides bounded FIFO drains,
explicit shutdown states, and exact event destruction under admission races. It
is threaded and sanitizer-tested.

Retained callback transport tokens build on that queue with slot/generation
identity and one combined atomic state/invocation-lease word, so close and
admission have an exact order and every admitted event stays owned through
delivery or discard. The owner-side table roots active registration anchors
explicitly and retires them only after cancellation and all leases complete.

Owned native handles carry generic lifecycle edges; a result-owned callback
edge closes admission before the native destructor and completes cancellation
only after it returns. Native factories use a prepare/call/commit transaction
so runtime OOM cannot strand a returned resource or a staged registration.

The runtime exposes one-event owner dispatch and a host-callable
nextTick/microtask checkpoint, so batching cannot collapse distinct JavaScript
turns and callback exceptions stay pending for the target error policy.

### Errors

A failable operation can now report failure in a slot beside its result rather
than as its result, which is what a trailing `GError **` is
([0005](records/0005-failure-beside-the-result.md)). The compiler owns the
slot, raises the contract's message, releases the object on every path, and
unwinds before the result is projected — so a projection only ever sees a
success.

SCABI says it with an `error-out` contract, and the translator appends the
slot itself — the manifest declares that failure arrives in one, not a
parameter for it.

`bindgen-gir` uses it. A GError-reporting member binds its own symbol and keeps
its own result; the adapter that used to absorb the out-parameter and return
the error is gone, along with the restriction that a throwing member's result
must carry nothing beyond success. A generated `register()` declares `boolean`
rather than `void`, and the probe covers throwing callables for the first time
— it had skipped them, so a class whose only selected method throws could not
produce a probe at all.

This is the outcome protocol's first slice;
[the foreign boundary](foreign-boundary.md) names the rest — out-slots as
ordinary outputs, success classification independent of the result, capture
and clear as distinct operations, and output-validity rules.

Two shapes still refuse and name the slice they need: a throwing constructor,
whose adopting adapter would have to forward the compiler's slot, and a
throwing member with out-parameters, which needs the outputs half of the
outcome protocol.


Exact integer `errno` contracts are implemented: the failure sentinel is
checked in its native type, thread-local `errno` is captured before cleanup,
and a symbolic, operation-qualified `Error` is thrown through the ordinary
catch path in both backends.

Nullable owned handle results throw before null wrapping. Non-null results
preserve their exact destructor during ordinary returns and during
callback-exception unwinding.

Other native error conventions remain explicit future slices.

A borrowed handle input may also be optional: the source passes the handle or
null while the ABI slot stays one pointer, and the null arm never consults the
handle table. Owned `to-native` handles are excluded, since a destructor takes
the handle it destroys. A derived handle does not yet reach an optional
parameter, because union re-tagging does not consult identity upcasts, so
GObject generation still projects the non-null subset.

### Booleans

Exact integer-backed native boolean parameters and results use their SCABI
false/true representations directly in both backends while remaining ordinary
TypeScript `boolean` values. Any other native result representation throws a
catchable `TypeError`, including through transitive helper calls.

### Exports

A SCABI `export` root maps an entry-module TypeScript function to an exact C
symbol. Exact `i32` parameters, results, and wrapping `+` compile through both
backends, link into a static library, and execute from an independent C host.
The translation retains the selected C-export adapter's provenance.

Broader export types and artifact-graph materialization remain pending.

### The foreign boundary

The legalizer [the foreign boundary](foreign-boundary.md) requires is being
built in slices, each observationally inert. Landed: the callback decisions
(payloads, trampoline shape, call lifecycle) and the result form — what a
call's result becomes, resolved and validated once rather than by a ladder each
backend maintains.

Each backend ends that ladder with a line that names the only arm it did not
handle, so adding a form and forgetting a backend fails to compile. Before it,
five measured defects were exactly that mistake with nothing but review to
catch it.

Arguments followed the same way, and found a divergence that had never fired:
one backend tested ownership before the nullable arm and the other after, which
the validator happens to make unreachable. Shared code ends it rather than
leaving it for the first binding that made it reachable.

The failure check followed, which closed the last drifted wording: one check
was called "sentinel failure over non-integer result" on one side and "errno
over non-integer result" on the other, so a reader who found either had no way
to know the other existed. The call's own shape followed that.

**No decision about a native call is made in two places any more.** One
`nativeCall` lowering went from 704 lines and 24 duplicated contract checks to
608 and 1 in the C backend, and from 1142 and 28 to 1049 and 5 in the LLVM one,
where four of the five are genuinely physical. The two forms that can grow fail
to compile if a backend forgets an arm.

Outstanding: the structured cleanup regions the platform dimensions need, which
is where a shared decision becomes a shared lowering.

**The document's own precondition has been measured.** `scripts/adapter-lto-falsifier`
answers the question the foreign boundary made a gate on its own expansion —
how much of a conservative adapter's price link-time optimization already
refunds — against a real JVM, on final assembly, exact reference and frame
operation counts, and steady-state timings. The answer is: none of the
structural price, because the operations that remain are calls through the
JVM's function table and no linker can see through one. LTO did not even fully
inline the adapter.

What that licenses is narrower than the document was written to license. A
non-escaping returned object pays 2.4×, which justifies resource-protocol
lifetime domains and escape-driven promotion and frame elision. The other two
cases — a value stored beyond the call, and a fallible call with a detailed
failure channel — are at parity, the fallible one even without LTO. So **no
remaining slice of the outcome protocol may be justified by performance**;
each must earn its place on correctness or expressibility.
[0008](records/0008-what-the-linker-will-not-refund.md) records the numbers,
the rejected readings, and the ART and threading revisits that make the result
a floor rather than a ceiling.

### An answer beside the value it answers about

A struct field reads as a boolean, which is what the answer-as-a-field shape
needs: a C predicate with an out-parameter says whether it worked AND what it
found, and flattened into one record the answer is a field.

The reading is C's own truth test rather than the exact one a boolean result
may declare. A field read is not a call, and a reading that could fail would
make every struct field access a throwing site — for a value whose meaning in C
is "nonzero" to begin with. Writing is the inverse: `true` stores 1.

Measured over live GTK 4 methods with out-parameters: 80 of them, of which 31
answer `gboolean`, and 13 of those have outputs that already project.

The generator asks for it. A value-return adapter admits a `gboolean` result
and puts the answer in the record's leading field, which needed no new manifest
vocabulary: SCABI already says "read this as a boolean" with a type carrying
its storage and both representations, so the field is typed `gboolean` and the
translator turns the type into the projection.

The Clang probe, the manifest's field list, and the generated declarations all
had to agree the record now starts one field earlier — an output whose proven
offset is a field late is exactly the defect the probe exists to prevent.

- **A boxed record crosses as an argument, not only as a result.** No wrapper:
  the SDK's own symbol takes the pointer the handle names, borrowed for the
  call, so what one method hands back another accepts. That has been true since
  the boxed projection landed and nothing pinned it; a test does now. Measured
  over live GTK 4, 62 methods take a record parameter and 49 take a
  `GtkTextIter`.

  A VALUE record crossing by value is still refused, and every motivating
  program for it is foreign — `Graphene.Rect`, `Graphene.Point`, `Gdk.RGBA`.
  [The roadmap](roadmap.md) records why that is a composition question rather
  than an input-family one.

### The manifest format

SCABI is at schema version 4. That version deleted `entry.kind`, which said
whether a symbol came from the SDK or from a generated adapter — build
information stated inside a signature, and stated twice, because an adapter
input already lists the bindings it provides. A binding now carries only its
symbol, and `entry` remains a record because that is the position a call
target other than a plain symbol will occupy.

The envelope split [0001](records/0001-native-manifest-boundary.md) sequences
next — the manifest carrying the compiler's document verbatim under one key,
with identity, the build graph and composition around it rather than mixed
through it — is v5 and is not built.


## Build

See [Build artifacts](build-artifacts.md) for the normative model.

### Graph and executor

The canonical artifact graph and Linux sandboxed executor content-verify file
and tree sources and tools, compile and link a real host-C product, and reject
cycles, content drift, and undeclared outputs.

Pkg-config include trees resolve to logical SDK artifacts with no host paths in
the plan. Actions can stream tool standard output into a declared, verified,
cacheable metadata artifact, so machine-readable compiler output needs no
shell-redirection escape hatch.

### Cache

A schema-versioned local action cache keys deterministic actions by their
complete logical request and verified input content, verifies every hit,
rejects corrupt entries, and publishes concurrent misses atomically.

### ScriptC integration

ScriptC exposes a schema-versioned, path-free executable-compilation plan
containing validated IR, exact backend/target facts, and its complete native
build request. Native TypeScript runs the corresponding deterministic C/LLVM
emitter as a cacheable graph action, then uses ScriptC's exact compiler-driver
plan without calling a materializer or inventing caller-visible paths. This
keeps ScriptC's runtime-source selection as the single source of truth.

Only reached bindings and native types enter emitted IR or the link.

### Outbound native calls: one node, two input dialects

The compiler carried two outbound native-call subsystems — upstream's FFI
profile (`ffiCall`) and this project's Native IR (`nativeCall`) — sharing no
code and duplicated through every backend and validator.
[0001](records/0001-native-manifest-boundary.md) sequences their unification:
the FFI profile becomes an input dialect that desugars into Native IR
bindings, and `ffiCall` is deleted once nothing needs it.

Done. All 31 of the profile's conformance descriptors lower as `nativeCall`,
and its 48 tests gate both backends. The second outbound subsystem — both
backends' callback trampolines, the shared adapter allocation, the extern
block, and the validator's retained-registration rules, about 1,200 lines — is
deleted. A descriptor the native vocabulary cannot express is refused as
SC5005 where it is called rather than lowered a second way.

Registrations come in three scopes: the call that makes one, a handle that
owns one, and the process. A process-scoped registration is released by naming
its function value back, matched by pointer identity in a counted ledger, and
may be raised by a foreign thread, in which case the payload is copied where
it is raised and the invocation queued for a later turn.

One substrate backs every retained registration: the callback table, reached
through a token, delivered by the owner gateway. A registration nothing owns
is the same table entry with no owner set, which is what makes it findable by
the value it holds when a release names that value back. A program with no
embedder configures the gateway itself, through a self-pipe wake installed
just before its first registration; a host that owns its loop supplies the
wake and wins, because it configures during its own startup.

`ffiCall` survives, serving only library mode's host-callback channels: a
channel's name is a registration key rather than a C symbol and a call
dispatches through a runtime slot, which is a different feature that happens
to share the node.

Foreign payloads carry exact scalars at every width, because the transport is
the gateway's invocation record rather than the retired queue's fixed slots.

Outbound native-call lowering is decided once for both backends rather than
twice ([0004](records/0004-one-decision-two-backends.md)): what a payload
becomes, which trampoline a contract calls for, and what the call does around
itself. Each backend materializes those decisions with its own primitives and
makes none of its own.

The callback payload vocabulary is complete for the call-scoped tier: exact
scalars, a widened number, a boolean over declared storage values, a
NUL-terminated C string, and pointer/length spans as text or as bytes. A
handler answers with an exact scalar, a boolean over storage values, or a
number narrowed by a named conversion. Queued delivery admits every form but
the spans, whose count is consumed at read time and has nowhere to live in a
record that outlives the call.

## Bindings

### C ABI evidence

A target-neutral C binding package converts selected functions and record
fields into one structured, content-addressed ABI probe. Sandboxed target-Clang
actions check candidate types against the real headers, derive selected record
size/alignment and field layout, and emit raw AST plus LLVM
calling-classification evidence.

Correct constructor and method signatures pass; a deliberate const mismatch
fails in Clang, as does a deliberately wrong record field. A deterministic
normalization action reduces the raw, location-bearing AST to canonical
selected ABI evidence.

Cross-target fixtures pin direct x86-64 SysV, expanded AArch64/SysV, and
indirect Windows/SysV forms.

### JVM class metadata

A second binding family ingests JVM class metadata into a bounded, frozen,
canonically ordered snapshot, built the way `gir.ts` is: an explicit selection
drives what is read, and nothing unselected reaches the snapshot. The class
file is parsed for real — modified UTF-8 including CESU-8 surrogates, the
double-slot constant-pool entries for `long` and `double`, and the attributes
that carry contract (`ConstantValue`, `Exceptions`, `Signature`,
`Deprecated`, `InnerClasses`), with everything else skipped by declared
length. Integral constants are decimal strings and floats are exact IEEE bit
patterns, because formatting must never enter a cache key. Archives are read
directly: a pure-TypeScript zip central-directory reader handles `.jar` and,
with leading-offset correction, `.jmod`, and refuses zip64, encryption, and
exotic compression precisely.

Diagnostics mirror the GIR family's taxonomy one range up (NTS6001–6006),
including the rule that a superclass present among the sources but unselected
is an error rather than silent lost ancestry. Overloads resolve by descriptor,
and a bare-name selection that is ambiguous is refused with the declared
descriptors listed.

**Measured over the real surface, not a fixture.** Every class of an Android
SDK `android.jar` (API 36, 6,270 classes) and of `java.base.jmod` (7,535)
walked with full-member selections — roughly 92,000 methods and 56,000 fields
across 13,762 class files — produced **zero parse failures and zero
unexpected diagnostics**. The only refusals are by design. Reading and
inflating the whole of `android.jar` takes 160 ms and sweeping it 300 ms,
which is the evidence that no lazy-parse machinery is justified;
`scripts/jvm-metadata-sweep.ts` re-derives all of it.

Non-static inner classes project their methods and fields, with only
CONSTRUCTION deferred — an enclosing instance is what a TypeScript-side
construction would need and nothing selects one yet. The acceptance surface
reaches exactly one such class and reaches it as a return type, so the
deferral costs nothing today. Local, anonymous, and module classes are outside
the algebra rather than deferred, and say so.

Not built, each waiting for its consumer: Kotlin metadata, AAR reading, and
the Clang-evidence half that the GIR family has.

A census of the real `jni.h` (231 members, `scripts/jni-pair-census.ts`) sorts
its disposals into exactly three shapes, two of which this project already
expresses: the three `Delete*` reference members are destructor-as-data, and a
bare symbol consumed inside a projection is what the string-vector result uses.
The third — twelve acquire/release pairs whose token is two values held across
a region — has no expression, and the critical variants add a restriction no
probe can establish, because it lives in the JNI specification and not in the
header. [0009](records/0009-a-region-with-the-boundary-closed.md) records the
shape and why it waits: every one of those pairs has a copying accessor beside
it, and all 1,333 measured array-returning methods are served by the copy.

### GIR and GObject

An explicit namespace/class/member selection becomes a content-addressed
immutable snapshot preserving C and GType identity, class ancestry, ownership,
nullability, receivers, and signals, while rejecting malformed or unsupported
reached metadata.

Class references resolve against the namespace boundary: a same-namespace
parent must be selected, and a cross-namespace parent is preserved as an
explicit external reference where the generated package stops.

**A GObject interface projects as one.** GTK declares 196 methods on its own
29 interfaces — `orientation` is GtkOrientable's, which 24 widgets implement —
and none of them were reachable, because a class carries the members it
declares and nothing else. An interface is now selected as a class is and
ingests through the same path: the two are one shape, differing in
construction, in the hierarchy, and in how the declaration file spells them.
The class's handle gains an identity upcast to each interface it adds, which
is exactly true — the same pointer under another nominal type — and the
declaration merges (`export interface Box extends Orientable {}`) rather than
redeclaring. So the member has one declaration and one binding, over the
interface's own handle, and every implementer reaches it the way it reaches an
inherited method. GIR lists inherited interfaces on every subclass; the edge
is stated where the class adds it.

A dependent binding-package action consumes stable evidence, the exact selected
GIR snapshot, and a canonical generation request. Its content-addressed host
tool regenerates the GObject adapter and emits one immutable package directory
containing TypeScript declarations, validated SCABI, adapter metadata/source,
and provenance. A second build root reuses that package from the local cache.

Gio-2.0 ingests through the same namespace-neutral path as Gtk-4.0.

A class whose parent lives in another namespace projects across the package
boundary, and so do a parameter typed by another namespace's object and one
typed by its enumeration. SCABI records an imported type owned by the other
package, the generated handle carries an identity upcast to it, and the
declaration file imports the type under a namespace-qualified alias. Imported
type identities are derived by the same function that produced them in the
owning package, so the two agree by construction rather than by a hand-kept
table. Importing is opt-in: an external parent whose namespace was not
supplied still truncates, and a parameter naming an unsupplied namespace's
class is refused like any unselected one.

A handle is the one thing a signature can carry without its definition,
because the pointer is the whole representation — which is why an imported
type may appear in a signature position at all, and why it may only cross by
pointer. `gtk_widget_set_cursor` takes Gdk's object, so gtk4 imports the
handle gdk4 defines rather than declaring a second one for the same class:
one type in two packages, and a cursor constructed through gdk4 is the same
type at gtk4's call.

Results cross too, now that a handle type names its own destructor.
`gtk_widget_get_display()` answers an object gtk4 does not declare: the
adapter takes a reference, which makes the result owned, and what releases it
is gdk4's binding — carried by the import, derived by the same function that
produced it there, and proven present at composition. Nothing about the
display is declared twice, and gtk4 depends on no local binding for it.

Composition is the only stage that sees both packages, so it proves every
handle upcast target is provided, is a handle, and shares its derived handle's
thread-safety and identity contracts. Inside the artifact graph, each imported
namespace is a content-verified snapshot input of the dependent package's
generation action.

A parameter typed by another namespace's enumeration needs no SCABI type
import, unlike a handle: an enumeration lowers to a bare scalar with no
instance-scoped identity, so the type is defined locally for its ABI and only
declared as the owning package's for its identity. The importing package proves
the storage with its own Clang probe. Member constants stay with the owning
package.

Generated adapter symbols are qualified by namespace wherever a class name
would otherwise identify them, because a class name is unique only inside its
namespace and two namespaces link into one executable.

The gates generate gio2 and gtk4 against the installed GIRs, translate both,
and compose them into one program in which `gtk_application` upcasts to
`gio_application`; composing gtk4 alone fails. One artifact graph runs both
analysis subgraphs with real Clang in the sandbox, and both packages' adapter
objects compile and link into one executable.

The whole GApplication lifecycle projects: `new Application(id, flags)`,
`activate()`, `quit()`, `hold()`, `release()`, `getIsRemote()`,
`getApplicationId()`, `setApplicationId()`, `onActivate()`, and `register()`.

`register()` reports failure through a GError, and binds `g_application_register`
itself: the compiler owns the `GError **`, allocates it, passes its address, and
reads it back, so the member keeps its own result and declares `boolean`. One
accessor pair per namespace reads the message and releases the object. Nothing
generated stands between the caller and the call. `gtk_application_new()`
projects as
`constructor(applicationId: string | null, flags: GioApplicationFlags)`.

A metadata C spelling is an untrusted candidate that the probe proves, so
equivalent spellings of one type are accepted: `Gio` writes `const gchar*`
where `Gtk` writes `const char*` for the same borrowed UTF-8 parameter.

## GTK target

See [GTK TypeScript API](gtk-api.md) for the normative projection.

### Runtime provider

The GLib adapter attaches the selected `GMainContext` as ScriptC's host
scheduler, composes ScriptC timer deadlines with GLib blocking waits, and uses
asynchronous sources for owner- and foreign-thread callback wakes. Each source
performs exactly one retained-callback dispatch and one microtask checkpoint.
Failure delivery, thread affinity, stop/detach ordering, and source lifetime
are explicit and sanitizer-tested.

### Process bootstrap

`nts_gtk_application.c` initialises GTK, attaches the owner runtime, and tears
both down again. It is the target's own SCABI package rather than generated
code, because it describes hand-written C the target ships. An application
composes it alongside the generated toolkit bindings and its own native code.

Start and shutdown are separate calls with separate verdicts: shutdown reports
whether the retained-callback service was idle when asked to stop, and the
application runs its own teardown checks before calling it so an application
failure is never reported as a runtime one.

The owner runtime and the bootstrap share one source tree and one link, but not
one dialect — the runtime is portable C under `-std=c11 -pedantic`, while the
bootstrap reaches GNU extensions through the GTK headers.

### Proven surface

`fixtures/gtk-widgets` selects 28 GTK classes and 145 of their members, and
builds a window from them — labels, entries,
buttons, toggles, switches, adjustments, scales, spin buttons, progress bars,
list boxes and rows, grids, frames, expanders, revealers, stacks, text views,
scrolled windows, header bars, separators, images — and then reads its own
state back. A shared adjustment really is shared between a scale and a spin
button; a list row really knows its index. The gate exists for breadth: a
member that stops projecting fails there rather than being found by whoever
first tried to use it.

Breadth is what a fixture loses quietly, so the selection is deliberately wider
than the application uses — a member nothing calls still has to generate and
link. Three defects were found by widening it rather than by running it: that
unsigned integers did not project at all, that a method returning a GTK
interface is refused, and that a non-nullable object result was paired with the
failure contract. The gate asserts the member count so it cannot shrink back
unnoticed.

Two things a project author meets immediately, both deliberate:

- **A GLib integer of at most 32 bits is a plain `number`.** `gint`, `guint`,
  and every fixed width up to 32 bits are transparent aliases: the spelling
  survives in signatures because it says what the value means, and the value
  orders, prints, and does arithmetic like the number it is. Writing one back
  is checked at the boundary — a fraction, a NaN, an infinity, or an
  out-of-range value raises a catchable `TypeError` instead of being
  truncated. A literal is decided at compile time instead: proven literals
  emit no check at all, and a literal that cannot convert is refused where it
  is written. `gdouble` is a plain `number` too, and there the crossing is the
  identity: the slot is the double, nothing is checked, and every value
  crosses. Only `gint64` and `guint64` keep exact branded carriers.
- **A narrowed read of a nullable native result is refused**, because the
  callee returns what its declaration allows on every call and a read narrowed
  to `string` has nowhere to put a null. The compiler names the cause and the
  fix at the call site: a guard needs the value read once into a local, an
  assignment needs the assigned value widened.

  This is no longer reachable through a generated property. A getter that can
  report its value as absent projects as a method — `window.getTitle()` — so
  the narrowing never arises, and the shape says what is true: each read is a
  call. Properties remain for everything else, where a narrowing is harmless
  because no exact two-arm match is required.
- An array of exact native scalars is not implemented. `[0 as gint64]` is
  refused by name; a union carrying one does work.

### Executed lifecycle

An application drives the whole GTK lifecycle from TypeScript with no
hand-written C of its own: `new Application(id, flags)`, `onActivate`,
`register(new Cancellable())`, `getIsRemote`, `activate`, and `quit`. The gate
builds it for both backends, runs it under Xvfb, and requires exact output.

`Application` comes from gtk4 and inherits its lifecycle from gio2 across a
package boundary, so this is also the first proof that cross-namespace
composition survives into a linked, running process rather than only into a
graph. Nothing blocks: `g_application_run()` is never reached, and the
runtime's attached `GMainContext` turns the loop.

Removing the `activate()` call makes the application report a missed activation
through a ScriptC timer instead, so the gate distinguishes "signal not
delivered" from "signal delivered late" rather than hanging.

### Generated surface

| Projected | Notes |
| --- | --- |
| Managed Widget ancestry | via declared identity upcasts |
| `new Window()`, `Button.withLabel(...)` | canonical and named constructors |
| Native properties | from authoritative GIR getter/setter links |
| Nullable string properties | `Button.label`, `Window.title` |
| Exact `gboolean` methods | both representations |
| GLib integers ≤32 bits | `gint`, `guint`, and every fixed width up to 32 bits, as plain `number` over their exact slots — checked in, widened out |
| `gdouble` | plain `number`: the slot is the double, so the crossing converts nothing |
| `gfloat` | plain `number` over a 32-bit slot: reads exactly, writes by rounding to nearest float |
| Branded 64-bit integers | `gint64`, `guint64`, exact with BigInt carriers |
| Nominal enums and flags | Clang-proven storage and member values |
| Output parameters | records and exact scalars, returned as one value: `Widget.getSizeRequest()` |
| Signals | non-detailed, answering `void` (queued) or `gboolean` (answered during the emission); payloads of any exact scalar, selected enumeration, UTF-8 string, or selected class |
| Handle inputs | borrowed for the call, or moved when GIR says the callee takes them |
| Deprecated members | bind normally, marked `@deprecated` in the declaration |

Selected constructors generate a content-addressed ownership adapter: GIR
`none` and `full` results become one strong, non-floating reference, and a real
GTK weak-finalization gate proves exact release.

A method that answers through output parameters returns a value instead. The
adapter declares a struct of the outputs, passes each field by address, and
returns it, so `gtk_widget_get_size_request(w, &width, &height)` reads as
`widget.getSizeRequest()` giving `{ width, height }` as plain numbers. Both
families project: a caller-allocated record, and an exact scalar — which GIR
annotates `transfer-ownership="full"` because the value is copied out, an
annotation that is correct and means nothing to release.

Inputs are forwarded, so a method may both take values and hand several back:
`Widget.measure(Orientation.Horizontal, -1)` gives all four measurements, and
`Grid.queryChild(child)` gives a placement. An input may be an exact scalar, a
selected enumeration, or a selected class — the families that already cross
this boundary as a plain argument — and an object input is borrowed for the
call, because the callee keeps no reference either. The wrapped call is rebuilt
from the declared parameter order rather than by assuming outputs come last.

A member the library has deprecated binds like any other. Deprecation is the
library's opinion about its own API, not a fact about that API's ABI, and the
Clang probe exists to read layout and calling convention from the real headers
— which a deprecated function has. Refusing one would stop an application from
calling a symbol that works, and GTK 4 deprecates enough (`gtk_widget_show`
among them) that the refusal would arrive constantly. It arrived as Clang
internals, at that: `-Werror` stopped inside a generated probe, naming a
`__builtin_types_compatible_p` line rather than the member the project
selected.

The notice belongs where the caller decides instead, so a deprecated member's
declaration carries `@deprecated` with the version GIR records, which
TypeScript renders as a strikethrough at the call site.

Signal connections share one `SignalConnection` capability. The adapter
strongly retains the signal instance, disconnects by handler ID, and composes
with ScriptC's retained callback lifecycle so no callback runs after disposal.

Reached metadata outside the implemented
handle/`void`/boolean/exact-scalar/NUL-terminated-UTF-8/signal-payload algebra
fails generation.

### Acceptance application

The application gate chains Clang inspection, evidence normalization, and
package generation as three declared analysis actions, promotes the verified
package into the compiler phase, composes it with the target-runtime package,
and compiles through both backends.

Against real GTK it constructs a `Window`/`Button`/`Box`/`DrawingArea`/`Overlay`
hierarchy, reads and writes nullable `Button.label` and `Window.title`, calls
`Window.setChild()` through the declared Widget upcast, passes both boolean
representations through `Widget.setVisible()`, sets `gint` dimensions from
plain numbers,
feeds `Widget.getWidth()` back into a native call, round-trips `gdouble`
opacity, calls `Widget.activate()` and projects its boolean result, receives
`Button.clicked` and `DrawingArea.resize(sender, width, height)` through
generated receiver-owned connections, and disposes deterministically.

The executable contains no JavaScript engine and no part of the Node build
tool.

## Building an application

`native-typescript build <project>` reads a `native-typescript.json`, generates
the binding packages its namespaces ask for, and links a native executable.
Parsing is strict and total: a project that the build would reject halfway
through is rejected before any work starts, naming the offending field.

The build runs in two phases, because generation is itself a build. The first
graph probes the C ABI with Clang and emits one binding package per namespace;
only once those exist can the second compile and link against them. Both phases
are ordinary artifact graphs, so both are sandboxed and cacheable.

The pipeline is `buildGtkApplication` in the target package rather than
something the command line assembles, so a gate, a command, and any future
editor integration take the same path instead of three reconstructions that can
disagree.

### Runtime services a target requires

ScriptC links a runtime service when the compiled program reaches it. That rule
is right for the program and wrong for the target: the GLib owner runtime calls
the retained-callback service whether or not the application connects a signal.

`ProviderDescriptor.requires.compiler` is now read rather than merely declared.
`nativeRuntimeServices` maps those capabilities onto ScriptC's own vocabulary
and the build passes them to the compiler, so an application that connects
nothing still links. A capability with no mapping is an error: linking without
it would fail on undefined symbols, which says nothing about the requirement
that was never declared.

## Known boundaries

These are deliberate, not oversights. Each is a named future slice.

- **Only two GIR namespaces have ever been linked together.** gio2 and gtk4
  compose and run; nothing proves a third, and no namespace outside the GNOME
  stack has been attempted.
- **A project cannot describe a non-GTK target.** `target` accepts `gtk4` and
  nothing else, and the parser says so rather than pretending otherwise. The
  Target SPI stays descriptor-only until a second target exists to justify its
  shape.
- **Absence is a value, and only for the results GIR says can be absent.** A
  method that hands back an object it keeps owning projects: the adapter takes
  a reference, which makes the result an owned handle, and the runtime interns
  it so repeated reads of one object name one managed cell. 187 GTK methods
  take this path.

  132 of them can return nothing, and those read as `T | null`. The remaining
  55 cannot, so a NULL from one would mean the library broke its own contract
  and throws. The `error` contract carries that difference: `nullable` means
  NULL is a failure, which is right for a constructor and wrong for a reader.

  A getter returning an object projects as a method, for the reason a nullable
  string getter does: it is a call whose answer can change, and the object it
  names has a lifetime of its own.

- **An exact integer's helper families are unbuilt.** Everything else the
  [Language profile](language-profile.md) specifies for it is implemented.
  Addition, subtraction, multiplication, the three bitwise operations, and all
  four orderings work on same-type operands; a decimal literal constructs one
  with a compile-time range check — `-5 as u32` is refused, not truncated;
  ordering compares at the declared width and signedness, so a `u32` whose
  bits are all ones is the largest value of its type rather than −1. Division,
  remainder, and the two shifts work the same way and throw where their width
  has no answer, and the two conversions are declared operations —
  `i64.toNumber(v)`, `i64.fromNumber(n)`. What remains is the checked,
  saturating, and explicitly wrapping helper families.

  All of the arithmetic is reachable only inside a construction: `(a + b) as
  u32` and `(a / b) as u32` lower, the bare forms do not. That is not a
  lowering seam to close — TypeScript types arithmetic over two branded
  numbers as plain `number`, so the bare expression does not typecheck against
  an exact declaration however the lowering would treat it. The cast is what
  makes the expression well-typed at the source level, and only then what
  supplies the target type.

  What this costs has narrowed sharply. Every GIR number now crosses as a
  plain `number` under the declared conversion policy, so ordering, printing,
  arithmetic, and `Math` work on the whole GTK surface with no operation
  needed at all. What remains exact by necessity — the 64-bit integers, and
  manifests that deliberately keep exact scalars such as the `scabi-c-v1`
  fixture — reaches the same capabilities by name.

- **A callee may take ownership of a handle argument.** GIR states which side
  owns the object after a call, and both answers now project: `none` borrows
  it for the call, `full` moves the reference. A moved handle is spent —
  `widget.addController(controller)` hands the widget the only reference, and
  a later use of the controller handle is a use-after-dispose, which is the
  same guarantee `dispose()` makes and for the same reason.

  The runtime shares one teardown for both: a transfer is a disposal minus
  freeing the object, since after a transfer that is not this side's to do.
  What had to be separated is that a destructor was previously the only
  consumer the emitters had seen, so "takes an owned handle" had come to mean
  "is a destructor" — a destructor is performed by the runtime, which holds
  its symbol and knows the teardown order, while every other consumer is an
  ordinary call.

  This is what makes event controllers reachable: `gtk_widget_add_controller`
  transfers, so keyboard, scroll, and gesture handling were unreachable
  whatever else worked.

- **A record projects as a value or as a handle, and its fields decide
  which.** Every field an exact scalar is a layout that crosses by copy, which
  is what `GtkRequisition` and `Gdk.Rectangle` are. Anything else is a boxed
  handle: `GtkTextIter` is fourteen opaque words with a `copy` and a `free`, so
  it crosses as an owned pointer whose destructor is that free — no reference
  count involved, and no interning, because `copy` makes a second object with
  the same contents.

  GTK hands one back by filling storage the caller reserves, so the adapter
  reserves it, calls, and returns the record's own copy of the result: one
  allocation, freed by the function that pairs with the one that made it. The
  copy and the free are the record's contract rather than its surface — read
  whether or not the project selected them, and projected only if it did.

  This is 79 live GTK members, led by `GtkTextIter` on 48. The allocation is
  the price: GTK allocates none, and an iterator here costs one, though a loop
  that advances one iterator allocates once rather than per step. The
  allocation-free alternative is a caller-allocated opaque value, which needs
  an IR value kind for a fixed-size blob that does not exist;
  [the roadmap](roadmap.md) records the comparison.

- **How a handle is released is a property of its type.** It was a property of
  each position that owned one, which was the same binding every time and had
  two consequences that looked unrelated. A class was given a release only if
  something in its own package destroyed one, because a release nothing names
  is refused; and a package that imported a handle could not own one, because
  a destructor is a binding and a manifest could only name its own. Both were
  the same missing statement. The type names it now, so every projected class
  has a release — performed by the runtime when the cell dies, not exposed as
  a `dispose()` member — and an importer receives the destructor with the
  type. Owned *pointer* results keep naming theirs on the position, where the
  producer really does decide the free.

- **A handle input may be absent.** GIR states whether a callee accepts NULL,
  and absence is what clears a child, unsets a transient parent, or declines a
  cancellable — so `frame.setChild(null)` and `application.register(null)` are
  the calls those mean, rather than an object constructed to stand for
  nothing. The ABI slot is one pointer either way; only the source side gains
  a null arm.

  What had been missing was on the compiler side. A value of a derived handle
  type flowing into `Widget | null` was refused, because union arm selection
  matched arms by identity: only an argument already spelled as the declared
  type could reach an optional slot, which is nearly never the one a caller
  has. A handle now widens into a union's ancestor arm through its declared
  identity upcast, the same rule the plain slot already had — nearest arm
  wins, and two arms the same distance away decline rather than being picked
  between. A whole union re-tags the same way, so
  `setChild(visible ? notes : null)` crosses as readily as the two calls it
  stands for.

- **Weak handles have no program**, and native invalidation is not the same
  question. Counted over the introspectable surface of GTK 4, Gio and GObject,
  the number of members whose name carries `weak` is zero: GObject is reference
  counted, so nothing can be freed under a live handle, and the cycle a weak
  edge is usually reached for is already collected by tracing.

  What GTK does document — 32 times — is an output becoming meaningless
  because of what the call answered, which is output VALIDITY and belongs to
  the outcome protocol rather than to a lifetime domain.

  GTK cannot declare it: of the ten attributes GIR puts on a parameter, none
  says a validity depends on an outcome, so `gtk_bitset_iter_next` and
  `gtk_text_buffer_get_iter_at_line` are indistinguishable in metadata and
  differ only in prose. A C caller has the same obligation for the same reason
  — read the answer, then the outputs — so the binding gives what C gives.
  Where the rule is derivable it is uniform and comes from a platform profile:
  JNI's pending-exception restriction is the first.
  [0007](records/0007-weak-and-invalid-are-not-one-thing.md) records the split
  and the correction.
- **A signal payload must be something the runtime can capture.** Exact scalars
  of every width, selected enumerations, UTF-8 strings, and selected classes
  project.

  Measured over every one of GTK 4's 330 declared signals, **198 project**, up
  from 179 — before boxed payloads, which add the 37 whose payload is a record: the 19 that gained one carry an object payload. Of the 132 still
  refused, 69 are detailed or non-void signals, 59 name a payload type with no
  C spelling — boxed records like `GtkTextIter`, and cross-namespace types — 3
  name `gboolean`, which has two representations and no chosen one, and 1 is
  nullable.

  Delivery is queued to the runtime owner, so a payload cannot be a pointer the
  emitter still owns: GTK may reuse a string the moment emission returns. A
  string is therefore copied when the signal fires, held by the invocation, and
  released whether the delivery runs or is dropped during shutdown — the same
  discipline the registration owner already used.

  A boxed record payload is the same discipline over a copy: delivery is
  queued, so the dispatch duplicates one with the record's own `copy` and the
  invocation owns the duplicate, released by the `free` its handle type already
  names. Taking a REFERENCE to one would read fourteen opaque words as a
  GTypeInstance — the two families arrive at the payload projection through the
  same table because both are handles, which is why how one is kept has to be
  asked rather than assumed.

  An object payload is the same discipline over a reference rather than a copy.
  The dispatch takes one before queueing; the trampoline turns it into a
  managed cell, and the identity map answers the question that used to block
  this — a bare `GtkListBoxRow*` gets the cell the application's own handle
  already denotes, so writing through the payload is visible through the
  handle. A payload GIR marks nullable is still refused, because absence would
  have to become a union arm the callback signature does not carry.

- **A signal that asks a question is answered during its emission.** GTK has
  57 signals returning `gboolean` — `close-request`, `key-pressed`, `scroll`
  — and every one asks whether the handler consumed the event. The answer has
  to exist before the emitting call returns, so those handlers run inside the
  emission rather than in a later runtime turn, and they return an ordinary
  `boolean`:

  ```ts
  window.onCloseRequest(() => {
    return unsavedChanges;   // true keeps the window open
  });
  ```

  That delivery is admissible for one reason: the invocation is same-as-caller
  on the thread that owns the runtime, and answering means reading a closure,
  which a foreign producer may never do. Only values cross it — nothing
  outlives the call, so a copied string or a referenced object payload would
  have no owner — and no sender is injected, for the same reason. A handler
  that throws leaves the exception pending, answers the toolkit with the ABI
  zero, and the next runtime turn reports it, exactly as it would an uncaught
  exception from a queued delivery.

  Every other signal stays queued. That is not an inconsistency to remove: a
  void signal's result is nothing, and keeping the toolkit's frames out of the
  runtime is worth having wherever it costs nothing.

- **A property change is observable.** GObject reports every one through the
  same signal, `notify`, whose detail names the property — so a project
  selects the property beside the class's methods (`"notify": ["reveal-child"]`)
  rather than beside its signals, and gets `onNotifyRevealChild`. The
  notification carries no value: the `GParamSpec` GObject passes says which
  property changed, which the detail already fixed, so the adapter absorbs it
  and the boundary never learns the type exists. The handler reads the new
  value off the sender. Delivery is queued and the registration is owned by
  the emitter, exactly as a listening signal's is.

  An observed property must have a selected getter on the class. Without one
  the notification is a subscription to nothing, and the getter's
  `glib:get-property` annotation is what gives the property name its single
  authority.

- **Detailed signals** fail generation, as do non-`gboolean` signal results and
  broader value-method input/output families. `notify::` is the exception, and
  it is not one in kind: a property observer is not a selected signal.
- **`gfloat` is the one crossing that is not exact.** It projects as a plain
  `number`, because a 32-bit float in a foreign signature is a slot rather
  than a second precision to compute in: reading one is lossless, since every
  float is a double, and writing one rounds to nearest float, which is the
  only thing storing a double in 32 bits can mean. `Label.xalign = 0.25`
  round-trips untouched; `= 0.1` comes back as the float nearest to it. The
  widget gate asserts both, so the rounding is a stated property rather than
  a discovery.

  There is no `f32` in the language: no literal, no arithmetic, no declared
  type. The compiler admits the scalar in a slot carrying the number
  conversion and refuses it everywhere else, per position.
- **`size_t` and `ssize_t` cross as plain numbers.** A length, a count, or an
  index is a number — it is compared to `.length` and used as an index far
  more often than it is stored — so the pointer-width integers carry one, and
  the crossing a double cannot always make is checked rather than assumed:
  reading answers only when the double denotes the same integer and raises a
  `RangeError` otherwise. For a byte count of anything that fits in memory it
  always does, which is why the check costs nothing and stays honest. A
  payload and a struct field keep the narrow rule, because neither has a
  caller to raise to.

  `long` and `unsigned long` are still absent, and no live GTK member names
  one; when one does, it joins the table the same way, and the Clang probe is
  what proves the width either way.
- **The final link is still one action.** Everything before it is reused. The
  ScriptC runtime compiles per source into its own cacheable objects, so an
  application edit recompiles the program and relinks rather than rebuilding
  twenty translation units. Measured on the single-namespace fixture: 6.7 s
  cold, 2.9 s after an application edit, against 7.6 s for either before.

  This is what [Architecture](architecture.md) asks for — an incremental build
  reusing validated artifacts at the narrowest sound boundary — and the link is
  where it stops. Its inputs include the program, so it re-runs whenever the
  application changes, which is correct; what remains is that a link is not
  itself cheap.

- **Sandbox inputs are not hermetic.** The executor binds the host filesystem
  read-only, so undeclared system headers can still influence a result.
  Declared inputs are content-verified; undeclared ones are not.
- **The Target SPI carries no planning behavior.** A provider's
  `requires.compiler` is now load-bearing, but everything else about a target
  is still wired directly: providers cannot plan, and GTK is reached by name.
  The remaining shape waits on a second target to justify it.
Platform UI and framework work begins only after the contracts above pass their
conformance gates. See [Roadmap](roadmap.md) for sequencing and exit gates.
