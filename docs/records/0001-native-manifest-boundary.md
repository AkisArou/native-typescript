# 0001 — One native vocabulary: growing scriptc's manifest, and the SCABI envelope

Status: accepted decision, steps 0-2 implemented; remaining steps reordered by
[0006](0006-one-vocabulary-one-owner.md)
Last revised: 2026-08-19

This is an investigation record under the policy in
[scriptc evolution](../scriptc-evolution.md). It records a decision and its
rationale; it is not normative. [architecture](../architecture.md) and
[binding ABI](../binding-abi.md) describe the built system and continue to win
on conflict; [status](../status.md) records how much of this plan is standing
today. When a step revises what those documents describe, they are revised in
the same change, and this record remains as the archive of why.

**Revised twice.** [0006](0006-one-vocabulary-one-owner.md) reorders what is
left: the committed type module was step 8 of 9, on the reasoning that the
earlier steps each shrink a parallel path and the module records the result.
That held for a plan whose remaining steps were small. It stopped holding when
[the foreign boundary](../foreign-boundary.md) was adopted, because every
dimension that design adds is cross-cutting, and a cross-cutting capability
added before the vocabulary is unified is added twice by construction. The
module is now first. Steps 3 through 7 keep their content and their relative
order and follow it.

**Revised.** The first version of this record was written before upstream
shipped FFI formats 3, 4, and 5. Two of its planks did not survive contact
with that: it proposed deleting upstream's manifest and replacing it, and it
proposed deleting upstream's wrapping integer ingress. Both are withdrawn
below, with the reasoning that replaced them.
[0002](0002-upstream-callback-tier.md) is the measurement that forced the
revision.

## Decision

A fact belongs to scriptc's manifest **iff it changes the machine code the
compiler emits**. A fact belongs to SCABI **iff it only changes what gets
built, linked, cached, composed, or proven**. Nothing satisfies both, so
nothing is stated twice.

Concretely:

1. **The compiler's manifest is upstream's, grown.** `ffi.json` becomes able
   to express everything `NativeFrontendInput` expresses, through additive
   format versions in upstream's own versioning discipline. It is not
   replaced, and formats 1 through 5 keep their meaning.
2. **There is exactly one lowering.** `ffiCall` and `nativeCall` become one
   IR expression kind, one trampoline family, one validator, one arm per
   backend. Every format version is an input dialect of one document; none is
   a second code path. This is what actually gets deleted.
3. **SCABI becomes an envelope** that embeds that document verbatim under one
   key and defines only what sits above the compiler: identity, provenance,
   composition, the link and adapter graph, permissions, availability, and
   declaration integrity.
4. **The signature/type/callback/error/thread vocabulary is defined once**, in
   the compiler, and its format version is definitionally the implemented
   algebra: no field exists without a lowering behind it.
5. **The fork carries no downstream identity.** No framework, no product, no
   package of ours appears in its code, comments, diagnostics, test fixtures,
   or module names. This is a precondition of the rest, not a courtesy — see
   *Neutrality* below.

## Feature or behavior

Unification of the two outbound native-call subsystems in the pinned
compiler, and removal of the duplicated ABI vocabulary between
`@native-typescript/scabi` and the compiler's Native IR.

## Real motivating program/test

- `fixtures/scabi-c-v1/package.scabi.json` — in particular
  `subscription_create`: an owned nullable handle result plus a retained
  callback owned by that result, with a foreign-thread producer, a
  cancellation binding, and runtime-owner delivery.
- `packages/target-gtk/application/package.scabi.json` and the applications
  compiled by `pnpm test` through both backends.
- Upstream's `tests/ffi/main.ts`, whose format 1–5 semantics must keep
  holding through the unification — it is the proof that step 1 is a
  refactor and not a rewrite.

## Current scriptc revision and result

Re-investigated at fork commit `42ee2847`, which merges upstream through
`ff98ee23` (`@scriptc/compiler` 0.0.32+, branch `native-typescript`).

