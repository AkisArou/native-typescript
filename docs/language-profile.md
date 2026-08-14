# Language Profile

Status: normative foundation; individual supported operations remain versioned  
Last revised: 2026-08-14

This document defines the source-language promise. It distinguishes the
language architecture from scriptc's current implementation coverage.

## Source language

Native TypeScript accepts ordinary `.ts`, `.tsx`, `.js`, and `.jsx` syntax
through the TypeScript parser and checker. The project does not add parser
syntax for native operations, ownership, threads, or process domains.

Native semantics are expressed through:

- declarations from identity-known packages;
- compiler-recognized intrinsic types and functions;
- validated binding metadata;
- target and platform module resolution;
- build configuration;
- optional standard TypeScript decorators or string directives only after a
  separate specification establishes their semantics.

Recognition is based on resolved symbol identity, never on an unqualified
spelling such as a type named `i32` in application code.

## Static profile

The static profile is the set of TypeScript and JavaScript behavior for which
the compiler provides an ahead-of-time representation with defined observable
semantics.

For every reachable source operation, the compiler must do exactly one of:

1. lower it statically;
2. route it to an explicitly selected dynamic realm;
3. reject it with a source-located diagnostic and actionable reason.

The compiler must not guess, silently change lanes, or accept an operation that
will fail only because no lowering exists.

The current scriptc limitation list is not the definition of this profile.
Limitations are classified and revisited under
[scriptc evolution](scriptc-evolution.md).

## Compatibility levels

Build reports distinguish:

- **Static exact**: promised JavaScript-observable behavior is compiled
  statically.
- **Static specified divergence**: behavior is static and intentionally differs
  under a documented Native TypeScript rule.
- **Dynamic**: execution occurs in an explicit compatibility realm.
- **Unsupported**: no selected execution mode can provide the behavior.

A package compatibility claim names the package version, target, mode, test
suite, and known divergences. A percentage of statically lowered statements is
useful diagnostic data, not by itself a compatibility claim.

## JavaScript values

Ordinary TypeScript `number` preserves the project's JavaScript-number
contract and is not reinterpreted as a native integer because an ABI happens to
expect one. `boolean`, strings, nullish values, records, classes, arrays,
closures, promises, errors, and supported standard-library objects retain their
defined ScriptC representations.

Native values extend this world but do not silently alter ordinary values.

## Exact native scalars

The compiler recognizes exact scalar types exported by a canonical package:

```text
i8   u8
i16  u16
i32  u32
i64  u64
isize usize
f32  f64
```

The exact package name is finalized with the first public API, but symbol
identity and semantics are fixed by this specification.

The implemented scalar direct-call conformance slice currently covers `i8`, `u8`,
`i16`, `u16`, `i32`, `u32`, `i64`, `u64`, `isize`, and `usize`. Fixed 64-bit
and pointer-sized types use decimal BigInt literals as construction syntax and
remain exact Native IR values; this does not introduce a general JavaScript
BigInt representation. A finite numeric literal can construct exact `f64` for
the implemented native-aggregate boundary, but general exact floating-point
operations still await their rounding-operation contract.

### Representation

- Fixed-width integers have exactly the named width.
- `isize` and `usize` match the target pointer width. SCABI supplies that width
  and ScriptC rejects a frontend/backend target mismatch before lowering.
- Signed integers use two's-complement representation.
- `f32` rounds at each operation to IEEE-754 binary32.
- `f64` is IEEE-754 binary64 and may share representation with ordinary
  JavaScript `number`, but remains a distinct ABI intent when required.

### Arithmetic

Exact integer arithmetic is deterministic and never invokes C or LLVM undefined
behavior:

- addition, subtraction, and multiplication wrap modulo the type width;
- signed results are interpreted as two's-complement values;
- division by zero traps;
- signed minimum divided by `-1` traps;
- shifts mask neither the count nor the result implicitly; an out-of-range
  shift count traps;
- checked, saturating, and explicitly wrapping helper families may expose more
  obvious intent without changing the primitive semantics.

This rule favors predictable low-level performance. APIs handling untrusted
sizes should use checked operations.

### Conversion

- There is no implicit conversion between ordinary `number` and an exact
  integer variable.
- A decimal `number` literal may construct an integer up to 32 bits when it is
  integral and in range; a decimal BigInt literal is required for `i64`,
  `u64`, `isize`, and `usize`. The pointer-sized BigInt carrier is stable on
  both 32- and 64-bit targets; only its accepted range changes. The carrier
  families never convert implicitly.
- Widening between exact integer types is allowed only when every source value
  is representable in the destination.
