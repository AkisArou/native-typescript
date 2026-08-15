# Implementation Status

Status: current implementation state  
Last revised: 2026-08-16

This document records what is **built and proven**, and by which gate. The
normative specifications say what must be true; this says how far the
implementation has got.

Every claim here corresponds to a passing test. "Both backends" means C and
LLVM produce equivalent observable results. "Sanitizer gate" means the case
also passes under ASan/UBSan, and under TSan where threads are involved.

The repository is not yet an application framework or a production compiler.

## Summary

| Layer | State |
| --- | --- |
| Exact scalars, aggregates, ABI classification | implemented |
| Native handles and ownership | implemented |
| Borrowed strings and byte views | implemented |
| Call-scoped and `until-cancelled` callbacks | implemented |
| Foreign-thread ingress, owner gateway, scheduling | implemented |
| Native error conventions | `errno` and nullable-handle only |
| TypeScript → C exports | exact `i32` only |
| Artifact graph, sandboxed executor, local cache | implemented |
| C ABI evidence (Clang-proven) | implemented |
| GIR ingestion and GObject projection | implemented for the narrow algebra below |
| GTK target runtime provider | implemented |
| GTK application lifecycle | specified, not generated |
| Cross-namespace GIR composition | not started |
| Terminal, mobile, React, partitions, DOM | not started |

## Compiler and runtime

The ScriptC fork owns generally reusable compiler and runtime capability. See
[scriptc evolution](scriptc-evolution.md) for how limitations are classified
and changed.

### Exact scalars

Reached SCABI bindings translate into a manifest-neutral compiler input. Exact
TypeScript declaration symbols are recognized, and signed and unsigned 8-, 16-,
32-, 64-, and target-pointer-width integer literals and calls lower through
both backends with no JavaScript-number carrier.

Fixed 64-bit and `isize`/`usize` source boundaries accept only exact BigInt
literals or values already carrying that native type. Pointer-sized ranges come
from SCABI target metadata and are checked against the selected backend. This
is not general JavaScript BigInt support.

Exact same-type `+`, `-`, and `*` wrap at their declared width without C
undefined behavior. `&`, `|`, and `^` operate at exact native width without
routing through JavaScript's `ToInt32`.

### Declaration-backed constants

SCABI integer, enum, and flags values are canonicalized and range-checked, and
package composition rejects identity conflicts. ScriptC lowers reached ambient
symbols directly to Native IR literals — no runtime namespace object, module
load, adapter, or C symbol.

### Aggregates and calling conventions

Nominal, default-packed, trivially copyable native structs are supported when
their fields are exact scalars or nested nominal structs, and their SCABI
metadata carries target Clang's complete physical calling signature.

Direct registers, expanded parameters, ordinary indirect pointers, `byval`, and
`sret` all lower without platform size heuristics. A direct object-literal
assertion constructs aggregate storage without reinterpreting a JavaScript
object: C verifies size, alignment, and offsets at compile time, while LLVM
emits the target's recorded physical signature.

Direct-`i64`, expanded two-`double`, padded indirect, and nested nominal
fixtures pass both backends, including statically typed field reads from
returned values.

### Handles and ownership

Owned, owner-confined opaque handles use a runtime-private managed cell with
alias-safe explicit disposal, automatic exact destruction, and checked borrowed
method ingress.

Direct, representation-preserving handle upcasts are explicit in SCABI and
Native IR, close over transitive ancestors, and preserve the same managed cell
in both backends. The runtime accepts a derived handle at a declared base call
while rejecting undeclared nominal conversions.

### Strings and bytes

| Boundary | Behavior |
| --- | --- |
| Borrowed UTF-8 input | one source string, evaluated once, projected without copying into const data and byte-length ABI slots |
| Checked C string input | one-pointer projection over the runtime's existing trailing NUL; throws before native entry on an embedded NUL |
| Nullable C string input | `string \| null` becomes the checked pointer or `NULL`, including through a runtime union |
| Borrowed C string result | copied into managed UTF-8 storage before the receiver is released; preserves declared `string \| null` |
| Borrowed `Uint8Array` input | exact view offsets and lengths, live backing-store mutation, single evaluation, prompt post-call release, no copy |

Unicode and embedded-NUL behavior, temporary-receiver lifetime, and null
behavior pass both backends and the sanitizer gate. Foreign pointers remain
ABI-only and never enter TypeScript values.

### Callbacks

