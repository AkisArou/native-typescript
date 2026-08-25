# RFC 0001: THRIVE

## Transparent Hot Revision of Imperative Android View Effects

**Status:** Draft / research architecture
**Version:** 0.1
**Date:** 2026-08-24
**Target platform:** Java applications using native Android Views
**Audience:** Android runtime, compiler, framework, IDE, and systems engineers

---

## Abstract

This RFC proposes **THRIVE**, a development runtime that provides Flutter/React-class stateful hot reload for ordinary imperative Java code using native Android Views.

The developer writes normal code:

```java
TextView title = new TextView(context);
title.setText("Foo");
root.addView(title);
```

After changing `"Foo"` to `"Bar"` and saving, the existing screen updates immediately. The developer does not write a `render()` method, extend a special `HotView`, assign reconciliation keys, move state into framework containers, annotate hot-reload boundaries, or restart an Activity.

The central design decision is:

> THRIVE does not rebuild an application-defined component tree. It revises the completed imperative effects that currently produce the live Android presentation.

To accomplish this, THRIVE combines:

* a revision-aware Java compiler and ART runtime;
* stable identities for source operations, methods, fields, classes, and runtime objects;
* a dynamic presentation-dependence graph;
* a causal ledger of View and framework effects;
* automatic separation of durable application state from revisionable presentation state;
* copy-on-write checkpoints and speculative execution;
* high-level checkpointing of Android framework state;
* deterministic handling of input, concurrency, and external effects;
* shadow execution followed by an atomic UI commit;
* full class-schema and active-stack evolution;
* a persistent incremental compiler independent of Gradle.

The proposed system requires a custom development build of Android, including changes to ART, the Android UI framework, system services, and tooling. Release builds remain ordinary Java/DEX Android applications and incur no THRIVE runtime overhead.

This RFC is a proposed architecture, not a description of an existing implementation.

---

# 1. Decision

THRIVE explicitly rejects an application-visible refresh abstraction.

The following are forbidden as requirements for application code:

```java
class HomeScreen extends HotView {
    View render(Context context) {
        ...
    }
}
```

```java
@HotReloadBoundary
void constructUi() {
    ...
}
```

```java
view.setHotReloadKey("title");
```

```java
HotReload.watch(state);
```

The developer must be able to use ordinary imperative Java:

```java
public final class MainActivity extends Activity {
    private int count;
    private TextView countView;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        countView = new TextView(this);
        countView.setText("Count: " + count);

        Button increment = new Button(this);
        increment.setText("Increment");
        increment.setOnClickListener(v -> {
            count++;
            countView.setText("Count: " + count);
        });

        root.addView(countView);
        root.addView(increment);
        setContentView(root);
    }
}
```

THRIVE moves the refresh boundary below the Java programming model:

```text
ordinary Java execution
        ↓
runtime records causal presentation effects
        ↓
source changes
        ↓
affected effects are revised transactionally
        ↓
live Android presentation is repaired
```

There is still a refresh system, because some mechanism must make a completed imperative statement affect the present again. The difference is that the **runtime owns it**, not the application architecture.

---

# 2. Benchmark and User-Visible Contract

Flutter hot reload injects updated code, rebuilds the widget tree, preserves application state, and does not rerun `main()` or `initState()`. Only code reached through rebuilding is automatically executed again.

Vite’s HMR model aims to invalidate only the affected module chain rather than reloading the page and destroying its state. Framework integrations provide the application-level state preservation behavior.

THRIVE’s contract is stronger at the Java/View boundary:

## 2.1 Source-level transparency

Application code MUST NOT require:

* a new UI toolkit;
* a declarative DSL;
* XML layouts;
* base classes;
* annotations;
* explicit keys;
* state wrappers;
* manually accepted modules;
* hot-reload callbacks;
* lifecycle restructuring;
* separation of UI code from business code.

Existing Java/View applications should become reloadable by selecting a THRIVE development runtime.

## 2.2 Successful save

After a successful compilation:

* changed Java code MUST become active;
* the current Activity MUST remain visibly alive;
* no Activity lifecycle restart may be exposed;
* no process restart, splash screen, blank frame, or navigation reset may be visible;
* application state MUST be preserved;
* focus, text selection, cursor position, scroll position, open dialogs, navigation position, and running animations SHOULD remain continuous;
* completed imperative View operations affected by the edit MUST be repaired;
* listeners and callbacks MUST execute their new implementations;
* structural class changes MUST NOT force an application restart;
* the update MUST be atomic from the user’s perspective.

## 2.3 Failed save

When compilation or speculative execution fails:

* the currently committed generation MUST continue running;
* no partial code or state change may leak into it;
* diagnostics MUST appear in the IDE and optionally in an in-app overlay;
* correcting the error and saving again MUST retry the update without restarting the app.

## 2.4 Future execution

After commit, every future method invocation, callback, event handler, timer, and asynchronous continuation MUST use the new program revision.

## 2.5 Completed execution

Completed durable state transitions are normally preserved rather than retroactively replayed under new business logic.

For example:

```java
button.setOnClickListener(v -> count++);
```

Suppose the button was clicked five times and `count == 5`. The developer changes the handler to:

```java
button.setOnClickListener(v -> count += 2);
```

After hot reload:

```text
count remains 5
next click produces 7
```

THRIVE does not recompute the five historical clicks as if they had always incremented by two.

However, completed effects that still contribute to the live presentation are revisionable. That distinction is the foundation of the semantic model below.

---

# 3. Semantic Model

## 3.1 Three state domains

THRIVE divides runtime state by provenance and effect, not by developer-defined classes.

### Durable application state

Examples include:

* domain objects;
* Activity fields representing user or application state;
* repositories;
* caches;
* navigation models;
* database state;
* completed network results;
* counters changed by user events;
* service state;
* application-owned collections.

Durable state is preserved across ordinary hot reload.

### Developer presentation effects

Examples include:

* View allocation;
* hierarchy insertion and removal;
* `setText`;
* `setVisibility`;
* layout parameter changes;
* drawable assignment;
* listener registration;
* adapter binding;
* window and dialog construction;
* custom-View state that contributes to measuring, laying out, or drawing;
* calls that causally determine the current frame.

These effects remain connected to their source-code provenance. If the responsible source changes, THRIVE may revise the effect even though the original method invocation has completed.

### Interaction and framework state

Examples include:

* text typed by the user;
* cursor and selection positions;
* focus;
* scroll offsets;
* pressed and hovered state;
* gesture progress;
* accessibility focus;
* IME composition;
* animation progress;
* framework-generated child state;
* asynchronously loaded visual resources.

These effects are preserved and reapplied over revised developer presentation effects.

## 3.2 Causal ordering

Every state-changing operation has a logical position in an effect timeline.

Consider an editable field:

```java
EditText name = new EditText(context);
name.setText("Initial");
```

The user then types `"Alice"`.

Conceptually:

```text
t0: developer effect  → text = "Initial"
t1: framework effect  → focus acquired
t2: user effect       → text = "Alice"
t3: framework effect  → cursor = 5
```

The developer changes:

```java
name.setText("Initial");
```

to:

```java
name.setText("Your name");
```

THRIVE revises the effect at `t0`:

```text
t0: developer effect  → text = "Your name"
t1: framework effect  → focus acquired
t2: user effect       → text = "Alice"
t3: framework effect  → cursor = 5
```

The final visible text remains `"Alice"` and the cursor remains at position five.

