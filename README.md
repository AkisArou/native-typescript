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

The current release measurement runs four equivalent programmatic Android
applications: Native TypeScript through ScriptC C/JNI, the experimental
Direct JVM compiler tier, Kotlin, and plain NativeScript TypeScript. The
NativeScript app uses neither React nor XML UI. Every route uses the same
Android objects, inputs, iteration counts, and checked results.

These are medians from three cyclic process rounds on an x86-64 Pixel 10 Pro
AVD running API 37, after ART `speed` compilation. Each repeated workload has
21 measured samples; `view-tree` has one sample per process round. Lower is
better. Ratios below compare the Direct JVM tier with Kotlin and NativeScript.

| Workload | Native/JNI | Direct JVM | Kotlin | NativeScript | Direct/Kotlin | Direct/NS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| View-tree child | 101,546.11 ns | 175,123.23 ns | 64,668.13 ns | 46,687.16 ns | 2.71x | 3.75x |
| Lightweight object | 242.36 ns | 0.68 ns | 0.34 ns | 3,759.45 ns | 2.01x | 0.00018x |
| Managed-class dispatch | 59.62 ns | 1.48 ns | 1.31 ns | 2.20 ns | 1.13x | 0.67x |
| Widget construction | 29,173.87 ns | 26,080.33 ns | 24,191.67 ns | 30,892.12 ns | 1.08x | 0.84x |
| Stable scalar setter | 78.01 ns | 63.38 ns | 18.68 ns | 362.58 ns | 3.39x | 0.17x |
| Same-thread callback | 189.99 ns | 20.87 ns | 20.01 ns | 1,617.98 ns | 1.04x | 0.013x |
| Two string arguments | 628.27 ns | 67.17 ns | 32.53 ns | 1,505.59 ns | 2.07x | 0.045x |
| Fresh string result | 662.50 ns | 224.17 ns | 230.47 ns | 773.62 ns | 0.97x | 0.29x |
| String operations | 661.69 ns | 2,652.96 ns | 2,393.09 ns | 341.81 ns | 1.11x | 7.76x |
| Array operations | 207.71 ns | 230.62 ns | 126.50 ns | 71.16 ns | 1.82x | 3.24x |
| Array pipeline | 673.91 ns | 460.55 ns | 295.55 ns | 171.19 ns | 1.56x | 2.69x |
| Fixed record | 88.61 ns | 69.32 ns | 1.42 ns | 0.90 ns | 48.90x | 77.13x |
| Optional values | 101.04 ns | 67.14 ns | 7.30 ns | 1.78 ns | 9.20x | 37.66x |
| Map operations | 116.27 ns | 90.26 ns | 38.02 ns | 21.60 ns | 2.37x | 4.18x |
| Set operations | 72.29 ns | 101.07 ns | 12.57 ns | 12.64 ns | 8.04x | 8.00x |
| Math operations | 30.41 ns | 75.62 ns | 26.27 ns | 8.74 ns | 2.88x | 8.65x |
| Number parsing | 111.61 ns | 250.10 ns | 161.01 ns | 102.47 ns | 1.55x | 2.44x |
| 256-byte array encoding | 1,479.62 ns | 609.06 ns | 525.18 ns | 8,693.67 ns | 1.16x | 0.070x |
| Nullable object result | 222.66 ns | 36.48 ns | 3.69 ns | 785.93 ns | 9.89x | 0.046x |
| Callback payload | 265.72 ns | 21.34 ns | 26.76 ns | 2,300.74 ns | 0.80x | 0.0093x |
| Captured callback | 361.49 ns | 26.03 ns | 27.72 ns | 2,394.53 ns | 0.94x | 0.0109x |
| Dynamic text update | 503.91 ns | 510.20 ns | 292.44 ns | 1,754.65 ns | 1.74x | 0.29x |
| Composite screen row | 154,681.97 ns | 110,294.72 ns | 118,639.09 ns | 148,144.09 ns | 0.93x | 0.74x |

Direct JVM is already within 16% of Kotlin for managed dispatch, widget
construction, callbacks, string results, byte arrays, string operations, and
the composite screen. It wins the measured string-result, callback-payload,
callback-capture, and screen-row comparisons. The largest actionable Direct
JVM gaps in this complete baseline were fixed records (48.90x), returned
handles (9.89x), optionals
(9.20x), sets (8.04x), stable setters (3.39x), Math (2.88x), maps (2.37x),
string arguments (2.07x), arrays (1.56–1.82x), and number parsing (1.55x).
NativeScript's mature V8 runtime wins several pure JavaScript kernels, while
Direct JVM is far faster on the measured Android boundary and callback paths.

The first compiler optimization selected from that matrix is now measured in
a focused five-round run. Closed helpers whose every caller supplies a proved
signed integer use an internal Java `int` parameter while public TypeScript
`number` entry points remain `double`. Fixed records improved from 69.32 ns to
3.13 ns (48.90x Kotlin to 1.56x), sets from 101.07 ns to 23.41 ns (8.04x to
1.67x), and Math from 75.62 ns to 32.86 ns (2.88x to 1.27x). The proof,
safety boundary, complete focused table, and raw report are in
[record 0045](docs/records/0045-direct-jvm-integer-parameters.md); the table
above remains the last complete 23-scenario application matrix.

A second focused optimization now keeps `number | null | undefined` in one
primitive JVM word instead of allocating a tagged object. Optional lookups
improved from 28.69 ns to **1.47 ns** (3.12x Kotlin to **0.23x**), while the
map workload improved from 97.60 ns to **36.77 ns** (2.12x to **1.26x**).
The same inspection remeasured returned handles at 3.19 ns, or 1.13x Kotlin;
their earlier 9.89x result was also removed by integer parameter
specialization and required no handle-specific representation. The exact
encoding, semantic observers, and five-round device reports are in
[record 0046](docs/records/0046-direct-jvm-primitive-number-unions.md).

