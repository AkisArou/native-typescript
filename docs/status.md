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
| GTK application lifecycle | generated and executed |
| GTK target runtime package | implemented |
| Application build pipeline and `build` command | implemented |
| Provider compiler requirements | read by the build |
| Cross-namespace GIR composition | implemented |
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

A borrowed handle input may also be optional: the source passes the handle or
null while the ABI slot stays one pointer, and the null arm never consults the
handle table. Owned `to-native` handles are excluded, since a destructor takes
the handle it destroys. A derived handle does not yet reach an optional
parameter, because union re-tagging does not consult identity upcasts, so
GObject generation still projects the non-null subset.

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

A class whose parent lives in another namespace projects across the package
boundary, and so does a parameter typed by another namespace's enumeration. SCABI records an imported type owned by the other package, the
generated handle carries an identity upcast to it, and the declaration file
imports the parent under a namespace-qualified alias. Imported type identities
are derived by the same function that produced them in the owning package, so
the two agree by construction rather than by a hand-kept table. Importing is
opt-in: an external parent whose namespace was not supplied still truncates.

Composition is the only stage that sees both packages, so it proves every
handle upcast target is provided, is a handle, and shares its derived handle's
thread-safety and identity contracts. Inside the artifact graph, each imported
namespace is a content-verified snapshot input of the dependent package's
generation action.

A parameter typed by another namespace's enumeration needs no SCABI type
import, unlike a handle: an enumeration lowers to a bare scalar with no
instance-scoped identity, so the type is defined locally for its ABI and only
declared as the owning package's for its identity. The importing package proves
the storage with its own Clang probe. Member constants stay with the owning
package.

Generated adapter symbols are qualified by namespace wherever a class name
would otherwise identify them, because a class name is unique only inside its
namespace and two namespaces link into one executable.

The gates generate gio2 and gtk4 against the installed GIRs, translate both,
and compose them into one program in which `gtk_application` upcasts to
`gio_application`; composing gtk4 alone fails. One artifact graph runs both
analysis subgraphs with real Clang in the sandbox, and both packages' adapter
objects compile and link into one executable.

The whole GApplication lifecycle projects: `new Application(id, flags)`,
`activate()`, `quit()`, `hold()`, `release()`, `getIsRemote()`,
`getApplicationId()`, `setApplicationId()`, `onActivate()`, and `register()`.

`register()` reports failure through a GError, so a generated adapter absorbs
its `GError **` and the boundary sees a pointer that is null on success. One
accessor pair per namespace reads the message and releases the object. The
adapter discards the wrapped call's own result, so this is limited to members
returning `gboolean` or `void`; a member whose result carries information is
refused rather than silently losing it. `gtk_application_new()` projects as
`constructor(applicationId: string | null, flags: GioApplicationFlags)`.

A metadata C spelling is an untrusted candidate that the probe proves, so
equivalent spellings of one type are accepted: `Gio` writes `const gchar*`
where `Gtk` writes `const char*` for the same borrowed UTF-8 parameter.

## GTK target

See [GTK TypeScript API](gtk-api.md) for the normative projection.

### Runtime provider

The GLib adapter attaches the selected `GMainContext` as ScriptC's host
scheduler, composes ScriptC timer deadlines with GLib blocking waits, and uses
asynchronous sources for owner- and foreign-thread callback wakes. Each source
performs exactly one retained-callback dispatch and one microtask checkpoint.
Failure delivery, thread affinity, stop/detach ordering, and source lifetime
are explicit and sanitizer-tested.

### Process bootstrap

`nts_gtk_application.c` initialises GTK, attaches the owner runtime, and tears
both down again. It is the target's own SCABI package rather than generated
code, because it describes hand-written C the target ships. An application
composes it alongside the generated toolkit bindings and its own native code.

Start and shutdown are separate calls with separate verdicts: shutdown reports
whether the retained-callback service was idle when asked to stop, and the
application runs its own teardown checks before calling it so an application
failure is never reported as a runtime one.

The owner runtime and the bootstrap share one source tree and one link, but not
one dialect — the runtime is portable C under `-std=c11 -pedantic`, while the
bootstrap reaches GNU extensions through the GTK headers.

