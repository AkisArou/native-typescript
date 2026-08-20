# Target Service Provider Interface

Status: normative; capability and composition API implemented  
Last revised: 2026-08-15

The Target SPI lets platforms participate in compilation without embedding
their logic throughout scriptc. It is a set of narrow provider contracts, not a
single plugin with access to compiler internals.

## Design requirements

- Providers are resolved before compilation and frozen into an immutable plan.
- Provider output is deterministic for declared inputs.
- All exchanged values are serializable data unless an interface explicitly
  supplies a restricted service object.
- Providers return diagnostics and artifact descriptions; they do not terminate
  the process or write arbitrary output files.
- The core compiler validates every Native IR operation independently of a
  target.
- A provider cannot introduce opaque language or Native IR semantics.
- Tool execution occurs through the build executor and is captured in the
  artifact graph.
- Capability/version mismatch fails before source lowering.

## Target composition

Conceptually, a target definition contains:

```ts
interface TargetDefinition {
  readonly descriptor: TargetDescriptor;
  readonly moduleResolvers: readonly ModuleResolver[];
  readonly bindingProviders: readonly BindingProvider[];
  readonly foreignBoundary: ForeignBoundaryProvider;
  readonly runtime: RuntimeProvider;
  readonly artifactProviders: readonly ArtifactProvider[];
  readonly packager: Packager;
}
```

This shape documents ownership. The implemented API may use functions and
opaque validated constructors rather than directly exposing these interfaces.

Every provider is serializable data with no behavior, and the boundary
provider is named for what it DECLARES rather than for a step it performs. It
names the ABI family this target's foreign boundary uses and what that
boundary requires of the runtime; it does not lower anything. An earlier name,
`NativeLoweringProvider`, invited the opposite reading — a provider handed
Native IR that returns C or LLVM contributions. That is a per-platform
mini-backend, and [0004](records/0004-one-decision-two-backends.md) already
measured five real defects from one decision living in two emitters. Lowering
belongs to the compiler, once, for both backends; exact ABI mechanics belong
to generated artifacts whose interface, target, and digest are verified.

## Target descriptor

The descriptor identifies the target and its compatibility requirements:

```ts
interface TargetDescriptor {
  readonly id: string;
  readonly version: string;
  readonly triple: string;
  readonly pointerWidth: 32 | 64;
  readonly endianness: "little" | "big";
  readonly objectFormat: "elf" | "macho" | "coff" | "wasm";
  readonly requiredCompilerCapabilities: readonly string[];
  readonly supportedBindingFamilies: readonly string[];
}
```

The final descriptor also records minimum OS/API versions and target feature
flags.

It does not record a product kind. One target produces executables, static and
shared libraries, and eventually application bundles, so the product belongs to
the build request rather than to target identity. Modelling it here would
require a separate target definition per product for one triple. A target ID is stable and globally namespaced. Build configuration never
selects a target by importing arbitrary executable configuration from a
dependency.

## Application-environment profiles

An application-environment profile composes a usage environment onto one
already selected target. It may require public module roots, target
capabilities, runtime features, binding providers, transport adapters,
artifacts, and packager inputs. It may not replace the target descriptor,
native lowering, runtime owner, or ABI identity.

Conceptually:

```ts
interface ApplicationEnvironmentProfile {
  readonly id: string;
  readonly version: string;
  readonly requiredTargetCapabilities: readonly string[];
  readonly requiredRuntimeFeatures: readonly string[];
  readonly moduleRoots: readonly string[];
  readonly artifactContributions: readonly ArtifactId[];
}
```

The concrete API may represent contributions through existing provider results
rather than this exact interface. Profiles are resolved and frozen with target
planning; they cannot inspect compiler AST state or register providers after
resolution.

Terminal applications use a terminal environment profile over Linux, macOS, or
Windows. A user-facing preset may select both, but internal reports preserve the
OS target identity and the terminal profile identity separately.

## Module resolution

A `ModuleResolver` handles a declared namespace or condition, for example
`native:c`, `native:gtk`, `native:terminal`, or platform-selected package
exports.

Its output is one of:

- an ordinary source or declaration module;
- a binding module associated with a SCABI package;
- an explicit dynamic-realm module;
- a source-located refusal explaining target availability;
- no opinion, allowing the next resolver to run.

Resolution order is deterministic and duplicate ownership is an error. A
resolver may not read ambient process state that is absent from the build
environment description.

Platform suffixes and conditional exports are normalized by core resolution;
targets contribute conditions, not their own unrelated module graph.

## Binding provider

A `BindingProvider` turns platform metadata into a validated SCABI package or
locates a pre-generated package whose SDK fingerprint matches the build.

```ts
interface BindingRequest {
  readonly target: TargetDescriptor;
  readonly module: string;
  readonly requestedMembers: readonly string[];
  readonly sdk: SdkIdentity;
}

interface BindingResult {
  readonly manifestArtifact: ArtifactId;
  readonly declarationArtifact: ArtifactId;
  readonly adapterArtifacts: readonly ArtifactId[];
  readonly diagnostics: readonly Diagnostic[];
}
```

Binding discovery and reachability specialization are separate stages. A
provider may ingest a complete SDK, while the planner emits adapters only for
reachable bindings.

Bindings are declarative and validated under [Binding ABI](binding-abi.md).

## Native lowering provider

The lowering provider maps validated, generic Native IR to backend fragments
and declared artifacts.

It receives:

- frozen Native IR;
- resolved binding records;
- target ABI and SDK identity;
- a read-only layout/query service;
- source and binding provenance for diagnostics.

It returns:

- LLVM/C lowering contributions;
- generated adapter-source artifacts;
- required runtime features;
- link inputs and ordering constraints;
- diagnostics.

