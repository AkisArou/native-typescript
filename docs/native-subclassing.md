# Native Subclassing and Platform Lifecycle

Status: normative; Android/JNI peers implemented  
Last revised: 2026-08-22

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

### What holds the peer, and what lets go

**The peer holds the handle, and the terminal event releases it rather than
the collector.** The peer needs the handle to call inherited methods, and it
needs it outside a dispatch — a closure created in `onCreate` and run on a
later tap may call `this.finish()`, with no receiver arriving from anywhere.
So the reference is owned, not borrowed per dispatch.

That makes deterministic release part of the design rather than a nicety. A
global reference to an Activity keeps its view tree and its Context alive,
which is the classic Android leak; holding one until a collector happens to
notice would mean the platform's teardown had completed while the objects it
tore down were still reachable. The terminal event is what makes the release
a point in time instead of an eventuality — which is a second reason for it
to exist, beyond cutting the cycle.

The peer carries the native handle, or inherited methods cannot be called on
it. Something must hold the PEER, or it is collected between two lifecycle
callbacks and the program loses its state without a word. If the thing holding
the peer is the handle's own managed cell, the two hold each other and neither
is released. Neither horn is acceptable: a weak edge silently resets state, a
strong one leaks every peer for the life of the process.

The cell is being asked to do two jobs, and only one of them is its.

- **Association** — which peer belongs to this handle — is a LOOKUP, and is
  weak. It answers a question; it does not decide how long anything lives.
- **Lifetime** — how long the peer lives — belongs to the class-anchored
  REGISTRATION, which already exists per receiver and is already what routes a
  callback to its handler. It holds the peer strongly.

The strong edge is then cut by a platform EVENT rather than by reachability,
which is what makes it terminate. This does not violate the rule above: the
peer's reference ends when the platform itself declares the object over, so
the object is never held one dispatch longer than the platform's own contract
holds it. That is the opposite of preserving a convenient reference.

**The terminal event is a stated selection fact.** A class file cannot say
which method ends an object — Android's `onDestroy` is an ordinary void method
in the bytes — so the selection states it, exactly as `delivery`, `anchor` and
a callback's `baseCall` are stated and for the identical reason: the metadata
is silent, and inferring from a name would make a platform convention into a
contract nobody wrote.

```
{ baseBinaryName: "android/app/Activity",
  anchor: "class",
  terminal: { name: "onDestroy", descriptor: "()V" }, … }
```

It is admitted only on a class-anchored subclass. Where the PROGRAM constructs
the object it also holds it, so its peer's lifetime is the program's business
rather than a policy the platform declares. Absent means the platform declares
no end — the honest reading for a base that has none, and the reason a peer
with state cannot be built on such a base rather than an omission to work
around. Android publishes one for every base that matters: `Activity` and
`Service` end at `onDestroy`, `Fragment` at `onDetach`, and a
`BroadcastReceiver`'s life IS the single `onReceive`.

**JNI references are not identities, which constrains the association half.**
`NewGlobalRef` called twice on one object yields two distinct `jobject`s, and
the JNI specification forbids comparing references with `==` — `IsSameObject`
exists because of it. So a cell table keyed by pointer collapses
per-REFERENCE, not per-object, and two dispatches carrying the same Activity
can arrive as two cells. Association therefore needs either an `IsSameObject`
scan over live peers, which is O(n) over the handful of lifecycle objects a
process has and entirely adequate, or an identity stored on the object itself.

**Status on Android/JNI: built.** The generator checks the terminal selection,
emits the override even when source omits it, and gives the generated object an
opaque `long` association slot. SCABI names the slot's exact read/write ABI and
the terminal registration; Native IR attaches one managed peer on first
dispatch, roots it for the registration, and clears the slot before releasing
that root after the terminal body. A terminal naming a missing or
non-overridable member, or one stated where the program owns the object, still
fails by name at generation.

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

This is not a concession and it is not ours: a recreated activity is a new
Java object whose own fields are gone, so a peer field resetting is the
behaviour a Java or Kotlin program has. What differs is only that nobody
expects it the first time, in either language.

The device lane distinguishes those two questions. It first proves that a field
written by `onCreate` is recovered by `onStart` on the same Activity. It then
mutates another peer field, rotates, and asserts the replacement Activity's
first mutation starts from its initializer rather than the old value. The fork
fixture separately counts live host objects after the terminal dispatch, so
correct identity with an uncut registration root is also a failure.

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

