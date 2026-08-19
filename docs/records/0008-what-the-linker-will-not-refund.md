# 0008 — What the linker will not refund

Status: accepted; the normative consequence is recorded in
[the foreign boundary](../foreign-boundary.md)
Last revised: 2026-08-19

This is an investigation record under the policy in
[scriptc evolution](../scriptc-evolution.md). It records the measurement that
[the foreign boundary](../foreign-boundary.md) made a precondition of its own
expansion, what the measurement returned, and why the answer licenses less
work than the document was written to license. It is not normative.

## Feature or behavior

[The foreign boundary](../foreign-boundary.md) describes a conservative
per-call adapter as the contingency for every platform, and compiler-side
lifetime and escape knowledge as the steady state. It then made its own
expansion conditional: *before expanding the compiler for any platform*, the
adapter-plus-LTO falsifier must measure how much of the adapter's price
link-time optimization already refunds.

That condition was written to stop a specific failure — expanding a compiler
to buy something a linker already gives away. It was unmeasured for as long as
it stood, which meant every scope argument downstream of it was an argument
about an unknown.

## Real motivating program/test

Three programs, each in two shapes, against a real JVM through the invocation
API. The instrument is `scripts/adapter-lto-falsifier`; the numbers below are
its output, and it is committed so that a reader who doubts them can produce
their own.

- **non-escaping returned object** — a call returns an object, one field is
  read, the value dies inside the iteration.
- **stored beyond the call** — the returned object outlives the call, so
  promotion is genuinely required and both shapes must promote.
- **useful result with a detailed failure channel** — an `int` result plus a
  failure whose message is captured, owned, and released.

Variant A is the contingency adapter verbatim, in its own translation unit so
it cannot see escape or liveness; built with and without `-flto=full`.
Variant B is what an escape- and liveness-aware compiler would emit.

## Current scriptc revision and result

Measured at parent `3cd72ee`, fork `bc52a803`, on Corretto 21 / clang 22 /
x86-64. Median nanoseconds per operation:

| case | adapter | adapter + LTO | compiler-informed |
| --- | --- | --- | --- |
| non-escaping | 144.1 | 145.5 | 60.9 |
| stored | 157.5 | 157.7 | parity |
| fallible | 51.6 | 52.7 | 51.7 |

**LTO refunds nothing structural.** The non-escaping case pays 83 ns/op — 2.4×
— and link-time optimization returns −2% of it, inside noise and stable across
two full runs.

The operation counts explain it without appeal to the timings. Variant A
performs four operations per iteration that B does not: `PushLocalFrame`,
`PopLocalFrame`, `NewGlobalRef`, `DeleteGlobalRef`. Each is a call through the
JVM's function table. A linker cannot see through a function table, so it
cannot delete them.

The assembly rules out the alternative explanation a reader would reach for
first — that LTO simply failed to inline, and a better linker would do better.
Inlining was partial: `nt_adp_make` and `nt_adp_capture` survive as calls in
the optimized binary. But `nt_adp_checked_add` was fully inlined into
`a_fallible`, and A-with-LTO still matches A-without-LTO on every case
including that one. Where the linker succeeded completely it still bought
nothing. **The price is not the cost of calling the adapter; it is the
operations the adapter performs.** That distinction is what makes the finding
about JNI's structure rather than about this compiler's inliner, and it is why
the conclusion is expected to hold on other toolchains.

The two remaining cases were never paying a structural price at all, which is
the half of this result that is easy to skip past and is the more consequential
one.

The stored case is reported as parity rather than as a number on purpose.
Within a single run the same logical B code measured 159.1 and 142.9 in the two
binaries; that 16 ns/op spread against a ~150 ns/op absolute is the resolvable
floor for this case, and A at 157.5/157.7 falls inside it. A second full run
agreed. Quoting a tax here would be quoting the noise.

## Classification

**Product-scope boundary, resolved by evidence.** Nothing is missing and
nothing is broken. What changes is how much compiler expansion the design
document licenses, and the change is a narrowing.