- Narrowing, signedness changes, float-to-integer conversion, and integer-to-
  float conversion use explicit compiler intrinsics.
- Conversion APIs name their behavior: checked, truncating, or wrapping.

### ABI use

Binding declarations must use exact scalars wherever the native ABI does.
Ordinary `number` is accepted only when the binding explicitly declares a
JavaScript-number conversion policy.

## Native aggregates

Native structs and unions are layout values, distinct from ordinary structural
TypeScript records.

- Their field order, size, alignment, packing, and target ABI are supplied by
  validated binding metadata.
- They are nominal by binding identity even if two layouts are identical.
- Field access is statically typed.
- Passing or returning an aggregate follows the target calling convention,
  including hidden return storage where required.
- A native aggregate containing pointers or handles inherits their lifetime
  restrictions.
- An ordinary object is never reinterpreted as a native aggregate.

Explicit copy/conversion functions bridge native aggregates and ordinary
records when useful.

The implemented first slice supports nominal, default-packed, trivially
copyable structs with exact scalar fields and authoritative indirect ABI
passing. Its direct object-literal assertion is a compile-time representation
constructor: every field must be present exactly once and already be an exact
native value. It does not accept an arbitrary object or preserve object
identity. Native field reads are statically typed and lower directly from the
nominal value. Field writes, nested aggregates, unions, and non-trivial
ownership remain outside this slice.

## Borrowed UTF-8 strings

An ordinary TypeScript `string` remains a ScriptC-managed, well-formed UTF-8
value. A reached SCABI string-marshalling contract may borrow its bytes for one
synchronous native call. The implemented slice requires a non-null const
`i8`/`u8` pointer in address space zero, an explicit `usize` byte-length
parameter, no required terminator, embedded NULs allowed, and call-scoped
borrowing.

Native IR records one logical string argument and two physical ABI projections.
The expression is evaluated once, the existing UTF-8 storage is passed without
a copy, and length is measured in bytes rather than UTF-16 code units. The
foreign pointer exists only during lowering and is never a TypeScript-visible
value. Mutable strings, transcoding, retained pointers, NUL-policy adaptation,
remain outside this first slice.

## Borrowed byte views

A reached SCABI byte-marshalling contract may borrow a `Uint8Array` for one
synchronous native call. The implemented slice requires a non-null const `u8`
pointer in address space zero, an explicit `usize` byte-length parameter, and
call-scoped borrowing. `Buffer` shares ScriptC's `u8` byte representation and
is accepted wherever its checker type maps to the same byte type.

Native IR records one logical `{ kind: "bytes", elem: "u8" }` argument and
projects its data pointer and byte length into two ABI slots. The expression is
evaluated once. A `subarray` or Buffer slice passes its exact view pointer and
length, not the retained owner's base address, and native code observes backing
store mutations made before the call. No boundary copy is introduced. The
logical value remains owned across the native call and is released immediately
after return; mutable native access, retained pointers, transfers, and non-u8
typed arrays remain outside this slice.

## Native handles

`NativeHandle<T>` is opaque and nominal. Application code cannot construct,
inspect, compare numerically, serialize, or cast a handle through ordinary
TypeScript operations.

Handle equality means native identity only when the binding declares an
identity policy. Otherwise equality is rejected rather than guessed. Detailed
lifetime rules are in [Ownership](ownership.md).

The implemented first slice accepts handles only from SCABI bindings that
transfer an owned, non-null C pointer and name its exact destructor. ScriptC
aliases share one reference-counted runtime cell. A binding-declared method
borrows the checked pointer for the duration of its direct call; a wrong-type
or disposed handle throws a catchable `TypeError` before native code runs.
An owned receiver operation such as `dispose()` clears the cell and invokes
the destructor synchronously and idempotently. Releasing the final alias does
the same automatically if explicit disposal has not occurred.

The pointer, destructor, and nominal type tag remain runtime-private. This
slice is confined to the runtime owner lane and does not yet provide retained
or weak handles, binding-declared identity unification, external native
invalidation, executor-hopping destruction, callbacks, or foreign-thread
ingress. It therefore rejects handle equality, sendable/shared handle types,
non-owner handle calls, and general consuming transfers even when their SCABI
metadata is retained for a later slice.

## Native failures

An implemented `errno` binding returns an exact native integer physically and
declares one exact failure sentinel. ScriptC snapshots thread-local `errno`
immediately after that sentinel is observed, then throws a catchable `Error`
with a symbolic `.code` and an operation-qualified message. No error machinery
is emitted for `no-fail` bindings. If a synchronous native callback already
left a TypeScript exception pending, that original exception wins.