If the user had never typed, the final text would become `"Your name"`.

This gives THRIVE the behavior developers usually intend:

* code-owned presentation changes update;
* later user interaction remains;
* the system does not blindly rerun setup code at the present moment.

## 3.3 Formal state transition

Let:

* `P₀` be the old program revision;
* `P₁` be the new program revision;
* `Sₜ` be durable application state at logical time `t`;
* `Dₜ` be developer presentation effects;
* `Xₜ` be interaction and framework effects;
* `Uₜ` be the resulting Android presentation;
* `ΔP` be the semantic source change.

Before reload:

```text
Uₜ = Apply(Dₜ(P₀, Sₜ), Xₜ)
```

After reload:

```text
S'ₜ = MigrateSchema(Sₜ, P₀, P₁)

D'ₜ = ReviseAffectedEffects(
    oldEffects = Dₜ,
    program = P₁,
    durableState = S'ₜ,
    changedSource = ΔP
)

U'ₜ = Apply(D'ₜ, Xₜ)
```

Future events execute against:

```text
(P₁, S'ₜ, U'ₜ)
```

Past durable events are not generally reevaluated. Active presentation effects are.

## 3.4 Ambiguous state mappings

An arbitrary source edit can admit multiple reasonable state mappings. THRIVE MUST NOT resolve that ambiguity by asking the developer to add a key, annotation, migration method, or restart boundary.

Instead it MUST:

1. preserve unchanged values and object identities whenever possible;
2. use source provenance and runtime data provenance to infer correspondence;
3. use order-preserving maximum matching for ambiguous collections;
4. synthesize or replay object construction history when direct migration is unavailable;
5. select a deterministic mapping;
6. retain the old generation for immediate rollback;
7. reject the new generation transactionally if executing it is invalid.

This is deterministic state evolution, not an attempt to infer human intent with certainty.

---

# 4. Key Insight: Completed Imperative Effects Are First-Class Runtime Objects

Ordinary hotswap changes method implementations. It does not revisit effects produced by methods that already returned.

THRIVE records those effects.

For:

```java
TextView title = new TextView(context);
title.setText("Foo");
root.addView(title);
```

the runtime records something conceptually equivalent to:

```text
Execution node A
  source site: MainActivity.java / allocation expression
  result: logical View object V17

Execution node B
  source site: MainActivity.java / setText invocation
  input: V17
  argument: "Foo"
  effect: Text(V17) = "Foo"

Execution node C
  source site: MainActivity.java / addView invocation
  inputs: root, V17
  effect: Child(root, index 0) = V17
```

After changing `"Foo"` to `"Bar"`:

```text
source diff maps old node B to new node B'
        ↓
constant output changes
        ↓
argument to setText changes
        ↓
effect Text(V17) is revised
        ↓
framework applies a transactional property update
```

The runtime does not need to call `onCreate()` again. It does not need an application-provided `render()` function. It does not need to rebuild every View.

The previous method invocation becomes a **revisionable execution record**.

This is closely related to self-adjusting computation, where a dynamic dependence graph records control and data dependencies so affected portions can be reevaluated after an input change. Research has extended this model to imperative programs with repeated writes.

THRIVE extends that idea in two directions:

1. the changed input may be the program itself;
2. the outputs include Android framework effects and live visual state.

Recent work on incremental live programming similarly explores reusing computations across structurally similar program revisions rather than rerunning everything from the beginning.

---

# 5. High-Level Architecture

```text
┌───────────────────────────────────────────────────────────────┐
│                       DEVELOPMENT MACHINE                     │
│                                                               │
│  Java source                                                  │
│      │                                                        │
│      ▼                                                        │
│  Persistent incremental compiler                             │
│      ├─ symbol graph                                          │
│      ├─ AST and IR cache                                      │
│      ├─ semantic tree differ                                  │
│      ├─ stable source-site IDs                                │
│      ├─ schema migration generator                            │
│      └─ revision metadata                                     │
│      │                                                        │
│      ▼                                                        │
│  Revision-aware DEX / native-code generation                  │
│      │                                                        │
│      ▼                                                        │
│  Authenticated ADB or development socket                      │
└──────────────────────────────┬────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                    CUSTOM ANDROID DEV IMAGE                   │
│                                                               │
│  Stable App Capsule                                           │
│      ├─ Activity/window tokens                                │
│      ├─ input and IME endpoint                                │
│      ├─ active worker process                                 │
│      └─ shadow worker process                                 │
│                                                               │
│  Revision-Aware ART                                           │
│      ├─ logical class/method/field IDs                         │
│      ├─ class-version evolution                               │
│      ├─ heap and object migration                             │
│      ├─ on-stack replacement                                  │
│      ├─ dynamic execution graph                               │
│      └─ transactional checkpoints                             │
│                                                               │
│  Presentation Runtime                                        │
│      ├─ presentation-dependence graph                         │
│      ├─ causal effect ledger                                  │
│      ├─ UI capsule manager                                    │
│      ├─ View identity resolver                                │
│      ├─ framework-state adapters                              │
│      └─ state transplant engine                               │
│                                                               │
│  WorldGate                                                    │
│      ├─ clocks, randomness, sensors                           │
│      ├─ filesystem and SQLite COW branches                    │
│      ├─ Binder and process callbacks                          │
│      ├─ network record/replay proxy                           │
│      └─ irreversible-effect suppression                       │
│                                                               │
│  Atomic Commit Manager                                       │
│      ├─ offscreen rendering                                   │
│      ├─ invariant validation                                  │
│      ├─ SurfaceControl transaction                            │
│      └─ instant rollback                                      │
└───────────────────────────────────────────────────────────────┘
```

---

# 6. Persistent Incremental Compiler

## 6.1 No Gradle invocation during ordinary reload

Gradle remains responsible for:

* initial application assembly;
* release builds;
* signing;
* initial manifest packaging;
* dependency resolution when the graph changes;
* initial resource packaging.

Ordinary Java edits MUST bypass a full Gradle build.

The THRIVE compiler runs as a persistent daemon containing:

* parsed syntax trees;
* symbol tables;
* type information;
* bytecode/DEX caches;
* dependency graphs;
* source-to-runtime provenance;
* previously generated class versions.

## 6.2 Stable source identities

Line numbers are not stable enough. Adding a blank line must not create a new runtime identity for every later operation.

Each relevant source construct receives a stable logical identity:

```text
ClassId
MethodId
FieldId
BlockId
ExpressionId
CallSiteId
AllocationSiteId
BranchId
LambdaId
```

Identity matching uses:

* enclosing symbol identity;
* structural AST fingerprints;
* token similarity;
* control-flow position;
* data-flow neighbors;
* developer rename detection;
* previous revision correspondence;
* runtime execution provenance.

Example:

```java
title.setText("Foo");
```

becomes conceptually:

```text
CallSiteId = 0x51A9...
Receiver expression = 0xCC18...
Argument expression = 0x09F2...
```

Changing only the literal preserves the call-site identity.

## 6.3 Semantic change classification

The compiler classifies each save into changes such as:

```text
constant change
expression change
control-flow insertion
control-flow deletion
method-body change
method signature change
field addition/removal/type change
class addition/removal
inheritance change
interface change
lambda capture-shape change
resource change
native ABI change
manifest change
dependency graph change
```

The runtime uses the classification to select the minimum valid update strategy.

## 6.4 Revision metadata

Generated code includes metadata sufficient to reconstruct dynamic dependencies:

```text
source-site identity
read set
write set
potential framework effects
allocation identity
exception edges
synchronization edges
local-variable correspondence
stack-map correspondence
schema correspondence
```

Metadata may be emitted separately from production bytecode.

## 6.5 Compilation errors

A failed compilation produces diagnostics but no installable revision.

```text
save
  ↓
incremental compiler
  ↓
error
  ├─ active generation remains untouched
  └─ diagnostics sent to IDE and overlay
```

The runtime never enters a half-compiled state.

---

# 7. Revision-Aware ART

ART TI exposes runtime instrumentation to native agents on Android 8 and later. Its capabilities include class redefinition, object-allocation tracking, heap iteration, stack inspection, and thread suspension. Runtime agent attachment is restricted to debuggable applications.

Android also exposes `InMemoryDexClassLoader`, which can execute DEX supplied in a `ByteBuffer` without writing it to the local filesystem. It has been available since API level 26.

Those mechanisms are useful but insufficient as the complete THRIVE foundation. THRIVE therefore specifies a custom ART build.

## 7.1 Logical type identity

A Java class has one stable logical identity and multiple runtime versions:

```text
Logical class: com.example.User

Version 17
  fields: name:String, age:int
  superclass: Object

Version 18
  fields: name:String, age:int, premium:boolean
  superclass: Object
```

References to `User.class`, reflection metadata, method IDs, field IDs, and JNI handles resolve through the logical identity.

## 7.2 Versioned object layout

Debug objects use a revision-tolerant layout.

One possible representation is:

```text
Object header
  ├─ logical ClassId
  ├─ layout version
  ├─ stable ObjectId
  ├─ fixed payload
  └─ extension-field storage
```

New fields can initially live in extension storage:

```text
Object U42
  name      → "Mina"
  age       → 32
  premium   → true
```

At GC or another safe point, objects may be compacted into a new physical layout.

Removed fields are retained as tombstones until rollback history expires.

## 7.3 Method evolution

Calls resolve through stable logical method identities:

```text
MethodId USER_GREETING
       │
       ├─ revision 17 implementation
       └─ revision 18 implementation ← current
```

The JIT may inline methods only while maintaining deoptimization metadata capable of returning execution to a revision-aware representation.

## 7.4 Hierarchy evolution

THRIVE MUST support:

* adding and removing interfaces;
* changing a superclass;
* adding and removing virtual methods;
* changing abstract/final status;
* changing method signatures;
* changing field types.

The runtime rebuilds:

* vtables;
* interface tables;
* subtype caches;
* cast metadata;
* reflection metadata;
* JIT assumptions;
* deoptimization dependencies.

AOSP’s structural-redefinition work illustrates why this cannot be treated as a trivial JVMTI extension: redefining classes changes runtime method and field structures, and even active JNI IDs in subtypes can make a structural update unsafe without additional indirection.

THRIVE therefore makes JNI and reflection identities opaque and stable by design.

## 7.5 Existing object migration

Migration proceeds in this order:

1. Preserve fields with the same logical identity and compatible type.
2. Detect renames through source differencing and data-flow correspondence.
3. Apply primitive and reference conversions where unambiguous.
4. Evaluate initializers for genuinely new fields.
5. Synthesize a transformation using constructor and method-invocation history.
6. Reconstruct only the affected object subgraph when direct transformation is unsuitable.
7. Retain the old representation for rollback until commit history expires.

Research systems such as JVOLVE demonstrate that class changes can be integrated with class loading, JIT compilation, safe points, on-stack replacement, object transformation, and garbage collection.

Work on automatic object transformation has also explored reconstructing new-version objects from method-invocation histories rather than requiring hand-written migration functions.

THRIVE combines both strategies.

## 7.6 Active stack frames

A save may occur while changed code is active.

At update time, THRIVE:

1. reaches a global revision safe point;
2. maps old SSA values and locals to the new method version;
3. performs on-stack replacement when a valid correspondence exists;
4. otherwise restores the current event’s entry checkpoint;
5. replays that event with the same recorded input under the new code;
6. resumes without exposing a restart.

Old frames are not allowed to call into a partially migrated class universe.

## 7.7 Existing lambdas and listeners

A previously allocated lambda may have a changed body or capture shape.

THRIVE treats it as a versioned logical closure:

```text
Logical closure L81
  captures revision 4: [activity, countView]
  captures revision 5: [activity, countView, analytics]
  implementation: latest LambdaId
```

Existing listener registrations continue pointing at `L81`. Future events execute the new implementation.

---

# 8. Dynamic Execution Graph

## 8.1 Dynamic execution nodes

Each relevant executed operation produces a node resembling:

```text
DynamicNode {
    ProgramRevision
    EventId
    ThreadId
    CallPath
    SourceSiteId
    DynamicOccurrence
    Inputs
    Output
    HeapReads
    HeapWrites
    ControlDependencies
    SynchronizationDependencies
    FrameworkEffects
    ExternalEffects
}
```

## 8.2 Dependency edges

The graph records:

* value dependencies;
* control dependencies;
* heap read-from relationships;
* field and array dependencies;
* object-allocation dependencies;
* call and return dependencies;
* exception flow;
* monitor, volatile, and atomic ordering;
* event ordering;
* framework-state dependencies;
* external-input dependencies.

## 8.3 Trace granularity

Recording every machine instruction indefinitely would be prohibitively expensive. THRIVE uses adaptive granularity:

* UI-producing code receives fine-grained tracking.
* Code transitively affecting a live presentation receives fine-grained tracking.
* stable pure computations can be memoized as larger units;
* cold unrelated code can be represented by coarser checkpoints;
* detailed trace chunks may be discarded after their effects are sealed and no longer revisionable;
* a shadow replay path remains available when fine-grained history has been compacted.

## 8.4 Code change propagation

A source edit produces a changed node set:

```text
Δ = {
    changed source nodes,
    inserted source nodes,
    removed source nodes,
    changed schemas
}
```

The runtime locates dynamic instances of those nodes and computes their affected causal cone.

Only nodes that can affect one of the following need immediate reevaluation:

* a live View or ViewGroup;
* a current window;
* current draw/layout output;
* a live listener or callback;
* a currently reachable code-derived configuration value;
* a migrated object’s validity;
* an active stack frame.

Unrelated completed calculations remain untouched.

---

# 9. Presentation-Dependence Graph

The general execution graph is filtered into a **Presentation-Dependence Graph**, or PDG-P.

Its roots include:

* every attached `ViewRootImpl`;
* dialogs and popup windows;
* active transitions and animations;
* accessibility-visible nodes;
* current notification presentations owned by the development capsule;
* active `SurfaceView`, `TextureView`, and WebView adapters;
* active listener registrations;
* custom View measure, layout, and draw output.

The graph traces backward from those roots to the Java operations and values that produced them.

Example:

```java
String greeting = formatter.greet(user);
title.setText(greeting);
```

The presentation graph contains:

```text
user.name read
      ↓
formatter.greet implementation
      ↓
greeting local value
      ↓
title.setText argument
      ↓
TextView text state
      ↓
layout and draw output
```

Changing `formatter.greet` invalidates the text effect even though the method completed long ago.

## 9.1 Current-state reads

When repairing a live presentation, reads of durable state normally observe the current state.

Suppose:

```java
subtitle.setText("Items: " + cart.size());
```

The original invocation happened when the cart contained three items. The cart now contains seven.

Changing `"Items: "` to `"Products: "` produces:

```text
Products: 7
```

