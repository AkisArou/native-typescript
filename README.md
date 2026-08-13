# RFC-0001: TypeScript as a Unified Native Systems and Applications Language

**Status:** Draft
**Milestone:** 1
**Date:** August 13, 2026
**Audience:** Compiler, runtime, platform, framework, tooling, and security contributors

---

## Abstract

This RFC proposes evolving `scriptc` into a unified native platform for TypeScript.

The goal is larger than compiling command-line programs or replacing one application framework. TypeScript should become capable of building:

- Command-line tools and servers.
- Native libraries.
- POSIX and operating-system software.
- Linux, Windows, and macOS desktop applications.
- Android and iOS applications.
- Shared native modules.
- React applications whose components, Hooks, and reconciler execute as native machine code.
- Desktop applications rendered with the real DOM, CSS, and browser APIs.
- Applications that combine browser APIs with familiar `node:*` APIs while retaining a secure process boundary.

The central compilation model is:

```text
TypeScript
    ↓
TypeScript parse and type checking
    ↓
typed scriptc IR
    ↓
target-specific lowering
    ↓
LLVM
    ↓
native machine code
```

Frameworks are optional layers. React is one library. GTK, WinUI, AppKit, UIKit, Android, POSIX, and the DOM remain directly accessible.

The intended result is:

> **TypeScript as a practical native systems and applications language across operating systems, mobile platforms, native UI toolkits, React, and the real browser DOM.**

---

# 1. Vision

## 1.1 One language, many kinds of software

A TypeScript developer should be able to use one language and one package ecosystem to build:

```text
                     TypeScript
                         │
                         ▼
                      scriptc
                         │
                         ▼
                 native machine code
                         │
     ┌──────────┬────────┼────────┬──────────┐
     ▼          ▼        ▼        ▼          ▼
   Linux      Windows   macOS   Android      iOS
     │          │        │        │           │
   POSIX      Win32    Cocoa     JNI     Objective-C
     │          │        │        │           │
    GTK       WinUI    AppKit Android UI     UIKit
```

The same compiler should also produce:

```text
native executables
static libraries
shared libraries
mobile application libraries
WebAssembly modules
desktop DOM applications
```

A project should not be forced into a high-level framework. Developers should be able to choose the appropriate level of abstraction:

```text
portable Node-compatible API
        ↓
platform-specific API
        ↓
native ABI
        ↓
unsafe pointer-level escape hatch
```

## 1.2 TypeScript should scale down as well as up

At a high level:

```ts
import { readFile } from "node:fs/promises";

const config = await readFile("config.json", "utf8");
```

At the platform level:

```ts
import { open, read, close } from "@scriptc/posix";
```

At the UI level:

```tsx
function Counter() {
  const [count, setCount] = useState(0);

  return <Button onPress={() => setCount((value) => value + 1)}>Count: {count}</Button>;
}
```

At the raw native level:

```ts
const button = new android.widget.Button(activity);

button.setText("Native Android button");
```

All four should compile through the same language pipeline.

## 1.3 React is a library, not a boundary

React should not require a JavaScript runtime merely because it was originally written in JavaScript.

The project should compile:

```text
components
Hooks
closures
state queues
effects
scheduler
Fiber reconciliation
host renderer
application event handlers
```

into native machine code.

The host renderer may target:

```text
Android Views
UIKit
GTK
WinUI
AppKit
Blink DOM
```

Anything React can do must also remain possible without React.

## 1.4 Native access must not fragment the source ecosystem

Portable application code should retain familiar APIs:

```ts
import { readFile } from "node:fs/promises";

import { createServer } from "node:http";

import { spawn } from "node:child_process";

import path from "node:path";
```

The implementation may differ by platform or execution domain, but the source API should remain recognizable and compatible.

---

# 2. Design Principles

## 2.1 Ordinary TypeScript

Application source remains ordinary `.ts` and `.tsx`.

Milestone 1 should avoid introducing new parser syntax. Native behavior should be expressed through:

- TypeScript declarations.
- Compiler-recognized intrinsic types.
- Binding metadata.
- Conditional package exports.
- Platform file suffixes.
- Optional string directives.
- Target extensions.

## 2.2 Static compilation by default

Code should compile statically or produce a precise diagnostic.

A JavaScript engine may exist as an explicit compatibility option, but it must not be added silently.

A build report must identify:

- Static coverage.
- Dynamic packages.
- Native calls.
- Remote calls.
- Required capabilities.
- Generated adapters.
- Process boundaries.

## 2.3 Compile-time native binding resolution

Whenever possible, the compiler should resolve the following at build time:

- Native type.
- Native method or function.
- Overload.
- ABI signature.
- JNI descriptor.
- Objective-C selector.
- COM interface.
- Ownership behavior.
- Nullability.
- Thread affinity.
- Platform availability.

The running application should not need to search a whole SDK metadata database to call a known method.

## 2.4 Platform-native behavior remains available

The platform should not hide native functionality behind a lowest-common-denominator abstraction.

Developers should be able to access:

```text
Android SDK
UIKit
AppKit
WinUI
Win32
GTK
POSIX
Linux APIs
Objective-C runtime
C libraries
DOM and Web APIs
```

directly from TypeScript.

## 2.5 Generated native glue is acceptable

Avoiding handwritten Kotlin or Swift does not mean pretending the underlying platform ABI does not exist.

The compiler may generate:

- Java or DEX adapter classes.
- JNI thunks.
- Objective-C-visible classes.
- Objective-C++ thunks.
- Swift adapter modules.
- COM callback objects.
- GObject signal closures.
- C trampolines.
- Blink callback adapters.

These are compiler artifacts rather than source maintained by application authors.

## 2.6 Platform layout belongs to the platform

- React-Native-style mobile UI may use Yoga.
- GTK applications should normally use GTK layout.
- WinUI applications should normally use WinUI layout.
- AppKit applications should normally use AppKit layout.
- DOM applications should use CSS and Blink layout.

Yoga is not a universal replacement for every host layout system.

## 2.7 Security boundaries must not damage source-level DX

A secure multi-process application should still look like one TypeScript program.

Application code should not manually construct generic IPC messages or command strings.

The compiler and target runtime should generate:

- Typed remote calls.
- Capability declarations.
- Data transport.
- Remote resource proxies.
- Validation stubs.

---

# 3. Native Command-Line Programs, Servers, and Libraries

The first role of `scriptc` is straightforward native compilation.

Current `scriptc` already uses the real TypeScript compiler for parsing and type checking, lowers checked code into a typed intermediate representation, emits LLVM IR, and links a feature-gated native runtime. Supported Node APIs lower to native implementations rather than requiring Node in the produced executable. ([scriptc][1])

## 3.1 Portable application APIs

A native HTTP server should remain familiar:

```ts
import { createServer } from "node:http";

const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json");

  response.end(
    JSON.stringify({
      path: request.url,
    }),
  );
});

server.listen(8080, () => {
  console.log("Listening on port 8080");
});
```

The output should be a native executable:

```text
server.ts
    ↓
scriptc
    ↓
server.exe / server / Mach-O executable
```

No `node` executable is required at runtime.

## 3.2 Lower-level POSIX access

Portable Node APIs are not sufficient for all systems programming.

A low-level POSIX package should expose native interfaces:

```ts
import { open, read, close, O_RDONLY } from "@scriptc/posix";

const descriptor = open("/etc/hosts", O_RDONLY);

if (descriptor < 0) {
  throw new Error("Unable to open file");
}

const buffer = new Uint8Array(4096);

const count = read(descriptor, buffer, buffer.length);

close(descriptor);

console.log(`Read ${count} bytes`);
```

This should lower to direct C ABI or platform syscall-library calls.

The POSIX layer is intended for:

- Memory mapping.
- File descriptors.
- Signals.
- Process control.
- Polling.
- Sockets.
- Zero-copy I/O.
- Native library implementation.
- APIs not represented by Node.

## 3.3 Linux-specific APIs

Linux packages may expose:

```ts
import { epollCreate1, epollCtl, epollWait, EPOLL_CLOEXEC } from "@scriptc/linux";

const epoll = epollCreate1(EPOLL_CLOEXEC);
```

Additional packages may cover:

```text
D-Bus
systemd
Wayland
X11
Vulkan
ALSA
PipeWire
io_uring
```

## 3.4 Native libraries written in TypeScript

TypeScript should also produce libraries callable from other languages.

```ts
import type { i32 } from "scriptc:native";

export function add(left: i32, right: i32): i32 {
  return left + right;
}
```

Possible outputs:

```text
Linux
    libmath.so
    libmath.a
    math.h

Windows
    math.dll
    math.lib
    math.h

macOS
    libmath.dylib
    libmath.a
    math.h

Android
    libmath.so

iOS
    libmath.a
```

