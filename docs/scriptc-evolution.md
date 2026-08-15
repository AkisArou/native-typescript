# scriptc Evolution Policy

Status: normative project policy  
Last revised: 2026-08-15

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

| Area | Current classification | Required direction | Owner |
| --- | --- | --- | --- |
| Target provider seam | Architectural constraint | Immutable phase/provider hooks and generic Native IR | scriptc fork + Target SPI |
| Native IR neutrality | Architectural constraint | Separate language/host concepts from generic native operations | scriptc fork |
| External native materialization | Compiler-emission and native-driver slices implemented | The compiler delegates a schema-versioned path-free IR/emission plan and one immutable complete native-build request; Native TypeScript emits C/LLVM as a cacheable graph action, and the C driver exposes its exact uncached invocation without duplicating feature/runtime selection; add explicit vendor producers and complete toolchain identity | scriptc fork + Native TypeScript |
| Exact native integers | Partial systems capability | Fixed-width and pointer-sized integers plus same-type wrapping `+`, `-`, and `*` are implemented through frontend, IR, C/LLVM, and ABI; generated GTK `gint` input/output is a real package gate; add the remaining arithmetic, bitwise, comparison, and explicit conversion families | scriptc fork |
| Exact native floats | First f64 direct/aggregate slice implemented | Branded `f64` values pass as fields and standalone parameters/results through C/LLVM, with generated GTK `gdouble` opacity as the real package gate; define the rounding-operation family before adding general exact-float arithmetic and add `f32` only with explicit per-operation rounding | scriptc fork |
| Native structs/by-value ABI | First slice implemented | Authoritative nominal layout plus indirect `byval`/`sret` lowering is implemented; add direct aggregate classifications, nested aggregates, and unions as authoritative target facts require | scriptc fork + SCABI |
| Native C strings | Bidirectional borrowed slice implemented | SCABI distinguishes explicit byte spans from implicit-length NUL strings; inputs borrow terminated runtime storage and reject embedded NUL, while receiver-borrowed const results are copied into managed `string`/`string | null` values before receiver release in C and LLVM; add transcoding, owned native strings, and retained input modes only when a binding requires them | scriptc fork + SCABI |
| TypeScript-to-C exports | First exact-scalar slice implemented | Explicit SCABI export roots resolve checked entry functions and emit exact C/LLVM wrappers; add broader ABI families and artifact-graph realization of declared adapters/products | scriptc fork + Native TypeScript |
| Retained callbacks | First exact-scalar slice implemented | SCABI/Native IR, generated C/LLVM copied-payload thunks, rooted owner invocation, transactional result-handle cancellation, one-event dispatch, microtask checkpoints, and executable attached-loop liveness are implemented; add broader payload/lifetime families and additional target-loop providers | scriptc fork + target runtime |
| Foreign-thread callbacks | First end-to-end slice implemented | Arbitrary attached producers admit exact-scalar copies through opaque tokens without heap access; owner delivery, exception fencing, cancellation races, explicit shutdown, and the GLib wake adapter pass threaded, sanitizer, and real GTK gates; add richer transport-safe values and more target adapters | scriptc fork + target runtime |
| Owned native returns | First slice implemented | Nominal runtime cells, checked borrowed calls, and exact-once SCABI destruction are implemented through C/LLVM; add retained, weak, invalidation, and executor-aware release modes as bindings require them | scriptc fork + SCABI |
| Native handle hierarchy | Identity-upcast slice implemented | SCABI and Native IR declare validated representation-preserving edges; frontend coercion and C/LLVM runtime tags preserve one managed cell across transitive derived-to-base calls, with generated GTK Widget ancestry as the real gate; add adapter-backed adjusted/query conversions only for native systems that require them | scriptc fork + SCABI |
| Native booleans | Exact parameter/result storage projection implemented | SCABI boolean storage and false/true representations lower to ordinary TypeScript `boolean` in C/LLVM; parameters select the exact declared native representation, while invalid native results throw catchably and participate in transitive may-throw analysis; add non-integer platform representations only when a binding requires them | scriptc fork + SCABI |
| Shared-memory threads | Deliberate/runtime constraint | Preserve heap confinement; use multiple instances and explicit transport | architecture |
| Common standard-library gaps | Missing coverage, case-by-case | Implement when semantics are sound and real programs require them | scriptc fork |
| Dynamic function patterns used by React | Mixed; investigation required | Classify each pattern, implement general semantics or explicit transform | scriptc fork/framework |
| React reconciler | Compatibility program | Pinned static and behavioral gate before renderer support | Native TypeScript |
| Mobile executable lifecycle | Product-scope boundary | Hosted runtime/application targets using platform toolchains | Native TypeScript |
| Direct Blink projection | Research/architectural risk | Isolated feasibility gate without contaminating core contracts | Native TypeScript |

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
