# Working with Android from TypeScript

Status: proposal, except where a section says otherwise  
Last revised: 2026-08-22

The Android crossing works: a compiled TypeScript program runs as an
application, draws, and answers a tap. What it is not yet is pleasant to
write. This document collects every rough edge the acceptance application
actually hit, proposes a fix for each, and says which are sugar, which are
machinery, and which are somebody else's capability.

Two measures, and neither may be traded for the other.

**Ergonomics.** A person who knows Android should be able to write the
Android they know. Where our spelling differs from Java's, the difference
must buy something a reader can name.

**Cost.** Everything stays generated: no runtime reflection, no method
lookup by name, no per-call allocation the platform would not also make.
A convenience that costs a JNI round trip per frame is not a convenience.

## The one thing worth taking from NativeScript

NativeScript writes a listener like this:

```js
button.setOnClickListener(
    new android.view.View.OnClickListener({
        onClick() {
            count++;
            text.setText(count.toString());
        }
    })
);
```

The part worth having is the CONSTRUCTION FORM: an interface is
implemented by passing an object of its methods, which reads like the
anonymous class it replaces and needs no separate class, no registration
call, and no bookkeeping variable.

The part not worth having is the DOTTED GLOBAL. `android.view.View` as an
ambient object means a program never says where a name comes from, unused
surface has to exist to be reachable, and something must populate that
object before the program runs. Ours are module imports and should stay
module imports — but the nesting inside them is worth keeping, because
`View.OnClickListener` is what the class is called:

```ts
import { View } from "@native-typescript/android/view";

button.setOnClickListener(new View.OnClickListener({ … }));
```

The module supplies the package; the outer class supplies the nesting.

And NativeScript buys its version with runtime metadata — the name lookup,
the method resolution, and the dispatch all happen while the app runs. We
do not have to make that trade, because our lookup happened at build time.
**The goal is that construction form over generated dispatch**: the same
line to write, without a reflective boundary at each tap.

## What is awkward today

Each of these is quoted from `fixtures/android-app/app.ts` or its
selection, not imagined.

### 1. A listener costs four statements and two module-scope arrays

```ts
const registrations: JvmConnection[] = [];
const listeners: ClickBridge[] = [];
// ...
const clicks = new ClickBridge();
listeners.push(clicks);
registrations.push(clicks.onClick((view) => { /* ... */ }));
button.setOnClickListener(clicks);
```

Java writes `button.setOnClickListener(v -> { ... })`. Four of our five
lines exist to satisfy lifetime rules rather than to say anything about
the program, and getting either array wrong produces a listener that
silently stops answering — the platform reports "no TypeScript handler is
registered", which is true and unhelpful.

### 2. Everything is nullable — RESOLVED, see B

`resized(a0: jint): Widget | null`, `getText(): string | null`,
`setContentView(a0: View | null)`. Java's type system says any reference
may be null, so the generated surface said so everywhere, and a program
narrowed values that cannot be absent. It now says so only where the class
file states nothing: `Intent.setAction` comes back as `Intent`, and
`Activity.getLocalClassName()` as `string`.

### 3. Overloads get hashed names

```ts
resize(a0: jdouble): void;
resize_df16004b(a0: jint, a1: jint): void;
```

`resize_df16004b` is a descriptor hash. It is stable and unguessable.

### 4. Selecting a class is a dependency hunt — RESOLVED, see D

Selecting `android/widget/TextView` failed until `android/view/View` was
selected, which failed until the ancestry above it was, and each failure
was a separate build. The rule was deliberate — an unselected superclass
is a silent-ancestry error rather than an invented one — but the
consequence was that adding one widget cost several rounds.

Correcting this entry, because investigating it found something worse than
the inconvenience it describes. That refusal only ever fired when the
ancestor was among the provided SOURCES. On the Android build path the
extractor pulls only the classes a selection NAMES, so an omitted ancestor
was not present-but-unselected — it was absent, and the guard could not
fire at all. Selecting `TextView` without `View` projected `TextView` with
an EXTERNAL superclass and lost every inherited member without a word.
The check was measuring a different question from the one that failed.

