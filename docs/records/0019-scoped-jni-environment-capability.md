# 0019 — Scope the current JNI environment across a runtime turn

Status: accepted  
Last revised: 2026-08-23

This is an implementation and measurement record under the
evidence-before-architecture rule in [the performance program](../performance.md).
It records why the JVM target now carries the `JNIEnv *` already supplied at
callback or owner-turn ingress, without adding a hidden operand to SCABI,
Native IR, or every backend call.

## The earlier hypothesis was too broad

[Record 0013](0013-performance-and-debuggability-audit.md) required a matched
measurement before the compiler, SCABI, both backends, adapters, and runtime
grew a general execution-context ABI. It predeclared 5 ns per eliminated
lookup as the threshold for paying that architectural cost.

The first host pair measured only 3.4–3.6 ns per `GetEnv`, apparently below
that threshold. That was valid evidence against the proposed *general ABI*,
but it did not establish that every smaller implementation was worthless:

- a real operation can contain several adapter entries and releases;
- a few nanoseconds are material beside an 84 ns primitive setter;
- JNI callback ingress already receives the correct `JNIEnv *` for free;
- the target runtime already owns native-origin owner turns;
- a save/install/restore TLS scope needs no compiler or published-ABI change.

The threshold was therefore re-evaluated against the implementation actually
available. Pre-implementation documents remain guardrails and falsifiable
hypotheses; they are not a reason to discard a measured cumulative win.

## Mechanism

The JVM target owns one reentrant thread-local capability:

```text
Java callback(env)
    save previous TLS env
    install env
    call the synchronous TypeScript handler
        outbound adapter -> scoped env
        release          -> scoped env
        nested callback  -> save/install/restore again
    restore previous TLS env
```

Native-origin turns have the corresponding runtime scope:

- an owner poll acquires the current environment once around callback dispatch
  and the loop checkpoint, then restores the previous value;
- a thread attached by the runtime keeps its environment for the lifetime the
  runtime controls that attachment;
- an adopted JVM scopes the `JNIEnv *` supplied during `JNI_OnLoad` only across
  binding, service startup, and hosted initialization;
- a runtime-created desktop JVM keeps the environment until it destroys that
  VM.

Every generated member adapter first consumes the scoped value. Calls outside
a declared scope retain the checked `JavaVM->GetEnv` fallback, including the
existing precise error or attached-owner trap. No cached pointer survives a
callback an external embedder may later detach.

Generated adapters provide a weak TLS definition so standalone adapter tests
and embedders still link. The JVM runtime provides the strong definition that
unifies all generated packages in the image. Inspection of the packaged
Android shared object found one global TLS symbol; the two `readelf` entries
are its dynamic and ordinary symbol-table views, not two slots.

## Host carrier falsifier

`scripts/adapter-lto-falsifier` now compares three shapes against a real JVM:

```text
lookup: JavaVM->GetEnv, then JNIEnv->GetVersion
scoped: read TLS JNIEnv, then JNIEnv->GetVersion
passed: explicit JNIEnv operand, then JNIEnv->GetVersion
```

All arms return the same checksum. Interposed JNI tables count exact
operations, every unwrapped slot traps, and the final assembly is inspected.
Measured on Corretto 21, clang 22, and x86-64 Linux with a 5,000,000-iteration
warmup and 15 repetitions of 5,000,000 operations:

| binary | per-call lookup | scoped TLS | explicit operand | TLS saving |
| --- | ---: | ---: | ---: | ---: |
| no LTO | 4.3 ns | 1.1 ns | 1.1 ns | 3.2 ns |
| full LTO | 4.3 ns | 1.1 ns | 1.1 ns | 3.2 ns |

Exact dynamic operations per iteration:

| arm | `GetEnv` | `GetVersion` |
| --- | ---: | ---: |
| lookup | 1 | 1 |
| scoped TLS | 0 | 1 |
| explicit operand | 0 | 1 |

The assembly retains `vm->GetEnv` only in lookup and `env->GetVersion` in all
three arms. On this host the scoped carrier reaches the explicit operand's
measured lower bound; widening the compiler ABI has no demonstrated additional
performance value.

## Android result

The unchanged three-way release suite was run for five cyclically ordered
rounds on the x86-64 Pixel 10 Pro API 37 AVD after ART `speed` compilation.
Each boundary microcase below contains 35 measured samples. The comparison is
against the immediately preceding nullable-result measurement:

| workload | before | scoped env | change | NTS/Kotlin before -> after |
| --- | ---: | ---: | ---: | ---: |
| lightweight object construction and scalar result | 221.70 ns | 159.09 ns | -28.2% | 8.92x -> 4.93x |
| primitive setter | 84.45 ns | 64.72 ns | -23.4% | 5.64x -> 4.71x |
| payload-free callback | 292.48 ns | 255.13 ns | -12.8% | 135.25x -> 102.81x |
| nullable handle result plus receiver reuse | 211.57 ns | 139.33 ns | -34.1% | 75.16x -> 48.16x |
| callback payload plus receiver reuse | 390.57 ns | 337.21 ns | -13.7% | 124.14x -> 102.07x |

The Kotlin normalization matters because both runs used an emulator. Kotlin's
setter improved 8.3%, versus Native TypeScript's 23.4%; Kotlin's handle result
worsened 2.8%, versus Native TypeScript's 34.1% improvement. String, byte-array,
view-tree, and composite results moved in both directions and are not attributed
to this change. This is a boundary-capability optimization, not a claim that
all Android work became faster.

Raw report:
`/home/akisarou/.cache/nts-tmp/android-env-scope-five-round-avd/results.json`.

## Correctness evidence

The live JVM callback observer proves all three scope properties in one path:

1. the TypeScript handler observes a non-null scoped environment;
2. a nested outbound Java call and its handle release succeed through it;
3. the TLS value is null again after every trampoline returns.

Generated-source observers pin save/install/restore and the checked fallback.
Hosted, executable, Android cross-compile, C, and LLVM paths all remain green.

## Decision

Keep the scoped JVM-target capability. Reclassify generated environment support
from a gap to a target translation: JNI callback ingress and target-owned turns
provide the capability, and standalone calls retain exact fallback behavior.

Do **not** add a neutral hidden execution-context operand yet. The narrower
mechanism captures the measured host lower bound and produces a material ART
win without changing ScriptC or SCABI. A future target requiring several
capabilities, a demonstrated TLS bottleneck, or cross-backend optimization may
independently justify a neutral context value.

