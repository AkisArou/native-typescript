# Native TypeScript

Native TypeScript is an attempt to make TypeScript a practical native systems
and application language without turning it into a framework-specific dialect.
It builds on [scriptc](https://github.com/vercel-labs/scriptc) and extends its
static compiler, runtime, and native ABI so TypeScript can target native
libraries, operating-system APIs, native UI toolkits, mobile applications,
React renderers, and—if the engineering proves viable—the browser DOM.

The project is in early implementation. Its first production seam validates
compiler and provider capabilities and freezes target composition before any
compiler or platform work begins.

## Direction

```text
TypeScript source graph
        ↓
ScriptC language frontend and typed language IR
        ↓
reachability, effects, ownership, and partition analysis
        ↓
target-independent native IR
        ↓
target lowering + generated adapters + resources
        ↓
reproducible artifact graph
        ↓
native executable, library, application, or runtime image
```

React is a library and renderer integration, not the architecture's lowest
layer. Android, Apple, GTK, Windows, C, POSIX, and future targets remain
directly accessible. A JavaScript engine may be selected as an explicit
compatibility realm, but is never introduced silently.

## Non-negotiable properties

- Static compilation is the default and unsupported behavior fails precisely.
- Source uses ordinary `.ts` and `.tsx` syntax under a documented static
  language profile.
- Native calls, ownership, callback lifetime, thread affinity, and process
  affinity are compiler-visible.
- Each ScriptC runtime instance has one owner executor; foreign threads enter
  through a checked scheduler gateway and never touch its heap directly.
- Native resources are opaque, generation-checked handles. Raw pointers are an
  explicit unsafe capability and never cross process boundaries.
- Targets contribute bindings, lowering, runtime integration, and packaging
  through separate contracts rather than compiler-wide special cases.
- Builds produce a deterministic artifact graph and report static coverage,
  native boundaries, capabilities, generated code, and dynamic realms.
- Security authority is explicitly granted. Reachability can minimize
  authority, but cannot grant it.
- Before 1.0, refactors replace old internal contracts atomically. The project
  does not accumulate deprecated aliases, legacy readers, or compatibility
  layers for unpublished architecture.

## Architecture documents

These documents are normative for implementation:

- [Architecture](docs/architecture.md) defines the system boundaries,
  invariants, and ownership of each layer.
- [Language profile](docs/language-profile.md) defines what it means to compile
  TypeScript statically and how native types extend the type world.
- [Target SPI](docs/target-spi.md) defines how targets participate without
  becoming compiler forks.
- [Binding ABI](docs/binding-abi.md) defines the versioned SCABI package and its
  validation rules.
- [Runtime and threading](docs/runtime-and-threading.md) defines runtime
  instances, scheduling, callbacks, shutdown, and error boundaries.
- [Ownership](docs/ownership.md) defines native handles, borrows, retention,
  identity, disposal, and unsafe pointers.
- [Partitions and capabilities](docs/partitions-and-capabilities.md) defines
  process domains, transport-safe values, remote handles, and authorization.
- [Build artifacts](docs/build-artifacts.md) defines planning, caching,
  generated adapters, SDKs, and reproducibility.
- [scriptc evolution](docs/scriptc-evolution.md) defines how current scriptc
  limitations are investigated, changed, tested, and proposed upstream.
- [Roadmap](docs/roadmap.md) defines permanent vertical slices and their exit
  gates.

When documents conflict, [Architecture](docs/architecture.md) owns system
invariants. The focused specification owns details in its domain. A conflict
must be resolved in the documents before implementation proceeds.

## Repository layout

```text
packages/
├── cli/          command-line entry point
├── core/         build planning and orchestration
├── scabi/        native binding schema, canonicalization, and validation
├── scriptc/      integration with the pinned scriptc fork
└── target-api/   target-provider contracts

third_party/
└── scriptc/      pinned fork as a Git submodule

docs/             normative architecture and development documentation
fixtures/         permanent native ABI and conformance fixtures
tests/            workspace-level tests
```

The package layout is internal until a public release. It may be changed
atomically when the architecture requires a cleaner boundary.

## Development

See [Development](docs/development.md) for prerequisites, workspace commands,
and the scriptc fork workflow.

```bash
corepack enable pnpm
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

## Status

The repository is not yet an application framework or production compiler.
Capability-aware target planning, the SCABI v1 core manifest/C conformance
fixture, and the first ScriptC Native IR slice are implemented. That compiler
slice translates reached SCABI bindings into a manifest-neutral compiler input,
recognizes exact TypeScript declaration symbols, and lowers signed and unsigned
8-, 16-, 32-, 64-, and target-pointer-width integer literals and calls through
both C and LLVM without a JavaScript-number carrier. Fixed 64-bit and
`isize`/`usize` source boundaries accept only exact BigInt literals or values
already carrying that native type; pointer-sized ranges come from SCABI target
metadata and are checked against the selected backend. This does not claim
general JavaScript BigInt support. The same permanent path now supports nominal,
default-packed, trivially copyable native structs whose fields are exact scalars
and whose SCABI metadata explicitly selects indirect by-value passing. A direct
object-literal assertion constructs aggregate storage without reinterpreting a
JavaScript object; C verifies size, alignment, and offsets at compile time, while
LLVM emits the target's `byval`/`sret` contract. The padded-struct fixture passes
through both backends, including statically typed field reads from returned
values. Owned, owner-confined opaque handles now use a runtime-private managed
cell with alias-safe explicit disposal, automatic exact destruction, and
checked borrowed method ingress. Borrowed UTF-8 input is also implemented as
one source string evaluated once and projected without copying into const data
and byte-length ABI slots; Unicode and embedded NUL behavior passes both
backends. Borrowed `Uint8Array` input follows the same logical-to-physical
projection path without copying. Exact view offsets and lengths, live
backing-store mutation, single evaluation, and prompt post-call release pass
both backends and the sanitizer/RC audit. Foreign pointers remain ABI-only and
cannot enter TypeScript values. Synchronous call-scoped callbacks are also
implemented for non-variadic C signatures with exact scalar parameters/results
and a required trailing context pointer. One source closure is projected into
the physical function/context pair; captures, reentrancy, and callback
exceptions pass both backends and the sanitizer/RC audit. Retained callbacks,
broader ownership modes, and owner-thread scheduling come next. The ScriptC
fork now also has the standalone foreign-thread ingress foundation: an
instance-owned, target-wakeable MPSC gateway with bounded FIFO drains, explicit
shutdown states, and exact event destruction under admission races. It is
threaded and sanitizer-tested. Retained callback transport tokens now build on
that queue with slot/generation identity and one combined atomic
state/invocation-lease word, so close and admission have an exact order and
every admitted event remains owned through delivery or discard. The
owner-side table now roots active registration anchors explicitly and retires
them only after cancellation and all leases complete. Owned native handles now
carry generic lifecycle edges, and a result-owned callback edge closes
admission before the native destructor and completes cancellation only after it
returns. Generated retained-callback lowering and the target event-loop
connection remain pending. Only reached bindings and native types enter emitted
IR or the link.
Platform UI and framework work begins only after those contracts pass their
conformance gates.