**Host-owned construction, with a peer when source declares fields.** The packager generates a `final`
Java subclass named in the generated manifest, compiled by javac against the
platform jar, and ART constructs it (`0d39608b`, `516cb34d`). The generated
class carries `static { System.loadLibrary(…) }`, because a class the platform
constructs runs nothing of ours first, and it is generated into a package the
application owns — Android refuses application classes defined under
`android.*`.

For a source class with fields, the generated class also carries the opaque
association slot. Every reached lifecycle registration delivers the generated
receiver, the compiler recovers or creates its managed peer, and source `this`
is that peer. The peer's hidden strong handle projects back into inherited
native calls—including calls made later by a closure that captured `this`.
A source class without fields keeps the earlier cheap shape and allocates no
peer.

**Registration is class-anchored** (`350348fb`, `70b4155c`). The platform never
hands over the instance before calling it, so there is no moment at which a
program could name one: registration attaches to the CLASS, answers for every
instance, and the receiver arrives as the handler's first argument. The
contract is process-owned — nothing owns the registration, so it returns
nothing and cancels through nothing — and the receiver crosses as an owned
handle whose physical form begins as the frame-scoped JNI local. The adapter
names exact promotion and local-release mechanics; compiler escape analysis
selects promotion when the peer or program retains the receiver, and the
managed cell's destructor gives that promotion back. Storing it is therefore
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

**The base call is a real binding, and `super` reaches it.** `super`'s
mechanism is this document's first listed option: a generated Java superclass
bridge that javac compiles to `invokespecial`, ingested as an ordinary instance
method. The manifest names it — `baseCall` on the registration — because a
class file cannot say which method is another method's base: a bridge is an
ordinary instance method and nothing in the bytes marks it.

Naming it is also what makes `super` STATIC in fact and not only in intent. The
member behind `super.onCreate` is `Activity.onCreate`, so resolving the call by
member symbol produced a virtual call that redispatched into the override that
made it — unbounded recursion, reported by ART as SuperNotCalled and by nothing
else. `super.m` denotes the base implementation, which is a different operation
from the member of that name, and the manifest is where the difference is
stated.

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

### The peer's lifetime, implemented

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

This was the point at which implementation correctly paused: Android first had
to state what keeps the peer alive, which callback ends it, and which executor
performs the final release. Once `terminal` supplied that policy, the lowering
could implement it without inventing lifecycle semantics.

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

The implemented representation follows those edges directly:

- the generated Java object stores one opaque peer pointer as association;
- the first delivered receiver creates the ScriptC peer, runs field
  initializers, and writes that pointer;
- the class-anchored registration holds one strong peer reference between
  dispatches;
- the peer holds one strong managed handle, typed at the declared native base,
  so inherited calls remain available outside a dispatch;
- every later JNI reference for the same object reads the same peer through the
  generated slot, independent of handle-cell interning;
- the terminal override clears the slot before releasing the registration
  root, including when the source class never declared that override.

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
fields has no second object and therefore no cycle: nothing the program can
hold outlives a dispatch, so one cell per object and one cell per dispatch are
indistinguishable. Note that this does NOT rest on interning — the paragraph
above is exactly why it cannot: a JVM handle declares `identity: "none"`, so
every dispatch builds a fresh cell, and only `pointer`-identity handles intern.
Identity becomes observable the moment a field exists, which is the same
boundary the refusal draws. Overrides, `this`, and `super` are all reachable
without it, which is why they ship first.

### The zero-cost no-fields slice remains

`class MainActivity extends Activity` with `override` methods, a real `this`
and a real `super` runs on a device. What it delivers and what it refuses is
recorded in [status](status.md); three things learned building it belong here,
because each is a fact about the SHAPE rather than about progress.

**An override's `this` is typed by the REGISTRATION, not by the declared base.**
A class-anchored registration answers for every instance of the class the
packager generated, so the receiver it delivers is that class, while `extends
Activity` names an ancestor — a weaker statement about a different type. Typing
`this` from the base produced a handler the registration could not accept.

**`super.m` is not the member of that name.** Resolving it by member symbol
reaches the base's own virtual binding, which redispatches into the override
that called it. The manifest's `baseCall` is what makes the distinction, and
nothing else can: in a class file a bridge is an ordinary instance method.

**What proves it is the device lane**, not a fork program. The registration-per-
override shape only exists in a generated platform surface, and both defects
above were invisible to a fork fixture until it was given the shape a real
surface always has — a base one upcast above the receiver, and a base whose
member is itself bound. See
[0012](records/0012-checks-that-cannot-fail.md).

### Not yet built

- **An application-declared constructor**, which this document already defers.