not:

```text
Products: 3
```

The runtime reconstructs the presentation expression against current durable state.

## 9.2 Historical input reads

Some values no longer exist in durable state.

For example:

```java
void showWelcome(ServerResponse response) {
    title.setText(response.message());
}
```

If `response` is no longer reachable, the execution graph retains either:

* the captured value required by the live effect;
* a compact representation of the response;
* a replay token capable of reconstructing it.

The runtime does not repeat the network request merely to repair the text.

## 9.3 Added operations

Consider:

```java
title.setText("Hello");
root.addView(title);
```

changed to:

```java
title.setText("Hello");
title.setGravity(Gravity.CENTER);
root.addView(title);
```

The semantic differ inserts a new operation into an existing historical execution path.

Because the enclosing path previously executed, THRIVE evaluates the new operation in a speculative presentation transaction and inserts its effect at the corresponding logical position.

## 9.4 Removed operations

Changing:

```java
title.setTextColor(Color.RED);
title.setText("Hello");
```

to:

```java
title.setText("Hello");
```

retracts the color effect.

The resulting color is obtained from:

* the previous still-active writer;
* theme resolution;
* inherited state;
* framework default;
* a later user/framework effect.

THRIVE does not need an application-provided inverse for `setTextColor`.

---

# 10. Causal Effect Ledger

The Presentation-Dependence Graph explains why an effect exists. The **Causal Effect Ledger** records how effects combine over logical time.

A ledger entry includes:

```text
EffectId
SourceSiteId
LogicalObjectId
PropertyOrOperation
Arguments
LogicalTimestamp
Origin:
    developer
    framework
    user
    external
Liveness
Supersession relation
Undo/checkpoint information
```

## 10.1 Property effects

A simple property may be represented as an ordered writer stack:

```text
Text(V17)
  t0 developer → "Initial"
  t4 user      → "Alice"
```

Changing the `t0` effect preserves `t4`.

## 10.2 Non-commutative effects

Not every API is a last-writer-wins setter.

Examples:

* adding and removing children;
* starting animations;
* spans and text mutations;
* adapter notifications;
* nested scrolling;
* selection changes;
* transition state;
* imperative Canvas or RenderNode operations.

For these, THRIVE replays the relevant ledger segment in a cloned UI capsule and obtains a new high-level state rather than attempting to invent an algebraic inverse.

## 10.3 One-shot effects

Expired one-shot effects are sealed and are not replayed on every save:

* old Toasts;
* completed vibration;
* an already-sent notification sound;
* an already-launched external intent;
* a completed purchase;
* an already-sent network mutation.

A currently visible dialog or notification remains live presentation state and may be revised.

---

# 11. Automatic UI Capsule

## 11.1 Definition

A **UI capsule** is the live object and framework-state subgraph that constitutes the application’s current presentation.

It includes:

* attached View trees;
* detached Views still participating in current presentation logic;
* drawables;
* layout parameters;
* text layout and selection state;
* ViewTreeObserver registrations;
* adapters and visible holders;
* animation objects;
* windows and dialogs;
* input connections;
* relevant native peers;
* framework rendering state.

It excludes durable application state except through bridge references.

## 11.2 Automatic discovery

The application does not declare a capsule.

The runtime discovers it from:

* `ViewRootImpl` roots;
* window tokens;
* framework ownership metadata;
* object reachability;
* field-write provenance;
* dynamic measure/layout/draw reads;
* registered listeners and adapters;
* native-peer ownership.

## 11.3 Field-level splitting

An Activity may contain both state and presentation references:

```java
class MainActivity extends Activity {
    int count;
    TextView countView;
    Cart cart;
}
```

The whole Activity object cannot simply be classified as either UI or non-UI.

THRIVE tracks at field granularity:

```text
count     → durable state
countView → bridge to UI capsule
cart      → durable state
```

During a shadow capsule rebuild:

* `count` is preserved;
* `cart` is preserved;
* `countView` may be rebound to a successor View object.

No state container or annotation is required.

## 11.4 Mixed methods

A method may perform both business and UI effects:

```java
void initialize() {
    repository.recordLaunch();
    title.setText(repository.currentTitle());
}
```

THRIVE can re-evaluate the presentation slice without repeating `recordLaunch()`:

1. run the affected slice in a copy-on-write transaction;
2. permit reads from current durable state;
3. intercept durable writes;
4. retain only the revised presentation effects;
5. discard the speculative repository mutation.

This is why rerunning a whole lifecycle method is unnecessary and unsafe.

---

# 12. Logical View Identity Without Developer Keys

## 12.1 Allocation identity

An allocation receives a stable logical identity based on:

```text
AllocationSiteId
+ enclosing dynamic invocation identity
+ control-path identity
+ iteration provenance
+ occurrence alignment
```

Example:

```java
TextView title = new TextView(context);
```

may produce:

```text
LogicalViewId V17
AllocationSite A44
Invocation MainActivity.onCreate / event 1
```

An unchanged allocation site continues to refer to `V17` across revisions.

## 12.2 Loops

Consider:

```java
for (User user : users) {
    TextView row = new TextView(context);
    row.setText(user.name);
    root.addView(row);
}
```

Iteration identity is derived from:

* the actual `User` object identity;
* collection-element provenance;
* iterator history;
* source allocation identity;
* order-preserving trace alignment.

Inserting a new user at the beginning does not require shifting the logical identity of every existing row.

## 12.3 Duplicate values

For primitive or duplicate values without explicit identity, THRIVE uses deterministic maximum preservation:

1. match equal provenance where available;
2. match unchanged dynamic dependencies;
3. preserve order;
4. maximize retained UI and interaction state;
5. create or delete only the unmatched remainder.

If two values and their complete provenance are genuinely indistinguishable, selecting one order-preserving mapping over another is not observable until some later operation distinguishes them. At that point, the new provenance is recorded.

## 12.4 Type replacement

Changing:

```java
TextView item = new TextView(context);
```

to:

```java
Button item = new Button(context);
```

creates a successor object for the same logical presentation position.

The state transplant engine carries over compatible state such as:

* ID;
* visibility;
* enabled state;
* alpha;
* transforms;
* layout parameters;
* accessibility metadata;
* focus when valid;
* hierarchy position;
* applicable text and selection state.

Heap references and migrated fields are redirected through GC-backed reference rewriting or stable logical handles.

---

# 13. Imperative View Repair Examples

## 13.1 Completed `setText`

Before:

```java
title.setText("Foo");
```

After:

```java
title.setText("Bar");
```

Result:

```text
same TextView object
same hierarchy
same focus and layout identity
text effect revised to "Bar"
```

No method-level rerun is required.

## 13.2 Changed helper method

Before:

```java
title.setText(formatName(user));
```

```java
String formatName(User user) {
    return user.firstName;
}
```

After:

```java
String formatName(User user) {
    return user.firstName + " " + user.lastName;
}
```

The current `user` object is read, the affected computation is reevaluated, and the active text effect is revised.

## 13.3 Changed condition

Before:

```java
if (account.isPremium()) {
    badge.setVisibility(View.VISIBLE);
}
```

After:

```java
if (account.isPremium() && account.isVerified()) {
    badge.setVisibility(View.VISIBLE);
}
```

THRIVE reevaluates the control slice against the current account state.

If the condition becomes false, the visibility effect is retracted and the next applicable value is restored.

## 13.4 Added View

Before:

```java
root.addView(title);
root.addView(button);
```

After:

```java
root.addView(title);

TextView subtitle = new TextView(context);
subtitle.setText("New subtitle");
root.addView(subtitle);

root.addView(button);
```

THRIVE:

1. inserts the new dynamic allocation and hierarchy effects;
2. creates the subtitle in a shadow UI capsule;
3. keeps the existing title and button identities;
4. preserves focus and interaction state;
5. commits the hierarchy edit atomically.

## 13.5 Removed View

Removing the subtitle retracts its hierarchy membership and any presentation effects owned only by it.

The View is destroyed only when:

* no current field or listener requires it;
* no rollback generation retains it;
* framework cleanup has completed.

## 13.6 Layout-class replacement

Before:

```java
LinearLayout root = new LinearLayout(context);
root.setOrientation(LinearLayout.VERTICAL);
```

After:

```java
FrameLayout root = new FrameLayout(context);
```

THRIVE creates a successor root in the shadow capsule, migrates children and compatible state, recalculates layout, and swaps the root presentation atomically.

## 13.7 RecyclerView binding

Before:

```java
@Override
public void onBindViewHolder(Holder holder, int position) {
    User user = users.get(position);
    holder.name.setText(user.name);
}
```

After:

```java
@Override
public void onBindViewHolder(Holder holder, int position) {
    User user = users.get(position);
    holder.name.setText(user.name.toUpperCase(Locale.ROOT));
}
```

Visible holders already contain presentation effects produced by completed `onBindViewHolder` calls.

THRIVE traces those effects back to the changed formatter and repairs each live holder automatically.

The developer does not call:

```java
notifyDataSetChanged();
```

Scroll position, item animations, recycled-holder identity, and current selection remain intact.

Offscreen holders naturally use the new method when rebound.

## 13.8 Listener body

Before:

```java
button.setOnClickListener(v -> count++);
```

After:

```java
button.setOnClickListener(v -> count += 2);
```

Existing listener registration resolves to the new logical closure implementation.

Past clicks are not recomputed. Future clicks add two.

## 13.9 Listener presentation effect

Before:

```java
button.setOnClickListener(v -> status.setText("Saved"));
```

After:

```java
button.setOnClickListener(v -> status.setText("Successfully saved"));
```

If the old `"Saved"` effect remains the active developer-owned presentation effect, THRIVE may revise it immediately to `"Successfully saved"`.

If a later user or framework effect superseded the text, that later effect remains.

## 13.10 Custom View drawing

```java
@Override
protected void onDraw(Canvas canvas) {
    canvas.drawText("Old", 20, 40, paint);
}
```

changed to:

```java
@Override
protected void onDraw(Canvas canvas) {
    canvas.drawText("New", 20, 40, paint);
}
```

The method implementation changes and the runtime schedules a new frame automatically.

The developer does not need to call `invalidate()` solely because source code changed.

## 13.11 Custom View state used by drawing

```java
@Override
protected void onDraw(Canvas canvas) {
    canvas.drawCircle(cx, cy, radius, paint);
}
```

The draw trace records reads of `cx`, `cy`, and `radius`.

Changing the expression that computes `radius` invalidates the corresponding presentation dependency and schedules measure/layout/draw as required.

## 13.12 EditText interaction

Before the edit:

```text
code default: "Type here"
user text:   "Mina"
cursor:      4
focus:       active
IME:         composing
```

The developer changes the default to `"Full name"`.

After reload:

```text
text:        "Mina"
cursor:      4
focus:       active
IME:         composing
```

The code-owned default changed underneath the later interaction layer.

## 13.13 Dialog currently open

A currently open dialog is part of the live UI capsule. Editing its title, buttons, spacing, or listener code updates the existing dialog without closing and reopening it visibly.

An expired dialog is not recreated.

---

# 14. Speculative Presentation Execution

## 14.1 Why speculation is required

Reevaluating arbitrary Java code can cause unintended effects:

```java
void configureScreen() {
    analytics.sendScreenView();
    database.markSeen();
    title.setText(loadTitle());
}
```

THRIVE cannot simply invoke `configureScreen()` again in the active process.

## 14.2 Copy-on-write branch

The runtime creates a speculative branch containing:

* a copy-on-write application heap view;
* a cloned UI capsule;
* revisioned class metadata;
* virtualized filesystem and database state;
* intercepted Binder operations;
* recorded external inputs;
* an offscreen rendering target.

The affected computation executes in this branch.

## 14.3 Commit filter

Effects are classified:

```text
presentation effect          → eligible for commit
schema migration             → eligible for commit
durable app-state mutation   → normally discarded during repair
external irreversible effect → suppressed
diagnostic output            → captured
```

Future actual event execution under the new code can mutate durable state normally. The suppression applies to retroactive presentation repair, not to ordinary post-commit execution.

## 14.4 Opaque computation

When a changed presentation calculation calls opaque native or framework code, THRIVE chooses among:

1. execute it in the fully cloned branch;
2. replay a previously recorded deterministic result;
3. use a framework-specific state adapter;
4. rebuild the affected UI capsule from a checkpoint;
5. reconstruct the relevant subgraph from its invocation history.

It does not fall back to an Activity restart.

---

# 15. Framework-State Integration

A Java heap snapshot alone is insufficient because Android presentation state crosses Java, native code, Binder services, rendering threads, and the input system.

Time-travel work for web applications found that accurate replay requires checkpointing both program state and a high-level representation of visual-engine state, including event listeners and asynchronous visual state.

THRIVE applies the same principle to Android.

## 15.1 View framework adapters

The custom framework exposes revision/checkpoint adapters for:

* `View`;
* `ViewGroup`;
* `TextView` and `EditText`;
* layout managers;
* RecyclerView;
* drawables;
* animations;
* transitions;
* menus;
* dialogs and popup windows;
* accessibility nodes;
* input connections;
* `SurfaceView`;
* `TextureView`;
* WebView;
* media and camera surfaces.

## 15.2 High-level state, not pixels

THRIVE checkpoints:

```text
View hierarchy
layout parameters
text and spans
selection
scroll offsets
focus
animation timeline
RenderNode properties
resource references
input connection state
surface ownership
```

It does not normally store every rendered pixel.

The shadow branch renders the resulting state offscreen before commit.

## 15.3 Framework-originated mutations

Framework mutations are entered into the causal ledger so they can be replayed over revised developer effects.

Examples include:

* IME edits;
* kinetic scrolling;
* nested-scroll consumption;
* pressed-state transitions;
* animation advancement;
* asynchronous drawable completion;
* accessibility focus changes.

## 15.4 AndroidX and third-party Views

Libraries can provide optional optimized state adapters, but correctness MUST NOT depend on them.

Without a custom adapter, THRIVE falls back to:

* heap and native-state checkpointing;
* execution tracing;
* reflective framework-state discovery;
* shadow reconstruction;
* offscreen validation.

---

# 16. Stable App Capsule and Atomic Worker Swap

## 16.1 Stable system identity

A visible Android application has identities owned by system services:

* Activity tokens;
* window tokens;
* input channels;
* process records;
* Binder endpoints;
* IME sessions;
* surface ownership;
* lifecycle state.

Replacing a normal app process would usually disturb those identities.

THRIVE introduces a stable **App Capsule** managed by the development system image.

The capsule owns system-facing identity while worker processes execute application code behind it.

```text
system_server
     │
     ▼
Stable App Capsule
     ├─ Activity/window identity
     ├─ input and IME proxy
     ├─ active worker A
     └─ shadow worker B
```

