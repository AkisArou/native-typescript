# scriptc Evolution Policy

Status: normative project policy  
Last revised: 2026-08-25

Native TypeScript builds on scriptc, but scriptc is an active experimental
compiler. Its current limitations are observations about one revision, not the
ceiling of this project or automatically permanent language decisions.

## Principles

- Treat scriptc as a strong foundation and active upstream, not an immutable
  specification.
- Preserve deliberate scriptc invariants when they remain sound, especially
  explicit static coverage and a confined runtime heap.
- Investigate limitations that block real programs or clean target
  architecture.
- Prefer general compiler/runtime capability over target-specific special cases.
- Compare other implementations for evidence, not authority.
- Keep fork changes isolated, tested, reviewable, and upstreamable where useful.
- Continuously remove patches that upstream supersedes.

## Limitation classes

Every relevant limitation is classified before implementation.

### Missing coverage

The semantics are understood and compatible with the architecture, but a
frontend, IR, standard-library, or backend lowering is absent. Examples may
include individual standard-library functions or syntax forms.

Default action: implement generally in scriptc with differential tests.

### Deliberate divergence

Scriptc intentionally chooses behavior different from a JavaScript VM, such as
a representation-driven safety or determinism rule.

Default action: evaluate the rationale against Native TypeScript's language
profile. Preserve, revise, or replace it explicitly; never inherit it silently.

### Architectural constraint

The current compiler or runtime shape makes a feature impossible or invasive,
for example the absence of retained callbacks, a target lowering seam, or
shared-memory threading.

Default action: design the reusable primitive and its invariants first. Do not
patch each target independently.

### Product-scope boundary

The feature is reasonable but outside scriptc's current CLI/server/library
focus, such as application lifecycle integration or a platform package format.

Default action: keep platform composition in Native TypeScript while adding only
the general compiler/runtime hook to scriptc.

### Fundamentally dynamic behavior

The behavior relies on runtime code generation, unrestricted reflection,
mutable prototype shape, or another operation that cannot satisfy the static
profile without a managed dynamic realm.

Default action: diagnose it in AOT-only mode and support it only through an
explicit realm if the product chooses to.

## Investigation record

Every non-trivial limitation receives a record containing:

```text
feature or behavior
real motivating program/test
current scriptc revision and result
classification
required observable semantics
language/IR/runtime implications
reference implementations and findings
chosen decision and rejected alternatives
implementation repository and owner
upstream issue/PR/status
conformance tests
removal or revisit condition
```

Records may begin in an issue and become a focused architecture decision when
the change affects a normative contract. The test case remains in the tree.

Accepted records live in `docs/records/`, numbered in acceptance order. A
record is rationale and archive: it never substitutes for the normative
documents it leads to, which are revised in the implementing change itself.

A record may also produce a normative document rather than revise one, when
the decision describes a contract that does not exist yet.
[0006](records/0006-one-vocabulary-one-owner.md) produced
[the foreign boundary](foreign-boundary.md) that way. The exploration a
document like that distils is not kept beside it: the normative text and the
record between them carry everything that survived review, and git history is
the archive for what did not.

## Reference implementations

Relevant sources include:

- V8/Node for ordinary JavaScript and Node-observable behavior;
- Hermes and Static Hermes for typed/AOT JavaScript implementation choices;
- Porffor for ahead-of-time JavaScript lowering experiments;
- TypeScript for syntax, checker, and emit semantics;
- platform compilers and runtimes for ABI behavior;
- language specifications and official conformance suites.

A reference implementation demonstrates feasibility or behavior; it does not
prove the same design fits scriptc. Hermes can rely on a managed heap and VM
facilities that scriptc intentionally does not have. Porffor may choose a
different compatibility/performance tradeoff. We extract the underlying
semantic requirement and evaluate it against our invariants.

## Decision test

Before accepting a change, answer:

1. Is the behavior required by the TypeScript/JavaScript promise or by a real
   native platform contract?
