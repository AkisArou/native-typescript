# GTK TypeScript API

Status: normative direction; generated subset under implementation  
Last revised: 2026-08-15

This document defines the source-level API generated from supported GTK,
GDK, GLib, GObject, Gio, and related introspection namespaces. GIR and the
matching C headers determine what exists and how it reaches native code; this
projection determines how that surface reads in TypeScript.

The public API is not a transliteration of C and it is not a compatibility
clone of GJS. It is an idiomatic, statically checkable TypeScript view over the
same native libraries. SCABI retains the exact ABI names, ownership, native
types, and adapter entries beneath this view.

## Modules and imports

Each GIR namespace/version is an ordinary ESM package with named exports:

```ts
import { Application, ApplicationWindow } from "@native-typescript/gtk4";
import { SimpleAction } from "@native-typescript/gio2";
```

A namespace import is the standard ESM spelling over the same declarations,
not a different compatibility layer:

```ts
import * as Gtk from "@native-typescript/gtk4";

const button = Gtk.Button.withLabel("Count: 0");
```

Applications may mix named and namespace imports. Reachability determines
which bindings, adapters, and link edges enter the artifact; it does not make
unreached declarations disappear from editor completion.

A published or locally generated package contains declarations for its entire
supported SDK surface. Unsupported metadata produces an explicit generation
diagnostic. It is never omitted merely because the current application does
not use it.

## Naming

- GIR namespaces become package boundaries.
- Classes, interfaces, records, enums, and flags use `UpperCamelCase`.
- Methods, properties, parameters, and functions use `lowerCamelCase`.
- Acronyms are treated as words, so `URI` becomes `Uri` in a compound name.
- The original GIR and C identities remain in SCABI and provenance; source
  spelling is not used to infer an ABI symbol.
- Names that collide with TypeScript syntax or with another projected member
  are resolved by deterministic, documented generator rules. An unresolved
  collision is an error.

Free native functions remain named exports when there is no semantic receiver
or constructed class. A C prefix alone is not evidence that a function belongs
on a class.

## Objects and construction

GObject classes project as TypeScript classes with their declared inheritance.
The class is a compile-time native declaration identity, not a JavaScript
constructor object materialized at runtime.

The canonical zero-configuration GIR constructor becomes `new Class()`.
Additional named constructors become static methods after removing the
`new_` prefix:

```ts
export declare class Widget {
  protected constructor();
}

export declare class Button extends Widget {
  constructor();
  static withLabel(label: string): Button;
}
```

Therefore `gtk_button_new()` and `gtk_button_new_with_label()` are used as:

```ts
const plain = new Button();
const labelled = Button.withLabel("Count: 0");
```

If no unambiguous canonical constructor exists, the class has no public
constructor. Static named constructors remain available. A nullable native
constructor is exposed only through a source contract that represents failure
explicitly; `new` never silently produces `null`.

Constructor property bags are a later projection over authoritative writable
GObject property metadata. They must not be guessed from setter names, and they
must preserve construction-only and required-property rules.

### Ancestry and the namespace boundary

GIR spells a same-namespace parent as a bare name (`Button` extends `Widget`)
and a cross-namespace parent as a qualified one (`Gtk.Application` extends
`Gio.Application`). The selected snapshot preserves that distinction instead of
carrying an unresolved string, because it decides whether the parent can be
projected into this package at all.

A same-namespace parent must be part of the selection. Selecting a class
without it fails ingestion rather than emitting a class whose `extends` clause
and identity upcast were silently dropped. Selecting the parent with no members
is the way to carry ancestry without projecting its surface:

```ts
classes: [{ name: "Widget" }, { name: "Button", methods: ["set_label"] }]
```

A cross-namespace parent is the deliberate edge of the generated package. The
snapshot records it as an external reference naming the other namespace, and
generation stops there. `Gtk.Widget` therefore roots the projected hierarchy
even though GIR declares it as extending `GObject.InitiallyUnowned`.

An external parent is resolved only when the owning namespace is supplied to
generation. Importing is opt-in, so omitting it truncates deliberately, which
is how `Gtk.Widget` roots its hierarchy despite extending
`GObject.InitiallyUnowned`.

When the owning namespace is supplied, the parent projects across the package
boundary:

```ts
import type { Application as GioApplication } from "@native-typescript/gio2";

export declare class Application extends GioApplication {
  // ...
}
```