- Two parallel outbound FFI paths exist end to end. Upstream's:
  `ffi/profile.ts`, the `ffiCall` expression kind, `backend/ffi-callbacks.ts`,
  `scr_ffi.c`, `scr_ffi_queue.c`, and per-backend emission arms. Fork-added:
  `frontend/native.ts`, `frontend/lowering/lower-native.ts`, the `nativeCall`
  expression kind, `backend/native-callbacks.ts`, the callback
  table/token/handle and owner-gateway runtime units, and per-backend arms.
  They share no code; every backend and validator carries both arms.
- `loadFfiProfile` already normalizes formats 1 through 5 into **one**
  internal shape, with the format number gating only which vocabulary is
  admissible. The unification therefore has a natural home: that normalized
  shape becomes `NativeFrontendInput`.
- Upstream's ABI class set is `f64, bool, u8, u32, i32, cstring, string,
  bytes, void`. It has no exact widths past 32 bits, no `f32`, no aggregate,
  and no handle. Its documentation states that pointer, string, and byte
  **returns** are omitted "because those need an explicit ownership and
  allocator contract" — which is exactly what the fork's handle model is.
- The parent defines the same ABI vocabulary a second time
  (`packages/scabi/src/model.ts`, 559 lines; `validation.ts`, 2,142 lines) and
  translates it into the frontend contract through
  `packages/scriptc/src/native.ts` (3,502 lines). The nine fields of the
  retained-callback contract appear verbatim on both sides — evidence that
  the vocabulary is compiler-owned and the duplication is structural.
- The parent uses upstream's `ffi.json` zero times.
- The frontend contract already states the intended boundary in prose
  (`frontend/native.ts`). This decision makes that sentence physical.

## Classification

**Architectural constraint** — the missing capability is a serialized,
validated form of the frontend's native contract; patching either manifest
format piecemeal reproduces a compiler invariant outside the compiler.

## Required observable semantics

- One outbound native-call machinery in the compiler; one expression kind;
  one trampoline family; equivalent C and LLVM emission.
- The compiler consumes a **closed** manifest: every referenced type is
  defined in the document it is handed. Package identity, link inputs, and
  provenance never reach the compiler.
- Every numeric boundary crossing **names its conversion**. See below.
- Metadata outside the format's vocabulary cannot be written down anywhere,
  so generators fail precisely at generation time — the existing
  "unsupported behavior fails precisely" rule applied to the format itself.
- The embedded native subtree is canonically serialized and independently
  digestible, and that digest keys compiler actions: envelope-only changes
  (link order, permission prose, provenance) do not invalidate compiled IR.
- The document resolves **once** at load into the in-memory contract, so
  lowering never pays for the type table's indirection.

## Withdrawn: deleting upstream's format

The first version of this record proposed that the fork's manifest "replaces
`ffi.json` formats 1 and 2, which are deleted together with the `ffiCall`
machinery behind them."

That was reasonable when formats 1 and 2 were a thin value-call surface with
little behind them. It is no longer: upstream has since put five formats, a
documentation page, and a forty-eight-test suite across both backends behind
that path. Deleting it is unlandable upstream, and — the part that matters
more — it was never the stronger design. Upstream's format is already
versioned, already normalizes every version into one internal shape, and
already grows additively. The endpoint this record wants *is* that format
with a wider vocabulary.

So: **grow it.** Formats 1–5 keep their exact meaning and their tests. The
deletion this record still demands is of the second *lowering*, not of the
first *format*, and a format version is not a compatibility shim — it is the
format's own versioning, which upstream authored and this project adopts.

## Withdrawn: deleting wrapping ingress

The first version called upstream's `ToInt32`/`ToUint32` ingress a deliberate
divergence to be removed, on the grounds that "a silent wrap at an ABI
boundary is a corruption, not a conversion."

The objection was right about *silent* and wrong about *wrap*. Wrapping is
what `value | 0` means, the language already spells it, and a binding author
may legitimately want it. What is indefensible is that formats 1–5 apply it
invisibly, with no way for the document to say which conversion a position
performs.

So the conversion becomes **a named projection on every position**:

| Projection | Meaning |
| --- | --- |
| `checked` | finite, integral, in range, else a catchable `TypeError` |
| `wrap` | the ECMAScript modulo conversion, exactly `\| 0` / `>>> 0` |
| `exact` | the slot's own branded value; no conversion occurs |

Formats 1 through 5 imply `wrap`, because that is the meaning they shipped
with. Format 6 and later **refuse a position that omits the choice**. The
divergence dissolves: both behaviors are first-class, neither is a default,
and the document says which one a binding gets. That is strictly better than
either side had alone, and it removes the one item on this record that could
not have been proposed upstream without asking them to break a shipped
contract.

## Minimum vocabulary for the unification

Measured at `35d5f67b`. Desugaring upstream's formats into Native IR bindings
needs four things Native IR does not have, and no others. Two are genuinely
new vocabulary; two are shapes the current design cannot express because it
states a related fact in a fixed form:

- **A `wrap` conversion.** Native IR's `number` projection is checked-only and
  capped at 32 bits; upstream's value ingress emits ECMAScript
  `ToInt32`/`ToUint32` and its tests assert the wrapping. Desugaring without a
  wrap projection would silently change upstream's shipped semantics. This is
  the same projection the conversion decision above already calls for, which
  means it arrives with a consumer rather than as aspiration — the growth rule
  this record imposes on SCABI, applied to itself.
- **A process-scoped registration owner.** Native IR scopes a retained
  registration to a `result` or an `argument`; upstream scopes one to the
  descriptor and context pointer for the life of the process, with no owner
  value at all. That arm has to exist for a format 4 or 5 binding to be
  expressible. Under [0003](0003-vocabulary-narrowing.md) it stops being a new
  concept and becomes the fourth arm of the unified `owner`, which is why that
  narrowing is sequenced first.

- **A truthy boolean result.** Upstream's `bool` return is `(call != 0)` —
  any nonzero is true and it never throws. Native IR checks the value against
  the declared `falseValue`/`trueValue` pair and raises catchably otherwise.
  Both are legitimate contracts and neither subsumes the other, so the result
  projection grows a second form.
- **A release-by-value parameter.** Upstream identifies the registration to
  release by the closure value passed back on a named descriptor. Native IR
  derives cancellation from the *owner handle*
  (`nativeCallbackCancellationArgument`). Those are dual identification
  mechanisms, and expressing formats 4 and 5 needs upstream's.

Everything else in formats 1 through 5 — the string, byte, and cstring
crossings, call-scoped callbacks, context placement — maps onto vocabulary
that already exists.

This is why step 1 cannot be a pure refactor of the IR, and saying so is worth
more than preserving the tidier claim: a unification that quietly dropped
wrapping would be a behavior change wearing a refactor's clothes.

**Correction, measured while implementing.** The last claim above was made from
the value crossings and does not hold in the callback direction. A string,
byte, or cstring crossing *into* a native parameter was indeed already
expressible; the same value arriving as a callback *payload* was not, and
neither was a plain number leaving one as the answer. The callback payload
vocabulary needed four additions, each landed with the descriptors that forced
it — a boolean payload, a narrowed-number answer, a `cstring` payload form
distinct from the script type it becomes, and a source argument built from a
pointer and a count. The general lesson is the one this record already applies
elsewhere: a projection is directional, and a fact measured on one direction is
not evidence about the other.

## Neutrality

The premise of this record is that the vocabulary is generally useful to a
TypeScript compiler. A compiler whose code names one downstream project
contradicts that premise on its face, and it does so in places a user sees.

Measured at `42ee2847`, the fork carries:

- **Framework mentions** — ten prose sites naming GObject, GLib, GError,
  GTK signals, or `gboolean` as the motivating example, in `ir/nodes.ts`,
  `lower-native.ts`, `scr_runtime.h`, and four test files.
- **Product identity** — the native-IR fixture package is named
  `@native-typescript/scabi-c-v1-fixture` and every fixture binding ID is
  `native-typescript.fixture.c-v1@0.0.0#…`, across roughly 150 sites.