**Call-scoped** callbacks are implemented for non-variadic C signatures with
exact scalar parameters/results and a required trailing context pointer. One
source closure projects into the physical function/context pair. Captures,
reentrancy, and callback exceptions pass both backends and the sanitizer/RC
audit.

**`until-cancelled`** callbacks are implemented for copied exact-scalar
payloads. Generated C and LLVM thunks admit opaque tokens from same or foreign
threads without touching the ScriptC heap, and the owner invokes the rooted
closure.

Broader payload families and ownership modes remain future slices.

### Foreign-thread ingress and scheduling

An instance-owned, target-wakeable MPSC gateway provides bounded FIFO drains,
explicit shutdown states, and exact event destruction under admission races. It
is threaded and sanitizer-tested.

Retained callback transport tokens build on that queue with slot/generation
identity and one combined atomic state/invocation-lease word, so close and
admission have an exact order and every admitted event stays owned through
delivery or discard. The owner-side table roots active registration anchors
explicitly and retires them only after cancellation and all leases complete.

Owned native handles carry generic lifecycle edges; a result-owned callback
edge closes admission before the native destructor and completes cancellation
only after it returns. Native factories use a prepare/call/commit transaction
so runtime OOM cannot strand a returned resource or a staged registration.

The runtime exposes one-event owner dispatch and a host-callable
nextTick/microtask checkpoint, so batching cannot collapse distinct JavaScript
turns and callback exceptions stay pending for the target error policy.

### Errors

Exact integer `errno` contracts are implemented: the failure sentinel is
checked in its native type, thread-local `errno` is captured before cleanup,
and a symbolic, operation-qualified `Error` is thrown through the ordinary
catch path in both backends.

Nullable owned handle results throw before null wrapping. Non-null results
preserve their exact destructor during ordinary returns and during
callback-exception unwinding.

Other native error conventions remain explicit future slices.

### Booleans

Exact integer-backed native boolean parameters and results use their SCABI
false/true representations directly in both backends while remaining ordinary
TypeScript `boolean` values. Any other native result representation throws a
catchable `TypeError`, including through transitive helper calls.

### Exports

A SCABI `export` root maps an entry-module TypeScript function to an exact C
symbol. Exact `i32` parameters, results, and wrapping `+` compile through both
backends, link into a static library, and execute from an independent C host.
The translation retains the selected C-export adapter's provenance.

Broader export types and artifact-graph materialization remain pending.

## Build

See [Build artifacts](build-artifacts.md) for the normative model.

### Graph and executor

The canonical artifact graph and Linux sandboxed executor content-verify file
and tree sources and tools, compile and link a real host-C product, and reject
cycles, content drift, and undeclared outputs.

Pkg-config include trees resolve to logical SDK artifacts with no host paths in
the plan. Actions can stream tool standard output into a declared, verified,
cacheable metadata artifact, so machine-readable compiler output needs no
shell-redirection escape hatch.

### Cache

A schema-versioned local action cache keys deterministic actions by their
complete logical request and verified input content, verifies every hit,
rejects corrupt entries, and publishes concurrent misses atomically.

### ScriptC integration

ScriptC exposes a schema-versioned, path-free executable-compilation plan
containing validated IR, exact backend/target facts, and its complete native
build request. Native TypeScript runs the corresponding deterministic C/LLVM
emitter as a cacheable graph action, then uses ScriptC's exact compiler-driver
plan without calling a materializer or inventing caller-visible paths. This
keeps ScriptC's runtime-source selection as the single source of truth.

Only reached bindings and native types enter emitted IR or the link.

## Bindings

### C ABI evidence

A target-neutral C binding package converts selected functions and record
fields into one structured, content-addressed ABI probe. Sandboxed target-Clang
actions check candidate types against the real headers, derive selected record
size/alignment and field layout, and emit raw AST plus LLVM
calling-classification evidence.

Correct constructor and method signatures pass; a deliberate const mismatch
fails in Clang, as does a deliberately wrong record field. A deterministic
normalization action reduces the raw, location-bearing AST to canonical
selected ABI evidence.

Cross-target fixtures pin direct x86-64 SysV, expanded AArch64/SysV, and
indirect Windows/SysV forms.

### GIR and GObject

An explicit namespace/class/member selection becomes a content-addressed
immutable snapshot preserving C and GType identity, class ancestry, ownership,
nullability, receivers, and signals, while rejecting malformed or unsupported
reached metadata.