### 5. Constants must be listed by name — RESOLVED, see E

`{ binaryName: "android/view/Gravity", fields: ["CENTER"] }`. A constant
costs no call and no generated C; naming each one is bookkeeping for a
value the class file already states. The acceptance project now selects
`{ binaryName: "android/view/Gravity" }` and gets all 27.

### 6. A method belongs to the class that declares it — RESOLVED, see F

`Button` inherits `setText` from `TextView`, so selecting it on `Button`
failed with "does not exist". Correct, and surprising the first time.

### 7. `super` is spelled `ntsSuperOnCreate` — RESOLVED

`docs/native-subclassing.md` explicitly refuses this spelling in the
public API. It existed because without `extends` there was no `super` for
it to be. The acceptance application is now `class MainActivity extends Activity`
with `super.onCreate(state)`, on a device. Two things had to land for the
spelling to go: the manifest gained `baseCall`, naming the binding that
reaches what an override replaced, and `this` inside an override took its
type from the registration rather than from the declared base — so the
receiver is a MainActivity and widens to Activity on the way into the base
call.

### 8. A colour needs `| 0` — RESOLVED, see H

`label.setTextColor(0xFF000000 | 0)`. `0xFF000000` is 4278190080, which is
not an `int`, and Java's `int` is signed. The acceptance application now
writes `label.setTextColor(0xFF000000)`.

### 9. One flat package, and nested classes flattened into it — HALF RESOLVED, see G

Everything arrives from `@native-typescript/jvm-android`, where Java has
`android.app`, `android.os`, `android.widget` — and a nested class like
`View$OnClickListener` was spelled `ViewOnClickListener`, which is a name
that exists nowhere else. The nesting half is fixed: it now reads
`View.OnClickListener`. The one flat module is not, and is much larger
than it looks — see G.

## Proposals

### A. Implement an interface by passing its methods

**Call site:**

```ts
import { View } from "@native-typescript/android/view";

button.setOnClickListener(
  new View.OnClickListener({
    onClick(view) { /* ... */ },
  }),
);
```

and, for an interface with exactly one abstract method, the shorter form
NativeScript cannot offer, because ours knows at build time that there is
only one method a bare function could mean:

```ts
button.setOnClickListener((view) => { /* ... */ });
```

**How.** The generated implementation class IS the interface's name:
`View.OnClickListener` is constructible even though Java's interface is
not,
because an interface has no other constructor for the spelling to collide
with. Its constructor takes an object whose properties are the interface's
methods; the generator emits one `native` method per selected member, and
the constructor registers each handler on the instance it just made.
`ClickBridge` disappears from the program — the class the program names is
the class the generator emits.

The single-abstract-method form is the same machinery with the object
literal implied, admitted only where the interface has exactly one
abstract method, so there is never a question about which method a bare
function means.

**Lifetime, which is the whole difficulty.** A registration is anchored to
its receiver, so the bridge must outlive the call. Java's answer is that
the button holds the listener; ours cannot see that reference. Three
policies, and the choice should be explicit rather than emergent:

1. *Process-scoped by default.* The runtime keeps the bridge and its
   registration alive until the program disposes the returned
   `Registration`. Predictable, matches "this button lives as long as the
   screen", and leaks one closure per registration in a program that
   registers repeatedly.
2. *Cleaner-based.* The generated bridge enrolls in a `java.lang.ref`
   queue so the closure is released when ART collects the listener. Real
   machinery, needs a program that demonstrates the leak it fixes.
3. *Peer-scoped.* Once `docs/native-subclassing.md`'s peer exists,
   registrations made by a peer end when the peer's platform object is
   destroyed, which is what an Activity's listeners should do.

Proposal: ship (1) with the returned `Registration` documented as the way
to end one early, name (2) as its own slice, and adopt (3) as the default
when peers land. What must not happen is a default that looks like Java's
and silently unregisters — today's behaviour with the arrays omitted.