### Proven surface

`fixtures/gtk-widgets` builds a window from 28 GTK classes — labels, entries,
buttons, toggles, switches, adjustments, scales, spin buttons, progress bars,
list boxes and rows, grids, frames, expanders, revealers, stacks, text views,
scrolled windows, header bars, separators, images — and then reads its own
state back. A shared adjustment really is shared between a scale and a spin
button; a list row really knows its index. The gate exists for breadth: a
member that stops projecting fails there rather than being found by whoever
first tried to use it.

Two things a project author meets immediately, both deliberate:

- An exact native scalar is constructed from a literal, never from an arbitrary
  number, because the compiler proves the value is in range.
- **A narrowed read of a nullable native result is refused**, because the
  callee returns what its declaration allows on every call and a read narrowed
  to `string` has nowhere to put a null. The compiler names the cause and the
  fix at the call site: a guard needs the value read once into a local, an
  assignment needs the assigned value widened.

  This is no longer reachable through a generated property. A getter that can
  report its value as absent projects as a method — `window.getTitle()` — so
  the narrowing never arises, and the shape says what is true: each read is a
  call. Properties remain for everything else, where a narrowing is harmless
  because no exact two-arm match is required.
- An array of exact native scalars is not implemented. `[0 as gint]` is
  refused by name; a union carrying one — `gint | undefined`, which is what a
  narrowing or an absent value produces — does work.
- Comparing exact scalars with `<` or `>` is not implemented either; `===` and
  `!==` are.

### Executed lifecycle

An application drives the whole GTK lifecycle from TypeScript with no
hand-written C of its own: `new Application(id, flags)`, `onActivate`,
`register(new Cancellable())`, `getIsRemote`, `activate`, and `quit`. The gate
builds it for both backends, runs it under Xvfb, and requires exact output.

`Application` comes from gtk4 and inherits its lifecycle from gio2 across a
package boundary, so this is also the first proof that cross-namespace
composition survives into a linked, running process rather than only into a
graph. Nothing blocks: `g_application_run()` is never reached, and the
runtime's attached `GMainContext` turns the loop.

Removing the `activate()` call makes the application report a missed activation
through a ScriptC timer instead, so the gate distinguishes "signal not
delivered" from "signal delivered late" rather than hanging.

### Generated surface

| Projected | Notes |
| --- | --- |
| Managed Widget ancestry | via declared identity upcasts |
| `new Window()`, `Button.withLabel(...)` | canonical and named constructors |
| Native properties | from authoritative GIR getter/setter links |
| Nullable string properties | `Button.label`, `Window.title` |
| Exact `gboolean` methods | both representations |
| Branded exact integers | `gint`, `guint`, and every fixed width, separately branded |
| Branded `gdouble` | parameters and results |
| Nominal enums and flags | Clang-proven storage and member values |
| Record outputs | `Widget.getPreferredSize()` as a nested value |
| Signals | non-detailed `void`, payloads of any exact scalar, selected enumeration, or UTF-8 string |

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

## Building an application

`native-typescript build <project>` reads a `native-typescript.json`, generates
the binding packages its namespaces ask for, and links a native executable.
Parsing is strict and total: a project that the build would reject halfway
through is rejected before any work starts, naming the offending field.

The build runs in two phases, because generation is itself a build. The first
graph probes the C ABI with Clang and emits one binding package per namespace;
only once those exist can the second compile and link against them. Both phases
are ordinary artifact graphs, so both are sandboxed and cacheable.

The pipeline is `buildGtkApplication` in the target package rather than
something the command line assembles, so a gate, a command, and any future
editor integration take the same path instead of three reconstructions that can
disagree.

### Runtime services a target requires

ScriptC links a runtime service when the compiled program reaches it. That rule
is right for the program and wrong for the target: the GLib owner runtime calls
the retained-callback service whether or not the application connects a signal.