SCABI records the same edge as an imported type owned by `gio2`, and the
generated handle carries an identity upcast to it. The importing package never
defines the type. Composition proves the owning package is present; see
[Binding ABI](binding-abi.md).

Imported type identities are derived by the same function that produced them in
the owning package, so the two agree by construction rather than by a hand-kept
table.

## Methods and properties

Ordinary instance operations become methods. A getter/setter pair becomes a
property only when GIR property metadata or a proven generator rule establishes
one coherent property contract:

```ts
export declare class Button extends Widget {
  get label(): string | null;
  set label(value: string);

  setChild(child: Widget | null): void;
}
```

The generator does not hide semantically distinct operations behind a
property. When a getter can fail, is asynchronous, has observable side effects,
requires additional parameters, or disagrees with the setter type, methods are
kept instead.

Caller-allocated record outputs do not surface as mutable pointer parameters.
For a non-throwing method whose outputs are selected transparent records, the
generator emits one adapter-owned result record and returns it by value:

```ts
export interface Requisition {
  readonly width: gint;
  readonly height: gint;
}

export interface WidgetPreferredSize {
  readonly minimumSize: Requisition;
  readonly naturalSize: Requisition;
}

export declare class Widget {
  getPreferredSize(): WidgetPreferredSize;
}
```

The adapter calls `gtk_widget_get_preferred_size()` once. Its synthetic C
record is an explicit Clang-probe input, so size, alignment, nested field
offsets, and physical return convention are evidence rather than generator
guesses.

Exact C integers and flags remain exact in SCABI. The public GTK API uses
ordinary `number`, `boolean`, or generated enum/flag types only where a checked
projection proves the value is lossless and within the declared range. Values
that cannot be represented exactly keep an explicit native scalar type.

## Enums and flags

Selected GIR enumerations become nominal numeric TypeScript types with named
compile-time members:

```ts
export type Orientation = number & {
  readonly [nativeScalar]: "Orientation";
};

export declare namespace Orientation {
  const Horizontal: Orientation;
  const Vertical: Orientation;
}
```

This declaration-merging shape supports ordinary named imports and qualified
members without creating a JavaScript namespace object:

```ts
import { Box, Orientation } from "@native-typescript/gtk4";

const box = new Box(Orientation.Vertical, 8 as gint);
```

GIR supplies each member's semantic name, native C identifier, and canonical
value. The matching target headers remain authoritative for storage: a Clang
probe proves the enum's exact size, alignment, signedness, and every selected C
member identity before SCABI or declarations are generated. For example, the
current Linux x86-64 GTK gate proves `GtkOrientation` as an unsigned 32-bit
physical scalar and proves `GTK_ORIENTATION_VERTICAL == 1`; the generator does
not assume that a C enum is `gint`.

SCABI retains the nominal enum over that proven storage and publishes each
member as a declaration-backed constant. ScriptC substitutes a reached member
as an exact Native IR scalar literal, so it needs no exported C data symbol,
adapter, module initialization, or runtime property lookup. Flags use the same
evidence path but remain a distinct nominal flags contract so valid bitwise
composition can be specified independently of closed enum membership.

The first executable flags projection is `EventControllerScrollFlags`. Its
Clang-proven members flow through the `EventControllerScroll` constructor and
its `flags` getter/setter as one nominal type:

```ts
const scroll = new EventControllerScroll(
  EventControllerScrollFlags.combine(
    EventControllerScrollFlags.Vertical,
    EventControllerScrollFlags.Horizontal,
  ),
);

scroll.flags = EventControllerScrollFlags.Vertical;
const current: EventControllerScrollFlags = scroll.flags;
const isVertical = current === EventControllerScrollFlags.Vertical;
```

Known composite members such as `BothAxes` are ordinary generated members.
ScriptC now implements same-representation native-width `&`, `|`, and `^`
without routing through JavaScript's `ToInt32`; the executable GTK gate proves
that `combine(Vertical, Horizontal)` has the exact `BothAxes` representation.
Each generated flags namespace declares `combine(first, ...rest)`, and SCABI
translation derives its manifest-neutral integer-reduction operation from the
flags type itself. ScriptC resolves that declaration by checker symbol and
folds it directly to Native IR. It creates no runtime namespace, module
evaluation, C adapter, or hidden target-specific compiler rule. The generator
does not weaken flags parameters to `number`, require consumer assertions, or
pretend an untyped built-in `|` result is still nominal.

## Signals

Signals become typed `onSignalName` methods. The callback receives the emitter
as its first argument followed by the projected signal payload. Passing the
emitter makes the common callback independent of an outer capture:

```ts
export interface SignalConnection {
  readonly connected: boolean;
  disconnect(): void;
}

export declare class Button extends Widget {
  onClicked(callback: (button: Button) => void): SignalConnection;
}
```

The returned connection is an optional, non-owning cancellation capability.
Dropping or ignoring it does not disconnect the signal. `disconnect()` is
idempotent and exists for early cancellation:

```ts
button.onClicked((source) => {
  source.label = "Clicked";
});

const temporary = button.onClicked(showTemporaryState);
temporary.disconnect();
```

The emitter owns the registration. Destroying or invalidating the emitter
closes callback admission, disconnects the native handler, drains or discards
already admitted work according to SCABI, and releases the closure exactly
once. Application shutdown performs the same operation before stopping the
runtime.

The ownership edge participates in ScriptC cycle collection. In particular, a
callback that captures its own emitter must not leak merely because the signal
registration retains the callback. The implemented runtime exposes the
receiver-to-connection and connection-to-closure edges to trial deletion, and
its conformance gate collects the exact receiver/connection/closure cycle under
plain, address-sanitized, and thread-sanitized builds.

Cross-thread signals may use the same source shape once the emitter itself has
a transport-safe identity contract. Foreign threads may enqueue copied or
natively retained payloads through the owner gateway, but they never execute
TypeScript or touch the ScriptC heap directly. The current managed-emitter
projection is therefore same-caller only. A signal requiring a synchronous
cross-thread return is unsupported until a separate deadlock and reentrancy
contract exists.

## Resource release

Ordinary GObject code does not call `dispose()` after every use. Managed handle
aliases share one native ownership entry, and normal last-reference release is
deterministic under ScriptC reference counting and cycle collection.

An API exposes explicit release only when early release is semantically useful:

- a domain operation such as `close()`, `destroy()`, or `cancel()` when that is
  the native API's behavior;
- `SignalConnection.disconnect()` for early signal cancellation;
- a standard disposable protocol once that protocol is supported by the
  static language profile.

The generator does not add a public `dispose()` method to every GObject class
merely because the internal handle has a release binding. Internal destructors
remain compiler-visible SCABI dependencies.

## Application lifecycle

`Application` starts the platform application and returns. It never blocks.

[Runtime and threading](runtime-and-threading.md) requires that top-level
TypeScript initialization completes normally and that no compiled native call
remains suspended around the UI loop. A blocking `run()` would violate that
invariant directly: it would hold a native frame open for the process lifetime,
nest every owner turn and microtask checkpoint inside that frame, and install a
second main loop competing with the runtime's attached host scheduler.

The GTK runtime provider already attaches the selected `GMainContext` as the
executable's host scheduler. Its poll operation runs at most one
`g_main_context_iteration` per turn and contributes ScriptC's next timer
deadline to the wait. Attached-loop liveness, not a suspended call frame, is
what keeps the process running after top-level TypeScript returns.

`start()` therefore lowers to registration followed by activation:

```text
Application.start()
    │
    ├─ g_application_register()      acquire or detect the primary instance
    │
    ├─ remote instance?  ──yes──▶    activation forwarded; request runtime stop
    │
    └─ g_application_activate()      emits `activate` on the primary instance
                                     returns immediately
```

It must not lower to `g_application_run()`, which owns its own `GMainLoop`.

```ts
export declare class Application {
  constructor(applicationId: string | null, flags: ApplicationFlags);
  onActivate(callback: (application: Application) => void): SignalConnection;
  start(): void;
  quit(): void;
}
```

- `start()` registers and activates the application, then returns. Calling it
  more than once on one instance is a contract violation.
- `onActivate` registers before `start()`. It is an ordinary receiver-owned
  signal with the same lifetime rules as every other GTK signal.
- `quit()` ends attached-loop liveness and requests runtime shutdown. Already
  admitted callbacks still drain before the owner observes quiescence.

### Process lifetime is explicit

Closing the last window does not end the process. The application runs until
TypeScript calls `quit()`.

GTK convention ties process exit to the window count, because
`g_application_run()` returns when `GtkApplication`'s hold count reaches zero.
This projection does not reproduce that implicitly. Process lifetime tied to
widget state is exactly the kind of hidden control flow the architecture
requires to be visible, and reproducing it without `run()` would mean observing
an unexported hold count or inferring intent from `window-removed`.

An application that wants the conventional behavior writes it:

```ts
window.onCloseRequest(() => {
  app.quit();
});
```

A declared, opt-in lifetime policy may be added later. It will be an explicit
constructor option with its own gate, never a default.

### Remote instances

`g_application_register()` may determine that another process already owns the
application ID. The local process is then a remote instance: its activation has
been forwarded and it has no primary-instance work to do. `start()` requests
runtime stop in that case rather than activating, so the process exits through
the ordinary shutdown path instead of presenting a second set of windows.

`ApplicationFlags` belongs to `Gio`, so it is imported from
`@native-typescript/gio2` rather than redeclared here. GIR gives the
constructor no default, and the projection does not invent one: the flags are
an ordinary parameter.

```ts
import { Application } from "@native-typescript/gtk4";
import { ApplicationFlags } from "@native-typescript/gio2";

const app = new Application("dev.native_typescript.Counter", ApplicationFlags.DefaultFlags);
```

## Representative declaration surface

```ts
// @native-typescript/gtk4
export declare class Application {
  constructor(applicationId: string | null, flags: ApplicationFlags);
  onActivate(callback: (application: Application) => void): SignalConnection;
  start(): void;
  quit(): void;
}

export declare class Widget {
  protected constructor();
  visible: boolean;
}

export declare class Window extends Widget {
  title: string | null;
  present(): void;
}

export declare class ApplicationWindow extends Window {
  constructor(options: { application: Application });
  setChild(child: Widget | null): void;
}

export type Orientation = number & {
  readonly [nativeScalar]: "Orientation";
};

export declare namespace Orientation {
  const Horizontal: Orientation;
  const Vertical: Orientation;
}

export type EventControllerScrollFlags = number & {
  readonly [nativeScalar]: "EventControllerScrollFlags";
};

export declare namespace EventControllerScrollFlags {
  const BothAxes: EventControllerScrollFlags;
  const Horizontal: EventControllerScrollFlags;
  const Vertical: EventControllerScrollFlags;
  function combine(
    first: EventControllerScrollFlags,
    ...rest: readonly EventControllerScrollFlags[]
  ): EventControllerScrollFlags;
}

export declare class EventController {
  protected constructor();
}

export declare class EventControllerScroll extends EventController {
  constructor(flags: EventControllerScrollFlags);
  flags: EventControllerScrollFlags;
}

export declare class Box extends Widget {
  constructor(orientation: Orientation, spacing: gint);
  append(child: Widget): void;
}

export declare class Button extends Widget {
  constructor();
  static withLabel(label: string): Button;
  get label(): string | null;
  set label(value: string);
  onClicked(callback: (button: Button) => void): SignalConnection;
}
```

This example describes the intended projection, not the current generated
coverage. Each declaration is emitted only after its GIR semantics, C ABI,
ownership, nullability, executor, and lifecycle contracts are proven.

## Counter application

```ts
import { ApplicationFlags } from "@native-typescript/gio2";
import {
  Application,
  ApplicationWindow,
  Box,
  Button,
  Orientation,
} from "@native-typescript/gtk4";

const app = new Application(
  "dev.native_typescript.Counter",
  ApplicationFlags.DefaultFlags,
);

app.onActivate((application) => {
  let count = 0;
  const button = Button.withLabel(`Count: ${count}`);

  button.onClicked((source) => {
    count += 1;
    source.label = `Count: ${count}`;
  });

  const window = new ApplicationWindow({ application });
  const content = new Box(Orientation.Vertical, 8 as gint);
  content.append(button);
  window.title = "Native TypeScript";
  window.setChild(content);
  window.onCloseRequest(() => {
    app.quit();
  });
  window.present();
});

app.start();
```

`start()` returns as soon as the application is activated. Top-level module
evaluation then completes, and the attached GLib main context owns waiting from
that point on. No signal handle or GObject release call is required in the
ordinary path.

## Current migration boundary

The generated surface is recorded in [Implementation status](status.md). The
projection above is normative: a declaration is emitted only once its GIR
semantics, C ABI, ownership, nullability, executor, and lifecycle contracts are
proven, and reached metadata outside the implemented algebra fails generation
rather than degrading.

The migration is intentionally one-way:

1. generate the non-blocking `Application` lifecycle and retire the fixture's
   hand-authored runtime entry point;
2. broaden proven GObject property types, value-method input/output families,
   and non-scalar signal payloads/results.

No deprecated aliases or duplicate compatibility surface remains after each
contract becomes implemented.
