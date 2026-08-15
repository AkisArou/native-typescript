# Binding ABI

Status: normative; core SCABI v1 model and C fixture implemented  
Last revised: 2026-08-14

SCABI is the declarative boundary between TypeScript declarations, native ABI
facts, generated adapters, and target lowering. A SCABI package contains data,
not executable compiler plugins.

## Package shape

```text
binding-package/
├── package.json
├── package.d.ts
├── package.scabi.json
├── adapters/
│   └── generated target sources or objects
├── provenance/
│   └── generation and SDK records
└── licenses/
```

`package.d.ts` owns the source-level type experience. `package.scabi.json` owns
the native contract. The compiler verifies that declarations and binding
records agree for every reachable export.

Native type IDs are manifest-local ABI identities, not source names. The
declaration contract therefore maps projected native types to exact exported
TypeScript declaration identities; the compiler never assumes that a type ID
and an alias happen to share a spelling.

Generated adapters may be stored in the package or produced as build artifacts.
Their provenance and exact inputs are always recorded.

## Manifest properties

The manifest is:

- UTF-8 JSON in a canonical serialization;
- immutable during a build;
- schema-versioned;
- target- and SDK-specific;
- free of executable expressions and host-dependent paths;
- validated before source lowering consumes a binding;
- content-addressable.

An invalid or incompatible manifest is a build error. The compiler does not
guess ABI details from TypeScript declarations.

## Top-level identity

Conceptually, every manifest contains:

```ts
interface ScabiManifest {
  readonly schema: "native-typescript.scabi";
  readonly schemaVersion: 1;
  readonly package: PackageIdentity;
  readonly target: TargetIdentity;
  readonly sdk: SdkIdentity;
  readonly generator: GeneratorIdentity;
  readonly declarations: {
    readonly digest: string;
    readonly types: Readonly<Record<string, DeclarationReference>>;
  };
  readonly types: Readonly<Record<string, NativeType>>;
  readonly bindings: Readonly<Record<string, NativeBinding>>;
  readonly linkInputs: readonly LinkInput[];
  readonly adapterInputs: readonly AdapterInput[];
  readonly permissions: readonly PermissionRequirement[];
  readonly platform?: Readonly<Record<string, unknown>>;
}
```

The actual JSON schema will use closed objects and tagged unions. Unknown keys
are rejected unless they occur in a versioned target-specific extension owned
by the selected binding family.

### Package identity

Package identity records name, version, export namespace, and a stable package
instance identifier. Two physical packages with different contents cannot
claim the same instance identity within one build.

### Target identity

Target identity includes the normalized target triple, architecture, pointer
width, endianness, object format, minimum platform version, ABI family, and
relevant feature flags.

### SDK identity

SDK identity contains:

- vendor and SDK name;
- exact SDK/platform version;
- headers, metadata, or framework digest;
- toolchain ABI identity;
- deployment target;
- optional framework/module identities.

A binding generated for one SDK may be reused only when its declared
compatibility rule accepts the selected SDK. Exact matching is the default.

### Generator identity

Generation records the generator name, version, source revision, normalized
arguments, and input digests. Generator upgrades invalidate derived bindings
unless they prove byte-identical output.

### Metadata ingestion boundary

Platform metadata is an input to binding generation, not a binding manifest and
not an ABI authority by implication. An ingester first produces an immutable,
schema-versioned snapshot whose source is identified by a portable logical path
and content digest. Physical SDK paths never enter the snapshot. Namespace,
version, selection, and unsupported-feature failures are diagnostics rather than
best-effort defaults.

Large platform descriptions are ingested by explicit class/member selection.
The snapshot sorts all unordered metadata and contains only selected declarations
plus their required semantic dependencies. Unsupported declarations outside that
selection do not block a build; an unsupported fact reached by the selection
fails generation. This is the metadata-side counterpart of binding and adapter
reachability, and prevents an SDK's unrelated surface from becoming part of a
binding's identity or cost.

For GObject targets, GIR is authoritative for introspection names, inheritance,
interfaces, ownership annotations, nullability, callback scope, and signal
metadata within the guarantees of the selected SDK. It is not authoritative for
C layout or calling convention. The generator must reconcile selected GIR facts
with the matching headers and target compiler's Clang AST/layout results before
emitting SCABI. Missing ownership or a disagreement between GIR and the
authoritative C view is an error; the generator does not guess.

