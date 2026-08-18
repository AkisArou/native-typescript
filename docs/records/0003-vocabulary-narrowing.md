# 0003 — Narrow the native vocabulary to what it lowers

Status: accepted decision, implementation in progress
Last revised: 2026-08-18

This is an investigation record under the policy in
[scriptc evolution](../scriptc-evolution.md). It records a decision and its
rationale; it is not normative.

[0001](0001-native-manifest-boundary.md) decides *where* the native vocabulary
lives. This record decides *what shape it has* when it gets there, because
re-deriving it from scratch — asking what a compiler would want if it had just
been forked, rather than what this project happens to have grown — showed that
a third of its surface has no lowering behind it and four of its fields are
never read.

## Feature or behavior

Reduction of the Native IR callback, error, ownership, and executor
vocabularies to the algebra the compiler actually lowers, and re-derivation of
their shape where the current one states a fact twice.

## Real motivating program/test

The whole existing gate, on the losing side: every simplification here must
leave `tests/harness/native-ir.test.ts`, the parent's GTK application gates,
and `fixtures/scabi-c-v1` compiling and behaving identically. Nothing in this
record buys a capability; it removes vocabulary that buys none.

## Current scriptc revision and result

Measured at fork commit `35d5f67b`. Declared variants against lowered ones:

| Union | Declared | Lowered | Dead |
| --- | --- | --- | --- |
| `ErrorContract` | 11 | 4 | 7 |
| `OwnershipContract` | 9 | 4 | 5 |
| `ExecutorIdentity` | 7 | 3 | 4 |
| `callingConvention` | 6 | 1 | 5 |
| callback `lifetime` | 5 | 2 | 3 |
| string `encoding` | 3 | 1 | 2 |
| `PassMode` | 5 | 3 | 2 |

Plus `variadic`, a field with one possible value.

Four callback-contract fields are validated to a constant and then read by
nothing outside the validator:

| Field | Validator requires | Read sites elsewhere |
| --- | --- | --- |
| `reentrancy` | a fixed value per arm | 0 |
| `postDisposal` | `"not-invoked"` | 0 |
| `shutdown` | `"drain"` | 0 |
| `deliveryExecutor` | a fixed value per arm | 0 |

`deliveryExecutor` is the clearest case. A call-scoped callback always
delivers `same-as-caller` and an until-cancelled one always delivers through
the runtime owner; the validator enforces exactly that correspondence, and
then no backend consults the field. It is a fact stated twice and read zero
times.

## Classification

**Deliberate divergence**, from this project's own earlier design rather than
from upstream: the vocabulary was written wider than the implementation on the
theory that generators could record contracts ahead of lowerings.
[0001](0001-native-manifest-boundary.md) already rejects that theory for
SCABI. This record applies the same rule to the compiler's own IR, where it
was never applied.

## Required observable semantics

Nothing observable changes. Every program that compiles before this lands
compiles after it, to the same code. The conformance argument is entirely
"the gate is unchanged", which is why the change is worth making now rather
than during a refactor that also changes behavior.

## Chosen decision

### 1. The owner is the lifetime

`lifetime` and `registrationOwner` are entangled: `"call"` forces
`native-call`, `"until-cancelled"` forces `result` or `argument`. That is why
the IR type is three union arms repeating eight fields each. Collapse them:

```ts
owner:
  | { kind: "call" }
  | { kind: "result" }
  | { kind: "argument"; argument: number }
  | { kind: "process" }
```

`lifetime` is deleted; its thirty-three read sites become reads of
`owner.kind`. A call-scoped callback is one whose registration the native call
owns — which is what "call-scoped" always meant.

The fourth arm is the reason this comes first. Upstream's retained
registrations are scoped to the descriptor and its context pointer for the
life of the process, and [0001](0001-native-manifest-boundary.md) listed that
as a *new concept* the unification would have to introduce. Under this shape
it is an arm of something that already exists, so the unification gets smaller
by doing this first.

### 2. Failure is three orthogonal questions, not eleven conventions

`ErrorContract` names platform conventions — `hresult`,
`jni-pending-exception`, `nserror`, `platform-exception`. A compiler should
not know what an HRESULT is. Failure has three independent axes:

```ts
error: {
  detect:  { kind: "never" }
         | { kind: "resultIsNull" }
         | { kind: "resultEquals"; value: string }
         | { kind: "resultNotIn"; values: readonly string[] }
         | { kind: "outParamNonNull"; parameter: number }
  message: { kind: "none" } | { kind: "errno" } | { kind: "binding"; id: string }
  release: { kind: "none" } | { kind: "binding"; id: string }
}
```

