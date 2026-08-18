# 0002 — Adjudicating upstream's callback tier against the fork's

Status: accepted finding, convergence not yet scheduled
Last revised: 2026-08-18

This is an investigation record under the policy in
[scriptc evolution](../scriptc-evolution.md). It records what upstream's FFI
formats 3, 4, and 5 supersede in this fork, what they cannot yet express, and
why the duplication survives this change rather than being deleted by it. It
is not normative.

It also fires the revisit condition
[0001](0001-native-manifest-boundary.md) set for itself: *"revisit before
implementation if upstream ships its own retained-callback or ownership
model."* Upstream shipped one. This record is that revisit.

## Feature or behavior

Two outbound native-callback implementations now exist in one tree: upstream's
`ffiCall` path (profile formats 2–5, `backend/ffi-callbacks.ts`, `scr_ffi.c`,
`scr_ffi_queue.c`) and the fork's Native IR path (`nativeCall`,
`backend/native-callbacks.ts`, `scr_retained_callbacks.c`,
`scr_owner_gateway.c`, `scr_callback_table.c`, `scr_callback_token.c`,
`scr_callback_handle.c`). The question this record answers is which one
survives, and what has to be true before the other can be deleted.

## Real motivating program/test

- `fixtures/scabi-c-v1/package.scabi.json` — `nts_subscription_create`:
  a retained callback whose registration is owned by the **result handle**,
  admitting `same-as-caller` and `any-attached-thread` producers, delivered
  through the runtime owner.
- `fixtures/gtk-counter/package.scabi.json` — a GTK signal: retained,
  `registrationOwner: "result"`, `deliveryExecutor: "runtime-owner"`.
- Upstream's `tests/ffi/main.ts` formats 3–5 cases, which pass 48/48 across
  both backends on the merged tree.

## Current scriptc revision and result

Investigated at fork commit `8b66e90a`, which merges upstream through
`729f809`. Both paths are live and both suites pass.

Measured: every retained callback this project declares, in every manifest in
the tree, is `registrationOwner: "result"`. There are no process-scoped
retained registrations anywhere in Native TypeScript.

### What upstream's model now covers

Field by field, upstream's descriptor against `IrNativeCallbackContract`:

| Fork contract | Upstream format 4/5 | Finding |
| --- | --- | --- |
| `lifetime: "call"` | `lifetime: "call"` | equivalent |
| `lifetime: "until-cancelled"` | `lifetime: "retained"` | equivalent concept |
| `cancellationBinding` | `release: "<binding>:<id>"` | **upstream is stronger** — it validates release-vs-registration pointer identity before the native call, rejects inline literals, rejects a binding that both registers and releases, and counts duplicate registrations |
| `allowedInvocationExecutors` | `invoke: "script-thread" \| "foreign"` | equivalent |
| `transports: [{kind:"copy"}]` | format 3 copy-in | **upstream is wider** — `cstring`, UTF-8 spans, and byte spans, with U+FFFD replacement and precise null traps |
| `postDisposal: "not-invoked"` | raw-slot invocation after teardown traps | equivalent |
| `shutdown: "drain"` | exit listeners first, foreign posting disarmed, remaining registrations dropped | **upstream is more complete** |
| `synchronousReturn: true` on a retained script-thread callback | scalar `returns` on a retained descriptor | equivalent |
| `registrationOwner: {kind:"result"} \| {kind:"argument"}` | — | **absent upstream** |
| `deliveryExecutor: "runtime-owner"` over a foreign loop | — | **absent upstream** |

### The two gaps, precisely

**Registration ownership.** Upstream's ledger is keyed by
`<binding>:<callback-id>` plus the context pointer, and its scope is the
process: registrations end at an explicit paired release or at exit teardown.
Ours is keyed by an owner **handle** (`scr_retained_callbacks_retain_owner`,
`scr_callback_handle.c`), so a registration ends when the object that owns it
dies — which is what `g_signal_connect(widget, …)` means, and what every
observer whose lifetime is an object's means.

**Delivery target.** Upstream's `scr_ffi_queue.c` wakes scriptc's own loop
through a self-pipe it creates and polls itself. Ours (`scr_owner_gateway.c`)
takes a wake function (`ScrOwnerGatewayWakeFn`) at construction, so a platform
loop that already exists — GLib's, CFRunLoop, an Android Looper — drives
delivery. Format 5 is unusable in any host that owns its own loop, which is
every GUI host.

### Why the duplication cannot be deleted in this change

Both gaps are *downstream of a type-system gap*. Upstream's entire ABI class
set is `f64, bool, u8, u32, i32, cstring, string, bytes, void`. There is no
handle class, so "the registration is owned by this object" has no object to
name; and there are no integer widths beyond 32 bits, so a GTK signal payload
(`gsize`, `gint64`, `guint16`) cannot be spelled at all.

