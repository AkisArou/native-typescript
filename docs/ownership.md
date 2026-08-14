# Ownership and Lifetime

Status: normative  
Last revised: 2026-08-14

This document defines how Native TypeScript represents native resources safely
without pretending that TypeScript has linear types.

## Principles

- Native resources are never represented as untyped integers in safe code.
- Binding metadata states ownership; the compiler never guesses it.
- Runtime enforcement is authoritative because TypeScript values may alias.
- Destruction occurs on an allowed executor and through the declared operation.
- Explicit disposal is available for scarce resources.
- Stale access fails deterministically.
- Raw pointers are a distinct unsafe capability, not a handle representation.

## Handle representation

A managed native reference is an opaque `NativeHandle<T>`. Its implementation
contains enough identity to locate a runtime handle-table entry and reject a
reused slot. A recyclable table normally uses an index plus generation; an
implementation may instead use a uniquely allocated, non-recycled entry. The
physical representation is runtime-private and not a public ABI.

A handle-table entry conceptually stores:

```text
generation
state
binding type identity
native identity/reference
ownership mode and destructor
strong and weak ScriptC reference state
owner runtime
allowed executor/thread/apartment
process/domain affinity
identity-map information
associated callbacks/children
debug provenance
```

Application code cannot extract the native pointer or table index from a safe
handle.

The implemented first C slice uses a uniquely allocated, reference-counted
entry as the handle value. It stores the native pointer, exact destructor,
compiler-emitted nominal type tag, and diagnostic type name. Because an entry
is never reused, its allocation identity supplies the generation guarantee.
This deliberately leaves room to replace the physical storage with an indexed
table when weak references, identity maps, native invalidation, or cross-domain
handles require it; that change cannot alter the source or SCABI contract.

## States

```text
alive → disposing → disposed
  │
  └──── native-invalidated → disposed
```

Disposal atomically prevents new operations. The declared native release runs
exactly once on an allowed executor. The slot generation changes before it can
be reused.

An operation on a disposed, invalidated, wrong-type, wrong-runtime, or wrong-
generation handle fails with a checked runtime error. It never reaches native
code with a stale reference.

## Ownership modes

### Borrowed

A borrowed value is valid for a declared anchor and scope. Common scopes are:

- the current native call;
- the current callback invocation;
- the lifetime of a receiver handle;
- the lifetime of another returned owner.

A call-scoped borrow may not be stored, returned, captured, or survive `await`.
The compiler rejects provable escapes. Checked builds also associate ephemeral
borrows with a scope generation so an unproven escape fails at use.

### Owned

An owned result transfers one native ownership obligation to the ScriptC
runtime. The handle-table entry invokes the exact declared destructor when its
last strong ScriptC owner is released or explicit disposal occurs.

### Retained/shared

The adapter acquires a platform retain/reference before exposing the handle and
releases it at destruction. Multiple ScriptC aliases refer to the same managed
entry or to entries unified through the binding's identity policy.

### Weak

A weak handle does not keep the native object alive. Upgrade returns an alive
strong handle or `null`. Targets use the platform's weak-reference mechanism;
they do not emulate weakness with an unchecked pointer.

### Autoreleased

An autoreleased result is borrowed until the current native autorelease scope
ends. If it escapes the call, generated code retains it immediately and records
a normal retained handle. Autorelease timing is never exposed as ScriptC
ownership.

### Call-scoped

A call-scoped pointer/reference is valid only during the dynamic native call.
It cannot be converted to a general handle without a binding-declared retain or
copy operation.

### Process proxy

A process proxy represents a resource owned in another domain. Its local entry
owns a remote-handle lease and releases it through the transport. It never
contains or exposes the remote native pointer.

## Type and identity

Every handle has a nominal binding type identity. Safe casts are allowed only
through binding-declared inheritance, interface, protocol, or query operations.

Native identity differs by platform:

- C resources usually have no identity beyond a binding-defined key.
- JNI object references require platform identity comparison and retained
  global/weak-global storage.
- Objective-C identity follows object identity and tagged-object rules.
- COM identity follows `IUnknown`, not arbitrary interface pointer equality.
- GObject identity follows the underlying object reference.
- DOM identity must account for execution context and wrapper systems.

When a binding declares stable identity, the runtime maintains a target-owned
identity map so repeated projection can reuse a managed entry. Map entries are
removed during native invalidation or final release. When identity is not
declared, handle equality is unavailable.

## Aliasing

TypeScript aliases to one handle share disposal state. Calling `dispose()`
through one alias invalidates every alias. This is intentional and must be
visible in the API documentation.

Copying a handle value does not implicitly call a native retain for every local
assignment. ScriptC manages aliases to the handle entry; the entry owns the
native obligation. Passing a handle to native code applies the binding's
parameter transfer rule at the call boundary.

## Explicit disposal and automatic release

Scarce or externally visible resources expose an idempotent `dispose()` or a
domain-specific close operation. Explicit disposal reports native close errors
when the API supports them.

Automatic release is the safety net:

- when the final ScriptC strong reference disappears, the entry is scheduled
  for destruction;
