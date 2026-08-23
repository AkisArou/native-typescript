# 0035 — Put a native TypeScript subclass directly on the JVM

Status: implemented; desktop bytecode proof complete  
Recorded: 2026-08-24

The direct JVM backend could already emit ordinary TypeScript classes and
generated interface listeners, but a platform-created class still belonged to
the JNI architecture. Android therefore ran a handwritten Java `Activity`
which called static TypeScript benchmark kernels. That measured individual hot
paths honestly, but it was not a complete TypeScript-to-DEX application: the
framework never dispatched a lifecycle method into JVM bytecode emitted from
the TypeScript subclass.

## Decision

The JVM binding sidecar now carries a `class-callback` arm for every
class-anchored generated override. It states all information a direct backend
needs and cannot safely reconstruct:

- the generated class's exact binary name;
- the source class declaration name;
- its superclass and implemented interfaces;
- the virtual method name and descriptor;
- the registration binding it replaces;
- the selected method which reaches `super`, when one exists;
- whether the callback is the declared terminal event.

This advances `native-typescript.jvm-direct-bindings` to schema version 3.
The sidecar remains target evidence joined to the same Native IR binding id;
the compiler does not parse a C symbol or infer a source class from a binary
name.

When one of these registrations is reachable, the Java translation unit is
the generated platform class itself:

```text
platform virtual dispatch
        ↓
ordinary Java override
        ↓
checked TypeScript implementation function
```

The module-initializer registration becomes an inert marker. It has no runtime
table, callback token, native method, or JNI transition. A stated base call is
emitted as an ordinary helper whose `super.name(...)` body javac lowers to
`invokespecial`.

## The peer in a direct artifact

The C and LLVM backends require a managed peer beside the foreign receiver:
the foreign object has no ScriptC field layout. That is not true on the direct
JVM route. The generated Java receiver is already a traced managed object, so
the TypeScript instance fields live directly on it.

`nativePeerAttach` therefore becomes a one-time initializer returning the same
Java object. It invokes the already-lowered peer constructor once, including
the hidden inherited-call handle and all field initializers. Subsequent
lifecycle deliveries return the same receiver and observe the same fields.

The terminal `nativePeerDetach` becomes a lifecycle marker rather than an
ownership operation. The separate registration root and weak foreign slot do
not exist in this representation; ART owns reachability of the one object.
Any retained closure which captures `this` naturally keeps that same receiver
alive, matching the source-level relationship without a global reference or a
side table.

## Disagreeing proof

The integration gate builds two generated platform subclasses from classfile
metadata, produces the SCABI package and direct sidecar, compiles TypeScript to
Native IR, emits Java, runs javac, inspects bytecode, and executes it on a host
JVM.

The first fixture proves dispatch and the base path:

- the emitted class extends the platform base;
- its override is not `native`;
- calling it reaches the TypeScript body;
- `super.onNotify` appears as `invokespecial fixture/Host.onNotify:(I)V`;
- no JNI symbol remains.

The peer fixture is intentionally stronger. One Java receiver receives
`onOpen(19)`, then `onOpen(23)`, then `onSettle`. A TypeScript instance field
accumulates the two deliveries and reports `42`. Rebuilding a peer per
dispatch would report `23`; failing to attach it would report the initialized
sentinel. A separately generated terminal override then runs. The bytecode
observer requires `getfield`, `putfield`, and the non-virtual base call on the
outer platform class, and refuses a nested managed peer class or any native
method.

Both required gates passed at this checkpoint:

```text
ScriptC: 9/9 fork lanes
Parent: 336 passed, 1 expected no-device skip
```

## Consequence

The direct JVM architecture now owns the class shape required by an Android
`Activity`: platform construction, virtual lifecycle dispatch, ordinary
TypeScript fields, exact `super`, and terminal lifecycle lowering can all stay
inside ART.

This record does not claim an Android application or launch measurement yet.
The benchmark still uses its handwritten Java `Activity` while the remaining
source operations in that harness are admitted by the JVM emitter. The next
slice is to emit that Activity from TypeScript, pass it through D8, run it on
the device, and only then add launch/lifecycle/memory comparisons to the
existing per-operation results.