The exported ABI should contain only explicitly declared exports.

---

# 4. Native Desktop Applications

Native desktop development should not require a browser renderer.

A developer should be able to build directly against GTK, WinUI, AppKit, Win32, or other platform APIs.

---

## 4.1 Linux and GTK

GTK has a C-based object model, widgets, signals, and an event-driven application architecture, making it well suited to generated native bindings. ([https://docs.gtk.org][2])

A raw GTK application should look like this:

```ts
import * as Gtk from "@scriptc/gtk";

const application = Gtk.Application.new("com.example.counter", 0);

application.onActivate(() => {
  const window = Gtk.ApplicationWindow.new(application);

  window.setTitle("TypeScript Counter");

  window.setDefaultSize(480, 320);

  const button = Gtk.Button.newWithLabel("Click");

  button.onClicked(() => {
    button.setLabel("Clicked");
  });

  window.setChild(button);

  window.present();
});

application.run(process.argv);
```

The runtime path is:

```text
compiled TypeScript
       ↓
generated C/GObject binding
       ↓
GTK
       ↓
Wayland or X11
```

No JavaScript engine is required.

### GTK React renderer

A React renderer may expose GTK concepts directly:

```tsx
import React, { useState } from "react";

import { Window, Box, Label, Button } from "@scriptc/react-gtk";

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <Window title="Counter">
      <Box orientation="vertical" spacing={12}>
        <Label>Count: {count}</Label>

        <Button label="Increment" onClick={() => setCount((value) => value + 1)} />
      </Box>
    </Window>
  );
}
```

This renderer should create real:

```text
GtkApplicationWindow
GtkBox
GtkLabel
GtkButton
```

GTK remains responsible for native desktop layout.

---

## 4.2 Windows and WinUI

WinUI, delivered through the Windows App SDK, is Microsoft’s recommended native UI framework for new Windows desktop applications. ([Microsoft Learn][3])

A raw WinUI projection should look like this:

```ts
import { Window, StackPanel, TextBlock, Button } from "@scriptc/winui";

const window = new Window();

const stack = new StackPanel();

const text = new TextBlock();

text.Text = "Hello from TypeScript";

const button = new Button();

button.Content = "Click";

button.onClick(() => {
  text.Text = "Clicked";
});

stack.Children.Append(text);

stack.Children.Append(button);

window.Content = stack;

window.Activate();
```

The intended lowering is:

```text
compiled TypeScript
       ↓
generated WinRT / COM projection
       ↓
WinUI
       ↓
Windows compositor
```

The Windows platform packages should eventually expose:

```text
Win32
COM
WinRT
Windows App SDK
WinUI
Direct2D
DirectWrite
Direct3D
Windows networking and storage APIs
```

### WinUI React renderer

```tsx
import React, { useState } from "react";

import { Window, StackPanel, TextBlock, Button } from "@scriptc/react-winui";

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <Window title="Counter">
      <StackPanel>
        <TextBlock>Count: {count}</TextBlock>

        <Button onClick={() => setCount((value) => value + 1)}>Increment</Button>
      </StackPanel>
    </Window>
  );
}
```

The renderer should create real WinUI controls and allow the native toolkit to perform layout.

---

## 4.3 macOS and AppKit

macOS applications should have access to:

```text
POSIX
Darwin and BSD APIs
Mach APIs
Foundation
AppKit
Core Foundation
Core Graphics
Metal
AVFoundation
Core Audio
Security
Network framework
```

The Objective-C runtime provides the native object and messaging foundation used by Apple’s Objective-C-compatible frameworks. ([Apple Developer][4])

A raw AppKit application should look like this:

```ts
import { NSApplication, NSWindow, NSButton } from "@scriptc/appkit";

const application = NSApplication.sharedApplication;

const window = new NSWindow({
  width: 800,
  height: 600,
});

const button = new NSButton();

button.title = "Hello TypeScript";

button.onPress(() => {
  button.title = "Clicked";
});

window.contentView.addSubview(button);

window.makeKeyAndOrderFront(null);

application.run();
```

The intended lowering is:

```text
compiled TypeScript
       ↓
generated Objective-C-compatible binding
       ↓
AppKit
       ↓
WindowServer
```

### AppKit React renderer

```tsx
import React, { useState } from "react";

import { Window, StackView, Label, Button } from "@scriptc/react-appkit";

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <Window title="Counter">
      <StackView>
        <Label>Count: {count}</Label>

        <Button onPress={() => setCount((value) => value + 1)}>Increment</Button>
      </StackView>
    </Window>
  );
}
```

The renderer should create real AppKit objects and use AppKit layout behavior.

---

# 5. Android and iOS Applications

Mobile applications should be able to use raw platform APIs directly from TypeScript.

The compiler should handle the platform interop boundary and generate the native-facing classes required by Android and Apple frameworks.

---

## 5.1 Android

Android’s JNI interface connects Java or Kotlin bytecode with native code. The same mechanism can connect Android framework objects to native-compiled TypeScript. ([Android Developers][5])

A native Android TypeScript application should look similar to Java or Kotlin Android development:

```ts
import { Activity } from "@scriptc/android/app";

import { Bundle } from "@scriptc/android/os";

import { Button, LinearLayout, Toast } from "@scriptc/android/widget";

export class MainActivity extends Activity {
  onCreate(state: Bundle | null): void {
    super.onCreate(state);

    const layout = new LinearLayout(this);

    const button = new Button(this);

    button.setText("Click");

    button.setOnClickListener(() => {
      Toast.makeText(this, "Hello from TypeScript", Toast.LENGTH_SHORT).show();
    });

    layout.addView(button);

    this.setContentView(layout);
  }
}
```

The application package should contain:

```text
APK / AAB
│
├── AndroidManifest.xml
├── resources
├── classes.dex
│   ├── bootstrap
│   ├── generated Activity shells
│   └── generated callback adapters
│
└── lib
    └── arm64-v8a
        └── libapp.so
             ├── compiled application TS
             ├── scriptc runtime
             └── JNI thunks
```

The developer writes TypeScript.

The compiler generates the JVM-visible shell Android needs to instantiate:

```text
Android framework
       ↓
generated Activity class
       ↓
JNI
       ↓
compiled MainActivity.onCreate()
```

Ordinary calls flow in the other direction:

```text
compiled TypeScript
       ↓
specialized JNI thunk
       ↓
Android framework object
```

JNI class references and method IDs should be resolved and cached rather than repeatedly discovered during normal calls.

---

## 5.2 iOS

A native iOS TypeScript application should expose UIKit and other Apple frameworks directly:

```ts
import { UIViewController, UIButton, UIControlState } from "@scriptc/uikit";

export class MainViewController extends UIViewController {
  viewDidLoad(): void {
    super.viewDidLoad();

    const button = UIButton.buttonWithType("system");

    button.setTitleForState("Click", UIControlState.Normal);

    button.onTouchUpInside(() => {
      console.log("Hello from TypeScript");
    });

    this.view.addSubview(button);
  }
}
```

The application bundle should contain:

```text
iOS application
│
├── compiled application binary
│   ├── application TypeScript
│   ├── scriptc runtime
│   └── Apple framework bindings
│
├── generated Objective-C-visible classes
├── generated protocol adapters
├── Info.plist
└── resources
```

An Objective-C protocol implemented by a TypeScript class should produce a native-visible adapter:

```text
Apple framework
       ↓
Objective-C delegate message
       ↓
generated adapter
       ↓
compiled TypeScript method
```

The library author should not need to write Swift or Objective-C for APIs that already expose an Objective-C-compatible surface.

Pure-Swift-only APIs may require generated Swift adapters.

---

# 6. Shared Native Modules Written Entirely in TypeScript

A shared native module should look like an ordinary npm package.

Consider a location module similar in spirit to `expo-location`.

## 6.1 Package structure

```text
@scriptc/location
│
├── package.json
├── scriptc.module.json
└── src
    ├── index.ts
    ├── types.ts
    ├── native.android.ts
    └── native.ios.ts
```

## 6.2 Shared public API

```ts
export type LocationAccuracy = "low" | "balanced" | "high" | "best";

export interface LocationOptions {
  accuracy?: LocationAccuracy;

  timeInterval?: number;

  distanceInterval?: number;
}

export interface LocationCoords {
  latitude: number;

  longitude: number;

  altitude: number | null;

  accuracy: number | null;

  speed: number | null;

  heading: number | null;
}

export interface LocationObject {
  coords: LocationCoords;

  timestamp: number;
}

export interface PermissionResponse {
  granted: boolean;

  status: "granted" | "denied" | "undetermined";
}

export interface LocationSubscription {
  remove(): void;
}
```

```ts
import * as Native from "./native";

export * from "./types";

export function requestForegroundPermissionsAsync(): Promise<PermissionResponse> {
  return Native.requestForegroundPermissions();
}

export function getCurrentPositionAsync(options: LocationOptions = {}): Promise<LocationObject> {
  return Native.getCurrentPosition(options);
}

export function watchPositionAsync(
  options: LocationOptions,

  callback: (location: LocationObject) => void,
): Promise<LocationSubscription> {
  return Native.watchPosition(options, callback);
}
```

The application uses one shared API:

```ts
import * as Location from "@scriptc/location";

const permission = await Location.requestForegroundPermissionsAsync();

if (!permission.granted) {
  throw new Error("Location permission denied");
}

const current = await Location.getCurrentPositionAsync({
  accuracy: "high",
});

console.log(current.coords.latitude, current.coords.longitude);
```

## 6.3 Android implementation

```ts
import { Location, LocationListener, LocationManager } from "@scriptc/android/location";

import { getApplicationContext } from "@scriptc/android/app";

import type { LocationObject, LocationOptions, LocationSubscription } from "./types";

function convertLocation(location: Location): LocationObject {
  return {
    timestamp: location.getTime(),

    coords: {
      latitude: location.getLatitude(),

      longitude: location.getLongitude(),

      altitude: location.hasAltitude() ? location.getAltitude() : null,

      accuracy: location.hasAccuracy() ? location.getAccuracy() : null,

      speed: location.hasSpeed() ? location.getSpeed() : null,

      heading: location.hasBearing() ? location.getBearing() : null,
    },
  };
}

class WatchListener implements LocationListener {
  constructor(private readonly callback: (location: LocationObject) => void) {}

  onLocationChanged(location: Location): void {
    this.callback(convertLocation(location));
  }
}

export async function watchPosition(
  options: LocationOptions,

  callback: (location: LocationObject) => void,
): Promise<LocationSubscription> {
  const context = getApplicationContext();

  const manager = context.getSystemService("location") as LocationManager;

  const listener = new WatchListener(callback);

  manager.requestLocationUpdates(
    selectProvider(options),
    options.timeInterval ?? 1000,
    options.distanceInterval ?? 0,
    listener,
  );

  return {
    remove(): void {
      manager.removeUpdates(listener);
    },
  };
}
```

Because `LocationListener` is marked in binding metadata as a native Java interface, the compiler generates the required JVM adapter.

## 6.4 iOS implementation

```ts
import { CLLocation, CLLocationManager, CLLocationManagerDelegate } from "@scriptc/core-location";

import type { LocationObject, LocationOptions } from "./types";

function convertLocation(location: CLLocation): LocationObject {
  const coordinate = location.coordinate;

  return {
    timestamp: location.timestamp.timeIntervalSince1970 * 1000,

    coords: {
      latitude: coordinate.latitude,

      longitude: coordinate.longitude,

      altitude: location.verticalAccuracy >= 0 ? location.altitude : null,

      accuracy: location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : null,

      speed: location.speed >= 0 ? location.speed : null,

      heading: location.course >= 0 ? location.course : null,
    },
  };
}

class OneShotDelegate implements CLLocationManagerDelegate {
  constructor(
    private readonly resolve: (location: LocationObject) => void,

    private readonly reject: (error: Error) => void,
  ) {}

  locationManagerDidUpdateLocations(
    manager: CLLocationManager,

    locations: readonly CLLocation[],
  ): void {
    const latest = locations[locations.length - 1];

    this.resolve(convertLocation(latest));
  }

  locationManagerDidFailWithError(
    manager: CLLocationManager,

    error: NativeAppleError,
  ): void {
    this.reject(new Error(error.localizedDescription));
  }
}

export function getCurrentPosition(options: LocationOptions): Promise<LocationObject> {
  return new Promise((resolve, reject) => {
    const manager = new CLLocationManager();

    manager.desiredAccuracy = selectAccuracy(options);

    const delegate = new OneShotDelegate(resolve, reject);

    manager.delegate = delegate;

    manager.requestLocation();
  });
}
```

Because `CLLocationManagerDelegate` is marked as an Objective-C protocol, the compiler generates an Objective-C-visible implementation.

## 6.5 Application configuration

The package declares native requirements:

```json
{
  "android": {
    "permissions": [
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_FINE_LOCATION"
    ]
  },

  "ios": {
    "frameworks": ["CoreLocation"],

    "requiredInfoPlistKeys": ["NSLocationWhenInUseUsageDescription"]
  }
}
```

The build system merges those requirements into:

```text
AndroidManifest.xml
Info.plist
linked frameworks
application entitlements
```

The complete module remains TypeScript-authored.

---

# 7. React Compiled to Native Machine Code

## 7.1 Actual React

The project should compile actual React semantics rather than only exposing React-like JSX.

React’s reconciler supports custom host renderers through a host configuration, although the `react-reconciler` package is explicitly experimental and its internal API changes more often than React’s public APIs. The project should therefore pin and test a specific React revision. ([GitHub][6])

A native React build should compile:

```text
React.createElement / JSX runtime
components
Hooks
closures
Fiber nodes
state queues
effects
scheduler
reconciliation
host configuration
event handlers
```

into native code.

## 7.2 Mobile React renderer

Application code should look familiar:

```tsx
import React, { useState } from "react";

import { View, Text, Pressable } from "react-native";

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text>Count: {count}</Text>

      <Pressable onPress={() => setCount((value) => value + 1)}>
        <Text>Increment</Text>
      </Pressable>
    </View>
  );
}
```

The resulting binary should contain native implementations of the component, state closure, React runtime, reconciler, and renderer.

## 7.3 Render pipeline

The mobile renderer should use a pipeline such as:

```text
React render
    ↓
host shadow tree
    ↓
layout
    ↓
commit
    ↓
mount operations
    ↓
platform UI thread
```

React Native’s renderer similarly separates render, commit, and mount phases and uses a shadow tree before creating or updating host views. ([React Native][7])

## 7.4 Yoga layout

Yoga is an embeddable C++ layout engine with a public C API. It calculates box size and position but does not draw UI. ([yogalayout.dev][8])

The renderer should call Yoga directly:

```text
compiled TypeScript
       ↓
Yoga C API
       ↓
layout values
       ↓
platform mount
```

A host shadow node may contain:

```ts
class ShadowNode {
  readonly yoga: YogaNode;

  parent: ShadowNode | null;

  children: ShadowNode[];

  nativeView: NativeHandle | null;
}
```

## 7.5 Native event path

Android:

```text
Android view event
       ↓
generated Java listener
       ↓
JNI
       ↓
compiled TS closure
       ↓
compiled React update
       ↓
reconciliation
       ↓
Yoga if needed
       ↓
JNI mount call
       ↓
Android view update
```

iOS:

```text
UIKit event
       ↓
generated target/action
       ↓
compiled TS closure
       ↓
compiled React update
       ↓
reconciliation
       ↓
Yoga if needed
       ↓
UIKit update
```

There is no JavaScript-to-native bridge in this path.

## 7.6 Native desktop React renderers

Desktop renderers should expose native platform components:

```text
@scriptc/react-gtk
@scriptc/react-winui
@scriptc/react-appkit
```

React controls:

```text
component execution
state
effects
reconciliation
mount scheduling
```

The host toolkit controls:

```text
native widgets
native focus
native accessibility
native layout
native text
native windowing
```

Yoga remains optional rather than foundational for these renderers.

---

# 8. Desktop Applications with the Real DOM

A second desktop UI path should use the browser platform itself.

This target is not a conventional website and does not require the application to run primarily as JavaScript.

It is a native desktop application with:

```text
real DOM
real CSS
real browser layout
real browser storage
real browser events
real Web APIs
native-compiled TypeScript
native-compiled React
native Node implementations
```

The complete target is called the:

> **scriptc Desktop DOM Runtime**

The target identifier is:

```text
dom-desktop
```

The DOM projection subsystem is called:

```text
scriptc-dom
```

Its proposed public package is:

```text
@scriptc/dom
```

---

## 8.1 Developer experience

A desktop DOM application should be able to use normal React, ReactDOM, DOM APIs, browser APIs, and Node APIs in one TypeScript project.

```tsx
import React, { useState } from "react";

import { createRoot } from "react-dom/client";

import { readFile } from "node:fs/promises";

function App() {
  const [content, setContent] = useState(localStorage.getItem("last-content") ?? "");

  const [status, setStatus] = useState("Ready");

  async function openFile(): Promise<void> {
    setStatus("Loading…");

    try {
      const value = await readFile("./notes.txt", "utf8");

      localStorage.setItem("last-content", value);

      setContent(value);

      setStatus("Loaded");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="app">
      <h1>Notes</h1>

      <button onClick={openFile}>Open notes.txt</button>

      <span>{status}</span>

      <pre>{content}</pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
```

The source surface is simply:

```text
React
ReactDOM
DOM
CSS
localStorage
node:fs/promises
```

The target determines where each operation executes.

---

## 8.2 Runtime architecture

The Desktop DOM Runtime has two mandatory application domains and one optional compatibility realm.

```text
┌────────────────────────────────────┐
│ Native Core Domain                 │
│                                    │
│ compiled TypeScript                │
│ node:*                             │
│ filesystem                         │
│ child processes                    │
│ databases                          │
│ operating-system APIs              │
│ native libraries                   │
└──────────────────┬─────────────────┘
                   │
             typed capabilities
                   │
┌──────────────────▼─────────────────┐
│ Native DOM Domain                  │
│                                    │
│ compiled application TypeScript    │
│ compiled React                     │
│ ReactDOM-compatible renderer       │
│ scriptc-dom                        │
│ Blink DOM                          │
│ CSS                                │
│ localStorage                       │
│ browser APIs                       │
│                                    │
│ optional V8 compatibility realm    │
│                                    │
│ sandboxed                          │
└────────────────────────────────────┘
```

### Native Core Domain

The core is responsible for privileged application functionality:

```text
node:fs
node:child_process
native databases
POSIX
Win32
native libraries
application coordination
long-running background services
```

### Native DOM Domain

The DOM domain is responsible for:

```text
React
ReactDOM-compatible rendering
DOM access
CSS
browser events
localStorage
browser fetch
canvas
media
browser-compatible packages
```

### V8 Compatibility Realm

The optional V8 realm handles packages that cannot yet compile statically because they rely on:

```text
eval
new Function
dynamic prototype mutation
unsupported reflection
runtime code generation
highly dynamic any behavior
```

The compatibility realm remains inside the sandboxed DOM process and receives no additional native privilege.

---

## 8.3 `scriptc-dom`: native access to the real DOM

The preferred architecture does not send DOM commands to a remote WebView.

Native-compiled TypeScript should call Blink directly.

Chromium’s Web IDL compiler currently generates C++ bindings that connect V8 calls to Blink implementations. `scriptc-dom` should add a second projection that connects compiled ScriptC operations to the same Blink implementations. ([Chromium][9])

```text
                         Blink Web IDL
                              │
               ┌──────────────┴──────────────┐
               ▼                             ▼
        V8 binding generator          scriptc-dom generator
               │                             │
               ▼                             ▼
        JavaScript wrappers           native TS declarations
                                      binding metadata
                                      C++ adapters
```

This TypeScript:

```ts
const button = document.createElement("button");

button.textContent = "Open";

document.body.appendChild(button);
```

should lower to:

```text
compiled TypeScript
       ↓
scriptc-dom binding
       ↓
blink::Document
       ↓
blink::HTMLButtonElement
```

There is no:

- JSON mutation protocol.
- DOM node ID table.
- JavaScript DOM agent.
- Application-level DOM IPC.
- Fake DOM implementation.

## 8.4 Real browser APIs

The DOM target should expose the actual browser platform:

```ts
localStorage.setItem("theme", "dark");

const response = await fetch("/api/data");

const socket = new WebSocket(url);

const observer = new MutationObserver((records) => {
  console.log(records.length);
});
```

The long-term API surface includes:

```text
DOM
HTML
CSSOM
events
localStorage
sessionStorage
IndexedDB
fetch
WebSocket
URL
Blob
File
FormData
Canvas
WebGL
WebGPU
audio
video
clipboard
observers
workers
custom elements
browser cryptography
```

These APIs should use Chromium’s implementations rather than being recreated as ScriptC standard-library substitutes.

---

## 8.5 Chromium Content as the host

The runtime should embed Chromium’s Content layer rather than the full Chrome product.

Chromium describes `content` as the core code needed to render pages in a multi-process sandboxed browser, including web-platform features and GPU acceleration, while excluding Chrome product features such as extensions and autofill. ([Chromium][10])

The packaged runtime should contain:

```text
scriptc Desktop DOM Runtime
│
├── Chromium Content
│   ├── Blink
│   ├── compositor
│   ├── GPU integration
│   ├── browser services
│   └── sandbox infrastructure
│
├── scriptc-dom
├── Native Core host
├── typed capability transport
└── optional V8 compatibility
```

Chromium should be distributed as a versioned, prebuilt SDK. It should not be compiled as part of a normal application build.

---

## 8.6 How the example application executes

Consider:

```ts
const value = await readFile("./notes.txt", "utf8");

localStorage.setItem("last-content", value);

setContent(value);
```

### Step 1: the click event

Blink receives the native click event:

```text
Blink EventTarget
       ↓
scriptc-dom callback adapter
       ↓
compiled TypeScript closure
```

### Step 2: React updates loading state

```ts
setStatus("Loading…");
```

This remains inside the Native DOM Domain:

```text
compiled React
       ↓
compiled renderer
       ↓
Blink DOM update
```

### Step 3: the filesystem call

```ts
await readFile("./notes.txt", "utf8");
```

The filesystem operation requires core privileges:

```text
compiled renderer call
       ↓
generated typed capability
       ↓
Native Core Domain
       ↓
native scriptc node:fs implementation
       ↓
operating system
```

### Step 4: asynchronous continuation

The DOM thread is not synchronously blocked.

The native TypeScript continuation resumes when the typed result returns.

### Step 5: browser storage

```ts
localStorage.setItem("last-content", value);
```

This remains in the Native DOM Domain and uses Chromium’s real storage implementation.

### Step 6: React commit

```ts
setContent(value);
```

causes native React reconciliation and a direct Blink DOM update.

---

## 8.7 Node APIs remain canonical

The developer continues to write:

```ts
import { readFile } from "node:fs/promises";
```

The same import can lower differently.

### Native executable

```text
readFile
    ↓
direct native runtime call
```

### Native Core Domain

```text
readFile
    ↓
direct native runtime call
```

### Native DOM Domain

```text
readFile
    ↓
generated typed core capability
```

Pure modules such as portions of:

```text
node:path
node:url
node:util
Buffer operations
```

may remain local to the DOM domain when they do not require privilege or process state.

---

## 8.8 Function placement

The target should infer execution requirements from typed effects.

Conceptually:

```text
document.createElement
DOM mutation
React state update
localStorage
browser fetch
    → DOM effect


node:fs
node:child_process
POSIX
Win32
native library access
    → Core effect


pure parsing
formatting
validation
compression
    → movable
```

A function containing only core effects may be moved completely into the core:

```ts
async function loadProject(path: string): Promise<Project> {
  const source = await readFile(path, "utf8");

  return parseProject(source);
}
```

The renderer receives a generated typed proxy:

```text
renderer loadProject(path)
        ↓
one capability call
        ↓
core reads and parses
        ↓
Project result
```

This is preferable to transferring a large raw file to the renderer and parsing it there.

Milestone 1 does not require automatically splitting arbitrary function bodies in the middle. It supports:

- Local operations.
- Remote operation lowering.
- Whole-function placement.
- Explicit domain annotations when needed.

---

## 8.9 Typed capability transport

The application should not call:

```ts
invoke("read-file", {
  path,
});
```

The compiler should generate a sealed typed operation:

```text
Capability:
    loadProject(
        path: string
    ) → Promise<Project>

Caller:
    main DOM renderer

Implementation:
    statically linked core function

Scope:
    selected workspace
```

Chromium’s Mojo system provides typed interfaces and message pipes for interprocess communication and service boundaries, making it the natural transport for this architecture. ([Chromium][11])

Transport choices should depend on the value:

| Value                  | Transport                              |
| ---------------------- | -------------------------------------- |
| Small scalar or record | Inline binary message                  |
| String                 | Length-delimited UTF-8                 |
| Large immutable buffer | Transferred or shared read-only memory |
| Stream                 | Data pipe with backpressure            |
| Child process          | Opaque remote handle                   |
| File descriptor        | Brokered remote handle                 |
| DOM object             | Remains in DOM domain                  |
| Core pointer           | Never crosses directly                 |

## 8.10 Remote Node objects

Some Node objects cannot be copied as ordinary records.

```ts
import { spawn } from "node:child_process";

const child = spawn("git", ["status", "--porcelain"]);

child.stdout.on("data", (chunk) => {
  console.log(chunk.toString());
});
```

The source API should remain Node-compatible.

Internally:

```text
renderer ChildProcess proxy
        │
        │ ProcessHandle #42
        ▼
core ChildProcess
        ├── stdout data pipe
        ├── stderr data pipe
        ├── exit event
        └── kill capability
```

Remote operations should be visible in editor tooling and diagnostics so that process-crossing latency is not hidden.

---

## 8.11 Renderer sandbox

The Native DOM Domain should be sandboxed by default.

Chromium’s architecture treats renderers as restricted processes, and its sandbox documentation describes renderers as target processes operating under explicit policy. Chromium’s compromised-renderer threat model assumes that an attacker may execute arbitrary native code inside the renderer sandbox, so privileged services must validate renderer requests. ([Chromium][12])

The sandbox should prevent direct unrestricted access to:

- Arbitrary files.
- Child-process creation.
- Native library loading.
- Raw core memory.
- Unrestricted devices.
- Arbitrary operating-system services.

Privileged operations occur through generated capabilities.

This is an implementation boundary, not a source-level API restriction.

### Trusted mode

A project may explicitly choose a trusted single-process mode:

```ts
export default {
  target: "dom-desktop",

  security: {
    renderer: "trusted-single-process",
  },
};
```

This mode permits:

- Direct Node calls.
- Synchronous Node APIs.
- Simpler native module behavior.
- Less application-level IPC.

It also means that a renderer, browser-engine, dependency, or native-binding compromise receives the full application’s privileges.

Trusted mode must be:

- Explicit.
- Visible in build reports.
- Accompanied by production warnings.
- Disabled by default.

---

## 8.12 Compatibility without explicit islands

A browser dependency should not require a special component merely because it falls back to V8.

```ts
import editor from "browser-editor-package";
```

The compiler should analyze the package.

Example report:

```text
Static coverage

application                  100%
react                        100%
DOM renderer                 100%
date-fns                     100%

browser-editor-package        27%
    V8 compatibility required
    reason:
        dynamic code generation
```

The package continues to interact with the same underlying Blink objects.

```text
                   blink::HTMLElement
                     /             \
                    /               \
        ScriptC native handle       V8 wrapper
```

A DOM node should not be serialized merely because it crosses between the native and V8 realms.

---

## 8.13 ReactDOM strategy

The desired source API remains:

```ts
import { createRoot } from "react-dom/client";
```

The long-term goal is to compile an upstream ReactDOM build directly.

For Milestone 1, the project may provide a pinned ReactDOM-compatible implementation that:

- Uses actual React.
- Exposes the normal `react-dom/client` entry.
- Uses React’s reconciler.
- Calls Blink directly through `scriptc-dom`.
- Does not use a remote DOM protocol.

This proves the architecture while allowing upstream ReactDOM compatibility to improve incrementally.

---

# 9. Existing `scriptc` Foundation

The proposed platform builds on a substantial existing base.

Current public `scriptc` already provides:

- TypeScript parsing and type checking through the TypeScript compiler.
- A validated and serializable typed IR.
- LLVM and readable C backends.
- A link-gated native runtime.
- Reference-counted values with deterministic cycle collection.
- Native fibers, promises, microtasks, and event loops.
- Native Node API implementations.
- Static coverage diagnostics.
- An explicit QuickJS compatibility island.
- Native FFI.
- Persistent content-addressed build caching.
- Native executable targets for macOS, Linux, and Windows.
- WASI output.
- Android and iOS library-mode archives. ([scriptc][1])

The current outbound FFI binds TypeScript declarations to exact C ABI symbols without runtime symbol lookup. It supports scalar calls and call-scoped callbacks, but retained callbacks, foreign-thread callbacks, owned pointer returns, struct-by-value calls, and runtime dynamic-library handles are not yet supported. ([scriptc][13])

Milestone 1 extends this foundation rather than replacing it.

---

# 10. Generalized Native Binding Architecture

All native targets should use a shared binding model.

## 10.1 Binding inputs

| Target          | Binding input                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------- |
| C and POSIX     | Headers, macros, target ABI                                                                        |
| Linux           | Headers and package metadata                                                                       |
| Android         | `.jar`, `.aar`, Java bytecode, Kotlin metadata                                                     |
| Apple           | Framework headers, module maps, Objective-C-compatible Swift headers, `.framework`, `.xcframework` |
| Windows         | C headers, COM metadata, `.winmd`                                                                  |
| GTK/GObject     | Headers and GObject Introspection metadata                                                         |
| DOM             | Blink Web IDL and Blink extended attributes                                                        |
| Third-party SDK | One or more of the formats above                                                                   |

## 10.2 Binding outputs

A generated package should contain:

```text
package.d.ts
package.scabi
generated adapters
native link inputs
configuration metadata
```

### TypeScript declarations

`package.d.ts` provides:

- Type checking.
- Autocomplete.
- Documentation.
- Overloads.
- Nullability.
- Inheritance.
- Protocol and interface shape.

### ABI database

`package.scabi` provides:

- Native symbol.
- JNI descriptor.
- Objective-C selector.
- COM interface identity.
- Calling convention.
- Ownership.
- Thread affinity.
- Platform availability.
- Error behavior.
- Permission requirements.
- Required libraries and frameworks.

## 10.3 Compiler-native operations

The typed IR should support first-class operations such as:

```text
NativeNew
NativeCall
NativeGetProperty
NativeSetProperty
NativeCast
NativeRetain
NativeRelease

NativeStructCreate
NativeStructLoad
NativeStructStore

NativePointerLoad
NativePointerStore

RetainedCallbackCreate
RetainedCallbackDispose

RemoteCall
RemoteHandle
TransferBuffer
```

The compiler can then:

- Validate calls.
- Generate platform adapters.
- Track ownership.
- Check thread affinity.
- Perform reachability analysis.
- Eliminate unused bindings.
- Produce useful diagnostics.

## 10.4 Reachability-driven output

The compiler should not ship the complete Android, Apple, Windows, GTK, or DOM SDK description at runtime.

```text
complete SDK
    ↓
reachable application members
    ↓
specialized adapters
    ↓
final binary
```

Only reached native members should contribute code or runtime metadata.

---

# 11. Native Types and Unsafe Operations

Ordinary TypeScript `number` should preserve JavaScript-compatible semantics.

Systems programming additionally requires exact native types:

```text
i8 / u8
i16 / u16
i32 / u32
i64 / u64
isize / usize
f32 / f64
pointer<T>
function pointer
native struct
native union
```

## 11.1 Intrinsic native types

A proposed type-only module:

```ts
import type { i32, u32, i64, u64, usize, ptr } from "scriptc:native";
```

These remain valid TypeScript types while receiving special meaning in the ScriptC compiler.

## 11.2 Native structs

```ts
interface Timespec {
  tvSec: i64;

  tvNsec: i64;
}
```

The binding metadata records:

```text
kind:
    struct

size:
    16

alignment:
    8

tvSec:
    offset 0
    ABI i64

tvNsec:
    offset 8
    ABI i64
```

## 11.3 Explicit conversions

Passing an ordinary `number` to an integer ABI must use:

- A compiler-proven safe conversion.
- A documented JavaScript conversion rule.
- Or an explicit native conversion helper.

Undocumented truncation is not acceptable.

## 11.4 Unsafe escape hatch

Raw pointer operations must be explicit:

```ts
import { unsafe } from "scriptc:native";

const header = unsafe.castPointer<PacketHeader>(address);

const flags = unsafe.read(header, "flags");
```

Unsafe behavior must not be hidden behind `any`.

---

# 12. Ownership and Lifetime

A foreign object must not be represented as an untyped integer or arbitrary `void*`.

## 12.1 Native handles

A native handle should carry compiler-visible metadata:

```text
NativeHandle<T> {
    platform
    native type
    nullability
    ownership
    thread affinity
    process affinity
    availability
}
```

Ownership classes may include:

```text
borrowed
owned
retained
weak
autoreleased
shared
call-scoped
process-proxy
```

## 12.2 Platform-specific ownership

### C

Binding metadata identifies:

- Allocator.
- Deallocator.
- Borrowed arguments.
- Mutable buffers.
- Returned ownership.
- Thread safety.

### Android

The runtime distinguishes:

- Local JNI references.
- Global JNI references.
- Weak global references.
- Thread-local `JNIEnv`.
- Java object identity.

### Apple

The runtime coordinates:

- Objective-C ownership conventions.
- ARC-compatible generated code.
- Weak delegates.
- Autorelease pools.
- Objective-C object identity.

### Windows

The runtime coordinates:

- COM `AddRef`.
- COM `Release`.
- `IUnknown` identity.
- Apartment affinity.
- HRESULT behavior.

### GTK

The runtime coordinates:

- GObject references.
- Floating references.
- Signal handler lifetime.
- GLib main-context affinity.

### Blink

The DOM projection coordinates:

- Blink object lifetime.
- Document destruction.
- Execution-context destruction.
- ScriptC native wrappers.
- Optional V8 wrappers.
- Shared DOM identity.

---

# 13. Retained and Foreign-Thread Callbacks

Mobile UI, desktop UI, networking, file watchers, browser events, and native SDKs all require callbacks that outlive the function call that registered them.

Milestone 1 requires a callback representation such as:

```text
CallbackHandle {
    id
    signature
    captured closure
    lifetime
    owner
    allowed threads
    delivery scheduler
    cancellation state
}
```

Required lifetime modes:

```text
call
once
retained
weak
until-cancelled
```

A callback arriving from a foreign thread should enter through a safe scheduler gateway:

```text
foreign callback
       ↓
thread-safe callback gateway
       ↓
target ScriptC scheduler
       ↓
compiled TypeScript closure
```

This generic mechanism is reused by:

```text
Android listeners
Objective-C delegates
WinUI events
GTK signals
C callbacks
Blink events
filesystem watchers
network callbacks
```

---

# 14. Compiler and Target Boundaries

The core `scriptc` compiler should remain platform-neutral.

## 14.1 Core compiler responsibilities

The compiler owns:

```text
TypeScript frontend
typed IR
generic specialization
closures
classes
promises
async state
native handles
ownership operations
callback operations
program partitions
remote-call IR
LLVM output
native library output
coverage diagnostics
```

## 14.2 Target responsibilities

### Android target

```text
JNI lowering
Android SDK projection
manifest generation
DEX adapter generation
Gradle packaging
```

### Apple target

```text
Objective-C lowering
Apple framework projection
Info.plist generation
Xcode packaging
native class and protocol adapters
```

### GTK target

```text
GObject projection
GTK linking
GLib scheduling integration
desktop packaging
```

### Windows target

```text
Win32
COM
WinRT
WinUI projection
Windows packaging
```

### `dom-desktop` target

```text
scriptc-dom
Blink lowering
Chromium Content
Mojo capabilities
core/DOM placement
sandbox policy
ReactDOM compatibility
desktop packaging
```

## 14.3 Target extension interface

A target should conceptually provide:

```ts
interface ScriptCTarget {
  resolveModule(
    specifier: string,

    context: ResolveContext,
  ): ResolvedModule;

  describeEffect(operation: IROperation): HostEffect;

  lowerNativeOperation(operation: NativeOperation): LoweredOperation;

  planPartitions(graph: ProgramGraph): PartitionPlan;

  package(artifacts: readonly NativeArtifact[]): PackageResult;
}
```

The exact API may evolve, but platform-specific logic should remain outside generic compiler code.

---

# 15. Module and Platform Resolution

## 15.1 Platform files

The compiler should support platform-specific source files:

```text
native.ts
native.android.ts
native.ios.ts
native.macos.ts
native.windows.ts
native.linux.ts
native.dom.ts
```

Shared code writes:

```ts
import * as Native from "./native";
```

The target selects the correct implementation at build time.

Unused platform implementations are excluded.

## 15.2 Conditional package exports

A package may publish:

```json
{
  "exports": {
    ".": {
      "scriptc-android": "./dist/index.android.js",
      "scriptc-ios": "./dist/index.ios.js",
      "scriptc-windows": "./dist/index.windows.js",
      "scriptc-macos": "./dist/index.macos.js",
      "scriptc-linux": "./dist/index.linux.js",
      "scriptc-dom": "./dist/index.dom.js",
      "default": "./dist/index.js"
    }
  }
}
```

The final condition names may change, but selection must occur at build time.

---

# 16. Scheduling and Thread Affinity

TypeScript promises and `async`/`await` should preserve JavaScript-observable ordering while integrating with native platform schedulers.

The runtime must coordinate with:

```text
Android Loopers and Executors
Apple run loops and dispatch queues
Windows dispatchers
GLib main contexts
Chromium task queues
native worker threads
```

## 16.1 Thread annotations

Binding metadata should identify:

```text
main-thread
any-thread
renderer-thread
dispatcher-thread
callback-thread
```

The compiler should reject unsafe calls:

```ts
runInBackground(() => {
  button.setText("Wrong thread");
});
```

A program can explicitly schedule:

```ts
await uiThread();

button.setText("Correct thread");
```

## 16.2 React scheduling

Compiled React requires native host primitives for:

- Time.
- Microtasks.
- Prioritized tasks.
- Yielding.
- Paint requests.
- Commit scheduling.
- Transitions.
- Interruptible work.

## 16.3 DOM scheduling

`scriptc-dom` requires integration with:

- Blink execution contexts.
- Browser task queues.
- Browser microtasks.
- Page navigation.
- Document shutdown.
- Worker termination.

---

# 17. Error Model

Native failures should become ordinary TypeScript errors with platform-specific detail.

## 17.1 POSIX

```text
errno
    ↓
SystemError {
    code
    errno
    syscall
    path?
}
```

## 17.2 Android

```text
Java Throwable
    ↓
NativeJavaError {
    className
    message
    cause?
}
```

## 17.3 Apple

```text
NSError
    ↓
NativeAppleError {
    domain
    code
    userInfo
}
```

## 17.4 Windows

```text
HRESULT / Win32 error
    ↓
NativeWindowsError {
    hresult
    code
    message
}
```

## 17.5 GTK

```text
GError
    ↓
NativeGError {
    domain
    code
    message
}
```

## 17.6 DOM

DOM failures should preserve DOM-compatible exception behavior where the Web API defines it.

Native exceptions must not unwind through incompatible ABI frames without generated protection.

---

# 18. Build Performance and SDK Distribution

Native compilation performs more work than JavaScript bundling, so fast iteration requires deliberate architecture.

## 18.1 Prebuilt platform SDKs

Developers should not compile major frameworks during ordinary application builds.

Prebuilt SDKs should include:

```text
React native archive
Yoga archive
Android binding metadata
Apple binding metadata
GTK binding metadata
WinUI binding metadata
Chromium Content runtime
scriptc-dom adapters
DOM renderer archive
```

## 18.2 Desktop DOM SDK

```text
scriptc DOM SDK
│
├── Chromium Content
├── Blink
├── Mojo
├── scriptc-dom
├── native React archive
├── DOM renderer archive
└── platform packaging support
```

An application build compiles:

```text
changed application modules
changed statically compiled dependencies
generated capability interfaces
small target entry modules
```

## 18.3 Incremental development builds

Development mode should use:

```text
incremental TypeScript checking
per-module typed IR cache
per-module native object cache
low LLVM optimization
parallel target partitions
cached framework archives
fast relinking
CSS hot reload
renderer restart when required
```

Current `scriptc` already provides persistent content-addressed caching for production and library builds; Milestone 1 should extend caching to finer module and partition boundaries. ([GitHub][14])

## 18.4 Production builds

Production mode may use:

```text
full static coverage validation
optimized LLVM output
dead-code elimination
ThinLTO
symbol stripping
capability minimization
resource packing
signing
```

Clean release builds may be expensive.

Normal edit-build-run cycles must remain incremental.

---

# 19. Performance Model

The project should not claim that AOT TypeScript always outperforms V8, Swift, Kotlin, Rust, or C++.

The architectural goals are more specific.

## 19.1 Static execution benefits

AOT-only applications avoid:

- Application JavaScript parsing.
- Application bytecode generation.
- Application JIT warm-up.
- Generic JavaScript/native dispatch.
- Runtime overload resolution.
- Whole-SDK runtime reflection.

They gain:

- Predictable startup.
- Predictable code placement.
- Native debugging.
- Build-time diagnostics.
- Whole-program optimization opportunities.
- Reachability-driven native bindings.

## 19.2 Native UI path

```text
native event
    ↓
compiled TypeScript callback
    ↓
compiled React
    ↓
native renderer
    ↓
platform widget update
```

## 19.3 DOM path

```text
Blink event
    ↓
compiled TypeScript callback
    ↓
compiled React
    ↓
direct Blink renderer
    ↓
DOM mutation
    ↓
CSS layout and paint
```

Browser layout, text shaping, painting, and composition remain real costs.

Native compilation removes application runtime overhead; it does not make browser rendering free.

## 19.4 Core capability path

```text
DOM domain
    ↓
typed Mojo call
    ↓
core domain
    ↓
native Node implementation
    ↓
operating system
```

This is slower than an in-process call.

It is appropriate for coarse operations such as:

- Reading a file.
- Querying a database.
- Running Git.
- Indexing a workspace.
- Saving a project.
- Opening a dialog.

It is inappropriate for thousands of tiny calls.

The target should support:

- Whole-function placement.
- Batching.
- Streams.
- Data pipes.
- Shared read-only buffers.
- Remote handles.

## 19.5 Startup

A Desktop DOM application still pays for:

- Chromium startup.
- Renderer creation.
- Blink initialization.
- GPU setup.
- Font initialization.
- DOM creation.

It is a Chromium-class application, not a tiny GTK binary.

AOT-only mode should nevertheless avoid the application JavaScript parsing and JIT work typical of JavaScript-hosted applications.

---

# 20. Tooling and Observability

The developer must be able to understand what the compiler produced.

## 20.1 Proposed commands

```bash
scriptc build
scriptc run
scriptc test
scriptc coverage

scriptc bind c
scriptc bind android
scriptc bind apple
scriptc bind winrt
scriptc bind gobject
scriptc bind webidl

scriptc inspect domains
scriptc inspect effects
scriptc inspect capabilities
scriptc inspect native-calls
scriptc inspect callbacks
scriptc inspect compatibility
scriptc inspect binary
```

## 20.2 Build report

```text
Compilation summary

Application:
    100% static

React:
    100% static

DOM renderer:
    100% static

Node APIs:
    6 direct core calls
    2 DOM-to-core capabilities

Native bindings:
    14 JNI thunks
    5 retained callbacks

Compatibility:
    1 V8 package
    reason:
        dynamic code generation

Capabilities:
    filesystem read
        $USER_SELECTED/**

    child process
        executable: git
```

## 20.3 Placement explanation

```text
$ scriptc inspect domains

Native DOM Domain
    App
    Toolbar
    Editor
    DOM event handlers

Native Core Domain
    loadProject
    indexWorkspace
    runGitStatus

Duplicated pure code
    formatPath
    validateProjectName
```

## 20.4 Debugging

Milestone 1 should support:

- TypeScript source locations in native stack traces.
- LLDB on Apple and Android.
- GDB or LLDB on Linux.
- Windows native debugging.
- V8 source maps for compatibility packages.
- Cross-domain async trace IDs.
- Capability-call tracing.
- Callback lifetime diagnostics.
- JNI reference diagnostics.
- DOM event tracing.

---

# 21. Security Model

## 21.1 Native UI applications

A GTK, WinUI, AppKit, UIKit, or Android application normally executes in one trusted application domain, subject to the operating system’s application sandbox and permissions.

Native UI applications may optionally isolate:

- Plugins.
- Codecs.
- Document parsers.
- Extension systems.
- Untrusted content.

## 21.2 Desktop DOM applications

The Native DOM Domain is sandboxed because it contains a large content-processing engine and may host compatibility packages or untrusted documents.

The Native Core Domain retains privileged APIs.

## 21.3 Capability policy

Capabilities should be:

- Typed.
- Generated from reachable operations.
- Scoped.
- Validated by the core.
- Assigned per renderer or window.
- Visible in build reports.

Example:

```text
Editor window
    read:
        selected workspace

    write:
        selected workspace

    child process:
        git


Documentation window
    no filesystem
    no child process


Plugin window
    plugin storage only
```

## 21.4 No arbitrary command IPC

The core should not expose:

```ts
invoke(arbitraryCommand, arbitraryArguments);
```

It should expose a finite generated operation table.

## 21.5 No raw pointers across processes

Cross-domain native resources become opaque handles.

```text
FileHandle #12
ProcessHandle #42
DatabaseHandle #8
```

The core owns the real resource and validates every operation.

---

# 22. Milestone 1

Milestone 1 proves the complete architecture through narrow, high-quality vertical slices.

It does not require complete SDK coverage.

## 22.1 Compiler and runtime foundation

Deliver:

- Target extension API.
- Native handle IR.
- Ownership metadata.
- Native call IR.
- Native struct support.
- Exact integer types.
- Retained callbacks.
- Foreign-thread callbacks.
- Program partitions.
- Remote-call IR.
- Remote handles.
- Transferable buffers.
- Partition-aware caching.

### Acceptance test

A target extension partitions one TypeScript project into two native binaries, generates a typed asynchronous call between them, retains a callback, receives it from another thread, and releases all resources correctly.

---

## 22.2 C, POSIX, and native libraries

Deliver:

- C header binding generator.
- Initial POSIX projection.
- Initial Linux projection.
- Initial Win32 projection.
- Native structs.
- Pointer escape hatch.
- Native library exports.

### Acceptance test

One TypeScript repository builds:

- A Linux CLI.
- A Windows CLI.
- A macOS CLI.
- A C-callable native library.

---

## 22.3 Native desktop UI

Deliver:

- Initial GTK projection.
- Initial WinUI projection.
- Initial AppKit projection.
- Minimal React renderer for each.

### Acceptance test

A React counter creates:

- Real GTK widgets on Linux.
- Real WinUI controls on Windows.
- Real AppKit controls on macOS.

---

## 22.4 Android and iOS

Deliver:

- Android application packaging.
- iOS application packaging.
- JNI projection.
- Objective-C projection.
- Generated lifecycle classes.
- Generated listeners and protocol adapters.
- Manifest merging.
- Property-list merging.
- Permission metadata.

### Acceptance test

The TypeScript-only location module:

- Requests permission.
- Gets a current location.
- Watches location changes.
- Removes the watch.
- Runs on Android.
- Runs on iOS.
- Contains no handwritten Kotlin, Java, Swift, or Objective-C.

---

## 22.5 Native React mobile renderer

Deliver:

- Pinned React build.
- Static Hooks.
- Native Fiber execution.
- Native scheduler.
- Shadow tree.
- Yoga integration.
- Android mount layer.
- iOS mount layer.
- `View`.
- `Text`.
- `Pressable`.
- Basic text input.
- Native event callbacks.

### Acceptance test

A React counter:

- Uses actual React.
- Uses `useState`.
- Uses Yoga.
- Creates real Android and UIKit views.
- Updates text after a native event.
- Requires no JavaScript engine in AOT-only mode.

---

## 22.6 `scriptc-dom`

Deliver:

- Blink Web IDL ingestion.
- DOM TypeScript declarations.
- Blink binding metadata.
- Native DOM handles.
- Element creation.
- Query selectors.
- DOM properties.
- EventTarget.
- Retained browser callbacks.
- DOM exceptions.
- Basic browser promise integration.
- `localStorage`.
- Browser `fetch`.

### Acceptance test

Native-compiled TypeScript:

- Creates a real DOM element.
- Registers a click listener.
- Reads and writes real `localStorage`.
- Performs browser `fetch`.
- Executes no application JavaScript.

---

## 22.7 Desktop DOM Runtime

Deliver:

- Prebuilt Chromium Content SDK.
- Native Core Domain.
- Sandboxed Native DOM Domain.
- Mojo capability generation.
- Async `node:fs/promises` capability.
- Whole-function core placement.
- Native React.
- ReactDOM-compatible direct-Blink renderer.
- Optional V8 compatibility package.
- Desktop packaging.
- Capability and domain reports.

### Acceptance test

The Notes application:

- Uses `react`.
- Uses `react-dom/client`.
- Uses canonical `node:fs/promises`.
- Uses the real DOM.
- Uses real CSS.
- Uses real `localStorage`.
- Executes React and application TypeScript natively.
- Reads the file through a generated core capability.
- Keeps the DOM renderer sandboxed.
- Requires no application JavaScript bundle in AOT-only mode.

---

## 22.8 Tooling and build performance

Deliver:

- Per-module IR cache.
- Per-partition native cache.
- Stable SDK cache.
- Domain inspector.
- Capability inspector.
- Callback leak detector.
- Cross-domain tracing.
- TypeScript-native stack traces.
- Development optimization mode.
- Production optimization mode.

---

# 23. Milestone 1 Acceptance Summary

Milestone 1 is complete when:

1. TypeScript builds native executables and native libraries.
2. Canonical `node:*` imports remain the portable application API.
3. Representative C, POSIX, Linux, Win32, GTK, Android, Apple, WinUI, and DOM APIs are callable.
4. Native bindings are generated at build time.
5. Retained callbacks work across native threads.
6. Android and iOS native modules can be authored entirely in TypeScript.
7. Actual React compiles to native machine code.
8. React creates real Android and iOS views.
9. Yoga performs mobile layout.
10. React creates real GTK, WinUI, and AppKit controls.
11. `scriptc-dom` projects the real Blink DOM into native TypeScript.
12. A desktop DOM application uses real CSS and browser APIs.
13. `localStorage` is the browser implementation.
14. `node:*` calls from DOM code use generated capabilities.
15. The DOM renderer is sandboxed by default.
16. A V8 compatibility package can coexist without receiving extra native privileges.
17. Chromium and major framework components are distributed as prebuilt SDKs.
18. Dynamic execution, native calls, process crossings, permissions, and capabilities are visible in tooling.

---

# 24. Non-Goals for Milestone 1

Milestone 1 does not require:

- Complete Android SDK coverage.
- Complete Apple SDK coverage.
- Complete WinUI or GTK coverage.
- Static compilation of every npm package.
- Perfect Electron compatibility.
- A V8-free Chromium build.
- A universal cross-platform widget set.
- Unmodified upstream ReactDOM.
- Automatic splitting of arbitrary mixed-domain functions.
- Complete pure-Swift ABI support.
- Full Web API coverage.
- Full browser worker support.
- Automatic memory safety for arbitrary pointer arithmetic.
- Compiling Chromium during an application build.
- Performance superiority in every workload.

---

# 25. Risks and Tradeoffs

## 25.1 Scope

The project spans:

```text
compiler engineering
runtime engineering
ABI tooling
mobile packaging
desktop UI toolkits
React internals
Chromium internals
security
debugging
build systems
```

Milestone 1 must use narrow vertical slices rather than broad but shallow API coverage.

## 25.2 React compatibility

React contains dynamic JavaScript patterns and internal build transformations.

Mitigations:

- Pin a React revision.
- Preprocess or transform its source.
- Expand static compiler coverage.
- Maintain a narrow compatibility fork where required.
- Differentially test observable React behavior.

## 25.3 Renderer API stability

React’s custom renderer interface is experimental.

Mitigations:

- Vendor a known revision.
- Keep renderer integration internal.
- Do not expose HostConfig as a stable project API.
- Maintain version-specific adapters.

## 25.4 Native ABI drift

Platform SDKs change.

Mitigations:

- Version binding databases.
- Record SDK versions.
- Generate bindings reproducibly.
- Compile platform availability checks.
- Test multiple SDK versions in CI.

## 25.5 Chromium maintenance

A second Blink language projection is a substantial commitment.

Mitigations:

- Generate from Web IDL.
- Support Blink extended attributes.
- Pin Chromium SDK revisions.
- Minimize handwritten per-API adapters.
- Keep V8 integration intact initially.
- Isolate the ScriptC patch set.

## 25.6 Ownership errors

Cross-runtime ownership bugs can cause:

- Leaks.
- Use-after-free.
- Calls after destruction.
- JNI reference leaks.
- COM apartment violations.
- GObject lifetime errors.
- Blink wrapper corruption.

Mitigations:

- Compiler-visible ownership.
- Sanitizer builds.
- Retained callback audits.
- Handle leak diagnostics.
- Strict rejection of unknown ownership contracts.

## 25.7 IPC security

A compromised renderer controls the arguments it sends.

Mitigations:

- Typed Mojo interfaces.
- Core-side validation.
- Path scopes.
- Executable allowlists.
- Handle ownership validation.
- No arbitrary operation strings.
- No raw pointers across processes.

## 25.8 Build speed

Native generation and linking are more expensive than JavaScript bundling.

Mitigations:

- Persistent caching.
- Per-module native output.
- Parallel partitions.
- Prebuilt framework SDKs.
- Low-optimization development builds.
- ThinLTO only for production.

## 25.9 Browser package compatibility

Some browser packages will remain too dynamic for AOT compilation.

Mitigations:

- Optional V8 compatibility.
- Static coverage reports.
- Shared Blink object identity.
- Progressive compiler support.
- Explicit AOT-only mode.

## 25.10 Binary size

Chromium-based DOM applications remain large compared with native-widget applications.

Future targets may offer:

```text
dom-desktop-chromium
dom-desktop-system-webview
native GTK
native WinUI
native AppKit
```

Renderer choice should be a packaging decision rather than a limitation of the language.

---

# 26. Open Questions

1. What are the final package names for each platform projection?
2. What is the stable target-extension API?
3. What is the final native binding database format?
4. How should exact integer types appear in public TypeScript declarations?
5. What is the final unsafe pointer API?
6. Which React revision becomes the first supported native build?
7. How closely should the mobile host surface match existing `react-native` packages?
8. Does the first DOM renderer transform upstream ReactDOM or provide a compatible implementation?
9. How should Blink promises integrate with ScriptC promises and microtasks?
10. How are wrapper identity and lifetime shared between ScriptC and V8?
11. How are custom elements implemented in native TypeScript?
12. How are Web Workers represented?
13. How are Node streams transported across Mojo?
14. How are synchronous Node APIs diagnosed and placed?
15. How are pure-Swift-only libraries projected?
16. How are COM apartments represented in the scheduler?
17. Should GTK bindings prefer GIR, headers, or a combination?
18. How should mobile lifecycle restrictions affect Node APIs?
19. How are capability policies authored and reviewed?
20. How does trusted single-process mode affect packaging and signing?
21. How should React Fast Refresh work with native modules?
22. How should DevTools display native TypeScript call frames?
23. Is a system-WebView DOM backend practical?
24. Is a V8-free Blink renderer worth maintaining?
25. When should automatic continuation splitting be introduced?
26. When should pure functions be duplicated between domains rather than moved?
27. What shared-memory rules are safe for renderer-controlled data?
28. How should plugins be isolated and granted capabilities?

---

# 27. Conclusion

This RFC proposes a single coherent TypeScript platform.

At the foundation:

```text
TypeScript
    ↓
typed scriptc IR
    ↓
target extensions
    ↓
LLVM
    ↓
native machine code
```

Native ecosystems become available through generated projections:

```text
C
POSIX
Linux
Win32
COM
WinRT
Objective-C
JNI
GObject
GTK
Blink
```

Application libraries build on those foundations:

```text
Node APIs
native modules
React
React Native-style UI
GTK React
WinUI React
AppKit React
ReactDOM
```

The project is governed by a small set of architectural rules:

1. Use ordinary TypeScript.
2. Compile statically by default.
3. Preserve canonical `node:*` APIs.
4. Resolve native bindings at build time.
5. Generate native adapters instead of requiring platform-language authoring.
6. Keep raw platform APIs available.
7. Compile actual React rather than replacing it with a JSX look-alike.
8. Use Yoga where React-Native-style layout is appropriate.
9. Use native toolkit layout for native desktop controls.
10. Use Blink directly for DOM applications.
11. Keep browser-specific knowledge outside the core compiler.
12. Use two privilege domains and one optional compatibility realm for desktop DOM applications.
13. Sandbox the DOM renderer by default.
14. Generate typed capabilities instead of generic RPC.
15. Keep V8 as an optional compatibility tool rather than the required application runtime.
16. Prebuild large platform SDKs.
17. Make dynamic execution, permissions, native calls, and process crossings visible.
18. Ensure that every framework feature remains reachable through lower-level TypeScript APIs.

The intended result is not merely another application framework.

It is:

> **TypeScript as a unified native systems and applications language—from POSIX and native libraries to mobile SDKs, platform widgets, React, and the real browser DOM.**

[1]: https://scriptc.dev/how-it-works "https://scriptc.dev/how-it-works"
[2]: https://docs.gtk.org/gtk4/getting_started.html "https://docs.gtk.org/gtk4/getting_started.html"
[3]: https://learn.microsoft.com/en-us/windows/apps/winui/winui3/ "https://learn.microsoft.com/en-us/windows/apps/winui/winui3/"
[4]: https://developer.apple.com/documentation/objectivec/objective-c-runtime "https://developer.apple.com/documentation/objectivec/objective-c-runtime"
[5]: https://developer.android.com/ndk/guides/jni-tips "https://developer.android.com/ndk/guides/jni-tips"
[6]: https://github.com/facebook/react/blob/main/packages/react-reconciler/README.md "https://github.com/facebook/react/blob/main/packages/react-reconciler/README.md"
[7]: https://reactnative.dev/architecture/render-pipeline "https://reactnative.dev/architecture/render-pipeline"
[8]: https://www.yogalayout.dev/docs/about-yoga "https://www.yogalayout.dev/docs/about-yoga"
[9]: https://chromium.googlesource.com/chromium/src/%2B/HEAD/third_party/blink/renderer/bindings/IDLCompiler.md "https://chromium.googlesource.com/chromium/src/%2B/HEAD/third_party/blink/renderer/bindings/IDLCompiler.md"
[10]: https://chromium.googlesource.com/chromium/src/%2B/HEAD/content/README.md "https://chromium.googlesource.com/chromium/src/%2B/HEAD/content/README.md"
[11]: https://chromium.googlesource.com/chromium/src/%2B/HEAD/docs/mojo_and_services.md "https://chromium.googlesource.com/chromium/src/%2B/HEAD/docs/mojo_and_services.md"
[12]: https://chromium.googlesource.com/chromium/src/%2B/HEAD/docs/design/sandbox.md "https://chromium.googlesource.com/chromium/src/%2B/HEAD/docs/design/sandbox.md"
[13]: https://scriptc.dev/ffi "https://scriptc.dev/ffi"
[14]: https://github.com/vercel-labs/scriptc/releases "https://github.com/vercel-labs/scriptc/releases"
