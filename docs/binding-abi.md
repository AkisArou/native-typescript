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

## Layout

A by-value aggregate records:

- size and alignment;
- field names, types, byte offsets, and bit-field information;
- packing;
- union overlap;
- flexible-array restrictions;
- target ABI classification where layout alone is insufficient;
- whether the value is trivially copyable;
- destruction requirements.

The generator computes layout using the authoritative platform compiler or
metadata system. The Native TypeScript compiler verifies internal consistency
but does not recreate target ABI layout heuristics from declarations.

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
- reentrancy policy;
- post-disposal behavior guaranteed by the native API.

Initial foreign-thread callbacks must have `void` native return and enqueue
transport-safe arguments. A callback requiring a synchronous TypeScript result
from a foreign thread is unsupported until a separately specified execution
model exists.

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
its exact `i8`/`u8`, `i16`/`u16`, and `i32`/`u32` declarations, manifest
bindings, Native IR, C symbols, and both ScriptC backends now agree end to end.
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
