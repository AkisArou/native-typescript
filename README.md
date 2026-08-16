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
import { applicationStart } from "@native-typescript/gtk-application";
import { Button, Window } from "@native-typescript/gtk4";

if (!applicationStart()) throw new Error("GTK did not start");

let count = 0;
const button = Button.withLabel("Count: 0");
button.onClicked((sender): void => {
  count += 1;
  sender.label = `Count: ${count}`;
});

const window = new Window();
window.setChild(button);
window.present();
```

Which classes and members exist is the project's own decision — generation is
closed over exactly what `native-typescript.json` selects, so an unlisted
member is absent rather than merely unused.

One rough edge is worth knowing before you meet it. A nullable string property
cannot be read through a narrowing, because a native getter returns what its
declaration allows on every call. `if (window.title !== null) use(window.title)`
does not compile; reading once into a local and testing that does. The compiler
explains this at the call site, and
[Implementation status](docs/status.md) records why it is refused rather than
accepted.

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

[Implementation status](docs/status.md) is not normative. It records what is
currently built and proven, so the specifications above can stay a statement of
what must be true rather than a changelog.

When documents conflict, [Architecture](docs/architecture.md) owns system
invariants. The focused specification owns details in its domain. A conflict
must be resolved in the documents before implementation proceeds.

## Repository layout

```text
packages/
├── bindgen-c/    target-neutral Clang C ABI evidence and probe generation
├── bindgen-gir/  GObject-introspection binding family: GIR ingestion, GObject
│                 adapters, and the GObject SCABI/declaration projection
├── cli/          command-line entry point, including `build`
├── core/         build planning and orchestration
├── scabi/        native binding schema, canonicalization, and validation
├── scriptc/      integration with the pinned scriptc fork
├── target-api/   target-provider contracts
└── target-gtk/   GTK target: GLib owner-runtime adapter, process bootstrap,
                  native object fragment, and the application build pipeline

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

Native TypeScript is in early implementation. It is not yet an application
framework or a production compiler.

The C ABI foundation and the first GTK vertical slice are the working surface
today. A narrow but real GTK application — window, button, properties, signals,
the `GApplication` lifecycle, deterministic teardown — compiles from TypeScript
through both the C and LLVM backends and runs against real GTK with no
JavaScript engine in the executable.

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
| Terminal, mobile, React, partitions, DOM | not started |

[Implementation status](docs/status.md) records what is built and proven, by
layer and by gate, including the deliberate boundaries that remain. The
[Roadmap](docs/roadmap.md) defines the sequencing and exit gates that govern
what comes next.

Platform UI and framework work begins only after the current contracts pass
their conformance gates.