- **A user-visible diagnostic** — `SC5101`'s hint tells the user to
  "translate native bindings from a SCABI manifest", naming a format the
  compiler does not read and a project the user may not have.

None of these is load-bearing. Every one has a general statement that is also
a *better* statement, because the general case is what the code actually
implements: an event handler that reports whether it consumed the event is
the shape, not `gboolean` specifically; an out-parameter error object an
adapter has absorbed is the shape, not `GError` specifically; a
reference-counted object with a stable address is the requirement, not
`GObject`.

Neutralizing is therefore a precondition of the ladder below, sequenced
first, and it is atomic across both repositories because the fixture module
name appears on both sides of the submodule boundary.

## The native manifest (compiler-owned)

The document serializes `NativeFrontendInput` plus the type table it
references, self-described by `ffi_format`:

- the `{ pointerBits, abi }` proof key the layout facts were probed against;
  the driver continues to refuse disagreement with the selected backend
  target;
- the type table: integer/float/boolean/enum/flags/pointer/array/slice,
  structs and unions with Clang-proven size, alignment, field offsets, and
  complete `abiPassing`, handles with `nativeName`, identity, thread safety,
  destructor, and upcasts, callback types with context placement;
- bindings: declaration reference, entry symbol, source-call shape,
  signature with per-position `passMode`, `nullable`, ownership, marshal,
  and conversion projections, the error contract, the thread contract, and
  the full callback contract;