**Cost.** One Java object and one global reference per registration,
exactly as Java's anonymous class — and exactly what NativeScript
allocates for the same line. The difference is dispatch: theirs resolves
`onClick` through runtime metadata on every tap, ours is a registered
trampoline calling a closure. Same construction form, no lookup per
event.

### B. Read the nullability the class file already states

**Call site.** `activity.setContentView(view)` with no `| null`;
`getText()` still returns `string | null` where the platform says it may.

**How.** `android.jar` carries `RuntimeInvisibleParameterAnnotations` and
`RuntimeInvisibleAnnotations` naming `android.annotation.NonNull`,
`android.annotation.Nullable`, and the `androidx.annotation.Recently*`
pair. Ingestion does not read annotations at all today. Reading them and
projecting `@NonNull` positions as non-null is evidence, not inference —
the same rule that makes ABI facts come from a Clang probe.

**Where it must stay honest.** An annotation is a claim, not a proof. A
`@NonNull` RESULT that arrives null must refuse by name rather than hand
over a value the type says cannot exist — the callback payload arm
already does exactly this.

**Cost.** None at runtime; it is a type-level projection. Slightly less
generated branching where a result stops being optional.

### C. Real overloads

**Call site.** `widget.resize(2, 3)` and `widget.resize(1.5)`, both
spelled `resize`.

**How.** The generated declaration carries TypeScript overload signatures;
the compiler resolves a call to one of several distinct native bindings.
That resolution is a compiler capability rather than generator sugar,
because each overload is its own symbol.

**Cost.** Compile-time only. It removes a name nobody can guess.

### D. Select a class, get its ancestry

**How.** Selecting a class implies selecting the ancestors it needs to be
that class. An ancestor with no selected members costs one handle type and
no generated C, so the boundary does not move — what moves is how many
builds it takes to discover the list.

**Landed**, and the silent-ancestry refusal is gone rather than kept. The
proposal originally said to keep it "for the case it was written for: a
class that is present but deliberately outside the selection". There is no
such case. A class's superclass chain is not a decision a caller makes —
it is what the class file says the class IS — so there is nothing for a
caller to deliberately exclude, and the remedy for losing ancestry is to
supply it rather than to demand it.

Superclasses only, not interfaces. `extends` is what a projected class
needs to be itself; implying every implemented interface would sweep in
Serializable and Comparable, which say nothing about the surface a program
asked for.

**It takes two changes, not one, and the second is the one that mattered.**
Ingestion can imply an ancestor it can SEE. But a caller reading class
files out of an archive decides what ingestion can see before ingestion
runs, so the extractor has to ask the same question first —
`requiredJvmAncestry` answers "what else must come out of the jar". Without
that half, the Android path keeps the hole described in item 4 above: the
ancestor is absent rather than unselected, and absence was invisible to
the guard.

The acceptance project drops five selections it only ever named to satisfy
the rule, including the whole four-deep chain above `Activity`.

### E. Constants come with their class

**How.** Compile-time constants of a selected class are projected without
being listed. They cost no call, no C, and no runtime; the manifest grows
by a literal each. Fields that are NOT compile-time constants keep their
refusal, because reading one is a field access against a live class.

**Landed**, and the interesting half was not the projection. Implying
constants means meeting many more that cannot be projected — of 197 across
eight Android classes, 18 fall outside the algebra, 13 String and 5 float.
Under the old rule each was a hard refusal, which is right when a program
asked and absurd when it did not: selecting `android/view/View` would have
failed on thirteen String constants nobody mentioned.

So it turns on who asked. A NAMED field was asked about, and not
projecting it answers that question — it refuses. An IMPLIED one was never
asked about, so not projecting it is not a refusal at all; it is recorded
next to its class with the reason, and the reason is per constant, because
"String constants are not projected" and "f32 has no value form" are
different futures and a reader deserves to know which one they are waiting
on. Absence with a reason beside it is not silence.

