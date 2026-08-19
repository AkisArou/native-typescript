# 0006 — One vocabulary, one owner

Status: accepted decision, implementation not started
Last revised: 2026-08-19

This is an investigation record under the policy in
[scriptc evolution](../scriptc-evolution.md). It records why the native
vocabulary is declared in two repositories, what that has cost, why the
foreign-boundary design is adopted now rather than later, and what order the
remaining work runs in. It is not normative;
[the foreign boundary](../foreign-boundary.md) is the document it produces.

It supersedes the ordering in
[0001](0001-native-manifest-boundary.md), which is revised in the same change.

## Feature or behavior

There is one native vocabulary and two declarations of it. The compiler
declares it as Native IR; the parent declares it again as SCABI plus a
translator, and the two are kept in agreement by review.

## Real motivating program/test

Not a program — a measurement, and one this repository walked into with its
eyes open.

| Where | File | Lines |
| --- | --- | --- |
| Parent | `packages/scriptc/src/native.ts` | 3,568 |
| Parent | `packages/scabi/src/validation.ts` | 2,105 |
| Parent | `packages/scabi/src/scabi-v3.schema.json` | 1,916 |
| Parent | `packages/scabi/src/model.ts` | 554 |
| Fork | `packages/compiler/src/ir/nodes.ts` | (native section) |
| Fork | `packages/compiler/src/ir/validate.ts` | (native section) |

**24 of the fork's 37 `IrNative*` types have a same-named twin** among the
parent's 38 `ScriptCNative*` types: `AbiType`, `Binding`, `CallbackContract`,
`CallbackSignature`, `ErrorContract`, `FailureDetection`, `ParameterProjection`,
`ResultProjection`, and sixteen more. `native.ts` says so out loud in two
places — *"Mirrors the compiler's contract exactly."*

The most recent instance is the clearest, because it was added deliberately
and defended in a commit message. Landing the error-out contract required one
predicate — *does this failure contract read the call's own result?* — and it
was written twice:

```ts
// packages/scabi/src/model.ts
export function errorContractReadsResult(error: ErrorContract): boolean {
  return error.kind !== "no-fail" && error.kind !== "error-out";
}
```
```ts
// third_party/scriptc/packages/compiler/src/ir/nodes.ts
export function nativeFailureReadsResult(detect: IrNativeFailureDetection): boolean {
  return detect.kind !== "never" && detect.kind !== "outParameterIsNotNull";
}
```

The commit called this "naming the question once on each side of the
manifest". Once per side is twice.

## Current scriptc revision and result

Measured at fork `3763c41c`, parent `9f2a5f0`. Both trees green; nothing is
broken by the duplication, which is exactly what makes it survivable and
therefore dangerous.

## Classification

**Architectural constraint**, and the same one
[0004](0004-one-decision-two-backends.md) already measured one level down.

That record found five defects in this repository's history, every one of them
a decision made in the C backend and not the LLVM one, and drew the
conclusion: *the number of places a decision can be made is the number of
places it can be made differently, and the measured defect rate is what that
costs.*

The finding generalizes without modification. Two backends became two places
to lower a decision; two repositories are two places to **declare** it. The
defect shape is identical — *changed one, forgot the other* — and it is worse
here for two reasons. A backend divergence usually fails to build; a
vocabulary divergence typechecks on both sides and fails at a manifest
boundary, or does not fail at all. And every capability added from here
arrives twice: a type in two repositories, a validator in two repositories,
diagnostics in two repositories.

## Required observable semantics

None for a running program. The whole change is required to be
observationally inert, which is the property that makes a refactor of this
size verifiable at all — the same requirement 0004's slices were held to.

What changes is where a fact is allowed to be stated:

- **The compiler is the semantic owner** of the signature, type, callback,
  error and thread vocabulary. It declares it once and validates it once.
- **SCABI derives and proves.** It keeps package, target, SDK and generator
  identity; the build graph (link inputs, adapter inputs, permissions);
  composition (type imports, dependencies, availability); evidence and
  digests. It states nothing about what the compiler emits.
- **The translator stops translating.** `packages/scriptc/src/native.ts`
  collapses from a vocabulary mirror to a planner: verify the envelope, prune
  by availability, compose imports, hand over.

The test is [0001](0001-native-manifest-boundary.md)'s, unchanged: *a fact
belongs to the compiler iff it changes the machine code emitted; it belongs to
SCABI iff it only changes what gets built, linked, composed, or proven.*

## Language/IR/runtime implications

None to the IR. The vocabulary already exists in the compiler; what is missing
is that it is **published** — a committed, pure-type, import-free, erasable
module the parent may import type-only by source path, plus the same format as
a JSON Schema for non-TypeScript consumers. 0001 specifies this and it is
unchanged: present on a clean checkout, erased at runtime, no build required,
one definition compiler-checked on both sides of the submodule boundary.

The submodule constraint is what produced the mirror, and it is real: the
parent may not import the fork's `dist`, because that would make a clean
checkout fail to typecheck before anything is built. A committed type module
satisfies the constraint without paying for it twice.