## Required observable semantics

None. This record adds no behavior. Its output is a constraint on what future
slices may claim as their justification.

## Language/IR/runtime implications

- **Licensed:** resource-protocol lifetime domains, and escape-driven
  promotion and frame *elision*. This is the 2.4× case. It is the only case
  with a structural price, and only compiler-side escape and liveness
  knowledge can remove it.
- **Not licensed on performance grounds:** the outcome protocol. The fallible
  case is at parity, and at parity *without* LTO, so the conclusion does not
  even rest on the linker. Its remaining slices — output validity included —
  must earn their place on correctness or expressibility alone.
  [0007](0007-weak-and-invalid-are-not-one-thing.md) already deferred output
  validity for a metadata reason; this removes the argument that might have
  overridden that deferral.
- **Not licensed:** a batched-region primitive. Batching local frames at 512
  per region beat per-iteration `DeleteLocalRef` by about 5 ns/op. Region
  *extent* is marginal; the win is *elision*. A primitive for choosing region
  size would be machinery for a rounding error.

## Reference implementations and findings

The instrument measures exactly the four legs the *Performance* claim demands
and refuses to measure intermediate IR: steady-state medians; exact dynamic
counts of reference and frame operations through an interposed JNI function
table where every unwrapped slot traps; final-assembly call sites, with
indirect calls labelled from offsets probed out of the real `jni.h` rather
than hand-written; and identical-work checksums covering the failure path's
message as well as the success values.

The probe matters more than it looks. Hand-written function-table offsets are
how a measurement quietly stops measuring what it names, because a wrong
offset labels the wrong call and the report still renders.

## Chosen decision and rejected alternatives

**Chosen.** Record the result in the normative document as a narrowing rather
than as a green light, and state both halves: the case that justifies compiler
work, and the cases that do not.

**Rejected.**

- *Read the 2.4× as licensing the expansion the document describes.* It
  licenses one dimension of it. Reading a single positive case as approval for
  the whole horizon is precisely the 51-declared/23-lowered failure
  [0003](0003-vocabulary-narrowing.md) amputated, arriving by a new route.
- *Treat parity as "no finding" and leave it out.* The parity results are the
  load-bearing half. They are what stops outcome-protocol machinery from being
  built for a performance reason that does not exist, and a reader who sees
  only the 2.4× will supply that reason themselves.
- *Defer the measurement until a platform is actually being built.* The
  document made it a precondition specifically so the scope argument would
  happen before the code did. Measuring after would mean measuring something
  already written.
- *Report the stored case's tax as a number.* Two measurements of identical
  code differ by more than the effect. Reporting the difference would put a
  false precision into a normative document.

## Implementation repository and owner

`scripts/adapter-lto-falsifier` in this repository, alongside
`scripts/measure-failable-callables.py`: it measures a claim owned by a
document here, and it is not a gate. Owner: project maintainer.

## Upstream issue/PR/status

None, and none is appropriate. The finding is about this project's scope, not
about a compiler capability. The lifetime-domain and escape work it licenses
would be neutral compiler capability when a platform reaches it.

## Conformance tests

None. This is a measurement, not a behavior, and it is reproduced by running
the instrument rather than by a test that would gate on a benchmark number.
Gating on nanoseconds would fail on other people's hardware and teach everyone
to ignore it.

## Removal or revisit condition

**Revisit on ART.** This is HotSpot on a desktop. The structural finding
transfers, because the unrefundable operations are calls through a function
table and every JVM has one; the magnitudes will not. Re-run when an Android
target exists and record the ART numbers beside these.

**Revisit under threads.** Contention on the global-reference lock and the
GC-root pressure a population of global references creates are both
unmeasured, and both make the conservative adapter *worse*. Together with the
ART caveat they mean the licensed scope is a floor, not a ceiling — so a
revisit can widen this record's conclusion but is unlikely to narrow it.

**Supersede** if link-time optimization ever gains the ability to see through
a function table populated at runtime, which would make the central mechanism
here false rather than merely dated.