Class references resolve against the namespace boundary: a same-namespace
parent must be selected, and a cross-namespace parent is preserved as an
explicit external reference where the generated package stops.

A dependent binding-package action consumes stable evidence, the exact selected
GIR snapshot, and a canonical generation request. Its content-addressed host
tool regenerates the GObject adapter and emits one immutable package directory
containing TypeScript declarations, validated SCABI, adapter metadata/source,
and provenance. A second build root reuses that package from the local cache.

Gio-2.0 ingests through the same namespace-neutral path as Gtk-4.0.

## GTK target

See [GTK TypeScript API](gtk-api.md) for the normative projection.

### Runtime provider

The GLib adapter attaches the selected `GMainContext` as ScriptC's host
scheduler, composes ScriptC timer deadlines with GLib blocking waits, and uses
asynchronous sources for owner- and foreign-thread callback wakes. Each source
performs exactly one retained-callback dispatch and one microtask checkpoint.
Failure delivery, thread affinity, stop/detach ordering, and source lifetime
are explicit and sanitizer-tested.

### Generated surface

| Projected | Notes |
| --- | --- |
| Managed Widget ancestry | via declared identity upcasts |
| `new Window()`, `Button.withLabel(...)` | canonical and named constructors |
| Native properties | from authoritative GIR getter/setter links |
| Nullable string properties | `Button.label`, `Window.title` |
| Exact `gboolean` methods | both representations |
| Branded `gint` / `gdouble` | parameters and results |
| Nominal enums and flags | Clang-proven storage and member values |
| Record outputs | `Widget.getPreferredSize()` as a nested value |
| Signals | non-detailed `void`, zero or copied exact `gint`/`gdouble` payloads |

Selected constructors generate a content-addressed ownership adapter: GIR
`none` and `full` results become one strong, non-floating reference, and a real
GTK weak-finalization gate proves exact release.

Signal connections share one `SignalConnection` capability. The adapter
strongly retains the signal instance, disconnects by handler ID, and composes
with ScriptC's retained callback lifecycle so no callback runs after disposal.

Reached metadata outside the implemented
handle/`void`/boolean/exact-scalar/NUL-terminated-UTF-8/exact-scalar-signal
algebra fails generation.

### Acceptance application

The application gate chains Clang inspection, evidence normalization, and
package generation as three declared analysis actions, promotes the verified
package into the compiler phase, composes it with the target-runtime package,
and compiles through both backends.

Against real GTK it constructs a `Window`/`Button`/`Box`/`DrawingArea`/`Overlay`
hierarchy, reads and writes nullable `Button.label` and `Window.title`, calls
`Window.setChild()` through the declared Widget upcast, passes both boolean
representations through `Widget.setVisible()`, sets exact `gint` dimensions,
feeds `Widget.getWidth()` back into a native call, round-trips exact `gdouble`
opacity, calls `Widget.activate()` and projects its boolean result, receives
`Button.clicked` and `DrawingArea.resize(sender, width, height)` through
generated receiver-owned connections, and disposes deterministically.

The executable contains no JavaScript engine and no part of the Node build
tool.

## Known boundaries

These are deliberate, not oversights. Each is a named future slice.

- **GTK application lifecycle** is specified in [gtk-api.md](gtk-api.md) but
  not generated. The fixture still starts the GLib runtime and requests its
  stop through hand-authored C.
- **Cross-namespace composition** is not implemented. `Gtk.Application` extends
  `Gio.Application`, so the lifecycle cannot be generated until an external
  reference resolves into a second package.
- **GObject identity, weak handles, and native invalidation** have no general
  policy yet.
- **Non-scalar signal payloads and results**, detailed signals, and broader
  value-method input/output families fail generation.
- **Native toolchain actions are non-cacheable.** Implicit system
  toolchain/library trees are not declared graph inputs, so GTK native actions
  opt out of the implemented cache.
- **Sandbox inputs are not hermetic.** The executor binds the host filesystem
  read-only, so undeclared system headers can still influence a result.
  Declared inputs are content-verified; undeclared ones are not.
- **The Target SPI is descriptor-only.** Providers declare capabilities but
  carry no planning behavior, so GTK is wired directly rather than through the
  SPI.
- **The CLI has no build command.** Application assembly currently lives in the
  integration test.

Platform UI and framework work begins only after the contracts above pass their
conformance gates. See [Roadmap](roadmap.md) for sequencing and exit gates.