## Chosen decision and rejected alternatives

**Chosen.** Adopt [the foreign boundary](../foreign-boundary.md) as normative
direction, and reorder the remaining work so the single vocabulary comes
first.

The reorder is the substance. 0001 sequenced the committed type module as step
8 of 9, on the reasoning that steps 3 through 7 each shrink a parallel path
and the module records the result. That reasoning holds for a plan whose
remaining steps are small. It stopped holding when the foreign-boundary design
was adopted, because every dimension that design adds is cross-cutting, and a
cross-cutting capability added before the vocabulary is unified is added twice
by construction.

The exploration this document replaces said the same thing in its own
sequencing and was not followed: its step 1 is *"finish manifest unification —
one clearly versioned compiler-consumed boundary contract, derived by SCABI"*,
and this project implemented its steps 3 and 4 first. Records 0004 and 0005
are those steps. They are good work and they are out of order, and the order
is why the predicate above had to be written twice.

**Rejected.**

- *Leave it, since nothing is blocked.* Nothing is, and that is the wrong
  test. The cost is not a blocked feature, it is a tax on every future one,
  compounding exactly as the two-backend duplication did until 0004 measured
  it. Applying a rule one level down and declining it one level up is not a
  position.
- *Adopt the foreign-boundary design wholesale as a build plan.* Its own
  admission rule forbids this, and its own risk register names the failure:
  the five-dimension contract adopted eagerly recreates the
  51-declared/23-lowered amputation of
  [0003](0003-vocabulary-narrowing.md). The design is a horizon and a shape to
  build into, not a backlog.
- *Unify by generating one side from the other.* A generator has to model both
  vocabularies to emit either, which is the shared module with extra steps and
  a build dependency the submodule boundary forbids.
- *Do the legalizer first.* It is the more visible architectural win and it is
  second, not first. A legalizer built over a vocabulary declared twice is a
  single lowering fed by two disagreeing declarations, which moves the seam
  without closing it.

### The contradiction this resolves

The exploration document argued both that the outcome protocol "ships whole"
and that no dimension is admitted ahead of a real failing program. Those
cannot both govern, and
[CLAUDE.md](../../CLAUDE.md) requires the conflict be resolved in the
documents before implementation proceeds; it was not, and 0005 implemented
against one side of it while recording the disagreement.

Resolved in favour of the admission rule, on this repository's own evidence:
0005's single detection arm was not redesigned, it was extended, and the
extension was found because a real binding exercised the arm. The concern
underneath "ships whole" is foreclosure, and it is answered by a weaker,
truer rule now stated in the normative document — **a dimension is designed
whole before its first slice ships, and then shipped by slices.**

## Implementation repository and owner

Both repositories; owner: project maintainer. Ordered so each change is atomic,
green on its own, and bisectable.

1. **Publish the vocabulary.** The fork commits the pure-type module and the
   JSON Schema, with a fork test asserting mutual assignability with
   `NativeFrontendInput`. Nothing consumes it yet; the fork is unchanged
   behaviourally.
2. **Consume it.** The parent imports it type-only by source path and deletes
   its mirror. `native.ts` collapses to a planner. Observationally inert, and
   the parent's 182 gates plus the fork's suites are the proof.
3. **Move the rules.** Roughly 1,600 lines of `validation.ts` — layout, sizes
   and alignment, canonical integer values, handle upcasts, type references,
   position ownership, destructor arity, conversion admissibility,
   marshalling, callback admissibility, binding rules — move to the compiler,
   where the lowering they describe lives. Roughly 540 stay: type imports,
   dependency and unique-input checks, composition semantics, envelope entry
   points.
4. **Fold the envelope.** SCABI v4, `entry.kind` deleted, physical paths out
   of the manifest entirely, fixtures regenerated, and
   [architecture](../architecture.md) and [binding ABI](../binding-abi.md)
   rewritten in the same change.
5. **Then the legalizer**, and then the dimensions, each carried by a program
   that needs it.

Steps 1 and 2 are where the duplication dies. Steps 3 and 4 are where the
boundary becomes the one 0001 describes.

## Upstream issue/PR/status

None filed. The published vocabulary and the schema are neutral compiler
capability and are the form in which the rest of this fork becomes proposable
at all — a format version is reviewable where an embedder seam is an argument.
Nothing is proposed until the local work is complete.

## Conformance tests

- A fork test asserting the committed module and `NativeFrontendInput` are
  mutually assignable. This is the whole guarantee: if it compiles, the two
  sides cannot have diverged.
- The parent's full gate and the fork's conformance suites unchanged across
  every step, since the change is observationally inert.
- The manifest parse and validate fixtures ported into the compiler *before*
  the parent's are deleted, with their diagnostics preserved by code and
  message.

## Removal or revisit condition

Superseded when step 4 lands and the normative documents carry the boundary;
this record then remains as rationale. Revisit sooner if the adapter-plus-LTO
falsifier shows that generated adapters plus link-time optimization already
achieve what the compiler-side dimensions propose — that would not change the
vocabulary work, which is owed regardless, but it would shrink what steps 5
and later have to build.