So the adoption order is forced, and it is the opposite of what it looks like
from the diff: **the callback tier cannot converge until the type tier does.**
Deleting the fork's callback path today would delete working capability and
replace it with a model that cannot express the programs this repository
compiles.

## Classification

**Architectural constraint**, with one component that is a
**deliberate divergence**.

The constraint: the missing capability upstream needs is not a callback
feature, it is a type. The divergence: upstream's integer ingress wraps
(`ToInt32`/`ToUint32`, asserted by `tests/ffi/main.ts` as
`nativeU8(258) === 2`); ours checks and raises a catchable `TypeError`, per
[binding ABI](../binding-abi.md).

## Required observable semantics

For convergence to be possible, upstream's profile must be able to express:

1. exact integer classes at every C width plus pointer width, and `f32`;
2. an opaque handle class with a declared destructor and identity, so a
   pointer result can be owned and a registration can name its owner;
3. a retained registration whose scope is a handle rather than the process;
4. a delivery target the embedder supplies rather than one the runtime owns.

(1) and (2) are prerequisites; (3) and (4) are the callback work proper.

## Language/IR/runtime implications

- **Nothing is deleted yet.** Both paths stay live, both suites gate.
- The convergence target, once (1) and (2) exist, is: upstream's registration
  ledger (`scr_ffi.c`) becomes the substrate; the fork contributes
  handle-scoped registration on top of it, and a pluggable wake on
  `scr_ffi_queue.c` replacing the fork's separate gateway. The fork's
  `scr_callback_token.c` and `scr_callback_table.c` are then redundant with
  the ledger and go.
- `scr_owner_gateway.c` survives that merge only as the *pluggable wake*
  contribution; its MPSC half is duplicated by `scr_ffi_queue.c` and should
  not both exist.
- The fork's contract keeps two fields upstream does not model —
  `reentrancy` and `allowedInvocationExecutors` as a set — which are
  declarations about what a native API promises rather than about what the
  runtime does. [0003](0003-vocabulary-narrowing.md) settles it by
  measurement: `reentrancy` has no read site outside the validator and is
  deleted, while `allowedInvocationExecutors` has three and stays.

## Reference implementations and findings

Upstream's own documentation is the primary evidence for the ordering above:
it states that pointer, string, and byte **returns** are omitted "because
those need an explicit ownership and allocator contract." That contract is
exactly what the fork's handle model is, and it is the missing piece their
callback model would need to become object-scoped. The two designs converge
on the same requirement from opposite directions.

## Chosen decision and rejected alternatives

**Chosen.** Keep both paths for now. Sequence the convergence behind the type
tier: exact widths, then handles, then handle-scoped registration, then
pluggable delivery. Adopt upstream's release-identity validation, copy-in
payload classes, and exit-teardown semantics as the reference behavior our
form must match or beat when the paths merge.

**Rejected.**

- *Delete the fork's callback path now and re-express on formats 4/5.* It
  cannot express `registrationOwner: "result"`, has no payload class for a
  GTK signal's integers, and delivers on the wrong loop. This would be a
  regression sold as de-duplication.
- *Delete upstream's path now and keep only Native IR.* This was
  [0001](0001-native-manifest-boundary.md)'s plank, and it is withdrawn.
  Upstream has since invested five formats, a documentation page, and a
  48-test suite in that path; deleting it is unlandable upstream and buys
  this repository nothing it does not already have.
- *Maintain both indefinitely.* Every backend, validator, and may-throw
  analysis carries two arms forever. Acceptable as a transition, not as an
  endpoint — which is why this record names the exit condition.

## Implementation repository and owner

scriptc fork; owner: project maintainer. Sequenced behind the type tier, not
scheduled here.

## Upstream issue/PR/status

None filed, deliberately. Nothing is proposed upstream until the full local
adjudication and refactor are complete.

## Conformance tests

The tests that must keep passing through any convergence, on both backends:

- `tests/harness/ffi.test.ts` — upstream's 48, formats 1–5;
- `tests/harness/native-ir.test.ts` — the fork's 127, including
  `callback-retained`, `callback-answer`, `callback-attached-loop`,
  `callback-attached-timer`, `callback-call-scoped-throw`;
- `tests/harness/owner-gateway.test.ts`, `callback-token.test.ts`,
  `callback-table.test.ts`, `callback-handle.test.ts`,
  `retained-callbacks.test.ts`;
- the parent's GTK application gates, which exercise a real GLib loop.

## Removal or revisit condition

Superseded when the convergence lands and one callback path remains. Revisit
sooner if upstream adds a handle or pointer-ownership class to the profile —
that single change unblocks (2) through (4) and makes this record's ordering
obsolete.