## 16.2 Shadow worker

During reload, worker B:

* begins from a copy-on-write checkpoint of worker A;
* installs the new program revision;
* migrates schemas;
* repairs the presentation graph;
* catches up to the current event boundary;
* renders into a hidden surface;
* validates invariants.

Worker A remains interactive until final commit.

## 16.3 Atomic commit

At a display synchronization boundary:

1. input dispatch pauses briefly;
2. worker A and B align at the same logical event frontier;
3. the new UI state is validated;
4. a `SurfaceControl` transaction swaps the visible surface;
5. capsule Binder routing moves to worker B;
6. input and IME routing move to worker B;
7. queued input resumes;
8. worker A remains available for instant rollback.

The visible commit target is at most one frame and SHOULD produce no blank frame.

## 16.4 In-place fast path

Simple edits may be committed transactionally inside worker A.

However, the shadow path remains the semantic safety mechanism. The fast path is used only when the runtime can prove or verify that it produces the same high-level state as the branch model.

---

# 17. Concurrency and Event Semantics

## 17.1 Event boundaries

Android’s main Looper provides useful quiescent points between callbacks.

THRIVE takes lightweight checkpoints at boundaries such as:

```text
before input callback
after input callback
before lifecycle callback
after lifecycle callback
before frame traversal
after frame commit
before Binder callback
after Binder callback
```

## 17.2 Synchronization log

The runtime records enough information to reproduce:

* monitor acquisition order;
* volatile and atomic operations;
* thread creation and termination;
* condition waits;
* executor scheduling;
* Handler/Looper ordering;
* Binder callback ordering;
* coroutine or future completion;
* native synchronization exposed through runtime hooks.

## 17.3 Changed active event handler

When a changed handler is currently executing:

* THRIVE first attempts OSR;
* if OSR cannot map the active state, it restores the checkpoint immediately before the event;
* it replays the same event input under the new code in the shadow worker;
* it commits only after reaching a consistent event frontier.

No Activity restart is exposed.

## 17.4 Racy programs

For existing races, THRIVE records the observed schedule and uses it during replay.

If the source edit changes synchronization structure, the shadow branch creates a new deterministic continuation from the first changed synchronization point.

The old branch remains available if the new schedule produces an exception or invariant failure.

---

# 18. External World and Irreversible Effects

No runtime can physically undo an email already delivered, a payment already captured, or a motor already activated.

THRIVE therefore makes external-effect behavior explicit and safe rather than duplicating actions during reload.

## 18.1 WorldGate

All development execution routes external interactions through **WorldGate**:

```text
application
    ↓
WorldGate
    ├─ filesystem
    ├─ SQLite
    ├─ SharedPreferences
    ├─ network
    ├─ Binder
    ├─ sensors
    ├─ clocks
    ├─ random sources
    ├─ notifications
    └─ external intents
```

## 18.2 Reads

Read-like nondeterministic inputs are recorded:

* network responses;
* current time;
* random values;
* sensor samples;
* location;
* Binder replies;
* file contents;
* database query results;
* user input.

Presentation repair can reuse those values without repeating the operation.

## 18.3 Local writes

Local mutable storage uses copy-on-write branches:

* SQLite transactions;
* files;
* preferences;
* app-local caches.

Speculative writes are discarded unless they are part of the committed forward execution rather than retrospective presentation repair.

## 18.4 Network and remote mutations

Past remote mutations are represented by immutable effect tokens.

During presentation repair:

* an identical historical request is not sent again;
* its recorded result may be reused;
* a changed request is evaluated against a development proxy or sandbox when available;
* an irreversible production-like action is never issued merely because source was saved.

## 18.5 Presentation semantics

Past external facts remain facts.

THRIVE updates local code and presentation around those facts without pretending that the physical outside world can be rewound.

This is a safety invariant, not an Activity-restart fallback.

---

# 19. Native Code

## 19.1 Revisioned native libraries

Development native libraries load in versioned linker namespaces:

```text
libfeature revision 12
libfeature revision 13 ← current
```

JNI registration resolves through stable logical native-function identities and trampolines.

## 19.2 Native heap

The shadow worker’s process-level copy-on-write checkpoint includes native heap pages.

Framework-owned native objects additionally expose high-level checkpoint adapters where raw process memory is insufficient.

## 19.3 Active native frames

THRIVE handles changed active native code through:

1. generated stack maps and binary OSR when supported;
2. returning to a managed safe point;
3. restoring the current event checkpoint in the shadow worker;
4. replaying to the current frontier with the new library.

The active visible application does not restart.

## 19.4 JNI identity

`jclass`, `jmethodID`, and `jfieldID` values resolve through stable opaque handles rather than raw pointers into replaceable method and field arrays.

This avoids the pointer-invalidation problems that constrain ordinary structural redefinition in ART.

---

# 20. Resources, Dependencies, and Manifest Changes

## 20.1 Resources

A persistent `aapt2`-compatible service produces revisioned resource overlays.

The runtime supports:

* string changes;
* drawable changes;
* dimensions;
* colors;
* styles;
* fonts;
* raw assets;
* resource additions and removals;
* stable resource-ID remapping.

`AssetManager` and `Resources` resolve through the current overlay generation.

Existing Views whose resolved resource dependencies changed are invalidated through the presentation graph.

## 20.2 Dependencies

Adding or updating a Java/AAR dependency triggers:

* incremental dependency resolution;
* classpath update;
* DEX generation;
* resource-overlay update;
* schema analysis;
* shadow-worker validation.

It does not require a visible application restart.

## 20.3 Manifest changes

The custom development `PackageManager` and `ActivityManager` maintain an ephemeral manifest overlay.

Changes may add or alter:

* activities;
* services;
* receivers;
* providers;
* intent filters;
* metadata;
* permissions available in the development image.

System-facing component identity remains attached to stable capsule proxies while implementation classes evolve behind them.

## 20.4 Release build

The release build uses the ordinary manifest, resources, D8/R8 output, and Android component model.

Development-only overlays and proxies are absent.

---

# 21. Error Handling and Rollback

## 21.1 Compilation failure

```text
new revision does not compile
        ↓
do not load it
        ↓
old app continues
        ↓
show diagnostics
```

## 21.2 Migration failure

If new code cannot execute against migrated state:

* the shadow transaction aborts;
* the old worker remains active;
* the developer receives the exception, migration trace, and affected source mapping;
* no partial state is committed.

## 21.3 Rendering failure

If the shadow UI:

* throws during measure/layout/draw;
* violates framework invariants;
* produces a detached input target;
* fails accessibility validation;
* loses required window state;

the update is rejected transactionally.

## 21.4 Immediate rollback

Every committed revision retains:

* previous code generation;
* previous schema descriptors;
* previous UI capsule root;
* previous effect-ledger frontier;
* rollback mapping.

Undoing a source edit can switch back as quickly as the forward update.

## 21.5 Crash after commit

For a configurable grace period, THRIVE may automatically roll back a newly committed generation if it crashes before receiving another developer or user event.

---

# 22. Correctness Model

## 22.1 Reference execution

For each update, THRIVE defines a reference result:

1. preserve the committed durable state;
2. migrate it to the new schema;
3. reconstruct the affected presentation capsule under the new program;
4. reuse recorded historical inputs where needed;
5. apply preserved interaction/framework effects in logical order;
6. render to a high-level framework state.

The optimized repair path must be equivalent to that reference result.

## 22.2 State equivalence