The next focused optimization declares the Direct JVM array representation's
existing signed-int length bound to shared integer inference and removes the
one-element Java varargs allocation from `push(value)`. The idiomatic
map → filter → reduce workload improved from 647.30 ns to **234.96 ns**
(1.58x Kotlin to **0.82x**) in a repeated five-round run. The ordinary dynamic
array lifecycle improved from 233.52 ns to 162.65 ns in raw time, although its
Kotlin-normalized ratio did not improve across the noisier cross-run baseline.
The target boundary, bytecode proof, and both device reports are in
[record 0047](docs/records/0047-direct-jvm-int-bounded-arrays.md).

The remaining ordinary-array trace exposed a second independent allocation:
`push(a, b)` constructed a two-element Java varargs array on every call. A
fixed two-value overload removed it while preserving the general variadic and
spread paths. In two five-round device runs, the dynamic array lifecycle fell
from 156.63/162.65 ns to **141.37/144.07 ns** (9.7%/11.4%), and its
Direct/Kotlin ratio improved from 1.60x/1.80x to **1.32x/1.30x**. The exact
bytecode and repeated measurement are in
[record 0048](docs/records/0048-direct-jvm-fixed-two-value-push.md).

With the argument allocation gone, the same trace exposed one remaining copy:
the exact four-value literal grew its backing array when the immediately
following two-value append ran. Direct JVM now reserves the exact six slots
while keeping the literal's logical length at four and executing `push` at its
original statement. In two more five-round runs, the lifecycle fell from
141.37/144.07 ns to **103.80/85.55 ns** (26.6%/40.6%), moving its
Direct/Kotlin ratio from 1.32x/1.30x to **1.008x/0.782x**. The deliberately
disagreeing evaluation-order proof and repeated device results are in
[record 0049](docs/records/0049-direct-jvm-array-capacity-planning.md).

A fresh five-round priority batch then showed that earlier general compiler
work had already moved the stable setter to 1.06x Kotlin and two-string calls
to 1.01x; neither old gap needed a local workaround. Number parsing remained
stable at 1.39x Kotlin. Its common short-integer path now preserves proved
radices as Java `int` and accumulates validated prefixes during the first scan
instead of scanning them twice. Two device runs reduced the parsed triple from
188.46 ns to **165.70/160.00 ns** (12.1%/15.1%), improving Direct/Kotlin to
**1.29x/1.19x** without weakening huge-value or invalid-input semantics. The
full Node-bit-vector proof and reports are in
[record 0050](docs/records/0050-direct-jvm-short-integer-parsing.md).

The remaining dynamic text-update gap came from materializing
`Integer.toString(value)` before Java built the final template string. Exact
signed integers and booleans now enter the final JVM concatenation directly;
general doubles retain the JavaScript-exact formatter, and a disagreeing
two-substitution fixture prevents accidental numeric addition. Repeated device
runs reduce the Android text update from 335.67 ns to **258.90/252.95 ns**
(22.9%/24.6%) and improve Direct/Kotlin from 1.52x to **1.18x/1.09x**. The
unchanged string-operation control remains in its prior range. See
[record 0051](docs/records/0051-direct-jvm-primitive-string-concat.md).

Static `Math.trunc` and JavaScript `Math.round` also classified NaN, infinity,
and zero before calling JVM operations that already preserve or propagate
those values. Removing the redundant guards preserves the full special-value
domain, now covered by an all-bits edge fixture, while repeated device runs
reduce the math workload from 43.10 ns to **19.59/21.57 ns**
(54.5%/50.0%). Direct JVM moves from 1.48x Kotlin to **0.68x/0.80x**; see
[record 0052](docs/records/0052-direct-jvm-math-special-values.md).

Four matched probes now separate string normalization, slicing, padding, and
search. Only padding remained materially behind Kotlin. A single final-sized
builder improves Direct JVM `padEnd` from 533.13 ns to **227.56/302.67 ns**
in repeated runs (2.50x Kotlin to **1.05x/1.35x**), while the unchanged
aggregate string workload reaches 1.03x Kotlin. See
[record 0053](docs/records/0053-direct-jvm-single-builder-padding.md).

The complete matrix also measured application shape:

| Measurement | Native/JNI | Direct JVM | Kotlin | NativeScript |
| --- | ---: | ---: | ---: | ---: |
| Process launch | 461 ms | 477 ms | 456 ms | 796 ms |
| Warm foreground | 89 ms | 68 ms | 28 ms | 37 ms |
| Total PSS | 18,503 KiB | 17,586 KiB | 18,673 KiB | 76,102 KiB |
| Total RSS | 143,816 KiB | 141,480 KiB | 142,948 KiB | 203,140 KiB |
| APK size | 811,291 B | 61,648 B | 2,461,904 B | 28,640,616 B |

The sub-nanosecond lightweight-object results describe an optimized loop, not
literal allocation latency. `view-tree` has only three high-variance emulator
samples; the 21-sample composite screen is the stronger application-shaped
observation. APK sizes reflect different product shapes and the Kotlin APK now
includes its reached standard library. These are measurements of this pinned
fixture, not general platform rankings.

The complete contract, raw-run coordinates, operation counts, and next
optimization priorities are recorded in
[record 0044](docs/records/0044-first-complete-direct-jvm-matrix.md). The
JavaScript-exact parser and its device result are in
[record 0043](docs/records/0043-direct-jvm-number-parsing.md). Earlier JNI
resource-domain optimizations remain documented in
[records 0016–0021](docs/records/0016-frame-bounded-native-results.md), and the
reproducible instrument is described in
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