- exports (C-callable entries implemented in TypeScript), constants, and
  exact-scalar operations. Generators state these; no layer synthesizes them.

Two simplifications fall out:

- **`entry.kind` dies.** The compiler calls a symbol; who produces it — a C
  library or a generated adapter — is build-graph data and moves to the
  envelope. The `c-symbol`/`adapter-symbol` distinction was build information
  wearing a signature costume.
- **Physical paths leave the manifest entirely.** Standalone scriptc use
  passes link inputs on the invocation, like any compiler; paths belong to
  invocations, never to documents.

### What moves

From `packages/scabi/src/model.ts` (559 lines), the compiler takes the type
algebra (`VoidType` through `PlatformObjectType` and `NativeType`), the
signature algebra (`OwnershipContract`, `MarshallingContract`, `PassMode`,
`AbiResult`, `AbiParameter`, `FunctionSignature`, `NumberConversion`), the
concurrency and callback contracts (`ExecutorIdentity`, `ThreadContract`,
`CallbackContract` and its argument contracts), the failure contract
(`ErrorContract`), the declaration binding (`DeclarationReference`,
`DeclarationContract`), and the binding shapes minus their dependency and
availability fields.

The envelope keeps identity (`PackageIdentity`, `TargetIdentity`,
`SdkIdentity`, `GeneratorIdentity`, `Sha256Digest`), the build graph
(`LinkInput`, `AdapterInput`, `PermissionRequirement`), composition
(`TypeImport`, `BindingDependencies`, `BindingAvailability`), and
`ScabiManifest` itself.

From `validation.ts` (2,142 lines), roughly 1,600 move: layout, size and
alignment, canonical integer values, handle upcasts, type references,
position ownership, destructor arity, conversion admissibility, marshalling,
callback admissibility, and the callable/constant binding rules. These are
meaningless without a lowering behind them. Roughly 540 stay: type imports,
dependency and unique-input checks, composition semantics, and the envelope
entry points.

`packages/scriptc/src/native.ts` (3,502 lines) collapses from vocabulary
translation to a planner — verify envelope, prune by availability, compose
imports, hand over.

## The SCABI envelope (v4)

```jsonc
{
  "schema": "native-typescript.scabi",
  "schemaVersion": 4,
  "package": { /* identity: name, version, namespace, instance */ },
  "target": { /* full TargetIdentity: triple, endianness, objectFormat, … */ },
  "sdk": { /* toolchain, deployment target, metadataDigest */ },
  "generator": { /* name, revision, arguments, inputDigests */ },
  "declarations": { "digest": "sha256:…" },
  "imports": {
    "object_base": { "package": { /* owner identity */ },
                     "type": "object_base", "destructor": "object_unref" }
  },
  "linkInputs": [ { "id": "toolkit", "kind": "system-library", "order": 1 } ],
  "adapterInputs": [ /* generation jobs */ ],
  "permissions": [ /* requirements */ ],
  "bindingMeta": {
    "counter_create": { "bindings": ["counter_destroy"],
                        "linkInputs": [], "adapterInputs": [],
                        "permissions": [] }
  },
  "native": { /* the compiler's document, verbatim */ }
}
```

