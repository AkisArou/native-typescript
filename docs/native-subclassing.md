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

## Implementation status — Android/JNI

The JVM track built most of this document's Android path WITHOUT REFERENCE TO
IT, which is the strongest evidence available that the direction is right: what
follows is a list of predictions this document made, discovered independently
and then found already written down. What it records is what EXISTS, so a
reader can tell the direction from the distance still to travel.

**Host-owned construction, without the peer.** The packager generates a `final`
Java subclass named in the generated manifest, compiled by javac against the
platform jar, and ART constructs it (`0d39608b`, `516cb34d`). The generated
class carries `static { System.loadLibrary(…) }`, because a class the platform
constructs runs nothing of ours first, and it is generated into a package the
application owns — Android refuses application classes defined under
`android.*`.

What is absent is the PEER. A reached override today dispatches to a
registration rather than to a TypeScript object, so this document's "create or
attach one TypeScript peer" step has no implementation and ordinary instance
fields have nowhere to live.

**Registration is class-anchored** (`350348fb`, `70b4155c`). The platform never
hands over the instance before calling it, so there is no moment at which a
program could name one: registration attaches to the CLASS, answers for every
instance, and the receiver arrives as the handler's first argument. The
contract is process-owned — nothing owns the registration, so it returns
nothing and cancels through nothing — and the receiver crosses as an owned
handle the adapter promotes from the frame-scoped JNI local, with the managed
cell's destructor giving the promotion back. Storing it is therefore
memory-safe; keeping it past `onDestroy` is the ordinary Android leak, which is
the program's business.

**Lifecycle overrides run on the thread ART dispatches on** (`92bbc773`).
`JNI_OnLoad` adopts the LOADING thread as the instance's owner and returns —
nothing spawned, nothing parked — which is correct because the library is
loaded from the generated Activity's own static initializer, so the loading
thread is the main looper's. Every generated trampoline asks the runtime whether
it is on the owning thread and throws `IllegalStateException` by name otherwise
(`512fa6b4`); the predicate is weak, so an adapter linked without this runtime
degrades to the previous behaviour rather than refusing every delivery.

**The base call is a real binding.** `super`'s mechanism is this document's
first listed option: a generated Java superclass bridge that javac compiles to
`invokespecial`, ingested as an ordinary instance method. **Divergence,
temporary:** it is currently EXPOSED on the TypeScript surface as
`ntsSuperOnCreate`, which the `super` semantics section explicitly refuses. It
has nowhere else to live until `extends` gives `super` something to mean. It is
a way-station, and it should disappear in the same change that admits native
base classes.

**Payloads.** An override's object payload crosses as an owned handle, and a
SYNCHRONOUS payload may be withheld (`6e371b36`, `ecbe9957`) — which is what a
first launch's null `savedInstanceState` is: the platform reporting absence,
not a caller declining to pass something. Both arms are taken on a device: a
cold start reports "fresh", a rotation recreates the Activity and reports
"restored".

**`implements` for interfaces is built**, and the contrast with the paragraph
above is the part worth keeping. ART constructs the Activity, so its lifecycle
registration is class-anchored and process-owned; the program constructs a
listener, so its registration is instance-anchored the ordinary way. One
generator, opposite anchors, and the difference is WHO OWNS THE OBJECT rather
than what kind of thing it is. A generated bridge implementing
`View.OnClickListener` passes where the interface is expected because identity
upcasts now include selected interfaces, walked transitively — at the ABI a
jobject is a jobject, and the manifest says so. A default method is refused by
name: replacing an implementation the interface already provides is a different
act from providing the first one.

**It runs** (`4577bd6c`). A signed, 16KB-aligned APK installs and launches on an
emulator; the device lane asserts the platform's own view hierarchy rather than
pixels or only a log line, so what it checks is that the handler's work reached
the platform. A tap reaches a TypeScript handler and its result returns to the
screen.

### The peer's lifetime is the undeclared part, not its lowering

Investigated 2026-08-22, recorded because the obstacle is not where it looks.

The peer carries the native base handle so inherited methods work, so peer →
handle is strong. For the peer to survive BETWEEN lifecycle callbacks —
`onCreate` setting a field the later `onStart` reads — something must keep it
alive, and the only candidate that is not "retain every peer for the process"
is the handle cell itself. That makes handle → peer strong too, and the two
edges are a cycle neither side leaves.

Both breaks are wrong in a way a program can observe:

- **Weak handle → peer.** Nothing holds the peer between callbacks, so it is
  collected and the next dispatch builds a fresh one. The identity rule above
  still holds — a collected peer is not live — while the program watches its
  fields reset for no reason it can see.
- **Strong handle → peer.** The peer lives exactly as long as the cell, which
  is correct for Android, where destruction ends it. But this document forbids
  keeping a platform lifecycle object alive to preserve a convenient managed
  reference, and choosing this without saying so is exactly the silent policy
  the *Identity and lifetime* section requires to be declared.