The implemented C evidence slice accepts named types, pointer composition, and
explicitly selected typedef-named records and fields. It treats metadata C
spellings as untrusted candidates and generates one content-addressed ABI probe.
Clang `typeof` compatibility assertions must accept every selected function and
record field against the real headers. The same target compilation records each
selected aggregate's size and alignment plus every selected field's Clang type,
byte offset, size, and alignment. A filtered AST record then becomes canonical
evidence. Raw AST output remains a non-cacheable intermediate because Clang
includes unstable IDs and physical source locations; only normalized selected
evidence participates in binding identity. Direct/indirect aggregate
calling-convention classification is not inferred from layout. The same source
is compiled to target LLVM by a second sandboxed Clang action, and canonical
evidence records the closed physical type algebra, expanded parameter list,
alignment/stack-alignment, extension/in-register attributes, and exact
`byval`/`sret` pointee types. This preserves direct, expanded, and indirect ABI
forms without encoding size heuristics in Native TypeScript.

The first GTK package generator accepts only when the GIR probe, normalized
Clang evidence, target triple, SDK modules, and deterministically regenerated
GObject adapter agree. It currently maps selected GObject constructors,
instance methods, `void`, exact `gboolean`, branded exact `gint` and `gdouble`,
required borrowed NUL-terminated UTF-8 inputs, borrowed UTF-8 results, confined
owned handles, coherent GIR-linked getter/setter properties, and non-detailed
`void` signals with zero or exact `gint`/`gdouble` payloads into canonical
declarations and a validated SCABI manifest. Equivalent unordered target inputs
produce identical output. Signals are adapter entries rather than invented
direct C functions. Exact scalar signal payloads are copied before owner
delivery; any reached signal or parameter/result form outside that closed
algebra is an error instead of a guessed projection.

Selected non-throwing instance methods whose remaining parameters are
caller-allocated transparent-record outputs use a value adapter. The adapter
allocates every output locally, calls the native method once, and returns one
generated nested record. That adapter-owned record is a structured generated
Clang candidate: the probe emits its definition and records its exact layout
and physical identity-call signature. SCABI and declarations use the same
adapter field names, so idiomatic members such as `minimumSize` remain exact ABI
identities rather than post-lowering aliases.

Selected transparent GIR records also enter that probe. The permanent GTK gate
selects `Gtk.Requisition` and preserves its field metadata, while target Clang
proves its 8-byte size, 4-byte alignment, two exact `int` field layouts, and
direct `i64` parameter/result classification on x86-64 SysV. The generated
package emits that record as the public nominal `Requisition` interface and as
a SCABI struct with the exact target classification. ScriptC consumes the same
closed algebra for direct, expanded, `byval`, and `sret` forms; neither layer
chooses a calling convention from aggregate size.

The source projection is distinct from ABI identity. Selected GObject types
are emitted as named TypeScript classes with their proven inheritance.
Canonical GIR `new` constructors use `new Class(...)`; additional `new_*`
constructors use named static factories such as `Button.withLabel(...)`.
SCABI continues to identify the exact constructor or adapter symbol, and
ScriptC lowers the declaration identity directly. No JavaScript constructor
object or C-name inference is involved at runtime.

Opaque handles declare their direct upcast edges explicitly. The first edge
kind is `identity`: source and target share the exact foreign-pointer
representation and the same thread-safety and identity contracts. This is the
correct rule for GObject class ancestry, but is intentionally not inferred for
all native hierarchies; C++ adjusted bases, COM interface queries, and similar
conversions require a future adapter-backed edge.

Selected GObject constructors also produce a generated ownership adapter after
their direct C signature has been accepted. GIR supplies the explicit `none` or
`full` result-transfer fact; the adapter queries actual floating state when
required and presents exactly one strong, non-floating reference to the future
managed-handle projection. Its C source and object are declared artifact-graph
nodes. The generated constructor SCABI binding enters through the adapter symbol
and names its generated release binding as the owned-handle destructor. Repeated
native identity, weak/invalidation policy, and broader method adapters remain
separate work.

