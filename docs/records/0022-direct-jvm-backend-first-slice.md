# 0022 — Admit a direct JVM backend by executable evidence

Status: experimental first slice implemented; Android call measured in record 0023  
Recorded: 2026-08-23

[Record 0021](0021-frame-local-jvm-string-bridge.md) removed avoidable native
staging, but the remaining isolated string-argument path was still 14.14x the
equivalent Kotlin call. That is not all removable JNI overhead: a native
program must still construct an ART string, cross JNI, and maintain the
foreign ownership contract. An Android API-heavy program can avoid that class
of cost only by executing on ART's side of the boundary.

This record admits a second Android code-generation route:

```text
TypeScript -> checked ScriptC IR -> JVM translation unit -> javac -> classfile
                                                        -> D8/R8 -> DEX
```

It does not remove or weaken the existing ScriptC IR to C/LLVM path. Native
targets and explicitly native computation continue to need it.

## Why Java is the first translation unit

The current C backend emits readable C and delegates object-file mechanics to
clang. The first JVM slice follows the same division: it emits deterministic
Java from checked, validated ScriptC IR and delegates classfile verification,
stack maps, and constant-pool construction to `javac`.

That choice changes build mechanics, not the runtime call path. `javac`
produces ordinary JVM bytecode, D8 consumes the resulting class directly, and
there is no Java-source interpretation at runtime. A bespoke classfile writer
would have to reproduce verifier and stack-map machinery before it could emit
the same `invoke*` instructions. It becomes worthwhile only if measurements
show javac build latency or generated-source scale is a problem.

## First executable contract

The ScriptC fork now publishes an experimental emitter over its serialized IR
boundary. Its first deliberately small tier supports the module/function
shape needed by the hello corpus program and refuses every unsupported IR
node through `JvmUnsupportedError`; it does not silently project a C runtime
operation onto an approximately similar Java one.

The parent gate proves all four stages:

1. the ordinary ScriptC frontend type-checks and lowers the TypeScript fixture;
2. the JVM emitter consumes that versioned IR rather than re-reading the
   TypeScript AST;
3. javac produces a class whose output agrees byte-for-byte with Node;
4. `javap` shows a direct `PrintStream.println(String)` call with no native or
   JNI entry, and D8 accepts the class into `classes.dex`.

The existing C/LLVM compilation plans retain their exact schema. The JVM
emitter has a separate loader so an additive experiment cannot make existing
native-plan consumers require the new capability.

## What this does not claim

The first fixture proves the route, not useful Android coverage. It does not
yet implement:

- Android member calls or generated platform subclasses;
- JavaScript number formatting beyond operations that never reach output;
- classes, closures, arrays, exceptions, promises, async functions, or timers;
- the Android Looper/microtask integration;
- `fetch`, WebSocket, or other target capability providers;
- a performance win.

Those remain refusals until an observer needs each one. In particular,
`CompletableFuture`, Kotlin coroutines, and one Android `Runnable` per Promise
reaction are not accepted substitutes for JavaScript microtask ordering.

## Next measurement-bearing slice

The next observer must be a direct Android/JVM member call, not broader pure
language coverage. It should compile one existing benchmark operation from
the same checked declaration and binding identity into `new`, `invokevirtual`,
or `invokestatic`, then establish two disagreeing facts:

- bytecode inspection contains the exact platform member descriptor and no
  generated JNI adapter call;
- the unchanged on-device benchmark reports the direct route separately from
  the current JNI route and Kotlin.

The JVM target already owns class-file metadata and binding identities. The
direct emitter should consume that authoritative mapping beside ScriptC IR;
it must not parse class and descriptor facts back out of generated C symbols
or dotted binding IDs.

Only after that direct-call slice wins do classes/fields, callback subclasses,
and the small Looper-integrated Promise scheduler become implementation work.
This preserves the project's evidence rule while testing the architectural
hypothesis at the operation responsible for it.

That observer and measurement have now landed in
[record 0023](0023-direct-jvm-android-call.md). The exact static Android call is
6.85x faster than the current JNI route and within 1.87x of Kotlin in its first
valid matched input shape; the existing JNI target remains the shipped path.