Equivalence is evaluated over:

* logical Java object graph;
* logical field values;
* View hierarchy and identities;
* current View properties;
* current listeners and callbacks;
* focus, selection, and scroll;
* animation state;
* framework high-level state;
* pending event frontier;
* external-effect tokens.

Raw memory addresses and incidental allocation order are not part of the semantic state unless the program explicitly observes them. In development mode, identity hash codes and similar values are virtualized when necessary to maintain continuity.

## 22.3 No partial commit

A revision is committed as a single transaction:

```text
code
schema
heap migration
presentation effects
framework state
listener routing
surface
event frontier
```

Either all of it becomes current or none of it does.

---

# 23. Performance Targets

These are engineering targets, not claims about an existing implementation.

## 23.1 Ordinary Java/UI edit

```text
source detection                 < 10 ms
incremental compile              < 60 ms
IR/DEX generation               < 50 ms
transport                       < 20 ms
affected-graph analysis          < 30 ms
speculative repair/render        < 80 ms
atomic commit                  ≤ one frame
```

Target:

```text
p50 save-to-visible:  < 150 ms
p95 save-to-visible:  < 400 ms
```

## 23.2 Structural edit

For field, method, and hierarchy changes:

```text
p50 target: < 500 ms
p95 target: < 1 second
```

## 23.3 Techniques

Latency is reduced through:

* persistent compiler processes;
* AST, symbol, IR, and DEX caches;
* stable source identities;
* precise invalidation;
* dynamic dependence graphs;
* cross-version memoization;
* copy-on-write checkpoints;
* warm shadow workers;
* offscreen rendering;
* effect-ledger segment replay;
* no Gradle invocation for ordinary edits;
* no APK reinstall;
* no Activity recreation.

## 23.4 Development overhead

THRIVE may accept substantial debug-only overhead:

* extra memory for active and shadow workers;
* trace storage;
* object identity metadata;
* write barriers;
* framework adapters;
* deterministic event logging.

Production performance is protected by removing THRIVE instrumentation from release builds.

---

# 24. Security

ART’s official tooling interface restricts runtime agent attachment to debuggable applications because instrumentation and runtime modification are powerful capabilities.

THRIVE follows a stricter development-only model:

* the application MUST be debuggable;
* the custom runtime MUST reject release-signed non-debuggable applications;
* the revision channel MUST be authenticated through the development host;
* arbitrary network clients MUST NOT be able to inject code;
* revision DEX and native libraries MUST be integrity checked;
* the runtime MUST visually indicate that a development image is active;
* all THRIVE services MUST be absent or disabled in production images;
* release packages MUST contain no open revision endpoint.

---

# 25. Conformance Tests

A conforming implementation must pass automated tests covering at least the following.

## 25.1 View effects

* Change a literal in a completed `setText`.
* Remove a setter.
* Insert a setter.
* Change View visibility through a changed condition.
* Add, remove, and reorder children.
* Replace a View subclass.
* Change layout parameters.
* Change a drawable and style.
* Change custom `onMeasure`, `onLayout`, and `onDraw`.

## 25.2 Interaction preservation

* Preserve EditText contents.
* Preserve cursor and selection.
* Preserve IME composition.
* Preserve focus.
* Preserve RecyclerView position.
* Preserve nested scrolling.
* Preserve selected list item.
* Preserve open dialog state.
* Preserve animation progress.
* Preserve accessibility focus.

## 25.3 Callbacks

* Update an existing click-listener body.
* Add and remove lambda captures.
* Change anonymous-class methods.
* Update delayed Handler callbacks.
* Update executor tasks before execution.
* Update callbacks currently on stack.

## 25.4 Structural Java changes

* Add and remove fields.
* Rename fields.
* Change field types.
* Add and remove methods.
* Change method signatures.
* Add and remove interfaces.
* Change superclass.
* Add and remove classes.
* Change enum and sealed-type structure where supported by the source language level.
* Preserve reflection behavior.
* Preserve JNI handle validity.

## 25.5 Mixed side effects

* Reevaluate UI code that also writes a database.
* Verify the database write is not duplicated.
* Reevaluate UI code that performs analytics.
* Verify no duplicate event is sent.
* Reevaluate code using a recorded network response.
* Verify no duplicate remote mutation occurs.

## 25.6 Failure handling

* Syntax error leaves old generation active.
* Type error leaves old generation active.
* Migration exception leaves old generation active.
* Shadow rendering exception leaves old generation active.
* Commit interruption rolls back atomically.
* Undo restores the previous revision and state.

## 25.7 Oracle testing

A fuzzing system should generate:

* random Java/View programs;
* user-event streams;
* source edits;
* schema edits;
* scheduling variations.

For each case, it compares optimized repair against the reference capsule reconstruction and hashes the resulting logical state.

---

# 26. Implementation Plan

## Phase 0: Development environment

Build:

* a custom Android emulator image;
* stable app-capsule process model;
* persistent Java compiler;
* revision transport;
* code-error overlay;
* shadow surface switching.

At this phase, whole UI-capsule reconstruction may be used instead of fine-grained repair.

## Phase 1: Presentation effect tracing

Implement:

* stable source-site IDs;
* View allocation identity;
* framework-call interception;
* causal effect ledger;
* current presentation liveness;
* property-level repair;
* hierarchy repair;
* interaction-state overlay.

Goal: transparent reload for ordinary single-threaded Java/View applications without application changes.

## Phase 2: Dynamic dependence graph

Implement:

* heap read/write tracking;
* dynamic control dependencies;
* helper-method invalidation;
* current-state reevaluation;
* trace compaction;
* cross-version computation reuse.

Goal: update effects caused indirectly by changed calculations.

## Phase 3: Revision-aware ART

Implement:

* logical class/method/field identities;
* versioned object layouts;
* schema migration;
* JIT deoptimization;
* on-stack replacement;
* reflection evolution;
* opaque JNI identities.

Goal: arbitrary structural Java edits without restart.

## Phase 4: Android framework integration

Implement high-level state adapters for:

* Views;
* text and IME;
* RecyclerView;
* animations;
* windows and dialogs;
* accessibility;
* rendering surfaces.

Goal: preserve complete interaction continuity.

## Phase 5: Deterministic concurrency and WorldGate

Implement:

* event and synchronization logging;
* filesystem and database branching;
* Binder mediation;
* network record/replay;
* sensor and clock virtualization;
* external-effect suppression.

Goal: safe repair of mixed UI/business methods.

## Phase 6: Native, resources, and components

Implement:

* revisioned native namespaces;
* native stack and heap handling;
* resource overlays;
* dependency graph updates;
* manifest overlays;
* stable component proxies.

## Phase 7: Physical development devices

Port the development image from emulator-first execution to supported unlockable devices.

The release artifact remains compatible with normal Android devices.

---

# 27. Rejected Alternatives

## 27.1 Explicit `render()` method

Rejected because it changes the application programming model and requires developers to reorganize imperative code into rerunnable components.

It is a practical shortcut, not the required end state.

## 27.2 `HotView` base class

Rejected because only code inside special classes would receive full reload semantics.

The requirement is ordinary Java everywhere.

## 27.3 Manual keys

Rejected because keys are application-visible reconciliation metadata.

THRIVE derives identity from source, execution, object, and data provenance.

## 27.4 Rerunning `Activity.onCreate()`

Rejected because it:

* repeats business side effects;
* violates lifecycle semantics;
* often loses state;
* duplicates registrations;
* can produce stale references;
* cannot safely undo removed operations;
* is too coarse.