- **`bindingMeta` is a side table**, not fields inside bindings. That is what
  keeps the subtree byte-for-byte the compiler's format, which is what makes
  the subtree digest a compiler cache key.
- `declarations` keeps only the digest — the `.d.ts` anti-drift check.
  Declaration references live inside the subtree, where the checker resolves
  through them.
- `availability` stays in the envelope; the planner prunes bindings before
  the compiler sees anything. A pruned destructor still referenced by a
  surviving type is a composition error, reported precisely.
- Everything else v3 carried that restated ABI vocabulary is deleted from the
  SCABI schema, not preserved beside the subtree.

## Composition and imported holes

A package's subtree is open: a type another package owns appears as an
explicit `{ "kind": "imported" }` hole, and the envelope's `imports` table
maps it to the owning package instance, restating the destructor in the
owner's identity so composition can prove agreement. The planner prunes by
availability, splices owners' definitions under instance-scoped IDs, and
hands the compiler a closed document. The compiler's validator rejects any
surviving hole. The compiler never learns package identity; the composer
never learns calling conventions.

## Vocabulary growth policy

SCABI v3's vocabulary is wider than the compiler's (eleven error kinds
against four; five callback lifetimes against two). Under this decision the
wider forms are not features — they are pending lowerings, and they are
deleted rather than preserved as aspiration. When a lowering lands, the
format version grows the kind, and only then may a generator emit it.
Capability negotiation *is* the format version; speculative vocabulary lives
nowhere.

## Language/IR/runtime implications

- IR: `ffiCall` and `nativeCall` collapse into one expression kind, with one
  set of arms in validation, may-throw analysis, and both backends.
- Runtime: the fork's callback table, token, and the owner gateway's MPSC
  half become redundant with upstream's registration ledger and queue and are
  deleted; what survives is handle-scoped registration and an
  embedder-supplied delivery wake, per [0002](0002-upstream-callback-tier.md).
- Library-mode host-callback channels currently ride `ffiCall` and follow it
  onto the unified node.
- Parent: `packages/scriptc/src/native.ts` becomes a planner;
  `packages/scabi` shrinks to envelope model, canonical serializer, and
  envelope/composition validation.

## Type sharing across the submodule boundary

The parent may not import the fork's `dist` (clean-checkout typecheck), and
must not drag the fork's source graph into its own. The fork therefore
commits one pure-type, import-free, erasable module declaring the manifest
format, beside a fork test asserting mutual assignability with
`NativeFrontendInput`. The parent imports it type-only by source path:
present on a clean checkout, erased at runtime, no build required. One
definition, compiler-checked on both sides of the submodule boundary, zero
code dependency. The fork also ships the format as a JSON Schema for
structural validation by non-TypeScript consumers.

## Implementation repository and owner

Both repositories; owner: project maintainer. Sequenced as follows, each
change atomic, green on its own, and bisectable:

0. **Neutralize the fork.** Framework mentions, product identity, and the
   `SC5101` hint. Atomic across both repositories, because the fixture module
   name crosses the submodule boundary.
1. **Narrow the vocabulary to what it lowers.**
   [0003](0003-vocabulary-narrowing.md): collapse `lifetime` into `owner`,
   replace the eleven error conventions with three orthogonal axes, delete the
   four inert callback fields and the constant-valued ones. Nothing observable
   changes, which is a safety argument available only while nothing else is
   moving — and it makes the next step smaller.