That leaves `fields:` a better job than it had. It is now an ASSERTION
that these must project, rather than a selection of which ones do — so a
platform version that changes a constant's type is a diagnostic instead of
a silent disappearance. Naming a constant that would arrive anyway
produces byte-identical declarations and manifest digests, so no selection
written before this rule pays for having been written.

It also needed one compiler change, which is the kind this proposal keeps
producing: a class with BOTH a constructor and a merged namespace could
not resolve its constructor, because the merge predicate admitted an
ambient interface and not an ambient namespace. No such class had ever
existed — only constant-only classes got namespaces — so the gap was
invisible until constants came with their class.

### F. Members resolve on their declaring class

**How.** Selecting `setText` on `Button` resolves it on `TextView` and
selects it there, rather than refusing. The upcast chain already makes the
call legal; this only removes the requirement to know which ancestor
declares what.

**Landed.** The NEAREST declaring ancestor wins, which matters where an
ancestor overrides: asking for `setPadding` on `Button` resolves it on
`TextView`, not `View`, because TextView overrides it — the same binding a
Java compiler would choose, and identical at run time either way since JNI
dispatches virtually.

Methods only. A constructor is never inherited, and a callback is a native
method the class itself declares. A FIELD deliberately stays put: a
constant projects into a namespace merged with its declaring class, and
TypeScript does not inherit a merged namespace through `extends`, so
moving the selection would let ingestion succeed while `Button.MAX_LINES`
still failed to resolve — trading a clear refusal for a confusing one.

Superclasses only, matching D. A member found on an implemented interface
would resolve onto a class the projection does not carry.

The walk widens where a member may be FOUND and invents nothing: a name
that exists nowhere in the chain still refuses, and a member the class
declares itself — an override included — never triggers a search, because
the class file has already answered.

### G. Java package paths, and nested classes spelled as nested

**Call site.**

```ts
import { Activity } from "@native-typescript/android/app";
import { View } from "@native-typescript/android/view";

const listener = new View.OnClickListener({ /* ... */ });
```

**How.** Two changes with one motivation. Modules mirror the Java package
a class lives in (`android/app`, `android/os`, `android/view`,
`android/widget`) instead of one flat module per project. And a nested
class is emitted as a member of a namespace merged with its outer class,
so `android/view/View$OnClickListener` reads `View.OnClickListener` rather
than today's flattened `ViewOnClickListener` — a name that exists nowhere
else and that a reader cannot map back to Java. The namespace-merging
shape is already in use for constants.

The module supplies what Java's package prefix supplied; the outer class
supplies the nesting, which is part of the class's identity rather than
decoration. It also removes a collision class for free: two packages may
each nest an `OnClickListener`, and under this spelling they are
`View.OnClickListener` and whatever else, rather than two claims on one
flattened name.

**These two halves are not the same size, and they should be taken
separately.**

*Nested spelling* — **landed** — is generator-side with no runtime effect, as claimed. A
nested class is emitted inside a namespace named for its outer class, and
the nesting is spelled whether or not the outer class is itself selected —
a name that changed shape depending on an unrelated selection would be
worse than either spelling, and an outer namespace with no class beside it
is ordinary TypeScript. It needs one compiler change: a handle type's
declaration name becomes dotted for the first time, and the symbol walk
looks for the nested class on the outer class's INSTANCE type, where a
nested class does not live. The constant path already passes the right
member space; the type path does not.

*Per-package modules* — **not started** — is not generator-side and is much
larger than it reads. No generator emits a module other than `"."` within a package —
`bindgen-gir` uses a non-root module only to name a DIFFERENT package — so
sub-modules are a new packaging capability, touching what the manifest's
declaration references mean, how many files a binding package produces,
and how the target assembles them. It is worth doing and it is not a
spelling change.

**One boundary the spelling exposes, and it reaches proposal A.** A nested
class's own constructor declaration is the class name itself — one hop —
so `new View.OnClickListener(…)` resolves. A MEMBER on a nested class
would be two hops, and the compiler's symbol walk reads the declared type
at every hop after the first, where a namespace member does not live. That
refuses by name rather than emitting a binding that resolves to nothing.