2. Is it statically representable with defined semantics?
3. Does it improve scriptc generally or only one target?
4. Which layer owns it: language IR, Native IR, runtime, target provider,
   adapter, or framework?
5. Does it weaken static diagnostics, safety, deterministic cleanup, or owner
   confinement?
6. What is the performance cost on programs that do not use it?
7. Can reachability keep optional runtime code link-gated?
8. How will C and LLVM backends remain equivalent where both apply?
9. Which differential or native conformance tests prove it?
10. Is it suitable for upstream scriptc?

## Repository ownership

### Changes in the scriptc fork

The fork owns changes that are reusable independent of a Native TypeScript
platform package:

- language coverage and semantics;
- language and Native IR operations;
- validation and serialization;
- compiler analysis and extension hooks;
- exact scalar and aggregate support;
- handle/callback/scheduler runtime primitives;
- backend implementation;
- coverage diagnostics and conformance infrastructure.

### Changes in this repository

Native TypeScript owns:

- Target SPI composition;
- SCABI schemas and generators;
- platform metadata ingestion;
- platform runtime adapters and generated glue;
- build/artifact orchestration;
- application packaging;
- domain/capability configuration;
- framework renderers and platform SDK distributions.

If code in this repository starts reproducing a compiler invariant across two
targets, move the invariant into the scriptc fork rather than create a shared
workaround layer here.

That rule was written for a shared workaround and it applies to a shared
DECLARATION with equal force. SCABI's schemas and generators are this
repository's; the signature, type, callback, error and thread vocabulary they
speak is not, and stating it here as well as in the compiler is the same
violation with a tidier name.
[0006](records/0006-one-vocabulary-one-owner.md) measures what it cost and
[the foreign boundary](foreign-boundary.md) states the split: the compiler
defines the contract's closed semantics, SCABI derives and proves it.

## Fork discipline

The submodule pins the `native-typescript` branch of the project fork. The fork
keeps upstream history and groups changes into coherent commits.

Each fork commit should:

- solve one architectural capability or logically inseparable set;
- include frontend, IR, validator, backend, runtime, diagnostic, and test
  changes required for completeness;
- avoid branding or assumptions tied only to one Native TypeScript target;
- document compatibility/performance implications;
- remain bisectable;
- reference an upstream issue or explain why the change is project-specific.

The parent repository updates its gitlink only after the fork commit is pushed
and its test suite passes.

### Current upstream baseline

The fork is merged up to `d7b4480e` (v0.0.34) and is zero commits behind.
Which fork commit the workspace pins is the submodule's to say, and naming it
here only creates a second place to be wrong: read it from
`third_party/scriptc`.

Keeping that number at zero is a policy, not housekeeping. A slice measured
against a stale base describes a diff nobody will review, and the merge cost
grows superlinearly with the gap — six upstream commits cost 16 conflicted
files, while #178's restructure of the lowering entry point this fork extends
cost two, precisely because it arrived alone.

On the merged fork, upstream's own FFI suite passes across both backends, and
this project's focused Native IR, retained-callback, callback
table/token/handle, owner-gateway, executable-plan, library-plan,
native-build-executor, native-call-plan, native-manifest, and host
compiler-driver gates pass beside it. The full upstream differential lane
remains a VCR-sandbox gate: an arbitrary host SDK and declaration set is not an
accepted replacement for its pinned image. The fork's whole corpus is NOT a
gate — it carries a large pre-existing baseline of Node-surface refusals that
predate this project.

The two-outbound-path duplication that earlier versions of this document
described as deliberate and temporary is **resolved**. The adjudication landed:
Native IR is the single outbound path, and the outbound FFI subsystem was
deleted rather than kept beside it. `ffiCall` survives only as library mode's
host-callback channel, which is an inbound concern and not a second dialect for
calls leaving TypeScript.

## Upstream policy

Generally useful changes should be proposed upstream early enough for design
feedback. Native TypeScript does not wait indefinitely for acceptance when a
sound capability is required, but it avoids unnecessary divergence.

When upstream implements or replaces a fork capability:

1. evaluate semantics and performance against our conformance tests;
2. adopt the upstream form when it satisfies the architecture;
3. migrate all consumers atomically;
4. remove the superseded fork commits/code where history permits;
5. update the compatibility register.

There is no permanent adapter preserving both old fork and new upstream APIs
before a public compatibility requirement exists.

## Initial compatibility register

This table records known architectural work, not a complete scriptc limitation
list.

| Area                                    | Current classification                                                       | Required direction                                                                                                                                                                                                                                                                                                                                                                                                                                  | Owner                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target provider seam                    | Architectural constraint                                                     | Immutable phase/provider hooks and generic Native IR                                                                                                                                                                                                                                                                                                                                                                                                | scriptc fork + Target SPI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Native IR neutrality                    | Architectural constraint                                                     | Separate language/host concepts from generic native operations                                                                                                                                                                                                                                                                                                                                                                                      | scriptc fork                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| External native materialization         | Compiler-emission and native-driver slices implemented                       | The compiler delegates a schema-versioned path-free IR/emission plan and one immutable complete native-build request; Native TypeScript emits C/LLVM as a cacheable graph action, and ScriptC derives its exact uncached driver plan without fake paths, materialization, or duplicated feature/runtime selection; add explicit vendor producers and complete toolchain identity                                                                    | scriptc fork + Native TypeScript                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Exact native integers                   | Partial systems capability                                                   | Fixed-width and pointer-sized integers, same-type wrapping `+`, `-`, and `*`, exact-width `&`, `                                                                                                                                                                                                                                                                                                                                                    | `, and `^`, exact same-storage `===`/`!==`, all four orderings at the declared width and signedness, trapping division, remainder, and shifts through the same construction form, and named conversions to and from an ordinary number are implemented through frontend, IR, C/LLVM, and ABI; nominal flags comparison and typed `combine(Vertical, Horizontal) == BothAxes` are real package gates; add unary operations, width-to-width conversions, and the checked/saturating/wrapping helper families only with defined exact-width semantics | scriptc fork         |
| Exact native floats                     | First f64 direct/aggregate slice implemented                                 | Branded `f64` values pass as fields and standalone parameters/results through C/LLVM; a binding may instead declare the JavaScript-number conversion, which for a double slot is the identity and is what GIR's `gdouble` now uses, so the branded form remains for manifests that want a nominal double; define the rounding-operation family before adding general exact-float arithmetic and add `f32` only with explicit per-operation rounding | scriptc fork                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Native structs/by-value ABI             | Nested direct/expanded/indirect slice implemented                            | Authoritative nominal layout, transitively closed nested nominal fields, and target-Clang physical signatures lower through C/LLVM for direct registers, expanded values, plain indirect pointers, `byval`, and `sret`; generated caller-allocated GTK record outputs normalize to one proven nested value return; add unions, remaining pointer/inout families, and non-trivial values as real bindings require                                    | scriptc fork + SCABI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Native C strings                        | Bidirectional borrowed slice implemented                                     | SCABI distinguishes explicit byte spans from implicit-length NUL strings; required and nullable inputs borrow terminated runtime storage, reject embedded NUL on string arms, and map null arms to `NULL`, while receiver-borrowed const results are copied into managed `string`/`string                                                                                                                                                           | null` values before receiver release in C and LLVM; add transcoding, owned native strings, and retained input modes only when a binding requires them                                                                                                                                                                                                                                                                                                                                                                                              | scriptc fork + SCABI |
| TypeScript-to-C exports                 | First exact-scalar slice implemented                                         | Explicit SCABI export roots resolve checked entry functions and emit exact C/LLVM wrappers; add broader ABI families and artifact-graph realization of declared adapters/products                                                                                                                                                                                                                                                                   | scriptc fork + Native TypeScript                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Retained callbacks                      | First exact-scalar slice implemented                                         | SCABI/Native IR, generated C/LLVM copied-payload thunks, rooted owner invocation, transactional result-handle cancellation, one-event dispatch, microtask checkpoints, and executable attached-loop liveness are implemented; add broader payload/lifetime families and additional target-loop providers                                                                                                                                            | scriptc fork + target runtime                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Foreign-thread callbacks                | First end-to-end slice implemented                                           | Arbitrary attached producers admit exact-scalar copies through opaque tokens without heap access; owner delivery, exception fencing, cancellation races, explicit shutdown, and the GLib wake adapter pass threaded, sanitizer, and real GTK gates; add richer transport-safe values and more target adapters                                                                                                                                       | scriptc fork + target runtime                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Weak native references                  | Product-scope boundary, deferred with a trigger                              | No introspectable GNOME member declares one and GObject's refcounting means none is needed; a weak lifetime DOMAIN with a fallible upgrade arrives with the first platform that has one, which is JNI                                                                                                                                                                                                                                              | scriptc fork + binding families                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Owned native returns                    | First slice implemented                                                      | Nominal runtime cells, checked borrowed calls, and exact-once SCABI destruction are implemented through C/LLVM; add retained, weak, invalidation, and executor-aware release modes as bindings require them                                                                                                                                                                                                                                         | scriptc fork + SCABI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Native handle hierarchy                 | Identity-upcast slice implemented                                            | SCABI and Native IR declare validated representation-preserving edges; frontend coercion and C/LLVM runtime tags preserve one managed cell across transitive derived-to-base calls, with generated GTK Widget ancestry as the real gate; add adapter-backed adjusted/query conversions only for native systems that require them                                                                                                                    | scriptc fork + SCABI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Native declaration projection           | Constructors, properties, named constants, and flags composition implemented | External native declarations lower canonical `new Class()` construction, named static factories, getter/setter properties, exact enum/flags members, and variadic typed flags combination without materializing runtime class or namespace objects; add broader declaration forms only from authoritative binding semantics                                                                                                                         | scriptc fork + binding generators                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Receiver-owned callbacks                | First collectible lifecycle slice implemented                                | Receiver-owned handle families are selectively collector-traced; transactional owner-to-registration-to-closure edges, non-owning cancellation capabilities, native invalidation, early cancellation, cycle collection, shutdown, and real GTK signal gates pass C, LLVM, ASan, and TSan; broaden lifetime and payload families only from real target requirements                                                                                  | scriptc fork + SCABI + target runtime                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Native booleans                         | Exact parameter/result storage projection implemented                        | SCABI boolean storage and false/true representations lower to ordinary TypeScript `boolean` in C/LLVM; parameters select the exact declared native representation, while invalid native results throw catchably and participate in transitive may-throw analysis; add non-integer platform representations only when a binding requires them                                                                                                        | scriptc fork + SCABI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Native vocabulary ownership             | Architectural constraint                                                     | The compiler is the semantic owner of the signature/type/callback/error/thread vocabulary and publishes it as one committed pure-type module plus a JSON Schema; SCABI imports it and keeps only identity, the build graph, composition, and evidence. 24 of 37 native IR types currently have a same-named twin in this repository, which is what the unification deletes                                                                                                          | scriptc fork + SCABI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Foreign boundary effects                | Architectural constraint                                                     | Five closed dimensions — call target, execution context, resource protocol, outcome protocol, call effects — lowered by one backend-neutral legalizer, with exact ABI mechanics in generated verified capsules and platform metadata in SCABI; each dimension admitted only by a program that needs it                                                                                                                                                                                | scriptc fork + binding families                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Shared-memory threads                   | Deliberate/runtime constraint                                                | Preserve heap confinement; use multiple instances and explicit transport                                                                                                                                                                                                                                                                                                                                                                            | architecture                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Common standard-library gaps            | Missing coverage, case-by-case                                               | Implement when semantics are sound and real programs require them                                                                                                                                                                                                                                                                                                                                                                                   | scriptc fork                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Dynamic function patterns used by React | Investigated against pinned React 19.2.8                                     | Nine documented source transforms carry React's element API to native execution; the residue is three named compiler items — a symbol arm for the checked-dynamic tree, `switch` over a dynamic discriminant, and `.call` on a callee that provably ignores `this` — recorded with their minimal fixtures in record 0058                                                                                                                            | scriptc fork/framework                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| React reconciler                        | Compatibility program                                                        | Pinned static and behavioral gate before renderer support                                                                                                                                                                                                                                                                                                                                                                                           | Native TypeScript                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Mobile executable lifecycle             | Product-scope boundary                                                       | Hosted runtime/application targets using platform toolchains                                                                                                                                                                                                                                                                                                                                                                                        | Native TypeScript                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Direct Blink projection                 | Research/architectural risk                                                  | Isolated feasibility gate without contaminating core contracts                                                                                                                                                                                                                                                                                                                                                                                      | Native TypeScript                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