For accepted signals, the generated source embeds one namespace-local
`SignalConnection` base in each signal-specific callback record. The base
strongly retains the GObject instance and records the handler ID. One shared,
non-consuming disconnect symbol closes the handler; a separate internal release
symbol disconnects if necessary, unreferences the instance, and frees the record.
Signal-specific records retain distinct callback layouts so payload-bearing
signals can be added without changing the connection ABI. SCABI exposes the
base as one confined, non-identity handle whose owned-result lifecycle closes
callback admission before native disconnection and drains admitted callbacks
before final release.

Native IR records whether a source declaration is called, read, or written.
This makes accessor pairs first-class: getter and setter bindings share one
checker-owned declaration identity while retaining distinct native operations,
reachability, ABI signatures, and reports.

### Native subclass and override metadata

Subclass-based platforms extend SCABI with explicit records for host-owned
construction, native peer attachment, override entry, interface/protocol
conformance, and immediate-base calls. The records identify exact source and
native declarations and carry the same parameter/result, ownership, executor,
reentrancy, error, and exception contracts as ordinary bindings.

`super.member(...)` resolves to a distinct checked base-call binding; it is not
spelled as a public helper such as `superOnCreate` and cannot redispatch to the
same override. Metadata also states whether base invocation is required,
optional, forbidden, or unavailable.

The generated foreign subclass is an adapter artifact. A Java/JNI entry,
Objective-C selector, Swift thunk, or C++/WinRT virtual method does not become a
second source lifecycle declaration. Final or unsupported native classes,
ambiguous overrides, unrepresentable peer lifetime, or missing base-call facts
fail binding generation.

See [Native subclassing and platform lifecycle](native-subclassing.md).

## Native type algebra

Every type is a tagged value. Core SCABI v1 supports:

- `void`;
- exact signed and unsigned integers;
- `f32` and `f64`;
- native boolean representations with an explicit storage class;
- enum and flag types with an exact underlying integer;
- pointers with pointee, mutability, nullability, address space, and lifetime;
- arrays with fixed extent;
- slices represented by an explicit pointer/length ABI;
- structs with fields and complete layout;
- unions with complete layout and an optional discriminator contract;
- opaque values passed by value;
- opaque native handles;
- function pointers and callback signatures;
- platform-defined nominal object references.

Ordinary TypeScript strings, bytes, records, and errors map through explicit
marshalling rules. They are not native types by implication.

A native boolean names an integer storage type plus distinct, canonical,
in-range false and true values. Its source projection is an ordinary TypeScript
`boolean`; the storage integer is ABI-only. Both backends compare the exact
physical value, preserve a previously pending callback exception, and throw a
catchable `TypeError` if native code returns any representation other than the
two declared values. For parameters, both backends select the declared false or
true physical value directly from the logical TypeScript boolean.

## Layout

A by-value aggregate records:

- size and alignment;
- field names, types, byte offsets, and bit-field information;
- packing;
- union overlap;
- flexible-array restrictions;
- explicit by-value ABI passing metadata where layout alone is insufficient;
- whether the value is trivially copyable;
- destruction requirements.

Struct fields may name exact scalar types or other nominal structs. Reached
definitions close transitively, every nested field is validated against the
referenced type's authoritative alignment, and backends retain the nested
nominal identity rather than flattening it into a compiler-invented layout.

The generator computes layout using the authoritative platform compiler or
metadata system. The Native TypeScript compiler verifies internal consistency
but does not recreate target ABI layout heuristics from declarations.

`abiPassing` is the physical identity-function signature produced by target
Clang: one result, zero or more expanded source parameters, and any leading
hidden return-storage parameter. Its recursive types cover integers, floats,
pointers and address spaces, arrays, vectors, literal structs, and the nominal
aggregate itself. Per-value attributes preserve extension, `inreg`, alignment,
stack alignment, `byval`, and `sret` facts. This is executable backend input,
not a descriptive target-name string.

The C backend expresses the nominal C type and lets the selected C compiler
apply that contract. The LLVM backend explicitly reinterprets logical aggregate
storage into the recorded direct or expanded values, supplies copied indirect
storage where required, and reconstructs logical results from direct values or
hidden result storage. Direct `i64`, expanded two-`double`, and indirect
`byval`/`sret` and nested nominal fixtures run through both backends.

