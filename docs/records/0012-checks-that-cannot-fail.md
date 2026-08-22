# 0012 — Checks that cannot fail

Status: accepted finding, no removal condition
Last revised: 2026-08-22

Fourteen defects were found on 2026-08-21. Every one had passed every gate it
was subject to, and none of the gates was negligent. This record is about why,
because the answer is not "test more" and the individual fixes do not carry it.

The common shape: **a check that is structurally incapable of observing the
property it is understood to check.** It runs, it passes, and its passing
carries no information about the thing it names. That is worse than a missing
test, because a missing test is visible in a coverage list and this is not —
the list says the property is covered.

## The whole of it, for someone who will not read the rest

**Falsify every check that matters: break the thing deliberately and watch the
check go red.** That one habit catches five of the six mechanisms below, and it
is the only thing that catches the two worst. It is necessary and not
sufficient — see the refusal caveat below.

**Falsify the ones you just wrote a comment to justify, first.** A guard nobody
explained is easy to doubt; a guard with a rationale beside it reads as
settled, and the rationale is usually true of exactly one caller — the one its
author had in mind while writing it. Mechanism 6 was found and then reproduced
forty minutes later, in the code fixing it, under a comment calling it a
deliberate boundary. The highest-risk moment for repeating a mechanism is
immediately after finding it, while the shape still looks like someone else's
mistake.

**When the check is a REFUSAL, watch which refusal.** A test that expects a
compile to fail passes when the compile fails for an unrelated reason: same
red, different subject, and falsifying it proves nothing because it was already
red for free. Assert the message, not the failure. Found 2026-08-22 — a program
meant to prove a heritage-clause refusal was refused earlier at the
external-module import check, and only printing the diagnostics showed it.

If you do more than that, do these:

- Ask what the check's EVIDENCE is, and whether the subject can influence it.
- Ask what the rest of the system actually hands the check — and measure that
  rather than reasoning about it.
- Ask what would have to be true for the check to fail. If nothing would, it is
  decoration.

The rest of this document is evidence for those four lines. It is longer than
anyone recalls under pressure, which is a property of the document rather than
of the reader: both sessions that produced these findings had read it, and
neither consulted it at the moment it would have helped. A record has no
failure mode — nothing goes red when it is ignored — so it is subject to its
own mechanism 4, and the four lines above are the only part expected to survive
contact with a real afternoon.

## The mechanisms

Six have produced it — four on the day this record was written, two more the
following day. They are separated because the defence against each differs.

## 1. The instrument cannot see its own subject

The plainest form, and the most frequent.

- A grep for `scr_child_` establishing that a runtime unit was self-contained.
  The symbols are `scr_children_*`. The search could not have found them.
- A PIC gate asserting that `-fPIC` appeared in the archive's flags rather than
  that the archive's objects were position-independent. It passed while the
  flag was absent from the one command that mattered.
- The same gate, rewritten to link a shared object — which passed again,
  because `-shared` accepts undefined symbols by default. `-Wl,--no-undefined`
  is what moved the discovery back to the build.
- An emitted-output A/B over four changed families that reached one of them.
  Byte-identity across code the comparison never exercised is not evidence.
- A compile through `packages/cli/dist/main.js` to test a change in `src`.
  The built compiler ran; the change was not in it. That check would have
  reported the same result with the fix present or absent.

**Defence.** State the property, then ask what would have to be true for the
check to fail. If nothing would, the check is decoration. Falsify: break the
thing deliberately and watch the check go red. Every fix in this repository
that matters was falsified this way, and two of the five above were caught
only by doing it.

## 2. Two complete lists whose intersection is uninhabited

The subtlest, because every list is genuinely complete and every audit of a
list passes.

- Nine exact-integer identity bindings covered sub-word results. Two error-out
  bindings covered failure slots. The LLVM backend emitted invalid IR for a
  sub-word result *with* a failure slot, because the `select` that binds a call
  into a temporary exists only when `afterCall` is non-empty, and only the
  failure slot makes it non-empty. Neither list was missing an entry. Their
  product had no inhabitant.
- Handle payloads were reachable on the queued delivery path. Synchronous
  delivery was reachable with exact scalars. A synchronous handler holding an
  object was reachable from neither, and building it found three defects.

**Defence.** Coverage is a claim about a product, not a sum. When two
independently-varying axes exist, ask what inhabits the corner — and if
nothing does, that is the fixture to write rather than a gap to note.

## 3. A restatement in a layer no lower fixture can reach

Four instances of one contract, in three files, each found in the order a
program could reach it.

`validate.ts` restated the result-projection union twice and its arm whitelist
a third time; a `utf8Span` arm was added, one site widened, another not, and
the compiler accepted a binding then refused every call to it. Then
`packages/scriptc/src/native.ts` conflated "delivered during the caller's
frame" with "answers a boolean". Then the same function required every
synchronous parameter to be an exact scalar.