## 27.5 Destroying and rebuilding the View tree

Rejected as the primary strategy because it unnecessarily loses View identity and interaction state.

A shadow capsule rebuild remains a correctness fallback, but state is transplanted and commit is atomic.

## 27.6 View-tree reconciliation alone

Rejected because a tree diff cannot discover:

* which helper computations changed;
* completed direct View mutations;
* durable state dependencies;
* side effects mixed into UI code;
* active callbacks;
* arbitrary class-schema evolution.

The system needs execution provenance, not only tree shape.

## 27.7 JVMTI redefinition alone

Rejected because changing future method execution does not repair presentation effects from completed methods.

Ordinary ART tooling also does not provide the unrestricted class and object evolution required by this RFC. ART TI remains useful for diagnostics, heap traversal, suspension, and fast-path operations.

## 27.8 New ClassLoader per save

Rejected as the complete solution because:

* old objects remain instances of old classes;
* existing listeners may retain old closures;
* type identity fragments;
* arbitrary framework-held objects cannot be replaced transparently;
* completed View effects still do not update;
* state migration becomes application architecture.

Versioned DEX loading may still be used internally as a transport or staging mechanism. Android’s in-memory DEX loader provides an appropriate primitive for that purpose.

## 27.9 Bundle serialization and Activity restoration

Rejected because Android saved-state APIs capture only explicitly supported state and do not represent arbitrary live Java, native, callback, framework, or execution state.

## 27.10 Forking ART without presentation tracking

Rejected as incomplete.

Even a VM capable of arbitrary class evolution would only change future execution. It would not make an old completed `setText("Foo")` become `setText("Bar")`.

The presentation-dependence graph and effect ledger remain necessary.

---

# 28. Research Risks

## 28.1 Trace size

Fine-grained execution provenance can consume substantial memory.

Mitigations include:

* presentation-directed tracing;
* trace chunking;
* dependency summarization;
* persistent memoization;
* checkpoint compaction;
* discarding sealed non-presentation history;
* storing reconstructible recipes rather than every instruction.

## 28.2 Radical source edits

A major rewrite may destroy most source correspondence.

The runtime must then:

1. preserve durable state where schema correspondence remains;
2. reconstruct a larger portion of the UI capsule;
3. use invocation-history synthesis for changed objects;
4. fall back internally to a broader shadow replay;
5. still commit without an exposed Activity restart.

## 28.3 Framework opacity

Some Android state is hidden in native or service processes.

The custom development image must expose stable high-level checkpoint interfaces rather than relying exclusively on reflection or process memory.

## 28.4 Racy native systems

Deterministic replay of arbitrary racy native code is difficult.

The stable-capsule and shadow-worker architecture provides a robust escape path: restore an earlier checkpoint, use the recorded schedule, and replace the worker atomically rather than mutating unsafe active native state in place.

## 28.5 State-migration ambiguity

No automatic mechanism can infer every domain-specific semantic transformation from arbitrary source changes.

THRIVE handles this operationally:

* deterministic correspondence;
* current-value preservation;
* construction-history synthesis;
* subgraph reconstruction;
* transactional rejection when new code cannot run;
* instant rollback.

It never requires a visible restart merely because the migration is complex.

## 28.6 Latency under long histories

Replaying from application launch would not meet the latency target.

Therefore launch-to-present replay is a last-resort correctness oracle, not the ordinary algorithm. Continuous checkpoints, presentation-directed tracing, state migration, and cross-version memoization are mandatory.

---

# 29. Why This Is Better Than an Implicit Declarative Framework

A compiler could secretly transform imperative Java into a component tree and a generated `render()` method.

THRIVE deliberately goes deeper.

It preserves the actual imperative execution model:

```java
TextView title = new TextView(context);
title.setText(computeTitle());
root.addView(title);
```

The runtime records:

* the actual allocation;
* the actual helper calls;
* the actual state reads;
* the actual framework mutations;
* the actual user effects that came later.

This has several advantages:

* no generated declarative API leaks into debugging;
* arbitrary existing code can participate;
* direct imperative mutations remain valid;
* custom Views remain ordinary Views;
* data and control provenance are available;
* identities can derive from actual runtime objects;
* UI effects can be repaired at finer granularity than rebuilding a component;
* non-UI side effects can be suppressed during repair;
* the system can preserve state that a synthetic tree would not understand.

The runtime is effectively an incremental, revision-aware interpreter for the portions of imperative execution that remain causally connected to the current presentation.

---

# 30. Final Architecture Decision

THRIVE adopts the following non-negotiable design:

```text
NO application render boundary
NO special View superclass
NO declarative rewrite requirement
NO manual state container
NO manual reconciliation key
NO Activity restart fallback
NO APK reinstall for ordinary edits
NO duplicate external side effects
```

Instead:

```text
ordinary Java
    ↓
revision-aware compiler and ART
    ↓
dynamic execution provenance
    ↓
presentation-dependence graph
    ↓
causal effect ledger
    ↓
automatic UI capsule
    ↓
speculative repair in shadow state
    ↓
framework-state replay and transplant
    ↓
atomic surface/process commit
```

The crucial conceptual shift is:

> Hot reload for imperative Android Views should not ask “which method should be rerun?” or “which component should rebuild?”

It should ask:

> “Which currently live effects were produced by source code that has changed, what values should those effects have under the new revision and current state, and how can that revised effect history be committed atomically without disturbing later user interaction?”

That question has a viable systems answer.

It requires owning the compiler, VM, framework state model, external-effect boundary, and development operating environment. Given that complexity is acceptable, there is no reason to impose a `render()` abstraction on application developers.

---

# 31. References and Technical Basis

1. Android Open Source Project, **ART Tooling Interface**. ART TI supports native runtime agents, DEX-based class redefinition, heap traversal, stack inspection, thread suspension, and related tooling for debuggable applications.

2. Android Developers, **InMemoryDexClassLoader**. Android can load and execute DEX directly from memory-backed buffers.

3. Android Open Source Project, **Structural-redefinition handling and JNI-ID constraints**. AOSP’s implementation demonstrates the metadata and pointer-identity problems involved in changing live class structures.

4. Subramanian, Hicks, and McKinley, **Dynamic Software Updates: A VM-centric Approach**. JVOLVE integrates Java class evolution with safe points, object transformation, JIT compilation, on-stack replacement, and garbage collection.

5. Acar and collaborators, **Imperative Self-Adjusting Computation** and related work. Dynamic dependence graphs and change propagation provide a foundation for reevaluating affected imperative computations.

6. Gu et al., **Automating Object Transformations for Dynamic Software Updating via Online Execution Synthesis**. Invocation-history reconstruction provides a basis for automatically transforming objects across program versions.

7. Vilk et al., **McFly: Time-Travel Debugging for the Web**. High-level visual-state checkpointing, event logging, and deterministic replay demonstrate how program and presentation state can be kept synchronized across complex runtime boundaries.

8. Kirisame et al., **Incremental Live Programming via Shortcut Memoization**. Cross-version reuse of structurally similar computations supports the low-latency incremental-execution direction required by THRIVE.

9. Flutter documentation, **Hot reload**. Flutter’s user-visible benchmark is state preservation plus automatic rebuilding of currently live UI code.

10. Vite documentation, **HMR API** and **Why Vite**. Vite provides the benchmark of precise invalidation and state-preserving updates without a full page reload.