Nothing in the projected surface takes that path today, but **A does**: a
generated implementation named `View.OnClickListener` would register its
`onClick` as a member of a nested class. So A needs the compiler rule
first — "value at every hop except the last, the member's own space at the
last" — and that rule is worth admitting only once a program needs it,
which A would be.

The spelling is also the half that was actually asked for. Module imports
are already what this project has and what makes it preferable to a dotted
ambient global; `android/widget` versus one flat module is a tidiness win,
while `View.OnClickListener` versus `ViewOnClickListener` is the
difference between a name a reader can map back to Java and one that
exists nowhere else.

### H. Colours and unsigned constants

**Awkward.** `label.setTextColor(0xFF000000)` does not compile. The
literal is 4278190080, `int` is signed, and the compiler refuses at the
call site: "the literal 4278190080, which no 'i32' value represents, so
this call could only throw." Every colour in Android is written this way,
so the first thing anyone puts on a screen hits it.

**How.** Admit the literal, by adopting the rule the source language
already has. This looked at first like a case for a helper —
`Int32.fromUnsigned(0xFF000000)` — on the reasoning that reinterpreting
an out-of-range number would be the boundary deciding what a program
meant. That reasoning was wrong about one thing: for a hexadecimal
literal the source language has already decided, and decided this way.

The line is between spellings, not between values: **a radix spelling
names bits, a decimal spelling names a quantity.** Java wrote it down in
JLS 3.10.1 — `int x = 0xFF000000;` compiles and means -16777216, while
`int x = 4278190080;` is rejected as "integer number too large" — but the
distinction is not Java's. It holds in C too, and in JavaScript's own
bitwise operators, because it is a fact about how people write bit
patterns rather than a fact about one language.

So: for an N-bit integer slot, a hexadecimal, binary, or octal literal in
`[2^(N-1), 2^N)` is admitted as its two's-complement value; the decimal
spelling of the same number keeps refusing, and says why. We are not
inventing a meaning for those bits — we are agreeing with the language
whose `int` it is, which is the same standard the rest of this boundary
holds itself to for layout and signedness.

Two properties make this cheap rather than a concession. It is a
compile-time rule on literals, so it costs nothing at runtime. And it
leaves computed values strict: an arithmetic result that overflows `int`
still refuses, because nothing in the source said those were bits.

**Landed.** Compiler-side, in `refuseUnprovableNumberLiterals`; no runtime
effect, both backends. The helper is superseded and was never built. The
decimal spelling of the same number still refuses, and its diagnostic now
names the spellings that are admitted — without that, the rule reads as
"large literals are fine now" and the next reader extends it to computed
values, where nothing in the source says what width the bits were for.

## The program, before and after

Today, from the acceptance application:

```ts
const registrations: JvmConnection[] = [];
const listeners: ClickBridge[] = [];

MainActivity.onCreate((activity, savedState: Bundle | null) => {
  activity.ntsSuperOnCreate(savedState);
  let taps = 0;
  const label = new TextView(activity);
  label.setTextColor(0xFF000000 | 0);
  label.setPadding(64, 420, 64, 32);
  const button = new Button(activity);
  button.setText("Tap me");
  const clicks = new ClickBridge();
  listeners.push(clicks);
  registrations.push(clicks.onClick((view) => {
    taps += 1;
    label.setText(`Tapped ${taps}`);
  }));
  button.setOnClickListener(clicks);
  const content = new LinearLayout(activity);
  content.setOrientation(1);
  content.addView(label);
  content.addView(button);
  activity.setContentView(content);
});
```

With everything in this document, plus the peer from
`docs/native-subclassing.md`:

```ts
import { Activity } from "@native-typescript/android/app";
import { Gravity } from "@native-typescript/android/view";
import {
  Button, LinearLayout, TextView,
} from "@native-typescript/android/widget";
import type { Bundle } from "@native-typescript/android/os";

export default class MainActivity extends Activity {
  private taps = 0;

  override onCreate(state: Bundle | null): void {
    super.onCreate(state);

    const label = new TextView(this);
    label.setTextColor(0xFF000000);
    label.setGravity(Gravity.CENTER);

    const button = new Button(this);
    button.setText("Tap me");
    /* The explicit form is `new View.OnClickListener({ onClick(v) {…} })`;
     * a bare function is admitted because this interface has exactly one
     * abstract method, so there is nothing else it could mean. */
    button.setOnClickListener(() => {
      this.taps += 1;
      label.setText(`Tapped ${this.taps}`);
    });

    const content = new LinearLayout(this);
    content.setOrientation(LinearLayout.VERTICAL);
    content.addView(label);
    content.addView(button);
    this.setContentView(content);
  }
}
```

Every line of the second is Android as an Android developer writes it, and
every call in it is a generated trampoline rather than a name resolved at
run time. The count moves from a closure into an instance field because
there is finally an instance to put it on, and nothing in the program is
bookkeeping.

## Threads, and which one your code runs on

A reasonable question, once the surface looks like Java: can a program use
`Thread`, `ExecutorService`, `Handler` and the rest the way Java does?

Mostly yes, and the interesting part is that our architecture already
answered this — `docs/runtime-and-threading.md` is normative here and says
more precisely what NativeScript's documentation says loosely. Three
different things hide under one question, and they have three different
answers.

### Calling Java's threading APIs: ordinary binding

`Executors.newFixedThreadPool(4)`, `handler.post(…)`, `queue.offer(x)`,
`new Thread(r)` are method calls on selected classes. Nothing about them
touches our runtime's threading, and nothing in the algebra treats them
specially — an `ExecutorService` is a handle exactly as a `TextView` is.

Measured rather than assumed: selecting `java/lang/Thread`,
`java/lang/Runnable`, `java/util/concurrent/{Executor,ExecutorService,
Executors}`, `android/os/Looper` and `android/os/Handler` against the real
`android.jar` ingests all eight classes and generates adapters with no new
family and no refusal — `Executors.newFixedThreadPool` comes back as an
`ExecutorService` handle, `Handler.post` as a boolean, `Thread.start` as
void. This costs nothing new to support.

### A Java thread calling back INTO TypeScript: refused today, by name

This is where the substance is. A runtime instance is bound to one **owner
executor** — on Android, the main Looper — and only callbacks on the owner
may enter compiled TypeScript, touch heap values, or drain microtasks.
That is not an implementation limit, it is the design: it is what keeps
every reference-count operation from becoming a shared-memory
synchronization problem.

So every generated trampoline carries this, and it is worth reading
because it is the whole answer:

```c
if (nts_jvm_runtime_owner_thread_is_current != NULL &&
    !nts_jvm_runtime_owner_thread_is_current()) {
  (*env)->ThrowNew(env, cls_illegal_state,
      "… was dispatched on a thread that does not own the TypeScript "
      "instance; a handler runs on the owning thread or not at all");
  return;
}
```

`new Thread(runnable).start()` with a TypeScript `run` therefore throws
`IllegalStateException` on that Java thread today. Loudly, naming the
thread rule, before touching a single managed value — which is the correct
failure and the one NativeScript's equivalent situation does not reliably
produce.

**The fix is already specified and small.** A runtime instance is defined
to have "a thread-safe foreign-event ingress queue", and the `queued`
delivery contract exists precisely to copy a payload and deliver it at the
runtime's pump. What is missing is that the guard is currently
unconditional: it refuses a queued dispatch that the design permits. The
change is to make the rule say what it means — **a synchronous delivery
(`answered` or `told`) requires the owner thread; a `queued` delivery may
be posted from any thread, because posting is all it does on the calling
thread** — and to hold the ingress queue to that. Then this works:

```ts
const pool = Executors.newFixedThreadPool(4);
pool.execute(new Runnable({          // delivery: "queued"
  run() { /* runs on the owner, posted from a pool thread */ },
}));
```