So the peer is not blocked on the lowerer. It is blocked on the per-platform
lifetime declaration this document already demands and Android does not yet
have: what keeps the peer alive, which callback ends it, and which executor
performs the final release. Writing that down is the prerequisite; the lowering
is downstream of it.

**The cycle resolves, and the resolution is to stop asking the cell to answer
two questions.** ASSOCIATION — which peer belongs to this handle — is a lookup
and may be weak. LIFETIME — how long the peer lives — is not the cell's
business at all, and giving it to the cell is what produced the cycle. Give it
instead to the registration, which already exists per receiver and already
routes the callbacks: registration → peer strong, handle → peer weak, peer →
handle strong. No cycle.

The strong edge is then cut by a platform TERMINAL EVENT rather than by
reachability — `onDestroy` on Android — and the generated class can always
override it whether or not the program does, so the hook cannot be forgotten.
This does not violate the prohibition above: the peer's reference ends when the
platform declares the object over, which is the platform's own lifetime adopted
exactly rather than a managed reference held for convenience.

That makes lifetime the third STATED SELECTION FACT, beside `delivery` and
`anchor`, and for the same reason each of those exists: a class file cannot say
which method ends the object, so the manifest says it —
`terminal: { name: "onDestroy", descriptor: "()V" }` — and a base that
publishes no terminal event refuses by name when a subclass declares instance
fields.

**A JNI fact that invalidates the cheap association.** The claim that interning
by foreign pointer already yields one cell per object does NOT hold for JNI:
`NewGlobalRef` called twice on one object returns two distinct `jobject`s, and
the specification forbids comparing references with `==` — `IsSameObject`
exists precisely because identity is not the pointer. So cells key
per-REFERENCE, and two dispatches carrying the same Activity can intern to two
cells. Association therefore needs a stored identity on the generated object or
an `IsSameObject` scan over live peers, which is O(n) over the handful of
lifecycle objects a program has and is entirely affordable. This is a
correctness requirement rather than an optimisation, and it would otherwise be
discovered after the lowering looked finished.

**What does NOT need it.** A class extending a native class with NO managed
fields has no second object and therefore no cycle: `this` is the handle cell,
whose identity the interning map already guarantees. Overrides, `this`, and
`super` are all reachable that way, which is why they can ship first — and an
instance field is what must refuse by name until the policy above exists.

### Implementation plan: the no-fields slice

Written 2026-08-22 after investigating the lowerer, so the next attempt starts
from mechanics rather than from a survey. This slice deliberately excludes
instance fields, which is what keeps it free of the peer's lifetime question
above.

**What it delivers.** `class MainActivity extends Activity` with `override`
methods, a real `this`, and a real `super` — the program this document's source
model shows, minus fields. It removes `ntsSuperOnCreate` from the public
surface, which this document's `super` section refuses and which ships today
only because there is no `super` for it to be.

**Why no fields means no peer.** With no managed state, `this` IS the native
handle cell: there is no second object to associate, so nothing needs the
registration to own a peer and nothing needs a terminal event. An instance
field is exactly what introduces the second object, which is why it refuses
here and waits for the policy above.

**Recognition is already in** (fork `2d81d607`). `nativeBaseHandleName` resolves
a base identifier through its value symbol, resolving aliases the way
`nativeTypeOf` does, and answers with the handle type the base declares. Today
it feeds a diagnostic; it is the same question the lowering asks.

**The shape of the lowering.** An override is a REGISTRATION the program does
not write:

    class MainActivity extends Activity {
      override onCreate(state: Bundle | null): void { super.onCreate(state); … }
    }

is the program that exists today spelled as a class:

    MainActivity.onCreate((self, state) => { self.ntsSuperOnCreate(state); … });

So the lowering is: for each `override m`, find the binding whose declaration
is `${className}.${m}`, lower the method body as a closure whose first
parameter is the receiver, bind `this` to that parameter, and append the
registration call to the declaring file's init (`lowerFileInit` in
`lower-modules.ts`, which is where a file's top-level statements already go).
`super.m(args)` lowers to the base-call binding on the same receiver.

**What must refuse, each by name.** An instance field or a constructor (the
peer). A non-`override` method, since nothing dispatches it. An `override` with
no matching binding — the class the packager generated does not declare that
member, which is a selection problem and should say so. A `super` call to a
member whose metadata records no base implementation.

**What proves it.** A fork program is not enough: the fixture's handles are
interfaces, and the registration-per-override shape only exists in a generated
JVM surface. The honest test is the Android acceptance application rewritten in
the class form, on the device, asserting the same log line — which makes this
slice's gate the JVM session's lane rather than the fork's.

**The risk worth naming.** Synthesizing a call the program did not write is new
in this lowerer. Everything else here is rearrangement of existing paths, so if
that one piece resists, the slice is not obviously worth forcing.

### Not yet built

- **The peer**, and therefore instance fields. This is the largest gap between
  the code and this document.
- **`extends` over a native base class** in the lowerer, which knows `extends`
  only for mixin functions today.
- **An application-declared constructor**, which this document already defers.
