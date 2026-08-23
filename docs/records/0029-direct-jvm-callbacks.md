# 0029 — Keep same-thread callbacks in ART

Status: experimental direct-JVM slice implemented and measured  
Recorded: 2026-08-23

[Record 0028](0028-direct-jvm-byte-arrays.md) left same-thread callbacks as
the largest measured direct-JVM candidate. The JNI route already avoided
dynamic lookup and queueing, but one click still crossed a registered native
trampoline, recovered the registration, entered ScriptC, and returned through
JNI. Kotlin stayed entirely in ART.

## Decision

The direct JVM backend may replace a generated listener shell with a Java
implementation only when the subclass generator states that role and class
ingestion proves the statement against the complete compiled bytes:

- it is a final class whose superclass is `java/lang/Object`;
- it implements exactly one interface;
- it has one public no-argument constructor;
- it contains one receiver-anchored, synchronous, void callback;
- it has no fields, ordinary methods, static initializer, base call, or
  terminal role.

The distinction matters because a snapshot contains only selected members:
absence from that projection cannot prove absence from the class. The
generator therefore marks its behavior-free interface shell, ingestion checks
the full constructor, method, field, superclass, interface, and initializer
shape, and the binding sidecar publishes the verified interface coordinate as
an `instance-callback` entry. The compiler does not infer it from
`ClickBridge`, `onClick`, or another generated name. A disagreeing class with
one unselected field is permanently refused by the observer.

For the first admitted callback body:

- the closure has no captures;
- the generated adapter stores the handler as a Java reference;
- the adapter directly implements `View.OnClickListener`;
- `onClick(View)` invokes the emitted TypeScript function in the same Java
  frame;
- registration returns an idempotent Java connection whose `disconnect()`
  clears that exact handler;
- a second registration and delivery without a registration throw rather
  than silently changing behavior.

The benchmark roots the connection in a module global, matching the existing
JNI benchmark's retained registration. Registration and widget construction
remain outside the timed loop. Capturing closures, answered callbacks,
queued callbacks, class-anchored lifecycle callbacks, and adapters with more
than one callback remain precise refusals.

## Disagreeing proof

The host observer first failed at the direct emitter with:

```text
JVM direct binding '...clickbridge.onclick' descriptor takes 1 arguments,
but IR supplies 2
```

The callback descriptor describes the Java delivery payload; the second IR
value is the TypeScript handler used to register it. Treating the callback as
an ordinary method therefore could not pass accidentally.

The observer now generates an interface adapter, registers a zero-capture
TypeScript handler, asks a Java host to deliver twice, and exits with `2`.
`javap` must show the nested class implementing the declared interface and:

```text
public void onClick(android.view.View)
getfield      ...ntsHandler
invokeinterface ...NtsCallback0.invoke:(Landroid/view/View;)V
```

Neither the generated kernel nor the nested listener class may contain a
native method or an `nts_jvm_` call.

Adding a retained callback initially caused the shared number analysis to
forget immutable literal globals at every native call. That de-specialized
unrelated loops and made the bytecode gate fail. Re-entrant code can mutate
only mutable bindings, so native-call havoc now preserves immutable global
seeds. A focused analysis test pins that fact; the complete Android bytecode
gate continues to reject a numeric-coercion helper in any proved kernel.

## On-device measurement

All four APKs ran for five cyclically ordered process rounds on the Pixel 10
Pro x86-64 API 37 AVD after ART `speed` compilation. Every implementation
performed 50,000 `Button.callOnClick()` deliveries per sample, with three
warmups, seven measured samples, and the same checksum. Registration was not
timed. Lower is better.

| Implementation | Median per delivery | Ratio to Kotlin |
| --- | ---: | ---: |
| Kotlin | **2.08 ns** | 1.00x |
| direct JVM Native TypeScript | **3.60 ns** | **1.73x** |
| JNI Native TypeScript | 167.01 ns | 80.44x |
| NativeScript | 1,381.52 ns | 665.40x |

The direct path is 46.37x faster than the current JNI route and 383.57x
faster than NativeScript in this matched run. The remaining 1.52 ns gap to
Kotlin is consistent with the generated handler-field load, null guard, and
interface invocation visible in bytecode. ART may inline those operations;
the structural claim is only that no native transition, identity scan,
managed handle, or scheduler hop remains.

Raw evidence:

```text
/home/akisarou/.cache/nts-tmp/direct-callback-five-round/results.json
sha256:669f148126bd1cb322e74303d6250b6586e80377330d10a379946b6fdd8c818a

/home/akisarou/.cache/nts-tmp/direct-callback-five-round/
  native-typescript-jvm/bytecode-evidence.txt
sha256:6249f788be92435677f01dcf121ed7a688e06a6648f7af49716a8afb80f2de09
```

The seven-kernel direct-JVM APK is 20,688 bytes. It remains a kernel hosted by
a small Java Activity rather than a complete application backend, so launch
and memory comparisons still apply only to the three full applications.

## Consequence

For same-thread Java delivery, the fastest correct identity and lifetime
mechanism is an ordinary Java object reference. Generation-checked native
tokens remain relevant when a callback crosses into native code or outlives a
Java-owned adapter, but adding one to this route would recreate bookkeeping
ART already performs.

The next callback slice should consume the delivered `View` directly before
considering captures. That separates payload representation from closure
environment design and reuses the existing `callback-payload` workload as a
matched falsifier.