An implemented nullable owned-handle result throws before a null pointer can be
wrapped; its source type remains the non-null handle. A non-null result follows
the ordinary managed-handle ownership path. If a callback exception is already
pending, a non-null owned result is still wrapped first so unwinding destroys
it exactly once.

This slice does not infer raw nullable pointers, sentinel-only errors, status
codes, HRESULT, JNI exceptions, `NSError`, or platform exceptions. Those remain
distinct contracts rather than aliases for `errno` or nullable handles.

## Unsafe pointers

Unsafe memory access is available only through an explicitly imported unsafe
capability and a build policy that permits it.

An unsafe pointer:

- is target- and address-space-specific;
- carries pointee type, mutability, and optional alignment information;
- may not be serialized or cross a process boundary;
- may not be captured by a retained callback unless its binding proves a
  compatible lifetime;
- may not survive `await` by default;
- requires explicit load, store, offset, cast, and lifetime operations;
- never makes the pointed-to memory managed by ScriptC.

The compiler rejects unsafe operations outside the capability. The API is an
escape hatch, not a mechanism used by generated safe bindings.

## Functions and callbacks

Ordinary compiled closures and native callback entries are different
representations. A binding operation explicitly creates a callback entry with a
signature, lifetime, delivery executor, and argument transport contract.

The compiler must reject callback captures that violate the requested lifetime
or cross-thread transport rules. Runtime checks remain authoritative because
TypeScript does not provide linear ownership.

The implemented call-scoped slice accepts an ordinary statically typed closure
where SCABI promises one synchronous, reentrant, same-caller C callback during
the dynamic native call. Its parameters and result use exact native scalar
types (or `void` for the result), and the native ABI supplies a required trailing
context pointer. Native IR evaluates the closure once and projects it to a
generated trampoline plus the borrowed closure context. Captured state therefore
works without global or thread-local callback slots. A callback throw propagates
through the outer native call into the surrounding TypeScript `catch`.

The native side may not store or invoke either pointer after return. Retained,
once, weak, cancellable, asynchronously delivered, foreign-thread, variadic, or
aggregate callback contracts remain unsupported until their callback-table,
owner-scheduler, transport, and lifetime primitives are implemented.

## Async behavior

Promises and `async`/`await` preserve the ordering contract of the selected
ScriptC static profile. A scheduler hop is an explicit Native IR effect. A
continuation resumes on the runtime instance's owner executor unless a
specified API creates or targets another runtime instance.

Native callbacks and platform promises are adapted into the same owner-owned
microtask and task model described in
[Runtime and threading](runtime-and-threading.md).

## Effects

Effects describe constraints and observable boundaries; they are not a general
effect-type syntax exposed to application authors in the first release.

Initial effect categories include:

- pure computation;
- runtime-local mutation;
- native call;
- owner-executor requirement;
- named platform-executor requirement;
- unsafe memory;
- blocking operation;
- domain capability call;
- dynamic realm execution.

Effects are inferred from resolved operations and propagated through the call
graph. They drive validation and reporting. They do not automatically relocate
functions between domains in the first implementation.

## Dynamic realms

A dynamic realm is an isolated compatibility mechanism, not a fallback branch
inside an individual expression.

- The build explicitly selects the engine and packages assigned to it.
- Values cross through a defined copy/handle boundary.
- Static and dynamic object identities are not silently unified.
- The realm receives only the capabilities granted to its enclosing domain.
- Coverage and build reports identify every dynamic module and transition.
- AOT-only builds reject all reachable dynamic requirements.

## Error semantics

Language errors, native errors, runtime traps, and domain transport failures are
distinct categories.

- Catchable TypeScript errors follow the static language profile.
- Native bindings declare how error indicators become typed errors.
- C++, Objective-C, Java, Swift, or platform exceptions never unwind through
  generated C/LLVM frames without an adapter boundary.
- Memory-safety invariant failures trap rather than continue in corrupted
  state.
- Cross-domain failures use serializable error records and preserve a causal
  trace where available.

Bindings may not claim that every platform failure is an ordinary exception;
the mapping is explicit per operation.

## Language evolution gate

A static feature is accepted when it has:

1. defined source and runtime semantics;
2. IR representation and validation;
3. C and LLVM backend behavior where applicable;
4. ownership and error behavior;
5. differential tests against the relevant JavaScript or native reference;
6. coverage diagnostics for unsupported edges;
7. target and cache-version effects documented.

Implementation coverage may grow continuously. The semantic promise changes
only through this specification and its conformance tests.
