# Native Subclassing and Platform Lifecycle

Status: normative direction; implementation not started  
Last revised: 2026-08-15

This document defines how ordinary TypeScript classes participate in native
platform inheritance, protocol/interface implementation, and host-owned
application lifecycle.

## Decision

When a platform's idiomatic application model is subclass-based, the public
Native TypeScript API is subclass-based too. Applications do not expose a free
adapter-shaped function merely because generated JNI, Objective-C++, or WinRT
glue ultimately receives the platform callback.

Examples include:

- Android `Activity.onCreate()` and related lifecycle overrides;
- UIKit and AppKit view-controller or application-delegate subclasses;
- Windows application/window lifecycle overrides;
- platform interfaces, delegates, and protocols implemented by application
  classes.

Generated foreign-language subclasses and registration thunks are internal
artifact-graph products. They preserve the source class's declared inheritance
and lifecycle instead of becoming the user-facing architecture.

Authoritative platform references include Android's
[Activity](https://developer.android.com/reference/android/app/Activity)
lifecycle, UIKit's
[UIViewController](https://developer.apple.com/documentation/uikit/uiviewcontroller),
AppKit's
[NSViewController](https://developer.apple.com/documentation/appkit/nsviewcontroller),
and WinUI's application
[OnLaunched](https://learn.microsoft.com/windows/apps/winui/winui3/desktop-winui3-app-with-basic-interop)
override model.

## Source model

The source uses ordinary TypeScript class syntax:

```ts
import { Activity } from "@native-typescript/android/app";
import { Bundle } from "@native-typescript/android/os";

export default class MainActivity extends Activity {
  override onCreate(state: Bundle | null): void {
    super.onCreate(state);
    // application initialization
  }
}
```

The build configuration or platform application description identifies the
entry class by exact declaration identity. Whether the initial configuration
uses a default export, an explicit application declaration, or generated
manifest metadata will be finalized with the application packager; it cannot
fall back to runtime name lookup.

Only metadata-proven subclassable native classes may be extended. Final,
sealed, unavailable, unsafe-to-subclass, or construction-incompatible classes
produce source-located diagnostics.

The initial host-created profile does not permit an application-declared
constructor. Platform construction acts as the native base-construction step;
peer attachment then runs the implicit TypeScript instance initialization and
field initializers exactly once before the first reached lifecycle override.
This preserves the ordering an implicit derived constructor would have after
`super()` without pretending application code allocated the native base.

A later explicit peer-constructor feature requires its own platform metadata,
argument, failure, and recreation contract. It must not reinterpret an ordinary
TypeScript constructor as a callback from the host.

An override must match one authoritative native member contract:

- source and native declaration identity;
- visibility and static/instance role;
- parameter and result projection;
- nullability, error, and exception policy;
- reentrancy and required executor;
- ownership and callback lifetime;
- whether a base implementation exists or must be invoked.

Overload or selector ambiguity is resolved before lowering. The compiler never
infers a native override from a similar spelling alone.

## Host-owned construction

Platform frameworks frequently construct application objects themselves.
Android instantiates an activity named by the application manifest; UIKit,
AppKit, and Windows application models may instantiate registered application,
delegate, controller, or activation classes.

The generated adapter therefore performs a host-owned construction sequence:

```text
platform constructs generated native subclass
        │
        ▼
adapter resolves the selected RuntimeInstance
        │
        ▼
create or attach one TypeScript peer
        │
        ▼
associate exact native and managed identity
        │
        ▼
dispatch the reached TypeScript override on its owner executor
```

This path is distinct from application-owned `new NativeClass(...)`. It does
not call a public platform constructor from TypeScript and then replace the
object the host already created.

The generated native instance stores only the minimum peer/runtime identity
required by the adapter. Ordinary TypeScript fields remain in the ScriptC
object and do not mutate Java object layout, Objective-C ivar layout, COM
layout, or a platform metadata format.

The managed peer carries the checked native base handle used by inherited
native properties and methods. `this` therefore names one TypeScript peer with
ordinary managed fields plus one opaque associated native identity; it is not
two independently constructible application objects.

Initialization is transactional. If peer creation, runtime association, or
source initialization fails, the adapter applies the platform's declared
failure policy and releases every partially established native and managed
obligation exactly once.

## Override dispatch

A platform callback into an override is a checked native entry:

- the adapter validates runtime, peer, generation, lifecycle, and executor;
- foreign arguments are projected according to SCABI;
- same-owner synchronous lifecycle callbacks may enter TypeScript reentrantly
  only under the common checked-entry rules;
- foreign-thread callbacks use the owner gateway and cannot pretend to return a
  synchronous TypeScript value;
- the reached override executes as a ScriptC turn and follows the specified
  microtask checkpoint rule;
- no Java, Objective-C, C++, COM, or platform exception unwinds through
  ScriptC-generated frames.

Generated adapter entry points remain visible in Native IR and build reports.
They are not exported as a second user-callable lifecycle API.

## `super` semantics

`super.member(...)` in a native override is statically bound to the immediate
declared native base implementation. It must not dynamically redispatch to the
same TypeScript override.

The platform adapter realizes this with the authoritative mechanism, such as:

- a generated Java superclass bridge or checked JNI nonvirtual call;
- Objective-C `super` dispatch from a generated subclass method;
- a generated C++/WinRT base implementation call;
- another metadata-proven platform base-call operation.

SCABI records a distinct base-call binding. The compiler validates its receiver,
arguments, result, executor, error, and ownership contracts like any other
native operation. Rewriting `activity.superOnCreate()` or exposing a manually
named helper in the public API is not accepted.

If the native contract requires the base implementation to be called, checked
builds diagnose or trap an override turn that returns without doing so. If base
invocation is forbidden, unavailable, or optional, metadata records that rule
explicitly.

## Identity and lifetime

One live host-created native instance has at most one managed peer per runtime
under the declared identity policy. Repeated projection returns the same
managed handle/peer rather than constructing unrelated TypeScript objects.

The lifecycle declares:

- what keeps the platform instance alive;
- what keeps the TypeScript peer and runtime alive;
- which platform callback establishes the association;
- whether recreation produces a new instance or restores state into a new peer;
- which callback or native invalidation ends method access;
- when callbacks, child handles, and weak references are detached;
- which executor performs final release.

Android activity destruction, Apple controller/delegate invalidation, Windows
window/application teardown, and process shutdown race through the ordinary
handle/callback lifecycle. A platform-owned object is not explicitly destroyed
merely because one TypeScript alias is released.

The adapter must not keep a platform lifecycle object alive indefinitely to
preserve a convenient managed reference. Strong, weak, borrowed, and
invalidation edges follow authoritative platform ownership.

## Interfaces, protocols, and delegates

Native interfaces and Objective-C protocols may project through TypeScript
`implements` only when generated adapter conformance is exact and closed. The
adapter advertises only the selected native interfaces/protocols and generates
only reached methods.

Optional protocol methods remain distinguishable from required methods.
Selector or method presence is not implemented by a generic runtime reflection
table when reachability can generate a fixed adapter.

Delegate retention—strong, weak, copied, or unretained—is explicit SCABI data.
A weak native delegate does not become strong because the TypeScript class
implements its protocol, and a retained block/listener does not become weak to
avoid a cycle.

## Platform requirements

### Android/JNI

The packager generates a Java/Kotlin-compatible subclass named in the Android
manifest. It preserves the activity/application class loader, owns the correct
`JavaVM` association, uses local/global/weak-global references correctly,
checks Java exceptions, and invokes lifecycle overrides on the main Looper.

Android may destroy and later recreate an activity. Source fields therefore
belong to that activity peer, not durable application state by implication.
Saved-state APIs remain ordinary Android APIs.

### Apple/Objective-C

The packager generates and registers an Objective-C-compatible subclass or
protocol adapter before the platform may instantiate it. Objective-C method
families, ARC, weak delegates, autorelease scopes, selectors, main-actor rules,
and `super` dispatch remain authoritative.

Pure-Swift-only inheritance requires an explicit generated Swift adapter and is
not inferred from an Objective-C-compatible surface.

### Windows/WinRT

The packager emits the required activation, application, or window adapter and
metadata. Overrides preserve COM identity, apartment/agility rules, dispatcher
affinity, and base-call semantics. A platform object is released only from an
allowed apartment.

### GObject

GObject subclassing may use the same source model once class initialization,
virtual methods, instance identity, properties, and finalization are represented
explicitly. The initial GTK surface uses ordinary constructors and signals; it
does not claim GObject subclassing merely because the source projection uses
classes for native handles.

## Generated artifacts

Native subclassing may produce:

- Java/Kotlin-compatible subclass and JNI registration sources;
- Objective-C++ subclass, protocol, selector, and base-call adapters;
- Swift adapters for explicitly supported Swift-only surfaces;
- C++/WinRT activation and base-call adapters;
- application manifest, class registration, linker retention, and metadata
  fragments;
- source declaration and native override maps;
- lifecycle, identity, and exception-boundary reports.

Every artifact is deterministic, content-addressed where sound, and generated
from exact reached declarations plus SDK metadata. Native registration cannot
depend on an unreported scan of source names at application startup.

## Static restrictions

The initial implementation may deliberately reject:

- dynamically computed base classes or decorators that alter inheritance;
- multiple native class inheritance;
- native generic subclass instantiation without one fixed ABI specialization;
- an explicit source constructor on an initially host-created native subclass;
- overriding a member after class creation;
- arbitrary runtime method swizzling;
- reflection-based discovery of unreferenced overrides;
- construction before the owning runtime instance exists;
- synchronous foreign-thread override results without a separately specified
  deadlock/reentrancy contract.

These are precise static-profile boundaries, not reasons to replace the class
API with free functions.

## Conformance gates

The common native-subclass suite includes:

- platform-owned construction and exact peer identity;
- reached override registration and unreached override elimination;
- immediate-base `super` dispatch without recursive redispatch;
- required, optional, and forbidden base-call policy;
- same-owner reentrant lifecycle entry and microtask ordering;
- foreign exception and TypeScript exception conversion;
- teardown/invalidation racing with retained callbacks;
- platform recreation producing the declared new-peer/state behavior;
- weak delegate/protocol lifetime;
- multiple runtime instances without a process-global peer collision;
- generated artifact determinism and application metadata agreement;
- sanitizer, leak, and platform lifecycle fixtures.