2. **Unify the call node.** One `nativeCall`; formats 1–5 desugar at load.
   The vocabulary grows by **exactly what faithfully expresses formats 1–5,
   and nothing more** (see *Minimum vocabulary* below); upstream's FFI suite
   and the fork's native-IR suite must both pass unchanged, which is the
   proof it is a refactor and not a semantic change.

   Landing in three slices, by capability, so each is verifiable against
   upstream's suite on its own:

   - **Value calls.** Done. Every profile binding with no callback desugars
     and lowers as `nativeCall`; the rest keep the profile's path. The
     measured cost was five real defects the oracle caught, not translation
     detail — the crossing analysis refusing a wrap it cannot refute, a
     symbol allocator reading one of two tables, an LLVM call-argument
     attribute used as a type in two places, a saturating narrowing on the
     unsigned half, and a deferred callback throw losing its checkpoint when
     the observing call changed paths.
   - **Call-scoped callbacks** (formats 2 and 3). Done: 22 of upstream's 31
     descriptors desugar, which is every one whose callbacks live only for
     the call. The additions were measured against the descriptors that
     forced them, one at a time, so none was built ahead of a use:

     | Addition | Unblocks | State |
     | --- | --- | --- |
     | the positional context slot | every call-scoped descriptor | `cf244122` |
     | **the callback's source vocabulary, made symmetric** — see below | `nativeApply`, `nativeEach`, `nativeCallbackMix` | `540be6f2` |
     | a `cstring` payload form, decoded lossily and trapping NULL | `nativeCallbackStringThrow`, `nativeNullCString`, `nativePropVisit` | `50b0b721` |
     | a source argument built from a pointer/length PAIR, and the two span payload forms | `nativeCallbackSpans` | `8bc04cb5` |
     | a contextless callback, bound through a thread-local slot | `nativeCallbackSymbolCollision` | `0edbc14b` |
     | more than one callback in one call | `nativeCombineRaw` | `43632635` |

     Two of those rows were predicted wrongly and the corrections are worth
     more than the tidier table. The third row was written as "copy transports
     on the call arm", which named the mechanism instead of the gap: the call
     arm did need to admit a copied payload, but `transports` turned out to be
     a field no backend read, uniform per contract arm, and derivable from the
     payload form — so it was deleted (`73b8c0fc`) rather than widened, and
     what actually had to exist was a payload form naming the C arrangement.
     The fourth row asked for "a `bytes` source parameter", which is a payload
     form; a span is two physical slots feeding one parameter, so the pairing
     belongs to the source ARGUMENT and the form says only what the handler
     receives. The fifth row named two descriptors as one gap and they were
     two: `nativeCombineRaw` needed nothing thread-local at all, only a
     desugarer that stops assuming a binding carries one callback.

     The first row was originally written as two separate gaps — "a plain
     number handler answer" and "a `bool` source parameter" — and blamed on
     the exact scalar carriers. Both attributions were wrong, and the
     correction matters because it changes what gets built.

     `IrNativeCallbackArgumentType` was grown one side at a time. Its
     `params` admit `{ kind: "f64" }`, the plain-number payload form; its
     `ret` does not. Its `ret` admits `{ kind: "bool" }`; its `params` do
     not. Neither omission follows from anything — they are the two halves
     of one bug, and one change closes both.

     The place the two sides legitimately differ is the conversion. A
     payload WIDENS out of an at-most-32-bit slot into a double, which is
     exact and cannot fail, so it names nothing. An answer NARROWS a double
     back into the slot, which must choose, so it carries the same
     `checked`/`wrap` projection a parameter position does — and upstream's
     callback returns wrap, through the same helpers its parameter ingress
     uses.

     This is also the answer to whether the exact carriers should be dropped
     to sit closer to upstream. They already are, everywhere it is possible:
     `bindgen-gir` emits the plain-number conversion for all thirteen GLib
     scalars a double can carry, `size_t` and `gunichar` included, and keeps
     a brand only for `gint64` and `guint64`, whose range a double cannot
     hold, and for enumerations, where the brand is nominal typing between
     enum families rather than a width. Upstream's answer for the 64-bit
     pair is that it cannot call those APIs at all.
   - **Retained and foreign** (formats 4 and 5). Done. `owner` gained its
     `process` arm, releases identify a registration by naming its function
     value back, and a foreign producer copies the payload where it raises so
     the invocation can be queued. The substrate is upstream's ledger and
     queue, unchanged — a process-scoped registration has no owner whose loop
     could carry it, which is the same reason it has no cancellation binding.

     The outbound subsystem is deleted with it, about 1,200 lines. `ffiCall`
     is NOT, and this record was wrong to assume it could be: the node also
     serves library mode's host-callback channels, which are not outbound
     descriptors at all — a channel's name is a registration key rather than
     a C symbol, and a call dispatches through a runtime slot. That
     entanglement was already doing damage; channels were being translated as
     outbound descriptors and 16 of 30 library-callback tests were failing
     before the boundary was drawn.
