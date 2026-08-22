# Working with Android from TypeScript

Status: proposal; nothing here is implemented  
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

### 2. Everything is nullable

`resized(a0: jint): Widget | null`, `getText(): string | null`,
`setContentView(a0: View | null)`. Java's type system says any reference
may be null, so the generated surface says so everywhere, and a program
narrows values that cannot be absent.

### 3. Overloads get hashed names

```ts
resize(a0: jdouble): void;
resize_df16004b(a0: jint, a1: jint): void;
```

`resize_df16004b` is a descriptor hash. It is stable and unguessable.

### 4. Selecting a class is a dependency hunt

Selecting `android/widget/TextView` fails until `android/view/View` is
selected, which fails until the ancestry above it is, and each failure is
a separate build. The rule is deliberate — an unselected superclass is a
silent-ancestry error rather than an invented one — but the consequence
is that adding one widget costs several rounds.

### 5. Constants must be listed by name

`{ binaryName: "android/view/Gravity", fields: ["CENTER"] }`. A constant
costs no call and no generated C; naming each one is bookkeeping for a
value the class file already states.

### 6. A method belongs to the class that declares it

`Button` inherits `setText` from `TextView`, so selecting it on `Button`
fails with "does not exist". Correct, and surprising the first time.

### 7. `super` is spelled `ntsSuperOnCreate`

`docs/native-subclassing.md` explicitly refuses this spelling in the
public API. It exists because without `extends` there is no `super` for it
to be.

### 8. A colour needs `| 0`

`label.setTextColor(0xFF000000 | 0)`. `0xFF000000` is 4278190080, which is
not an `int`, and Java's `int` is signed.

### 9. One flat package, and nested classes flattened into it

Everything arrives from `@native-typescript/jvm-android`, where Java has
`android.app`, `android.os`, `android.widget` — and a nested class like
`View$OnClickListener` is spelled `ViewOnClickListener`, which is a name
that exists nowhere else.

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
builds it takes to discover the list. Keep the silent-ancestry refusal for
the case it was written for: a class that is present but deliberately
outside the selection.

### E. Constants come with their class

**How.** Compile-time constants of a selected class are projected without
being listed. They cost no call, no C, and no runtime; the manifest grows
by a literal each. Fields that are NOT compile-time constants keep their
refusal, because reading one is a field access against a live class.

### F. Members resolve on their declaring class

**How.** Selecting `setText` on `Button` resolves it on `TextView` and
selects it there, rather than refusing. The upcast chain already makes the
call legal; this only removes the requirement to know which ancestor
declares what.

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

Generator-side; no runtime effect.

### H. Colours and unsigned constants

**How.** A helper — `Int32.fromUnsigned(0xFF000000)` — rather than
teaching the boundary to reinterpret out-of-range numbers. Silent
reinterpretation would be the boundary deciding what a program meant; a
named helper is the program saying it.

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
    label.setTextColor(Int32.fromUnsigned(0xFF000000));
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

## The root cause, and the honest ordering

Most of the awkwardness above is one missing thing wearing several hats.
Proposals A, and the whole of `ntsSuper*`, exist because a TypeScript
class cannot yet BE a platform object: there is no peer to own a
registration, no `this` to be the receiver, and no `super` to call. That
capability is already specified in `docs/native-subclassing.md` and it is
the largest single ergonomic win available.

Everything else divides cleanly:

- **Free, generator-side, no contract change:** D, E, F, G, H.
- **Evidence the metadata already carries:** B.
- **Compiler capability:** C, and the peer.

A reasonable order is B, D, E, F first — they are cheap, they remove the
most typing, and none of them changes what a program means. Then A, whose
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

**No silent widening.** `@NonNull` may be wrong, an unsigned literal is
not an `int`, and a `CharSequence` result is not a string. Each of those
stays a refusal or a named helper rather than a conversion nobody asked
for.

**No per-dispatch cost that Java would not pay.** One payload promotion
per callback is a global reference Java does not allocate; that cost is
known, measured, and its optimisation — JNI resource domains — is already
recorded as the measured improvement of a working crossing rather than a
prerequisite for one.
