# Native TypeScript

Native TypeScript is an attempt to make TypeScript a practical native systems
and application language without turning it into a framework-specific dialect.
It builds on [scriptc](https://github.com/vercel-labs/scriptc) and extends its
static compiler, runtime, and native ABI so TypeScript can target native
libraries, operating-system APIs, native UI toolkits, mobile applications,
terminal applications, React renderers, and—if the engineering proves
viable—the browser DOM.

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
layer. Android, Apple, GTK, Windows, terminal, C, POSIX, and future platform
surfaces remain directly accessible. A JavaScript engine may be selected as an
explicit compatibility realm, but is never introduced silently.

The following sketches show the intended direct, non-React experience. Package
names and API details are directional until each target is implemented and
proven against its authoritative SDK metadata and ABI.

### Android

An Android application uses Android lifecycle and widget APIs directly; it does
not need a JavaScript bridge or an embedded Node runtime.

```ts
import { Activity } from "@native-typescript/android/app";
import { Bundle } from "@native-typescript/android/os";
import { Button, LinearLayout, TextView } from "@native-typescript/android/widget";

export default class MainActivity extends Activity {
  override onCreate(state: Bundle | null): void {
    super.onCreate(state);

    let count = 0;
    const label = new TextView(this);
    label.text = "Count: 0";

    const increment = new Button(this);
    increment.text = "Increment";
    increment.onClick((): void => {
      label.text = `Count: ${++count}`;
    });

    const content = new LinearLayout(this);
    content.orientation = LinearLayout.Vertical;
    content.addView(label);
    content.addView(increment);
    this.setContentView(content);
  }
}
```

The platform still constructs the activity named by the generated application
manifest. A generated Java/JNI subclass associates that host-owned object with
the `MainActivity` TypeScript peer, dispatches the reached override, and lowers
`super.onCreate()` to the exact native base implementation. The generated
ingress function is not a second public lifecycle API.

### iOS

UIKit remains available as an ordinary native target surface, with Objective-C
ownership and main-thread rules represented by its generated bindings.

```ts
import { UIButton, UILabel, UIStackView, UIViewController } from "@native-typescript/apple/uikit";

export default class CounterViewController extends UIViewController {
  override viewDidLoad(): void {
    super.viewDidLoad();

    let count = 0;
    const label = new UILabel({ text: "Count: 0" });
    const button = UIButton.system({ title: "Increment" });
    button.onPrimaryAction((): void => {
      label.text = `Count: ${++count}`;
    });

    this.view = new UIStackView({
      axis: "vertical",
      arrangedSubviews: [label, button],
    });
  }
}
```

### macOS

The same Apple target family can expose AppKit without routing the application
through a browser view or cross-platform UI abstraction.

```ts
import { Button, StackView, TextField, ViewController } from "@native-typescript/apple/appkit";

export default class CounterViewController extends ViewController {
  override loadView(): void {
    let count = 0;
    const label = TextField.label("Count: 0");
    const button = Button.withTitle("Increment");
    button.onAction((): void => {
      label.stringValue = `Count: ${++count}`;
    });

    this.view = new StackView({ views: [label, button] });
  }
}
```

UIKit and AppKit use generated Objective-C-compatible subclasses or protocol
adapters for the same reason: controller/delegate lifecycle remains visible as
ordinary TypeScript inheritance, while registration, peer identity, ARC, and
selector dispatch remain generated native artifacts.

### GTK

GTK is the first implemented application target and establishes the binding,
ownership, callback, and artifact path that broader target work builds on.

```ts
import { Button, Window } from "@native-typescript/gtk4";

let count = 0;
const button = Button.withLabel("Count: 0");
button.onClicked((sender): void => {
  sender.label = `Count: ${++count}`;
});

const window = new Window();
window.child = button;
window.present();
```

### Windows

Windows applications can target the native Windows application SDK directly;
React is an optional renderer above this surface, not its owner.

```ts
import {
  Application,
  Button,
  LaunchActivatedEventArgs,
  StackPanel,
  TextBlock,
  Window,
} from "@native-typescript/windows/winui3";

export default class CounterApplication extends Application {
  private window: Window | null = null;

  override onLaunched(_event: LaunchActivatedEventArgs): void {
    let count = 0;
    const label = new TextBlock({ text: "Count: 0" });
    const button = new Button({ content: "Increment" });
    button.onClick((): void => {
      label.text = `Count: ${++count}`;
    });

    const window = new Window();
    window.content = new StackPanel({ children: [label, button] });
    window.activate();
    this.window = window;
  }
}
```

### Terminal

A terminal application is an environment composed over its real Linux, macOS,
or Windows executable target. Native TypeScript owns the terminal session,
screen, input, and direct TUI API; curses and React remain optional libraries
above or beside that surface.

```ts
import { TerminalSession } from "@native-typescript/terminal";
import { TuiApplication, column, text } from "@native-typescript/tui";

const terminal = await TerminalSession.open({ presentation: "fullscreen" });
let count = 0;

const app = new TuiApplication({
  render: () => column(
    text("Native TypeScript", { bold: true }),
    text(`Count: ${count}`),
    text("Press ↑ to increment"),
  ),
  input(event): void {
    if (event.type === "key" && event.key === "ArrowUp") {
      count++;
      app.invalidate();
    }
  },
});

try {
  await app.run(terminal);
} finally {
  terminal.close();
}
```

### C

C libraries are usable through verified headers and generated SCABI rather than
hand-written foreign-function casts. Exact C scalar types remain visible where
their width or signedness matters.

```ts
import { strlen } from "@native-typescript/c/string";
import type { size_t } from "@native-typescript/c/types";

const byteLength: size_t = strlen("native TypeScript");
```

### POSIX

POSIX is a systems surface rather than an application framework. Calls expose
their real error and resource contracts to the compiler.

```ts
import { O_RDONLY, close, open, read } from "@native-typescript/posix";

const fd = open("/etc/hostname", O_RDONLY);
try {
  const buffer = new Uint8Array(256);
  const bytesRead = read(fd, buffer);
  process.stdout.write(buffer.subarray(0, bytesRead));
} finally {
  close(fd);
}
```

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
- [GTK TypeScript API](docs/gtk-api.md) defines the final source projection,
  construction, properties, signals, and automatic lifecycle rules.
- [Native subclassing](docs/native-subclassing.md) defines host-owned platform
  construction, TypeScript overrides, native `super` dispatch, and peer
  lifecycle.
- [Terminal application environment](docs/terminal.md) defines OS-target
  environment composition, sessions, transports, protocols, cells, input, TUI,
  and React layering.
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
├── bindgen-c/    target-neutral Clang C ABI evidence and probe generation
├── cli/          command-line entry point
├── core/         build planning and orchestration
├── scabi/        native binding schema, canonicalization, and validation
├── scriptc/      integration with the pinned scriptc fork
├── target-api/   target-provider contracts
└── target-gtk/   GTK target metadata and GLib owner-runtime adapter

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
general JavaScript BigInt support. Declaration-backed compile-time constants now
use that same exact representation: SCABI integer, enum, and flags values are
canonicalized and range-checked, package composition rejects identity conflicts,
and ScriptC lowers reached ambient symbols directly to Native IR literals without
a runtime namespace object, module load, adapter, or C symbol. GTK now consumes
that permanent path: selected GIR enums retain their source and C identities,
target Clang proves their exact storage and member values, and the generated
nominal `Orientation` API drives `Box(Orientation.Vertical, spacing)` in the real
GTK app through both backends. The distinct SCABI flags kind now follows the
same proven path: `EventControllerScrollFlags` enters a constructor and
round-trips through its generated property, then compares at its exact native
width without becoming an untyped number.
The same permanent path now supports nominal,
default-packed, trivially copyable native structs whose fields are exact scalars
or nested nominal native structs and whose SCABI metadata carries target
Clang's complete physical calling signature. Direct registers, expanded
parameters, ordinary indirect pointers,
`byval`, and `sret` lower without platform size heuristics. A direct
object-literal assertion constructs aggregate storage without reinterpreting a
JavaScript object; C verifies size, alignment, and offsets at compile time, while
LLVM emits the target's recorded physical signature. Direct-`i64`, expanded
two-`double`, padded indirect, and nested nominal fixtures pass through both
backends, including statically typed field reads from returned values. GTK generation now exposes
the Clang-proven `Requisition` layout and direct classification as a public
nominal declaration and SCABI type. Its first caller-allocated record-output
adapter projects `Widget.getPreferredSize()` as an immutable nested value;
Clang proves the generated adapter record and the real GTK executable reads it.
Owned, owner-confined opaque handles now use
a runtime-private managed
cell with alias-safe explicit disposal, automatic exact destruction, and
checked borrowed method ingress. Direct, representation-preserving handle
upcasts are explicit in SCABI and Native IR, close over transitive ancestors,
and preserve the same managed cell in both backends. The runtime accepts a
derived handle at a declared base call while continuing to reject undeclared
nominal conversions. Borrowed UTF-8 input is also implemented as
one source string evaluated once and projected without copying into const data
and byte-length ABI slots; Unicode and embedded NUL behavior passes both
backends. Conventional C strings use a separate one-pointer projection over
the runtime's existing trailing NUL and throw before native entry on an
embedded NUL; normal and rejection paths pass C and LLVM. The reverse borrowed
C-string boundary is distinct from the physical pointer result: ScriptC copies
a checked receiver-anchored `const char *` into managed UTF-8 storage before
releasing the receiver and preserves declared `string | null` nullability.
Temporary-receiver lifetime and null behavior pass C, LLVM, and the sanitizer
gate. Borrowed `Uint8Array`
input follows the same logical-to-physical
projection path without copying. Exact view offsets and lengths, live
backing-store mutation, single evaluation, and prompt post-call release pass
both backends and the sanitizer/RC audit. Foreign pointers remain ABI-only and
cannot enter TypeScript values. Synchronous call-scoped callbacks are also
implemented for non-variadic C signatures with exact scalar parameters/results
and a required trailing context pointer. One source closure is projected into
the physical function/context pair; captures, reentrancy, and callback
exceptions pass both backends and the sanitizer/RC audit. Retained
`until-cancelled` callbacks are now implemented for copied exact-scalar
payloads: generated C and LLVM thunks admit opaque tokens from same or foreign
threads without touching the ScriptC heap, and the owner invokes the rooted
closure. Broader payload families and ownership modes remain future slices. Exact integer
`errno` contracts are also implemented: the failure sentinel is checked in its
native type, thread-local `errno` is captured before cleanup, and a symbolic,
operation-qualified `Error` is thrown through the ordinary catch path in both
backends. Nullable owned handle results also throw before null wrapping;
non-null results preserve their exact destructor during ordinary returns and
callback-exception unwinding. Other native error conventions remain explicit
future slices. Exact integer-backed native boolean parameters and results now
use their SCABI false/true representations directly in both backends while
remaining ordinary TypeScript `boolean` values. Any other native result
representation throws a catchable `TypeError`, including through transitive
helper calls. The ScriptC fork now
also has the standalone foreign-thread
ingress foundation: an
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
returns. Native factories use a prepare/call/commit transaction so runtime OOM
cannot strand a returned resource or staged callback registration. The runtime
also exposes one-event owner dispatch and a host-callable nextTick/microtask
checkpoint; this prevents batching from collapsing distinct JavaScript turns
and leaves callback exceptions pending for the target error policy. A concrete
GLib adapter now posts those turns to an attached `GMainContext` from owner or
foreign threads without inline reentrancy. It routes callback/checkpoint
failures through an owner-side sink and passes plain, ASan/UBSan, and TSan
conformance. The first canonical artifact graph and Linux sandboxed executor
now content-verify file/tree sources and tools, compile and link a real host-C
product, and reject cycles, content drift, and undeclared outputs. Pkg-config
include trees resolve to logical SDK artifacts without host paths in the plan,
and the real GTK fixture's GLib runtime and wrapper objects use that path. A
schema-versioned local action cache now keys deterministic actions by their
complete logical request and verified input content, verifies every hit, rejects
corrupt entries, and publishes concurrent misses atomically. Actions can stream
tool standard output into a declared, verified, cacheable metadata artifact;
machine-readable compiler output therefore needs no shell-redirection escape
hatch.
ScriptC now exposes a schema-versioned, path-free executable-compilation plan
containing validated IR, exact backend/target facts, and its complete native
build request. Native TypeScript runs the corresponding deterministic C/LLVM
emitter as a cacheable graph action, then uses ScriptC's exact compiler-driver
plan without calling a materializer or inventing caller-visible paths. This
preserves ScriptC's runtime-source selection as the single source of truth. The
GTK fixture materializes that generated unit, its adapter objects, ScriptC
runtime, and the final executable in one graph. Implicit system
toolchain/library trees are not declared graph inputs yet, so the GTK native
actions remain deliberately non-cacheable. Only reached bindings and native
types enter emitted IR or the link. The GTK target now also turns an explicit
namespace/class/member selection from GIR into a
content-addressed immutable snapshot. Real `Gtk.Widget`, `Gtk.Button`, and
`Gtk.Window` ingestion preserves C and GType identity, class ancestry,
ownership, nullability, receivers, and signals while
rejecting malformed or unsupported reached metadata. A target-neutral C binding
package now converts selected functions and record fields into one structured,
content-addressed ABI probe. Sandboxed target-Clang actions check candidate types
against the real headers, derive selected record size/alignment and field layout,
and emit raw AST plus LLVM calling-classification evidence; correct
Button and Window constructor/method signatures pass and a deliberate const
mismatch fails in Clang, as does a deliberately wrong record field. A deterministic
normalization action reduces that raw, location-bearing AST to canonical selected
ABI evidence. A dependent
binding-package action consumes the stable evidence together with the exact
selected GIR snapshot and a canonical generation request. Their
content-addressed host tool regenerates the GObject adapter and emits one
immutable package directory containing TypeScript declarations, validated
SCABI, adapter metadata/source, and package provenance. A second build root
reuses that package from the local action cache.
The same evidence path selects the transparent `Gtk.Requisition` GIR record and
has target Clang prove its size, alignment, field types, offsets, sizes, and
alignments plus its direct x86-64 SysV `i64` parameter/result ABI. Cross-target
fixtures also pin expanded AArch64/SysV forms and indirect Windows/SysV forms.
The generated package publishes that layout as `Requisition`, SCABI carries the
closed physical signature, and ScriptC consumes it without guessing an ABI from
layout. Adapter-owned records are probe inputs too: `Widget.getPreferredSize()`
calls GTK once and returns a Clang-classified `WidgetPreferredSize` containing
two nested `Requisition` values.
The native application never contains that Node build tool. The generated
surface covers managed Widget ancestry, class-based `new Window()` and
`Button.withLabel(...)` construction, automatic release, native properties,
borrowed handle
parameters, exact `gboolean` methods, branded
`gint`/`gdouble` parameters and results, and one shared `SignalConnection`
capability for non-detailed `void` signals with zero or copied exact
`gint`/`gdouble` payloads. The adapter strongly retains the signal instance,
disconnects by its handler ID, and composes with ScriptC's retained callback
lifecycle so no callback runs after disposal.
Reached metadata outside the implemented
handle/void/boolean/exact-scalar/NUL-terminated UTF-8/exact-scalar-signal
algebra fails generation.
The application gate now chains Clang inspection, evidence normalization, and
package generation as three declared analysis actions, promotes the verified
package artifact into the compiler phase, composes it with the target-runtime
package, and compiles
both ScriptC backends, and executes constructor, nullable `Button.label`
property reads and writes,
`Window.setChild(button)` through the declared Widget upcast, destruction, and
disposal against real GTK. It passes both boolean representations through
generated `Widget.setVisible(boolean)`, sets `Window` dimensions with exact
`gint` values, feeds `Widget.getWidth()` back into a native call, round-trips
exact `gdouble` through the `Widget.opacity` property, then calls
`Widget.activate()`, projects its native boolean result, and receives the
resulting real `Button.clicked` through the generated receiver-owned connection.
The same application builds a real `DrawingArea`/`Overlay`, receives
`DrawingArea.resize(sender, width, height)`, and feeds both copied `gint`
payloads back through generated native methods on both backends.
The remaining hand-authored fixture is
limited to host-loop/completion control and an independent counter turn. Record
layout, non-scalar signal-payload/result lowering, and GObject identity and
weak-reference policy remain. Selected
constructors now also generate a
content-addressed ownership adapter: GIR `none` and `full` results become one
strong, non-floating reference, the object is compiled through the artifact
graph, and a real GTK weak-finalization gate proves exact release. The first
reverse boundary is now implemented too: a SCABI
`export` root explicitly maps an entry-module TypeScript function to an exact
C symbol. Exact `i32` parameters, results, and wrapping `+` compile through C
and LLVM, link into a static library, and execute from an independent C host;
the translation retains the selected C-export adapter's provenance. Broader
export types and artifact-graph materialization remain pending.
Platform UI and framework work begins only after those contracts pass their
conformance gates.