- if destruction requires another executor, the owner retains a pending-release
  record until that executor performs it;
- shutdown drains pending releases or reports them as leaks;
- automatic release cannot surface an asynchronous error to dead application
  code, so such errors go to diagnostics.

The compiler must not make correctness depend on nondeterministic JavaScript
finalizers.

## Native invalidation

Some platforms destroy objects independently of ScriptC—for example a document
teardown, closed window, invalidated delegate owner, or remote process exit.

A target adapter invalidates the entry, releases associated callback anchors,
and makes future operations fail with a typed invalid-resource error. Native
invalidation and ScriptC disposal race through the same state machine so the
destructor or remote release runs at most once.

## Parent and child lifetimes

A binding may declare that one object keeps another alive or that a child is
valid only while its parent remains alive. These are explicit handle-table
edges:

- strong ownership edge;
- weak observation edge;
- invalidation edge;
- callback registration edge.

Generated bindings cannot encode lifetime relationships only in documentation.
Unrepresentable relationships make the binding unsafe or unsupported.

## Callback ownership

A retained callback entry strongly owns its compiled closure unless its SCABI
lifetime is weak. The native registration owns a callback token; the runtime
entry owns the corresponding cancellation obligation.

The registration must define which event breaks each edge. Common patterns are:

- explicit subscription disposal;
- once-callback delivery;
- native owner destruction;
- runtime shutdown.

Details of callback admission and races are in
[Runtime and threading](runtime-and-threading.md).

## Cycles

Cycles may cross ScriptC objects, handle entries, callbacks, and native objects.
No universal cross-runtime tracing collector is assumed.

The safe model is:

- generated bindings create only declared ownership edges;
- subscriptions have explicit cancellation;
- native owner invalidation breaks registered callback edges;
- the ScriptC cycle collector understands ScriptC-to-handle and handle-to-
  closure edges represented in its runtime tables;
- opaque cycles entirely inside a foreign runtime remain that runtime's
  responsibility;
- cycles spanning an optional dynamic realm require explicit bridge cleanup and
  are reported if they cannot be collected.

Checked builds expose an ownership graph and report surviving roots at shutdown.

## Strings and buffers

String and buffer bindings specify one of:

- borrowed for call;
- copied into native ownership;
- mutable borrowed span;
- returned copied value;
- owned allocation plus deallocator;
- transferred immutable buffer;
- shared native buffer under a separate synchronization contract.

Encoding, length unit, termination, mutability, and embedded-NUL behavior are
part of the binding. `string` never implies NUL-terminated UTF-8.

ScriptC arrays and typed arrays are not pinned by default. A native API that
retains bytes receives a copy, transfer, or separately allocated native buffer.
The implemented call-scoped const-byte slice needs no pin or copy: ScriptC does
not relocate a live `ScrBytes` allocation, and a view carries its exact data
pointer while retaining its owner. The compiler keeps the logical view alive
through the synchronous call and releases it immediately afterward. Mutable or
retained access still requires a later explicit contract.

## Unsafe pointers

An `UnsafePointer<T>` bypasses the handle table. It therefore carries no stale-
generation, identity, destructor, or executor enforcement unless the unsafe API
explicitly adds it.

Unsafe pointers:

- require an unsafe build capability;
- never cross processes or dynamic realms;
- cannot be serialized;
- cannot be treated as handles;
- cannot be retained by safe bindings;
- cannot survive an async suspension without a binding-proven lifetime token;
- expose alignment and bounds responsibility to the caller.

Generated safe bindings may use raw pointers internally in adapter code while
exposing handles, copies, or scoped borrows to TypeScript.

## Platform rules

### C

Allocator and destructor are explicit. Pointer ownership, aliasing, buffer
length, thread safety, and callback cancellation must be known. Unknown
ownership is unsupported in safe bindings.

### JNI

Local references are call-scoped. Retained references become global or weak
global references and are released with an attached thread environment. Native
identity does not use raw `jobject` equality.

### Objective-C

Generated adapters obey ARC method-family conventions, weak delegates, block
copying, autorelease pools, and executor requirements. Pure Swift ownership is
handled behind an explicit generated Swift/Objective-C-compatible adapter.

### COM/WinRT

Entries own `AddRef`/`Release` obligations, preserve `IUnknown` identity, and
record apartment agility or affinity. Release occurs in an allowed apartment.

### GObject

Entries handle owned, borrowed, weak, and floating references explicitly.
Signal connection IDs are cancellation obligations associated with callback
entries.

## Conformance tests

The ownership suite must exercise:

- aliases observing explicit disposal;
- exactly-once native destruction;
- stale generation rejection after slot reuse;
- borrow escape diagnostics and runtime scope checks;
- weak upgrade before and after invalidation;
- identity-map reuse and removal;
- destruction scheduled onto the correct executor;
- native invalidation racing with disposal;
- callback/owner cycle teardown;
- buffer copy/transfer behavior;
- shutdown ownership graph with zero unexplained roots;
- sanitizer-backed use-after-free and leak fixtures.