For C and Objective-C headers, the authoritative generator uses Clang AST and
target layout information. Text parsing is not an accepted ABI source.

## Binding kinds

SCABI distinguishes:

- free functions and C symbols;
- exported constants and resolved macros;
- constructors and factory operations;
- instance and static methods;
- properties and fields;
- callbacks, listeners, delegates, and protocols;
- exported TypeScript-to-native entry points;
- platform activation or registration records.

Each binding has a stable manifest-local ID. Translation qualifies it with the
package instance before it enters Native IR, so bindings from multiple packages
share one collision-free namespace. Calls reference that stable identity, never
an unchecked symbol string supplied by application source.

## Function contract

A callable binding records:

- native symbol, selector, method ID, interface slot, or adapter entry;
- calling convention and variadic policy;
- receiver convention;
- parameter and return types;
- pass mode: value, pointer, reference, hidden return storage, or platform
  object reference;
- nullability;
- ownership transfer;
- mutation and aliasing behavior;
- callback lifetime;
- thread/executor requirement;
- blocking and reentrancy behavior;
- error mapping;
- platform availability;
- required permission/capability;
- required adapter and link inputs.

Variadic functions are unsupported unless a binding expands a finite typed
surface or an explicit unsafe variadic operation is later specified.

### TypeScript-implemented export roots

An export binding describes the native ABI and public symbol; it does not guess
which application function implements that contract. One compiler invocation
therefore supplies an explicit program selection with separate reached imports
and `{ bindingId, sourceExport }` export roots. `sourceExport` names an exported
function in the library entry module. SCABI continues to own the qualified
binding identity, declaration identity, C symbol, exact signature, executor,
error contract, and adapter dependencies.

The implemented first slice accepts a non-variadic, no-fail C export on the
runtime owner with exact scalar value parameters and an exact scalar or `void`
result. Its one `c-export` adapter input is validated and retained as
provenance. ScriptC resolves the source function against its checked and
lowered signature, emits the public wrapper through both backends, and shares
the library lifecycle and trap funnel without converting through the legacy
JavaScript-number export classes. The current fixture proves exact `i32`.
Aggregate, buffer, ownership-bearing, asynchronous, and platform-specific
export families remain unsupported. The future artifact planner must also
materialize or account for the adapter input's declared output; the direct
compiler conformance gate does not claim that product-level artifact step.

## Ownership contract

Every pointer, object, handle, callback, string, and buffer position declares
one of the ownership modes defined in [Ownership](ownership.md). Absence of an
ownership contract is an error for a resource-bearing type.

Allocator/deallocator pairs are named binding IDs with compatible target and
SDK identity. The compiler never assumes that `free` releases an arbitrary
returned pointer.

Borrowed values state the borrow scope: call, receiver, returned owner, callback
invocation, or another manifest-described anchor. A scope the compiler/runtime
cannot enforce is rejected.

## Callback contract

A callback record contains:

- exact native ABI signature;
- optional context-pointer placement;
- `call`, `once`, `retained`, `weak`, or `until-cancelled` lifetime;
- registration owner;
- cancellation binding when applicable;
- allowed invocation executors/threads;
- synchronous-return requirement;
- argument copy/borrow rules;
- ordered source-argument projection, independently of the physical callback
  parameters;
- reentrancy policy;
- post-disposal behavior guaranteed by the native API.

Initial foreign-thread callbacks must have `void` native return and enqueue
transport-safe arguments. A callback requiring a synchronous TypeScript result
from a foreign thread is unsupported until a separately specified execution
model exists.

The implemented call-scoped callback slice accepts non-variadic C callbacks with
exact scalar value parameters, an exact scalar or `void` result, and one typed
context pointer in the trailing physical parameter position. The callback and
context are non-null, call-scoped, owned by the native call, delivered
synchronously on the caller, and explicitly reentrant. Every callback argument
is borrowed in ABI order.