Every lowered arm falls out: `no-fail` is `detect: never`; `nullable` is
`resultIsNull`; `errno` is `resultEquals` plus `message: errno`; `errorHandle`
is a non-null result plus `message: binding` plus `release: binding`.

The deleted arms are not lost, they are *subsumed*: `sentinel` and
`status-code` and `hresult` are instances of `detect`, available the day a
binding needs one, without a new arm. `nserror` is `outParamNonNull`. Only
`jni-pending-exception` is genuinely a new detector — a runtime probe rather
than a predicate on values — and it stays absent until an Android target makes
a real program fail without it.

This is both smaller and strictly more expressive than what it replaces.

### 3. Executors: three the compiler reasons about, one it does not

Keep `same-as-caller`, `runtime-owner`, and `any-attached-thread`: the
compiler genuinely decides emission from those. Everything else collapses to
`named(id)`, an identity the embedder resolves. `platform-ui` was a framework
concept inside a compiler; it is `named("ui")`.

### 4. Delete the four inert fields

`reentrancy`, `postDisposal`, `shutdown`, and `deliveryExecutor` go.
`deliveryExecutor` is derivable from `owner.kind` and the emission already
derives it. The other three are declarations about what a native API promises
that nothing consults; under the growth policy they are aspiration, and
aspiration lives nowhere.

If a later lowering needs one — a callback that must be refused reentry, say —
it returns as a field with a consumer, which is the rule.

### 5. Split text encoding from extent

`MarshallingContract` carries `encoding`, `length`, `termination`, and
`embeddedNul`, where `termination` restates `length.kind === "nul"`. Two
orthogonal facts — how bytes become text, and how the extent is known — plus
one ingress policy. `utf-16` and `latin-1` have no lowering and go.

### 6. Delete the constants

`variadic` has one value. `callingConvention` has one lowered value. Both are
fields whose only function is to be checked equal to a constant.

## Language/IR/runtime implications

- IR: `IrNativeCallbackContract` collapses from three arms repeating eight
  fields to one shape with a four-arm `owner`. The binding's `error` becomes
  the three-axis record.
- Runtime: no changes. Nothing here alters emitted code.
- Parent: SCABI's `model.ts` and `validation.ts` narrow to match, and the
  fixtures regenerate. This is atomic across both repositories, because the
  parent produces the contract the compiler consumes.

## Chosen decision and rejected alternatives

Chosen: as stated.

Rejected:

- **Keep the wider vocabulary as forward declaration.** The exact argument
  [0001](0001-native-manifest-boundary.md) already makes against SCABI's
  width: it lets a generator record a contract nothing can lower, which moves
  the precise failure from generation time to translation time. It is no more
  defensible inside the compiler than outside it.
- **Narrow during the unification instead of before it.** The unification is
  already a two-thousand-line emission merge whose safety argument is "both
  suites pass unchanged". Mixing a vocabulary change into it destroys that
  argument. Doing it first makes the unification smaller, and its own safety
  argument — nothing observable changes — is only available while nothing else
  is moving.
- **Keep `deliveryExecutor` for readability.** A field the validator pins and
  nobody reads is not documentation; it is a second place for the truth to
  live, and the two can disagree.
- **Design the error axes around a future JNI target.** That is precisely how
  the current width happened. The axes were derived from the four lowered
  arms; that they also cover five of the seven deleted ones is a consequence
  of picking the right decomposition, not of aiming at them.

## Implementation repository and owner

Both repositories; owner: project maintainer. Sequenced as decision 1 and 4
together (they are one shape change), then 2, then 3, 5, and 6, each atomic
across the two repositories and each proven by an unchanged gate.

## Upstream issue/PR/status

None filed. This narrowing is a precondition of anything proposed upstream:
the vocabulary that goes there should be the one the compiler lowers, not the
one this project once imagined.

## Conformance tests

Unchanged, and that is the point: `tests/harness/native-ir.test.ts`, the
parent's full `pnpm test` including the GTK application gates, upstream's
`tests/ffi` suite, and all three differential lanes. A narrowing that needed a
test to change would not be a narrowing.

## Removal or revisit condition

Superseded when the vocabulary and the lowered algebra are the same set by
construction — that is, when the format version *is* the algebra, per
[0001](0001-native-manifest-boundary.md). Revisit any individual deletion when
a real binding fails to compile without it.