`ProviderDescriptor.requires.compiler` is now read rather than merely declared.
`nativeRuntimeServices` maps those capabilities onto ScriptC's own vocabulary
and the build passes them to the compiler, so an application that connects
nothing still links. A capability with no mapping is an error: linking without
it would fail on undefined symbols, which says nothing about the requirement
that was never declared.

## Known boundaries

These are deliberate, not oversights. Each is a named future slice.

- **Only two GIR namespaces have ever been linked together.** gio2 and gtk4
  compose and run; nothing proves a third, and no namespace outside the GNOME
  stack has been attempted.
- **A project cannot describe a non-GTK target.** `target` accepts `gtk4` and
  nothing else, and the parser says so rather than pretending otherwise. The
  Target SPI stays descriptor-only until a second target exists to justify its
  shape.
- **Handle identity is specified and unimplemented.** [Ownership](ownership.md)
  already decides it: GObject identity follows the underlying object reference,
  and a binding that declares stable identity gets a target-owned identity map
  so repeated projection reuses one managed entry, with entries removed on
  native invalidation or final release. A SCABI handle already carries
  `identity: "pointer"` to declare it. Nothing maintains the map, so nothing
  can project an object the application did not construct.

  This is the largest gap in the GTK surface, not a corner of it. Of GTK 4's
  methods, **187 return a borrowed same-namespace object** — `get_child`,
  `get_parent`, `get_row_at_index` — and every one is refused today. The 19
  signal payloads carrying a GObject are the same gap seen from the other side.

  Two pieces are missing rather than one: the map itself, and a result
  projection for an object the callee already owns. The adapter is the natural
  home for the map, because it already owns the release function where an entry
  must be removed.
- **Weak handles and native invalidation** have no policy yet.
- **A signal payload must be something the runtime can capture.** Exact scalars
  of every width, selected enumerations, and UTF-8 strings project.

  Measured against GTK 4's 261 void non-detailed signals, **198 project**. What
  remains is GObject and boxed payloads, worth +19 and +8 respectively.

  Delivery is queued to the runtime owner, so a payload cannot be a pointer the
  emitter still owns: GTK may reuse a string the moment emission returns. A
  string is therefore copied when the signal fires, held by the invocation, and
  released whether the delivery runs or is dropped during shutdown — the same
  discipline the registration owner already used.

  A GObject payload needs one thing more: a managed cell made from a raw
  pointer. Retaining and releasing it is the pattern strings just established;
  deciding what cell a bare `GtkWidget*` belongs to is not, because nothing
  proves it is the same cell an existing handle already denotes.

- **Detailed signals and non-void signal results** fail generation, as do
  broader value-method input/output families.
- **`gfloat` does not project.** ScriptC's float slice is exactly `f64`, so
  admitting a 32-bit float would silently widen every value. Members taking one
  are refused by name.
- **Platform-width integers** (`glong`, `gsize`) are absent from the scalar
  table on purpose: their width should come from probe evidence rather than
  from a table that assumes an ABI.
- **The final link is still one action.** Everything before it is reused. The
  ScriptC runtime compiles per source into its own cacheable objects, so an
  application edit recompiles the program and relinks rather than rebuilding
  twenty translation units. Measured on the single-namespace fixture: 6.7 s
  cold, 2.9 s after an application edit, against 7.6 s for either before.

  This is what [Architecture](architecture.md) asks for — an incremental build
  reusing validated artifacts at the narrowest sound boundary — and the link is
  where it stops. Its inputs include the program, so it re-runs whenever the
  application changes, which is correct; what remains is that a link is not
  itself cheap.

- **Sandbox inputs are not hermetic.** The executor binds the host filesystem
  read-only, so undeclared system headers can still influence a result.
  Declared inputs are content-verified; undeclared ones are not.
- **The Target SPI carries no planning behavior.** A provider's
  `requires.compiler` is now load-bearing, but everything else about a target
  is still wired directly: providers cannot plan, and GTK is reached by name.
  The remaining shape waits on a second target to justify it.
- **The CLI has no build command.** Application assembly currently lives in the
  integration test.

Platform UI and framework work begins only after the contracts above pass their
conformance gates. See [Roadmap](roadmap.md) for sequencing and exit gates.