The last two were **unreachable from the compiler's own fixtures**, because
only a JVM manifest routes a synchronous void or handle contract through that
translation. A guardrail test written against the compiler's validator guarded
the compiler's validator and nothing else.

**Defence.** Derive the loosened view from the published type rather than
restating it — `Untrusted<T>` does this, and an arm added upstream then
appears at every site with no edit. Where a translation layer sits above a
compiler, its fixtures are not the compiler's, and a contract change needs a
program in the layer that actually routes it.

## 4. One backend correct because the other cannot express the mistake

The rarest and the most instructive, found last.

The C trampoline's bail was emitted as `if (cond) ${bail}`, and the bail grew
from one statement to two. C binds only the first to the `if`, so the return
became unconditional and the trampoline returned before reaching the handler.
It typechecked, emitted, linked, and ran; the process exited early with the
wrong status.

The LLVM backend passed throughout, and not by luck: its bail is
block-structured, so the mistake has no spelling there. A C/LLVM differential
would have shown a difference — but the differential was not what ran; the
suites were, and the C suite had no program exercising that path.

**Defence.** Where two backends have different structural affordances, one
being green says nothing about the other. Behaviour has to be asserted per
backend by a program that runs, not by emission that compiles.

## 5. The instrument reads its own answer

Found 2026-08-22, and it is the purest form in this record: the check's
evidence source includes the thing under test, so the claim proves itself.

- A check asserting that every fork-owned test file is named by some lane. It
  searched `package.json` and every script those scripts delegate to — and the
  list of claims lived INSIDE one of those scripts. A deliberately false entry
  ("this file is covered by `scriptc:test:imaginary`") passed, because the
  claim's own text was the evidence that satisfied it.

The fix was not a better search. It was moving the claims to a module no lane
reads, so a claim has to be backed by a lane's own text rather than by itself.

**Defence.** Name the check's evidence source out loud and ask whether the
subject can influence it. Falsification catches this one reliably — a
self-satisfying check passes every deliberate break, which is a very loud
signal once you look for it — and nothing else does, because the check is
correct about everything except where it is looking.

## 6. A guard whose precondition another component prevents

Found 2026-08-22. The guard is well-formed, its condition is exactly right for
the situation it names, and a neighbouring component ensures that situation
never arises on the path that matters. Distinct from mechanism 2: nothing here
is a coverage gap, and no fixture would have found it — the guard is production
code and its trigger is uninhabited by construction.

- `NTS6006` refused a selection that omitted a superclass, its message
  promising that otherwise "the projected class would lose its ancestry
  silently". It fired only when the superclass was PRESENT among the provided
  sources but unselected. The Android extractor pulls from `android.jar`
  exactly the classes a selection names, so an omitted ancestor was never
  present-but-unselected — it was absent, and the guard could not see it.
  Selecting `TextView` without `View` ingested cleanly with the superclass
  recorded as external, which is precisely the silent ancestry loss the
  diagnostic said was impossible.

The consequence was bounded — the program fails later at a call site with
"does not exist" on an inherited method — but it points at the method rather
than the ancestry, which is several confusing builds from the cause.

**Defence.** For each guard, ask what the rest of the system actually hands it,
and MEASURE that rather than reasoning about it. The finding here came from
running the extractor and reading what ingestion received; no amount of reading
the guard would have produced it, because the guard is not wrong.

## A note on this record's own contents

Mechanism 1 already recorded that `-shared` accepts undefined symbols by
default and that `-Wl,--no-undefined` is what moves the discovery back to the
build. On 2026-08-22 that exact defect was rediscovered on Android, from
scratch, by shipping a library whose every artifact assertion passed and which
could not load because `fmod` was undefined. The lesson was written down, was
true, and was not consulted.

That is worth recording in the record itself: a finding nobody reads has the
same value as a check that cannot fail. Whatever else this document is for, it
is not a substitute for a lane.

## What this changes

Nothing normative. It is an argument about how to read a green suite, and its
practical consequences are already in the working documents:

- [Development](../development.md) — read the pass count, not the exit code;
  suites skip cleanly when a dependency is absent.
- [Open work](../open-work.md) — the legalizer's method section records the
  emitted-output A/B and why the first one was worthless.
- [0004](0004-one-decision-two-backends.md) — the exhaustiveness guards catch a
  missing arm of a shared TYPE and cannot see a decision that was never given
  one. Three vocabularies had no guard at all until this date.

## Removal or revisit condition

None. This is a description of how verification fails, not a state to be
discharged. It was revised when a fifth and sixth mechanism were found, one day
later, which is the rate this predicted. Expect a seventh.