The implemented retained slice accepts `until-cancelled` callbacks with a
`void` native result and copied exact-scalar payloads, including the zero-payload
case. Same-caller or attached foreign producers admit opaque token events
without entering the ScriptC heap; delivery runs one callback per runtime-owner
turn. Cancellation may be either the handle destructor or a separate borrowed,
non-consuming operation. Both close new admission before native disconnection
and complete only after it returns. Explicit cancellation removes the callback
lifecycle while leaving the native handle live for state observation and
idempotent repeated calls. Normal cancellation keeps the closure alive until
admitted leases drain; collector cancellation suppresses those already-admitted
deliveries before reclaiming their closure.

`sourceArguments` is an explicit logical projection. A
`callback-parameter` entry selects one physical callback parameter; a
`registration-owner` entry injects the existing managed receiver identity
without manufacturing another foreign-pointer wrapper. The latter is
currently restricted to same-caller native invocation. Each admitted turn
takes a temporary live retain of the receiver and releases it with the copied
invocation record, while the registration table keeps only a checked weak
owner pointer. This preserves the sender through queued delivery without
adding a permanent connection-to-receiver cycle.

Registration ownership may be the result handle or a borrowed non-null method
receiver. Receiver ownership preallocates a receiver-to-result edge before the
native call and commits it transactionally with the result. Only those handle
families receive cycle headers, including every identity-upcast-connected
nominal type; ordinary native handles retain their lean allocation. The result
lifecycle owns and traces the closure, so
receiver-to-result-to-closure-to-receiver cycles are visible to ScriptC's cycle
collector. Borrowed or aggregate callback payloads, synchronous foreign-thread
results, and callbacks without an enforceable cancellation edge remain
rejected.

## Error contract

Bindings explicitly select an error convention, including:

- no-fail;
- nullable or sentinel return;
- `errno`;
- status/result code;
- HRESULT;
- JNI pending exception;
- Objective-C `NSError` out parameter;
- language/platform exception caught by a generated adapter;
- asynchronous success/error callback;
- platform promise/future adaptation.

The contract identifies success conditions, error extraction, cleanup ordering,
and the resulting TypeScript error shape. Foreign exceptions may not unwind
through ScriptC-generated frames.

The implemented first error slice accepts `errno` only with an exact integer
value result and a canonical in-range decimal failure sentinel. The generated
call compares the physical result without a JavaScript-number conversion and,
on failure, snapshots the calling thread's `errno` before any cleanup or error
allocation. It throws an ordinary `Error` whose message is
`<ERRNO>: <text>, <module>.<declaration>` and whose `code` is the symbolic errno
name. A TypeScript exception already pending from a synchronous callback in the
same native call has precedence and is not overwritten. Non-failure results
retain their exact native type. A declaration may use `never` when that binding
itself guarantees there is no success path; the integer remains present in
Native IR solely to test the ABI sentinel.

The implemented nullable slice is narrower: it applies only to an owned native
handle result transferred to the runtime. A null pointer throws an ordinary
`Error` with `<module>.<declaration> returned null` before handle construction;
a non-null pointer is wrapped with the declared destructor exactly as a
`no-fail` owned result. The TypeScript declaration remains the non-null handle
type because null is a failure, not a source value. If a synchronous callback
already threw and native code nevertheless returns a non-null owned pointer,
ScriptC wraps it before unwinding so ordinary cleanup still runs the destructor.

## Thread and executor contract

Thread affinity is expressed as an executor identity and call behavior:

```text
runtime-owner
platform-ui
named-dispatcher
any-attached-thread
same-as-receiver
same-as-caller
callback-defined
```

The target maps these abstract identities to concrete schedulers. Metadata also
states whether the compiler may insert an asynchronous hop, whether the call is
only valid when already on the executor, and whether it may block.

## Platform extensions

The common schema carries portable semantics. Versioned extensions carry facts
needed only by an ABI family, for example:

- JNI descriptors, class-loader strategy, and reference category;
- Objective-C selectors, ARC method families, protocols, and availability;
- COM interface IDs, vtable slots, apartments, and HRESULT details;
- GObject type IDs, floating references, and signal metadata;
- Blink extended attributes and execution-context requirements.

Extensions cannot override common ownership, type, thread, or error facts. A
disagreement is a generation error.

## Link and adapter inputs

Link inputs are declared by logical identity and type:

- static or shared libraries;
- system libraries and frameworks;
- object files;
- weak or optional imports;
- link-order groups;
- exported-symbol lists;
- runtime components.

Paths are resolved by the SDK/toolchain layer. Manifests do not embed a
developer's absolute filesystem paths.

Adapter inputs identify a generator template/family, reachable binding IDs,
language, compile flags derived from the SDK, and expected outputs. Generated
sources participate in ordinary dependency scanning and caching.

## Reachability

A complete SCABI package may describe a large SDK, but emitted adapters and
linked optional components are specialized to reachable bindings.

Reachability never removes:

- initialization required by a reachable binding;
- destructors or cancellation operations needed by reachable resources;
- registration records referenced indirectly by the platform runtime;
- permission declarations required by a reachable operation.

The binding generator declares these dependency edges explicitly.

## Validation

Validation occurs in layers:

1. JSON schema and canonical form.
2. Internal IDs and reference integrity.
3. Target and SDK compatibility.
4. Type and layout consistency.
5. Ownership, callback, thread, and error completeness.
6. Declaration-to-binding agreement.
7. Adapter and link dependency closure.
8. Reachability specialization.

Every failure names the manifest path and source declaration when available.

## Version policy

Before the first public SCABI release, the active workspace accepts exactly one
schema version. A schema change updates generators, manifests, readers, tests,
and cache namespaces atomically. No compatibility reader is retained.

After a public v1 contract exists:

- additive compatible changes use explicitly optional fields governed by the
  schema;
- semantic or representation changes require a new major schema capability;
- conversion, when supported, is an explicit standalone tool that produces a
  new manifest, not hidden compiler migration logic.

## C v1 acceptance fixture

The permanent fixture lives in `fixtures/scabi-c-v1`. Its canonical manifest,
declarations, authoritative C header, implementation, layout probe, and native
behavior test are active conformance inputs. The fixture contract is ratified;
its exact `i8`/`u8`, `i16`/`u16`, `i32`/`u32`, `i64`/`u64`, and `usize`
declarations, manifest bindings, target pointer width, Native IR, C symbols,
and both ScriptC backends now agree end to end. The fixture's borrowed UTF-8
binding additionally proves single source evaluation, exact byte length,
Unicode encoding, embedded NUL preservation, and zero-copy data projection.
The checked C-string variant uses a distinct implicit-NUL length contract:
ScriptC passes the already terminated storage as one pointer and raises a
`TypeError` before native entry if the logical string contains an embedded NUL.
Both C and LLVM pass the normal and rejection paths. Import bindings whose
entry is an adapter symbol retain the exact adapter input in the translated
build requirements while lowering the callable entry to the same C-symbol
Native IR operation.
Borrowed C-string results use the inverse but intentionally non-zero-copy
contract. Their physical const pointer stays anchored to a borrowed handle
receiver, while the logical result is `string` or `string | null`. ScriptC
copies the bytes into managed storage before releasing a temporary receiver;
both backends verify the surviving string and null branch. The generated
`Gtk.Button.label` getter is the first real package surface translated through
this result projection. It shares one declaration symbol with its setter while
retaining two exact native binding identities.
Its borrowed-byte binding proves the parallel `Uint8Array` contract: an exact
offset view and its byte length reach native code without copying, mutation of
the shared backing store is visible before the call, and temporary view/owner
references are released immediately after return.
Its `ts_add_i32` export now proves the reverse boundary: the manifest export and
C-export adapter select an entry-module TypeScript function, both ScriptC
backends emit the exact `nts_ts_add_i32` symbol, wrapping arithmetic retains
`i32` semantics, and an independently compiled C probe calls it successfully.
SCABI v1 remains pre-release until the rest of the acceptance surface passes
the same path.

SCABI v1 is not considered complete until one fixture proves:

- exact scalar parameters and returns;
- a padded struct passed and returned according to the host ABI;
- borrowed string/bytes input;
- an owned allocation with its declared destructor;
- a call-scoped callback;
- a retained callback delivered through the owner scheduler;
- a foreign-thread `void` callback;
- native error conversion;
- exported TypeScript functions in a native library;
- rejection of a deliberately mismatched layout and ownership contract.
