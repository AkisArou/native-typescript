# 0018 — Nullable object results stay frame-bounded

Status: implemented and measured; timings remain observations, not test gates  
Recorded: 2026-08-23

[Record 0017](0017-android-hotspot-matrix.md) selected nullable object results
as the next resource-domain target. The compiler could already keep an exact,
non-null owned handle in its foreign frame, but represented `T | null` as a
managed union around a stable handle cell. `ViewGroup.getChildAt()` therefore
paid for `NewGlobalRef`, `DeleteLocalRef`, identity lookup, a handle cell, and a
union box even when the program immediately tested for null, called `getId()`,
and discarded the result.

## Decision

A compiler-proven nullable frame resource uses one raw pointer:

```text
NULL            -> the source union's null arm
non-NULL handle -> the source union's handle arm
```

The Native IR local records the exact union id and its handle/null tags. The
C and LLVM backends use those facts only to lower the union tag test and the
checker-proven narrowing. A present narrowed value can enter synchronous
borrowed native calls directly. Scope cleanup invokes the capsule's
NULL-tolerant frame release on every exit.

The eligibility proof remains conservative. The local must be immutable,
unboxed, synchronous, and initialized directly by an owned nullable-handle
result whose binding supplies a frame entry and release. Its only admitted
uses are exact handle/null tag tests and a checker-generated narrowing used as
the whole argument of a synchronous borrowed native call. Storage, capture,
mutation, suspension, registration ownership, return, and every unrecognized
shape retain the stable path.

This is a compiler decision, not a JVM special case. The SCABI manifest names
both mechanics entries; the shared Native IR pass selects one; both backends
spell the selected plan. The JVM generator already emitted the local-reference
entry for nullable object methods, so its only platform change was to publish
that existing capability in SCABI.

## Disagreeing proof

The native fixture now has three nullable cases that cannot agree
accidentally:

| Case | Expected global promotions | Expected local releases | Expected managed cells |
| --- | ---: | ---: | ---: |
| present, null-tested, borrowed call | 0 | 1 | 0 |
| absent, null-tested | 0 | 0 | 0 |
| present, then stored in an array | 1 | 1 | 1 |

The observer exits 42 on both C and LLVM. Before the implementation, both
lanes failed on the precise Native IR refusal that allowed a frame capability
only on a direct non-null projection.

The generated Android C is a second structural check. The measured
`getChildAt()` loop now contains:

```text
getChildAt_frame -> raw NULL test -> getId(raw) -> release_frame
```

It contains no union allocation, identity-map lookup, stable-handle
preparation, or managed cell for the returned child.

## On-device measurement

The unchanged schema-3 matrix ran for five cyclically ordered process rounds
on the same Pixel 10 Pro x86-64 API 37 AVD with ART `speed` compilation. Each
repeated scenario contributed 35 accepted samples. The source workloads and
their SHA-256 digests are identical to record 0017.

The causal comparison is the targeted scenario; Kotlin and NativeScript are
controls for device/run drift:

| `handle-result` | Before | After | Change |
| --- | ---: | ---: | ---: |
| Native TypeScript | 366.31 ns/lookup | 211.57 ns/lookup | **-42.2%** |
| Kotlin | 2.82 ns/lookup | 2.81 ns/lookup | -0.3% |
| NativeScript | 509.41 ns/lookup | 524.55 ns/lookup | +3.0% |
| NTS / Kotlin | 129.78x | 75.16x | -42.1% |
| NTS / NativeScript | 0.72x | 0.40x | -43.9% |

The complete after-run report is preserved at:

```text
/home/akisarou/.cache/nts-tmp/android-nullable-frame-five-round-avd/results.json
```

The result does not make returned handles cheap relative to an in-ART Kotlin
call: two JNI transitions, error checking, receiver validation, and local
reference deletion remain. It does establish that stable ownership was a
large, removable part of the cost, while leaving the escaping sibling on the
safe stable path.

Other matrix medians moved in both directions. In particular, the five-sample
view-tree and framework-heavy screen-build cases remain noisy. They are
reported in the root README as the current complete observation, but none is
attributed to this optimization.

## Next question

The largest isolated remaining seams are callback delivery/payload handling
and outbound strings. The exact `GetEnv` counter was subsequently expanded
with the scoped TLS carrier actually available to the JVM target. That carrier
matched the explicit-operand host lower bound and reduced this handle-result
ART median again, from 211.57 to 139.33 ns/lookup.
[Record 0019](0019-scoped-jni-environment-capability.md) records the mechanism
and keeps a broader compiler execution-context ABI uncommitted.
