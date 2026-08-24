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
proven against its authoritative SDK metadata and ABI — except GTK, which is
implemented: its example below is the generated API as it exists today.

### Android

An Android application uses Android lifecycle and widget APIs directly; it does
not need a JavaScript bridge or an embedded Node runtime.

```ts
import { Activity } from "@native-typescript/android/app";
import { Bundle } from "@native-typescript/android/os";
import { Button, LinearLayout, TextView } from "@native-typescript/android/widget";

export default class MainActivity extends Activity {
  private count = 0;

  override onCreate(state: Bundle | null): void {
    super.onCreate(state);

    const label = new TextView(this);
    label.text = "Count: 0";

    const increment = new Button(this);
    increment.text = "Increment";
    increment.onClick((): void => {
      label.text = `Count: ${++this.count}`;
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

#### Current Android benchmark

The current three-way release measurement compares the same raw Android
workload in Native TypeScript, direct Kotlin, and plain NativeScript
TypeScript. The NativeScript application uses neither React nor XML UI, and
all timed work uses the same `android.*` objects, calls, iteration counts, and
checksums. These are medians from five cyclically ordered process rounds on an
x86-64 Pixel 10 Pro AVD running API 37, after ART `speed` compilation. Lower
is better.

| Workload | Native TypeScript | Kotlin | NativeScript | NTS / Kotlin | NTS / NativeScript |
| --- | ---: | ---: | ---: | ---: | ---: |
| 128-child view tree | 48,384 ns/child | 39,466 ns/child | 40,140 ns/child | 1.23x | 1.21x |
| lightweight `Rect` construction and `width()` | 222.71 ns/op | 0.30 ns/op | 4,615.52 ns/op | 740.23x | 0.048x |
| managed field, inheritance, `super`, and virtual call | 76.38 ns/dispatch | 1.33 ns/dispatch | 1.96 ns/dispatch | 57.41x | 39.05x |
| `TextView` construction and scalar call | 26,509 ns/op | 25,802 ns/op | 32,765 ns/op | 1.03x | 0.809x |
| repeated `TextView.setTextSize` | 73.74 ns/op | 18.53 ns/op | 257.65 ns/op | 3.98x | 0.286x |
| payload-free synchronous callback | 212.35 ns/delivery | 21.81 ns/delivery | 1,418.76 ns/delivery | 9.74x | 0.150x |
| ASCII/Unicode string arguments | 603.27 ns/comparison | 42.19 ns/comparison | 1,384.77 ns/comparison | 14.30x | 0.436x |
| fresh Java string result | 692.60 ns/result | 249.58 ns/result | 715.84 ns/result | 2.78x | 0.968x |
| 256-byte array encoding round trip | 1,665.12 ns/encoding | 782.88 ns/encoding | 8,935.55 ns/encoding | 2.13x | 0.186x |
| nullable object result plus receiver call | 172.27 ns/lookup | 3.90 ns/lookup | 691.53 ns/lookup | 44.15x | 0.249x |
| callback payload plus receiver call | 297.20 ns/delivery | 4.12 ns/delivery | 2,195.23 ns/delivery | 72.21x | 0.135x |
| captured Android receiver plus callback payload | 323.83 ns/delivery | 5.45 ns/delivery | 2,318.71 ns/delivery | 59.44x | 0.140x |
| dynamic `TextView` counter update | 555.56 ns/update | 295.10 ns/update | 1,579.56 ns/update | 1.88x | 0.352x |
| nested programmatic screen build | 115,030 ns/row | 151,367 ns/row | 159,147 ns/row | 0.76x | 0.723x |

The first matched direct-JVM batch covered ten unchanged scenarios. Their
checked TypeScript loops execute as ART bytecode and call the exact reached
Android members directly; bytecode inspection proves there is no native entry.
The latest matched five-round run measured:

| Workload | Direct JVM | Kotlin | NTS / JNI | NativeScript | Direct / Kotlin | Direct / JNI |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| lightweight `Rect` construction and `width()` | **0.62 ns/op** | 0.30 ns/op | 222.71 ns/op | 4,615.52 ns/op | 2.05x | **0.003x** |
| managed field, inheritance, `super`, and virtual call | **1.30 ns/dispatch** | 1.20 ns/dispatch | 67.04 ns/dispatch | 1.88 ns/dispatch | 1.08x | **0.019x** |
| stable `TextView.setTextSize` receiver | **15.67 ns/call** | 18.53 ns/call | 73.74 ns/call | 257.65 ns/call | **0.85x** | 0.212x |
| same-thread callback | **3.86 ns/delivery** | 21.81 ns/delivery | 212.35 ns/delivery | 1,418.76 ns/delivery | **0.18x** | **0.018x** |
| callback payload plus receiver call | **4.46 ns/delivery** | 4.12 ns/delivery | 297.20 ns/delivery | 2,195.23 ns/delivery | 1.08x | **0.015x** |
| captured Android receiver plus callback payload | **22.89 ns/delivery** | 5.45 ns/delivery | 323.83 ns/delivery | 2,318.71 ns/delivery | 4.20x | **0.071x** |
| ASCII/Unicode string arguments | **33.98 ns/comparison** | 42.19 ns/comparison | 603.27 ns/comparison | 1,384.77 ns/comparison | **0.81x** | 0.056x |
| fresh Java string result | 293.93 ns/result | 249.58 ns/result | 692.60 ns/result | 715.84 ns/result | 1.18x | 0.424x |
| 256-byte array encoding | 870.04 ns/encoding | 782.88 ns/encoding | 1,665.12 ns/encoding | 8,935.55 ns/encoding | 1.11x | 0.523x |
| nullable object result plus receiver call | **2.30 ns/lookup** | 3.90 ns/lookup | 172.27 ns/lookup | 691.53 ns/lookup | **0.59x** | **0.013x** |

The direct-JVM application now implements the complete 22-scenario matrix,
including specialized arrays, fixed records, optional scalar/reference values,
exact typed maps and sets, and primitive JavaScript Math operations. Those newer language-runtime workloads are intentionally absent from
the table until one matched four-APK device batch measures them; no number is
inferred from host bytecode evidence.

The direct JVM tier reuses ScriptC's flow-sensitive number facts to store
proved signed-32-bit locals, immutable literal globals, managed instance
fields, and compiler-private return values as Java `int`. A virtual method
descriptor specializes only when its complete override family agrees, while
public TypeScript `number` returns remain Java `double`.
Overflow, fractions, NaN, infinities, parameters, mutable globals, and
observable `-0` remain `double`.
Ordinary TypeScript classes now become Java classes too: their fields,
inheritance, `super`, object casts, and virtual calls remain in ART without a
native handle or managed peer.
The reference slices also keep Java strings as `java.lang.String`, exact
`T | null` native-handle unions as nullable Java references, and
`Uint8Array` values as Java `byte[]` on the exact direct-call surface. A
generator-stated, classfile-verified listener shell also becomes a Java
implementation whose exact registration arm stores captured Java references
or typed mutable holders and calls the reached TypeScript handler directly in
ART. An idempotent connection clears retained reference state when
cancellation cuts ownership. The
accepted bytecode feeds `Rect.flattenToString()` directly to `String.length()`,
stores/null-tests `getChildAt()` directly before `getId()`, and feeds
`Base64.encode([BI)[B` directly to `arraylength`, and dispatches
`View.OnClickListener.onClick` through a direct static handler call. The payload
handler then null-checks the delivered `View` and calls `getId()` directly,
with no JNI, handle cell, identity scan, tagged union, bytes-copy helper, or
numeric-coercion invocation. The captured-callback kernel preserves mutable
binding aliasing, reuses both the delivered and retained Android receivers,
and is 14.15x faster than the JNI route; it remains 4.20x Kotlin, identifying
captured state as a real remaining direct-tier cost. This is still a kernel APK
rather than a complete Android application backend, so it makes no launch or
memory claim. The first static-call proof is in
[record 0023](docs/records/0023-direct-jvm-android-call.md); constructor and
local instance-call evidence is in
[record 0024](docs/records/0024-direct-jvm-object-calls.md); host-supplied
receivers and the stable setter measurement are in
[record 0025](docs/records/0025-direct-jvm-stable-receiver.md); proved integer
storage and the parity measurement are in
[record 0026](docs/records/0026-proved-jvm-integer-locals.md).
Direct string and nullable-handle representation plus the latest five-kernel
measurement are in
[record 0027](docs/records/0027-direct-jvm-reference-values.md).
Direct `byte[]` residency and the latest six-kernel measurement are in
[record 0028](docs/records/0028-direct-jvm-byte-arrays.md).
Direct same-thread listener delivery and the latest seven-kernel measurement
are in [record 0029](docs/records/0029-direct-jvm-callbacks.md).
Direct callback payload reuse and the preceding eight-kernel measurement are in
[record 0030](docs/records/0030-direct-jvm-callback-payloads.md).
Captured callback state, direct registration-site dispatch, and the latest
nine-kernel measurement are in
[record 0031](docs/records/0031-direct-jvm-callback-captures.md).
Managed class representation, integer fields, and the latest ten-kernel
measurement are in
[record 0032](docs/records/0032-direct-jvm-managed-classes.md).
The controlled integer-return descriptor optimization and its 1.30 ns
managed-class result are in
[record 0034](docs/records/0034-proved-jvm-integer-returns.md).

The post-warm-foreground median memory and packaged artifact observations were:

| Measurement | Native TypeScript | Kotlin | NativeScript |
| --- | ---: | ---: | ---: |
| Total PSS | 16,532 KiB | 16,136 KiB | 72,109 KiB |
| Total RSS | 143,040 KiB | 141,192 KiB | 199,840 KiB |
| APK size | 610,587 bytes | 20,688 bytes | 28,639,848 bytes |

The view-tree result has only five high-variance emulator observations, and
the artifact sizes reflect deliberately different product shapes. They are
recorded observations rather than general platform rankings. The suite now
separates boundary microcases from Android operations and a composite screen:
widget construction remains near Kotlin parity, while callbacks and outbound
strings expose distinct remaining costs. JNI callback and owner turns now
scope the environment they already hold across nested adapter calls; the
targeted setter, light-object, handle-result, and callback medians improved by
12.8–34.1%. Synchronous callback objects now stay in their JNI frame when
whole-program analysis proves they do not escape, reducing the two callback
medians by 27.0–29.1%; its structural proof and matched measurement are in
[record 0020](docs/records/0020-frame-bounded-callback-payloads.md). Short
outbound strings now stage UTF-16 in their native frame, and Java results
borrow JNI's UTF-16 view while allocating only the final UTF-8 owner. The two
isolated string medians fell by 26.8–35.8% raw and their Kotlin-normalized
ratios improved by 10.6–16.0%; the exact mechanics and emulator caveats are in
[record 0021](docs/records/0021-frame-local-jvm-string-bridge.md). The scoped
environment mechanism, falsifier, and before/after evidence are in
[record 0019](docs/records/0019-scoped-jni-environment-capability.md). Nullable
returned objects stay in the JNI local-reference domain when their use does
not escape; that mechanism and before/after evidence are in
[record 0018](docs/records/0018-nullable-frame-bounded-results.md). The first
escape-selected JNI resource optimization and its before/after evidence remain in
[record 0016](docs/records/0016-frame-bounded-native-results.md). The expanded
hotspot matrix, exact inputs, source hashes, and caveats are in
[record 0017](docs/records/0017-android-hotspot-matrix.md). The original
three-way baseline remains in
[record 0015](docs/records/0015-first-android-nativescript-baseline.md); the
reusable instrument and full workload contract are in
[the Android benchmark README](benchmarks/android/README.md).

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
import { applicationStart } from "@native-typescript/gtk-application";
import { Button, Window } from "@native-typescript/gtk4";

if (!applicationStart()) throw new Error("GTK did not start");

let count = 0;
const button = Button.withLabel("Count: 0");
button.onClicked((sender): void => {
  count += 1;
  sender.setLabel(`Count: ${count}`);
});

const window = new Window();
window.setChild(button);
window.present();
```

Which classes and members exist is the project's own decision — generation is
closed over exactly what `native-typescript.json` selects, so an unlisted
member is absent rather than merely unused.

A getter that can report its value as absent projects as a method, not a
property — `window.getTitle()`, not `window.title`. A property claims
field-like stability, and a native getter has none: it calls into the library
on every read. Modelling it as a call is also what keeps
`if (w.getTitle() !== null) use(w.getTitle())` working, which as a property it
would not.

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
- [The foreign boundary](docs/foreign-boundary.md) defines what the compiler
  knows about a call that leaves TypeScript, and what belongs instead to
  generated capsules and to SCABI's evidence.
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

[Implementation status](docs/status.md) is not normative. It records what is
currently built and proven, so the specifications above can stay a statement of
what must be true rather than a changelog. [Open work](docs/open-work.md) is
the companion index: everything deferred, with the reason and the condition
that would admit it, so a reason is never lost by being remembered only in a
conversation.

[Investigation records](docs/records/) are dated findings rather than
specifications. Each states what was measured, what was decided, and what would
supersede it. They are the archive a specification is allowed to assume.

When documents conflict, [Architecture](docs/architecture.md) owns system
invariants. The focused specification owns details in its domain. A conflict
must be resolved in the documents before implementation proceeds.

## Repository layout

```text
packages/
├── bindgen-c/    target-neutral Clang C ABI evidence and probe generation
├── bindgen-gir/  GObject-introspection binding family: GIR ingestion, GObject
│                 adapters, and the GObject SCABI/declaration projection
├── bindgen-jvm/  JVM binding family: class-file ingestion, JNI adapter and
│                 subclass generation, and the JVM SCABI projection
├── cli/          command-line entry point, including `build`
├── core/         build planning and orchestration
├── scabi/        native binding schema, canonicalization, and validation
├── scriptc/      integration with the pinned scriptc fork
├── target-api/   target-provider contracts
├── target-gtk/   GTK target: GLib owner-runtime adapter, process bootstrap,
│                 native object fragment, and the application build pipeline
└── target-jvm/   JVM target: JDK/Android SDK discovery, javac invocation, and
                  the hosted and self-launched application lanes

third_party/
└── scriptc/      pinned fork as a Git submodule

docs/             normative architecture and development documentation
docs/records/     dated investigation records: what was measured and decided
fixtures/         permanent native ABI and conformance fixtures
scripts/          gates and falsifiers that are not part of `pnpm test`
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

Native TypeScript is in early implementation. It is not yet an application
framework or a production compiler.

The C ABI foundation and the GTK vertical slice are the working surface today.
A narrow but real GTK application — window, button, properties, signals, the
`GApplication` lifecycle, deterministic teardown — compiles from TypeScript
through both the C and LLVM backends and runs against real GTK with no
JavaScript engine in the executable.

A second binding family exercises the same boundary against a language rather
than a library. The JVM lane ingests class files directly, generates JNI
adapters and Java subclasses from them, dispatches TypeScript overrides through
a host-constructed object, and reaches the base implementation an override
replaced through javac's own `super`. It runs on the desktop JDK, in a JVM this
runtime created and in one it did not. Android itself is not yet crossed: the
two contract arms a real `Activity` forces — void-synchronous callback delivery
and handle payloads — are named refusals, pinned against the real
`android.jar` so the gate fails the moment either lands.

One command builds one:

```sh
native-typescript build path/to/project
```

The project states which GIR namespaces it wants and which members of them;
everything else — ABI probes, adapter generation, link order — is derived.

| Layer | State |
| --- | --- |
| Exact scalars, aggregates, proven ABI classification | implemented |
| Native handles, ownership, borrowed strings and bytes | implemented |
| Callbacks, foreign-thread ingress, owner scheduling | implemented |
| Artifact graph, sandboxed executor, local action cache | implemented |
| Clang-proven C ABI evidence and GIR/GObject projection | implemented, narrow algebra |
| GTK target runtime and generated widget surface | implemented, narrow surface |
| GTK application lifecycle | generated and executed |
| `build` command, project description, action cache | implemented |
| JVM/Android bindings, JNI adapters, native subclassing and peers | implemented, narrow surface |
| Terminal, iOS, macOS, Windows, React, partitions, DOM | not started |

[Implementation status](docs/status.md) records what is built and proven, by
layer and by gate, including the deliberate boundaries that remain. The
[Roadmap](docs/roadmap.md) defines the sequencing and exit gates that govern
what comes next.

Platform UI and framework work begins only after the current contracts pass
their conformance gates.