3. **The committed type module and JSON Schema.** Moved to the front by
   [0006](0006-one-vocabulary-one-owner.md), which measures what leaving it
   last has already cost: 24 of the compiler's 37 native IR types have a
   same-named twin in the parent, and the most recent capability needed its
   governing predicate written once per repository. The fork publishes the
   vocabulary; the parent imports it type-only by source path and deletes its
   mirror; the rules that describe a lowering move to where the lowering is.
   Nothing after this step is built twice.
4. **Type table and exact scalars.** All C widths, pointer width, `f32`, and
   the mandatory conversion projection.
5. **Handles.** Opaque pointer types, declared destructor, identity, upcasts,
   owned/borrowed/nullable results.
6. **Aggregates.** Structs and unions by value with Clang-proven layout.
7. **Callback convergence.** Done, and the ordering this record and
   [0002](0002-upstream-callback-tier.md) assumed was wrong. Both expected the
   merge to wait on the type tier, and to land handle-scoped registration on
   top of the profile's ledger. It went the other way and needed neither: the
   TABLE is the surviving substrate, a registration nothing owns is one with
   no owner set, and release-by-value is a lookup on the anchor it already
   held. `scr_ffi.c` and `scr_ffi_queue.c` are deleted; the gateway gained a
   default self-pipe wake so a program with no embedder can use it, while a
   host that owns its loop still supplies its own.
8. **Exports, constants, operations.**
9. **SCABI v4.** Envelope, composer, `bindgen-gir` emitting the subtree
   directly, fixtures regenerated, `schemaVersion` bumped to 4, and
   [architecture](../architecture.md) plus [binding ABI](../binding-abi.md)
   rewritten in the same change.

Steps 4 through 8 each shrink the parallel path; by 8 there is nothing left
to delete, because step 2 already merged the node and step 3 merged the
vocabulary that describes it.

## Chosen decision and rejected alternatives

Chosen: as stated under **Decision**.

Rejected:

- **Replace upstream's format.** Withdrawn above with its reasoning.
- **Keep both lowerings and grow only ours.** Every backend, validator, and
  may-throw analysis carries two arms forever. Acceptable as the transition
  state the merge created; not as an endpoint.
- **Keep upstream's format as a legacy spelling desugared to native
  bindings.** This is what step 1 does — and the distinction from a
  compatibility shim is exact: there is one document and one lowering, and
  the format version selects which vocabulary a document may use. A shim
  would be a second code path, which is what gets deleted.
- **Keep SCABI's wider vocabulary as forward declaration.** It lets
  generators record contracts nothing can lower, moving the precise failure
  from generation time to translation time and making SCABI a second, richer
  type system that drifts.
- **A sibling `package.native.json` referenced by digest.** Two files that
  can drift and an indirection with no consumer; embedding keeps one
  canonical artifact while the subtree digest stays computable.
- **Sharing types via the fork's build output or source graph.** Breaks
  clean-checkout typechecking or couples the parent to the fork's
  compilation settings.

## Upstream issue/PR/status

None filed, by decision: the full local adjudication and refactor complete
first, so that any eventual proposal is a working branch and a written
rationale rather than an argument. Every step above is authored to be
independently proposable — additive format versions, no renames of upstream
vocabulary, and no downstream identity anywhere in the tree.

## Conformance tests

- Compiler: upstream's `tests/ffi` suite passing unchanged through step 1 and
  every step after; manifest parse/validate fixtures with precise diagnostics
  for every vocabulary rule, ported from the parent's SCABI validation
  fixtures *before* those are deleted; an assignability test pinning the
  committed type module to `NativeFrontendInput`.
- Parent: `fixtures/scabi-c-v1` and the target manifests regenerated to v4 and
  compiled by the full gate; a cache-stability test proving an envelope-only
  edit (link-input reorder) leaves the compiler action digest unchanged;
  composition fixtures exercising imported holes, destructor agreement, and
  availability pruning of a referenced destructor.

## Removal or revisit condition

Superseded as a live decision when step 9 lands and the normative documents
carry the boundary; the record then remains as rationale. Revisit before
implementation if upstream adds a handle or pointer-ownership class to its
profile — that single change reorders steps 4 through 6 and may make part of
this record unnecessary.