Note what it does and does not buy. The Java work runs on the pool's
threads; the TypeScript body runs on the owner. That is **safety, not
parallelism** — and it is exactly right for the common case, which is a
background Java API reporting a result the program wants to act on.

### TypeScript running concurrently: a second instance, not a second thread

For CPU-heavy TypeScript, the answer is not a Java thread at all. Ordinary
heap values belong to exactly one runtime instance and never cross between
instances; concurrency comes from a **separate runtime instance** with
explicit value transport.

This is the same answer NativeScript gives — its Workers are isolated JS
contexts, and `enableMultithreadedJavascript` defaults to `false` — so the
model is not a limitation we carry and they escape. The difference is that
theirs is a runtime configuration flag and ours is a property the compiler
can rely on.

One consequence worth naming, because it needs no new machinery: two
runtime instances can talk **through Java**. A `ConcurrentLinkedQueue` or
a `Handler` is a native handle, each instance holds its own reference to
it, and the object is as thread-safe as Java says it is. Value transport
between TypeScript instances is a real design question; passing a
platform object that both instances already know how to hold is not.

### Your own Java in the project

NativeScript lets a project drop `.java` under `App_Resources` and call
the result directly. We are closer to that than it looks: the build
already runs `javac` over generated subclasses and already ingests class
files by binary name, so a project's own Java sources compiling into the
application and becoming ingestible is plumbing rather than new
capability.

It is also worth more than it first appears, and possibly more than
threading. Every refusal in this boundary — a `CharSequence` result, a
`long[]`, a generic signature — is a case where a person could write four
lines of Java and move on, instead of waiting for the algebra to widen. An
escape hatch that lands in the same APK, with no reflection and no bridge,
takes the pressure off every "not yet projected" diagnostic we emit.

## The root cause, and the honest ordering

Most of the awkwardness above is one missing thing wearing several hats.
Proposals A, and the whole of `ntsSuper*`, exist because a TypeScript
class cannot yet BE a platform object: there is no peer to own a
registration, no `this` to be the receiver, and no `super` to call. That
capability is already specified in `docs/native-subclassing.md` and it is
the largest single ergonomic win available.

Everything else divides cleanly:

- **Free, generator-side, no contract change:** G's modules half; D, E, F
  and G's nesting half — *landed*.
- **Evidence the metadata already carries:** B — *landed*.
- **Compiler capability:** C, H — *H landed*, and the peer.

A reasonable order was B, D, E, F first — they are cheap, they remove the
most typing, and none of them changes what a program means. All four have
landed. Then A, whose
value is high and whose lifetime policy deserves the argument. Then the
peer, which subsumes part of A and all of `ntsSuper*`. C last, unless
overload-heavy surface arrives sooner.

## What this proposes NOT to do

**No runtime reflection.** Resolving a method by name at run time would
make every one of these easy and would cost a lookup per call, on a
platform where JNI granularity was already measured at 2.4x. The
generated path stays generated.

**No implicit lifetime.** A registration that quietly outlives what a
program can see is a leak; one that quietly dies is the bug this document
opens with. Either is worse than a policy stated in one place.

**No silent widening.** A `CharSequence` result is not a string, and it
stays a refusal rather than a conversion nobody asked for.

The two cases that looked like this one and were not are worth keeping
straight, because the distinction is the whole rule. `@NonNull` may be
wrong — so B narrows the slot and the adapter CHECKS the claim, which is
not trusting a widening but refusing a broken promise by name. And a
radix-spelled literal was never a widening at all: `0xFF000000` names 32
bits in every language that has the spelling, so admitting it agrees with
the source rather than converting behind the program's back. The decimal
spelling of the same number still refuses, which is where the line is.

**No per-dispatch cost that Java would not pay.** A synchronous payload that
does not escape now stays in JNI's local-reference frame: no global promotion
and no managed handle cell. A queued or escaping handler promotes exactly once.
The target publishes those mechanics and whole-program analysis chooses the
edge, as measured in
[record 0020](records/0020-frame-bounded-callback-payloads.md).
