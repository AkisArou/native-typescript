# 0011 — What an outside audit found, and what it could not see

Status: accepted findings, implementation ordered below
Last revised: 2026-08-20

An external architecture audit reviewed the parent at `99c4b984`, the public
ScriptC fork branch, the Target SPI, the SCABI model, the artifact executor,
and both target pipelines. This record states which findings are accepted,
which are modified, which are declined, and — because it matters for reading
the audit — which rest on information the reviewer could not obtain.

It is not normative. [Architecture](../architecture.md) and
[Target SPI](../target-spi.md) are the documents it changes.

## What the audit could not see, and what that cost it

The review was static and worked from public GitHub state. The fork's public
`native-typescript` branch is **41 commits behind this machine**, and the
parent's gitlink names a commit inside those 41.

Three findings follow from that gap rather than from the architecture:

- **"The pinned object is unreachable, consistent with a force-push or
  history rewrite."** Nothing was rewritten. The commits were never pushed.
- **"The current branch tip does not expose `native-manifest.d.ts`."** It
  exists; the reviewed tip predates it.
- **"The parent-side import must move atomically with the compiler
  revision."** That work is unnecessary — the import already matches.

The RISK the first finding names is real and is accepted below. A fresh
recursive clone fails today. But the cause is unpushed work, and the remedy is
a push, not a repair. The distinction matters because the audit's recommended
remediation — repin, rewrite the import, and re-derive the contract — would
have been a day of work against a problem that does not exist.

The lesson generalizes past this audit and is the same one
[0010](0010-an-exit-code-hint-is-not-a-status.md) records from the other
direction: **an observer reports what it can observe.** A reviewer reading a
stale branch and a suite linking archives into executables are the same
failure — a confident conclusion drawn from a vantage point that could not
have seen the disconfirming fact. Neither is careless. Both are why a claim
should name the vantage point it was made from.

## Accepted without modification

**The lowering provider's name is a trap.** `NativeLoweringProvider` is
today `ProviderDefinition<"native-lowering">` — data, no behavior. The audit's
point is that the NAME will attract an implementation that receives Native IR
and returns C/LLVM contributions, which is a per-platform mini-backend and
precisely the drift [0004](0004-one-decision-two-backends.md) already measured
five real defects from. Narrowing it while it has no implementation is nearly
free; after a second ABI family it is not. This is the audit's most valuable
structural catch and the one with the shortest window.

**Directory artifact digests omit file modes.** `digestDirectory` hashes
entry type, path, byte length, and bytes. Changing a nested file from `0755`
to `0644` does not change the digest, so the cache can return a directory
whose executable is no longer executable. This is a correctness defect, not a
hardening item, and it is reachable now that a target stages a shared object
and class directories.

**Actions have no timeout, output bound, or cancellation.** A wedged tool
blocks forever and a noisy one accumulates unbounded strings in the build
process.

**The declared target architecture and the executed one disagree.**
`planTarget` requires every runtime provider to advertise both
`runtime-owner-executor/v1` and `foreign-callback-ingress/v1`. The JVM runtime
provider advertises owner execution and retained callbacks. It therefore
cannot pass its own planner, which is why the JVM build calls
`nativeRuntimeServices` directly instead. A validator no pipeline runs is not
a validator.

**A variable triple over fixed ABI facts.** The JVM project accepts an
arbitrary `target.triple` while the build hardcodes `x86_64`, `elf`,
`glibc-2.17`, and `sysv-amd64`. Being Linux/x86-64 only is fine; ACCEPTING a
triple that is then ignored is not. This is the same defect class as the PIC
contract that was stated in three places before `compileLibArchive` passed the
flag: a promise the code does not keep is worse than an absent promise,
because it stops the reader from checking.

## Accepted with modification

**One vocabulary, one owner — plus a handshake.** [0006](0006-one-vocabulary-one-owner.md)
already owns this finding. What the audit adds is better than what 0006
planned: a protocol version exchanged at load, and a `build-info.json` in the
compiler distribution recording source commit, contract versions, and runtime
ABI. The current loader checks only that two functions exist, so a stale
`dist` passes and fails later with a structurally incompatible plan. That
exact failure was hit during the library-planner work, by a consumer whose
build had not been rebuilt after a repin. The handshake is adopted; the
package split it proposes is deferred to the same sequencing 0006 already sets.

**Foreign callback ingress becomes reachability-driven.** The audit offers
two coherent fixes and prefers making ingress conditional. So do we, for a
reason the audit does not state: a capability required of every runtime
regardless of what the program reaches is not a capability, it is a constant.
`runtime-owner-executor/v1` is genuinely universal — every runtime has an
owner. Ingress is a property of what the selected bindings can DO, and a
runtime whose boundary cannot deliver a foreign-thread call should not have to
claim it can.

**Target identity splits, but not yet into three published types.** The
distinction between execution platform, ABI target, and application
environment is right, and the architecture already describes application
profiles. The immediate change is smaller and is the one that stops a wrong
build: refuse an unsupported triple where it is accepted. The three-identity
refactor follows the target-planning work rather than preceding it.

## Declined for now, with reasons

**`BoundaryMaterializer` returning `MaterializedCallTarget`.** The proposed
interface — reachable operations plus evidence in, typed call targets and
declared artifacts out — is very close to what SCABI already is. SCABI is
evidence-backed typed call targets with package identity and provenance. A
second mechanism beside it needs to justify itself against the first, and the
audit does not compare them. The NARROWING of the lowering provider is adopted;
the replacement interface waits until a second ABI family shows what SCABI
cannot express.

**Package splitting, execution-backend abstraction, remote execution,
capsule manifests.** All are sound at the scale they describe. None is
justified at one execution platform and zero capsules. The audit itself marks
most of these as non-urgent.

**Objective-C, COM, and the resource-domain work.** The audit's performance
findings are grounded in this project's own falsifier numbers and are
correct — JNI local/stable/weak domains are the largest demonstrated win. They
are also compiler-contract changes, and the audit's own ordering puts them
after vocabulary consolidation. That ordering is kept.

## Order

1. Push the fork branch and repin from a reachable commit. Nothing else in
   this list is verifiable by anyone else until this is done.
2. Narrow the lowering provider's role and name.
3. Directory digests carry modes.
4. Make ingress reachability-driven; refuse unsupported triples.
5. Executor timeouts, output bounds, cancellation.
6. Protocol handshake and distribution build stamp.
7. Length-delimited string projections — admitted by a committed failing
   program, the embedded-NUL refusal, per the standing admission rule.
8. Target planning and staged pipelines, then the three-identity split.