The register belongs in the active architecture and must be updated when a row's
classification or owner changes.

## React compatibility workflow

React is a useful stress test because it exercises closures, function values,
hoisting, symbols, scheduling, errors, and dynamic-looking but often statically
resolvable patterns.

For a pinned React/reconciler revision:

1. capture static coverage with stable diagnostics;
2. reduce every reachable fence to a minimal fixture;
3. classify the fixture under this policy;
4. implement general scriptc support where sound;
5. use a documented preprocessing transform only when upstream distribution
   syntax obscures semantics already representable by the compiler;
6. maintain a framework compatibility patch only as a last resort;
7. run behavioral tests against the reference React build.

Coverage percentage is tracked, but the gate is zero reachable unexplained
fences plus behavioral conformance for the promised surface.

## No compatibility debris

Before 1.0, refactors in either repository:

- replace old internal APIs in one coordinated change;
- delete old code paths and tests;
- reject stale IR/manifests/caches by version;
- avoid flags whose only purpose is selecting the previous architecture;
- avoid wrappers that merely rename the new interface to the old one;
- preserve behavior only when it is part of the documented language or public
  native contract.

Clean code does not mean avoiding migrations. It means completing them.

## Upstreaming

The fork is not a vendor patch. Measured against `d7b4480e` (v0.0.34), which it
is merged up to, it is **152 commits and roughly 32,400 changed lines**, of
which about 13,600 are tests. Line count overstates the risk badly, and the
breakdown is the argument: **20,300 of the insertions are in 118 files that do
not exist upstream**, and only about **2,500 lines of upstream's own code are
replaced**.