Native subclassing contributes validated override, host-construction, peer
attachment, and base-call operations through this closed Native IR boundary.
Generated Java, Objective-C++, Swift, or C++ methods are adapters, not opaque
compiler callbacks and not replacement source lifecycle APIs.

It must not:

- change language types or call-graph reachability;
- invent ownership or error policy absent from a binding;
- execute a linker or package manager directly;
- retain compiler AST or checker objects after the lowering call;
- emit untracked files;
- silently fall back to a different ABI.

The generic operation set is deliberately closed. If JNI and Objective-C need
different realization of `native.call`, they provide different lowerings. If a
platform needs a new semantic operation that the compiler must analyze, the
Native IR is extended first.

## Runtime provider

A `RuntimeProvider` describes how the target hosts ScriptC runtime instances and
maps abstract executors to platform schedulers.

It supplies:

- runtime library artifacts;
- owner-executor creation or attachment;
- scheduler wake integration;
- callback-gateway integration;
- thread-affinity mappings;
- process/application lifecycle hooks;
- error and trap sinks;
- shutdown hooks.

The runtime also supplies or selects one shared owner wait-set/event-source
contract when the target reaches timers, terminal input, sockets, pipes,
signals, child processes, filesystem watches, or another readiness source. An
application-environment profile may require event sources but may not install a
competing blocking loop.

The first concrete runtime-provider slice is the GLib main-context adapter in
`@native-typescript/target-gtk`; see [Implementation status](status.md) for
what it currently guarantees.

The provider must preserve the runtime rules in
[Runtime and threading](runtime-and-threading.md). It cannot opt a target into a
shared ScriptC heap or allow foreign-thread heap access.

For initial UI targets, the runtime owner executor is the platform UI executor.
A later target may place computation in another runtime instance, but it must
use explicit transport between instances.

## Artifact providers

Artifact providers contribute deterministic nodes such as:

- generated JNI registration sources;
- generated Java/Objective-C++/Swift/C++ native subclasses and exact base-call
  adapters;
- Objective-C++ protocol adapters;
- COM activation metadata;
- application manifests and permission fragments;
- resources and asset catalogs;
- generated capability schemas;
- pinned Unicode tables and reviewed terminal-profile/terminfo resources;
- debugging metadata.

Each artifact declares its content hash inputs, media/type identity, logical
purpose, and consumers. Generated source is not an untracked side effect.

## Packager

The packager converts a validated artifact graph into a final product using
declared tools.

```ts
interface PackagePlan {
  readonly product: "executable" | "library" | "application" | "sdk";
  readonly roots: readonly ArtifactId[];
  readonly steps: readonly ToolInvocation[];
  readonly outputs: readonly OutputDeclaration[];
}
```

The packager may invoke Clang, a linker, Gradle/D8, Xcode tools, Windows SDK
tools, or equivalent declared toolchains through the executor. It may not hide
network access, dependency installation, signing, or mutation outside declared
build/output directories.

Signing is an explicit non-cacheable or securely cache-scoped step. Unsigned
artifacts remain separately reproducible.

## Provider capabilities

Provider compatibility uses named capabilities rather than testing package
versions throughout the compiler. Examples include:

```text
native-ir/v1
scabi/v1
runtime-owner-executor/v1
retained-callback/v1
foreign-callback-ingress/v1
runtime-owner-wait-set/v1
native-subclass/v1
artifact-graph/v1
partition-interface/v1
```

Before 1.0, a capability changes atomically and old implementations are
removed. Once public compatibility is promised, capability versions permit
deliberate side-by-side protocol versions at the boundary, not scattered
feature checks.

Capability IDs use the normalized form `name/vN` and match exactly. Compiler
requirements and provider requirements are separate so a provider cannot
accidentally satisfy a compiler contract. Planning rejects malformed or
duplicate declarations, missing requirements, duplicate provider identities,
and provider placement under the wrong role.

Every selected runtime provider must advertise both
`runtime-owner-executor/v1` and `foreign-callback-ingress/v1`. These are
architectural requirements, even before a target uses retained callbacks.

## Lifecycle

Target planning follows this order:

1. Resolve the target descriptor, application-environment profiles, and
   provider set.
2. Validate compiler/provider capabilities.
3. Snapshot toolchain and SDK identities.
4. Resolve the complete source and binding graph.
5. Validate SCABI manifests.
6. Lower source to language IR.
7. Compute reachability, effects, ownership, and partitions.
8. Lower to Native IR.
9. Ask providers for lowering and artifact descriptions.
10. Validate the complete artifact graph.
11. Execute cache misses.
12. Package, sign if requested, and produce reports.

Provider registration is closed after step 1.

The implemented `planTarget` operation performs the target/provider portion of
step 1 and capability validation as a pure planning operation. It snapshots and
freezes the compiler descriptor, target definition, ordered provider set, and
resolved capability sources. Application-environment profile input remains a
planned extension of that same immutable operation; no separate mutable
registry is introduced. Later phases consume the frozen result rather than
re-reading mutable registration state.

## Diagnostics

Providers return structured diagnostics with:

- stable code;
- severity;
- source location or binding-provenance location;
- target and provider identity;
- explanation;
- remediation when one is known.

Raw native tool output is attached to a build step, not substituted for a
source-level diagnostic when the provider can map it to a binding or source
operation.

## Test contract

Every target must pass common suites for:

- descriptor and capability validation;
- deterministic resolution;
- SCABI validation failures;
- exact scalar and layout lowering;
- ownership transitions;
- callback lifecycle and shutdown;
- artifact graph determinism;
- clean rebuild equivalence;
- unsupported-operation diagnostics.

Target-specific suites add ABI, scheduler, lifecycle, and packaging tests.
