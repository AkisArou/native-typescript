# 0020 — Keep synchronous callback payloads frame-bounded

Status: implemented and measured; timings remain observations, not test gates  
Recorded: 2026-08-23

[Record 0018](0018-nullable-frame-bounded-results.md) removed stable ownership
from non-escaping JVM object results. Callback ingress still erased the same
information earlier: every object delivered by JNI was promoted with
`NewGlobalRef`, placed in a managed handle cell, and released after the
handler—even when the handler only made a synchronous call on it and returned.

## Decision

A target package may now publish the two mechanics that move an owned callback
payload out of its foreign frame:

```text
frameBounded.promote(frame reference) -> stable reference
frameBounded.release(frame reference)
```

The capability says how; it does not select when. A whole-program ScriptC pass
selects `resourceMode: "frameBounded"` only when all reached registrations for
that callback binding use directly known, synchronous closures and every use
of the payload is a null test or a borrowed synchronous native call. Storage,
capture, return, mutation, suspension, an unknown handler, or another use keeps
the binding on the stable path.

This rule is whole-binding because one generated callback trampoline currently
serves every registration of a binding. One unproved registration therefore
keeps every payload delivered through that trampoline stable. A distinct
binding in the observer makes the escaping arm disagree without weakening this
rule.

SCABI v13 carries the capability. Native IR carries both the target mechanics
and the compiler's selected mode. C and LLVM consume that same decision:

```text
synchronous + non-escaping
    raw frame handle -> handler -> exact frame release

synchronous + escaping
    promote -> managed cell -> handler -> stable release

queued
    promote before invocation record -> owner delivery -> stable release
```

The JVM trampoline now passes the local `jobject` through while its scoped
`JNIEnv *` is installed. Its promotion entry performs `NewGlobalRef` and
consumes the local reference on both success and failure. The ordinary stable
release remains `DeleteGlobalRef`; the frame release remains `DeleteLocalRef`.

## Disagreeing proof

The Native IR fixture delivers one object to three handlers:

| Case | Stable promotions | Frame releases | Managed cells | Observable result |
| --- | ---: | ---: | ---: | --- |
| telling handler, synchronous use | 0 | 1 | 0 | seed survives |
| answered handler, synchronous use | 0 | 1 | 0 | answer survives |
| retained handler through sibling binding | 1 | 1 | 1 | object works after return |

It exits 42 on both backends and runs in the sanitizer lanes. The generated
Android program supplies a second structural observation: the click trampoline
passes its raw payload directly, the payload handler calls `View.getId()` on
that pointer, and its function cleanup calls `release_frame`. That path has no
`promote_frame`, identity-map lookup, or `scr_native_handle_prepare`.

The failure paths are part of the proof. A missing/cancelled callback token,
an already-pending exception, a failed promotion, and a queued-record allocation
all release exactly the references acquired up to that point. The work also
closes a pre-existing queued allocation-failure leak for stable owned handles.

## On-device measurement

The three-way suite ran for five cyclically ordered process rounds on the same
Pixel 10 Pro x86-64 API 37 AVD after ART `speed` compilation. Each callback
scenario contributed 35 accepted samples. The comparison is against the
immediately preceding scoped-environment run in
[record 0019](0019-scoped-jni-environment-capability.md):

| Workload | Before | Frame-bounded payload | Change | NTS/Kotlin before -> after |
| --- | ---: | ---: | ---: | ---: |
| payload-free synchronous callback | 255.13 ns | 180.90 ns | **-29.1%** | 102.81x -> 78.62x |
| callback payload plus receiver reuse | 337.21 ns | 246.32 ns | **-27.0%** | 102.07x -> 62.18x |

The controls moved in different directions. Kotlin's payload-free callback
improved from 2.48 to 2.30 ns while its payload case worsened from 3.30 to
3.96 ns. NativeScript moved from 1,361.23 to 1,618.53 ns and from 1,758.16 to
2,039.18 ns respectively. Normalizing against Kotlin therefore improves the
targeted NTS ratio by 23.5% and 39.1%; the structural observer, rather than the
timing alone, establishes the removed operations.

The payload-free TypeScript handler now names its unused argument. This does
not change its workload, but it records a current compiler limitation: a
handler that omits a parameter is conservatively left on the stable path
because the shared trampoline cannot yet release that registration's argument
while lending the same position to a sibling handler. Per-registration
trampolines or trampoline-owned frame cleanup can remove that source-shape
restriction later.

Other workload medians moved in both directions and are not attributed to this
change. In particular, the unchanged handle-result case moved from 139.33 to
212.56 ns, which is evidence of cross-run emulator variance rather than a
resource-path change. The root README reports the complete current observation.

Raw report and checksum:

```text
/home/akisarou/.cache/nts-tmp/android-frame-callback-five-round-avd/results.json
sha256:e569db31e5e646abd4e24848ce7aa1ad35b0e6567fc966634a120109811fb378
```

## Consequence

Keep the capability and the compiler-owned selection. This is the callback
half of the local-versus-stable resource model proposed in
[record 0013](0013-performance-and-debuggability-audit.md): platform adapters
publish mechanics, whole-program analysis owns escape policy, and queued or
escaping values promote exactly once.

The next performance target should again come from the measured matrix. String
arguments remain the clearest isolated gap against Kotlin, while generated
token dispatch is the remaining callback-specific cost and would also remove
the current `IsSameObject` registration scan. Either needs its own structural
falsifier and matched device result.