The divergence is ADDITIVE — new files and new paths beside existing ones
rather than rewrites — and the merges are the evidence rather than the claim.
Upstream's six library-caching commits cost 16 conflicted files and 31 hunks.
#178's reachability rework, which restructured the very lowering entry point
this fork threads its Native IR input through, cost exactly two conflicts.

That property is worth protecting deliberately, because the work most likely to
destroy it is work this project wants: a backend-neutral foreign-boundary
legalizer rewrites both emitters, which are the two files with the largest
overlap. **Merge before restructuring, not after.**

### What is upstreamable

Each slice below is a generic compiler or runtime capability with no GTK, JNI,
Android, or Cocoa knowledge in it. Commit counts come from classifying all 152,
not from estimating.

| Slice | Commits | Why it is generic |
| --- | --- | --- |
| Embedder plans and external build execution | 16 | Serializable, path-free compilation plans and a seam that hands an embedder the exact driver commands. No semantics at all. |
| Exact native scalars and arithmetic | 29 | Exact integer widths, target-sized integers, 32-bit floats, bigint, and the operations an operator cannot carry. Language capability. |
| Native aggregates | 4 | Structs by value, nested aggregates, exact aggregate ABI signatures. |
| Strings and byte views | 18 | Borrowed UTF-8, checked C strings, C-string vectors, byte spans with explicit element and unit denomination. |
| Native handles and ownership | 16 | Opaque handles, nullable handles, identity upcasts, pointer-keyed interning, transfer, use-after-dispose. |
| Outcome contracts | 6 | Errno, error-object failure, and the reduction of eleven conventions to three questions. |
| Callbacks | 28 | Call-scoped and retained registrations, owner gateway, transport tokens, answered and queued arms, foreign-thread ingress. The largest slice. |
| Shared boundary decisions | 4 | One module deciding what a foreign call's arguments, result, failure and shape become, so both backends stop deciding it twice. |
| Native manifest contract | 3 | The declaration file an embedder writes against: no imports, no runtime value, so a consumer needs no build of the compiler. |

That is 124 of 152 commits. The remaining 28 are upstream merges, housekeeping,
fixture scoping, and fixes to this fork's own code.

### What stays in the fork

Deleting the outbound FFI subsystem is a fork-only simplification. Upstream
still ships FFI; this project routes every outbound call through Native IR and
removed the second path. Upstream would be right to refuse it, and the merge
has already shown the cost — a conflict where upstream's code calls a function
this fork deleted. Fork housekeeping (fixture scoping, artifact untracking)
likewise stays.

### What upstreaming would actually buy

Ranked by value to this project rather than by size, because the two orderings
disagree and the disagreement is the useful part.

**Shared boundary decisions and the manifest contract first (7 commits).** They
are tiny, and they are the VOCABULARY every other slice is written in. If they
land, each later slice becomes additive against an upstream that already speaks
the language instead of introducing it.

**Exact scalars second (29).** The largest single removable chunk of the diff,
and it touches nothing upstream is currently working in.

**Embedder plans last, despite being the obvious opener.** Two facts overturned
the original ordering. It touches `compileLibrary`, which is exactly where
upstream spent the week of 2026-08-17. And most of it lives in files upstream
does not have, so it is among the CHEAPEST slices to keep forked — its
footprint in upstream's own code is `cc.ts` and part of `index.ts`.

The general form: what is expensive to keep forked is not what is big, but what
sits inside upstream's files. Upstream has no `nativeCall` lowering at all, so
roughly 3,600 of this fork's lines live inside upstream's two emitters. That is
the merge cost, and no single slice removes it — the legalizer does, by moving
that lowering into this fork's own modules, which is why it is a merge-cost
decision as much as a correctness one.

Un-forking was never available. Even the whole list landing leaves this project
needing a fork until Native IR itself is upstream, which is not a proposal
anyone should make. The goal is a lower merge tax, not zero.

### PR strategy

The slices are DEPENDENT: handles need scalars, callbacks need handles and
outcomes. That dependency is real and should be visible rather than flattened
into one unreviewable change or hidden by proposing slices that secretly
require each other.

A stacked pull request expresses it directly — each PR targets the previous
one rather than `main`:

```text
upstream/main
  └── scriptc/embedder-plans
        └── scriptc/exact-native-scalars
              └── scriptc/native-aggregates
                    └── scriptc/strings-and-byte-views
                          └── scriptc/native-handles
                                └── scriptc/outcome-contracts
                                      └── scriptc/callbacks
```

Each PR then shows only its own diff, reviews independently, and merges in
order. What makes this suit this project specifically is that every slice
already carries its own fixtures and its own C/LLVM parity coverage, so a
reviewer can take one and stop.

The costs are real and worth stating. A stack must be rebased whenever
upstream moves, and every rebase touches every branch above the change. A PR
whose base branch is deleted on merge silently retargets to the default
branch and starts showing a cumulative diff. Both argue for keeping the stack
SHORT — propose the first two or three, land them, then restack the rest
rather than opening seven at once.

**Asked before proposing.** [vercel-labs/scriptc#185](https://github.com/vercel-labs/scriptc/issues/185)
describes the fork's shape and asks which slices, if any, are wanted, rather
than opening a stack nobody requested. There was no cheaper opening available:
this fork holds no standalone upstream bugfix to lead with. Every small change
to upstream's files here is a consequence of this project's own work, the
manifest contract is this fork's file rather than upstream's, and the one
backend divergence found was introduced here — upstream spells that predicate
identically in both emitters.

Nothing is proposed until that question is answered.
