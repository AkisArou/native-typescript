# Build Artifacts

Status: normative architecture  
Last revised: 2026-08-15

Native TypeScript models a build as a deterministic artifact graph. Compilation,
adapter generation, native tools, resources, packaging, and signing are visible
nodes rather than side effects hidden behind a target plugin.

## Planner and executor

The build has two phases.

### Planning

The planner:

- resolves configuration, target providers, toolchains, SDKs, modules, and
  bindings;
- creates immutable artifact and action nodes;
- computes dependency and cache-key inputs;
- validates ownership of output paths;
- rejects cycles, missing tools, incompatible capabilities, and conflicting
  artifacts;
- emits a reviewable plan without running platform tools.

### Execution

The executor:

- materializes cache hits;
- runs remaining actions in dependency order with bounded parallelism;
- provides declared inputs and isolated output directories;
- captures diagnostics, stdout/stderr, timing, and resource usage;
- streams standard output directly into a declared artifact when the action
  selects artifact capture instead of report capture;
- verifies declared outputs and their digests;
- never lets an action mutate source inputs or another action's outputs.

Targets contribute data to planning. They do not bypass the executor.

## Artifact identity

An artifact has:

- stable logical ID within the plan;
- kind and media type;
- producer action or immutable source identity;
- content digest when materialized;
- target/domain association;
- provenance;
- declared consumers;
- cache/export policy.

Artifact IDs are not filesystem paths. The executor chooses physical paths in a
build directory and supplies them to actions.

Source resolution preserves that boundary. `resolveSourceArtifact()` digests a
physical file or directory and returns its immutable graph definition together
with a separate executor source-path binding. The physical path is never a
field of the definition, so planners and serialized graphs cannot accidentally
make workspace or SDK locations part of the portable contract.

## Artifact kinds

Core kinds include:

- source module and declaration;
- language IR module or strongly connected component;
- whole-program analysis result;
- Native IR partition;
- LLVM bitcode, native object, and readable generated C;
- static/shared library;
- SCABI manifest and generated declarations;
- generated C, C++, Objective-C++, Java, Kotlin, Swift, or other adapter source;
- generated native subclasses, override/base-call tables, protocol/interface
  adapters, and application lifecycle registration;
- platform bytecode/object produced by authoritative tools;
- capability schema and generated transport adapter;
- resource, manifest fragment, permission declaration, and asset catalog;
- pinned Unicode property tables, terminal profiles, and optional embedded
  terminal capability databases;
- debug symbols, source map/line table, coverage report, and trace schema;
- executable, application bundle/package, SDK, and signing result.

The list evolves through versioned artifact capabilities. Unknown artifacts are
never treated as generic files with implicit behavior.

## Actions

An action declares:

- executable/tool identity;
- normalized arguments;
- environment allowlist;
- input artifacts;
- output declarations;
- whether standard output belongs in the action report or is itself one file
  output artifact;
- working-directory policy;
- network policy;
- target platform and execution platform;
- determinism and cacheability;
- sensitive inputs such as signing credentials;
- diagnostic parser identity.

Ambient environment variables, user home paths, current time, random values,
and undeclared SDK lookup cannot influence a cacheable action.

An artifact-captured standard output is not also passed to the command as an
output path. The executor creates it from the tool's byte stream, waits for the
file to close, and then applies ordinary output type, digest, cache, and
undeclared-output validation. This is the path for tools such as Clang whose
machine-readable metadata is emitted on standard output; shell redirection is
not part of an action contract.

## Toolchain and SDK identity

A build snapshots:

- scriptc and Native TypeScript revisions;
- TypeScript version and language-profile version;
- target provider versions/capabilities;
- SCABI schema and generator versions;
- compiler, linker, archiver, platform tool, and system image versions;
- target triple, minimum deployment version, and enabled ABI features;
- SDK/framework/header/metadata digests;
- optimization, sanitizer, debug, and dynamic-realm modes.

The snapshot is part of the report and relevant cache keys. A target must not
silently use whichever SDK happens to be first on the host search path.

## Cache keys

An action key hashes:

- action implementation/version;
- normalized tool identity and arguments;
- content digests of declared inputs;
- semantic compiler options;
- target and SDK identities;
- environment values explicitly declared semantic;
- relevant schema/capability versions.

Paths are normalized to logical artifact IDs so moving a workspace does not
invalidate sound cache entries.

Cache lookup never weakens validation. Cached IR, SCABI, and analysis artifacts
are schema-checked when loaded.

The implemented local cache uses an explicit root and a versioned namespace.
Only deterministic actions whose complete output set opts into `local` or
`exportable` storage are eligible. The key covers the canonical action, declared
tool identity, staged input names and types, verified input digests and sizes,
and output names and types. A hit is copied into the new build root and rehashed
before use; captured stdout/stderr are restored from separately verified cache
blobs, and the tool binary is needed only on a miss. Corrupt layouts, manifests,
types, top-level modes, digests, or sizes fail rather than degrading to an
unreported miss.
Misses publish complete multi-output entries with an atomic directory rename,
so concurrent builds can race safely without observing partial data.

## Compilation granularity

Per-file native caching is not promised when whole-program semantics make it
unsound. Cache boundaries follow semantic dependencies.

The initial model may cache:

- parsed/typechecked source graph inputs;
- language IR by module when no specialization crosses the boundary;
- strongly connected IR components when modules share initialization or
  recursive specialization;
- whole-program reachability/effect results;
- Native IR by partition and specialization digest;
- generated adapters by reachable binding set;
- native objects by stable lowered ABI and optimization configuration;
- final links by ordered object/library digests.

If monomorphization or whole-program layout changes an object ABI, every
affected cache key includes the specialization/layout digest. The build does not
claim arbitrary per-module object reuse until a stable internal ABI exists.

## Generated code

Generated code is a first-class artifact with:

- generator and template revision;
- source metadata digest;
- reachable binding/capability IDs;
- deterministic formatting;
- a banner pointing to provenance;
- platform-language compiler inputs;
- ownership and regeneration rules.

Generated source is normally placed in the build tree and not committed. Golden
fixtures may be committed for review and testing.

The GTK analysis graph applies this rule directly. Two sandboxed target-Clang
actions compile the same content-addressed probe: one writes selected AST and
one writes LLVM calling-classification IR to raw metadata artifacts. Because
those formats contain non-semantic compiler detail, a dependent action reduces
them to canonical selected ABI evidence. Function types, selected record layout,
and physical calling classifications share one probe contract.
`planGirBindingAnalysis()` owns this composition and returns the complete
immutable target subgraph; callers supply source and tool bindings but do not
reconstruct its dependency edges. The binding-package action consumes that stable
evidence, the canonical selected-GIR snapshot, an immutable generation request,
and a content-addressed self-contained host generator. Its single
directory output contains declarations, SCABI, GObject adapter source/metadata,
and package provenance. That directory is the explicit phase boundary consumed
by later compiler planning and is cache-reused across distinct build roots. The
bundled generator is a build input only and is never linked or packaged into the
target application.

The native objects a target contributes to the application link follow the same
rule. `planGtkTargetObjects()` returns one immutable fragment containing the
target-owned GLib owner-runtime object and the generated GObject adapter
object, together with their artifact and action definitions. Artifact
identities, per-object dialect policy, and dependency edges belong to the
target package: the GLib runtime is portable C compiled under the strict
dialect, while the generated adapters reach GNU extensions through the GTK
headers. An application build supplies only the SDK compile arguments, tool
identity, and execution facts, so it cannot reconstruct those edges
inconsistently or diverge from the target's own compilation policy.

Adapters should be narrow and mechanical. Application behavior belongs in
TypeScript or a documented platform runtime component, not generated bespoke
logic that cannot be tested independently.

Native subclass adapters follow the same rule. Their keys include the exact
source class/override declarations, authoritative SDK metadata, target ABI,
runtime ABI, registration identity, and generated base-call operations. Android
manifest classes, Objective-C runtime registrations, Apple protocol adapters,
and Windows activation metadata are explicit consumers of those artifacts.

Terminal Unicode tables and embedded capability profiles name their upstream
version, normalized source digest, generator revision, licensing, and selected
width policy. The runtime terminal type is not a build input, but every table
used to interpret it is.

## Platform toolchains

Native TypeScript delegates authoritative transformations:

- Clang/LLVM or the selected compiler handles target object generation and ABI;
- system linkers create native images;
- Gradle/D8 and Android build tools create Android bytecode/packages;
- Xcode command-line tools compile Apple adapters, resources, and bundles;
- Windows SDK tools create Windows metadata/packages;
- platform resource compilers process their native formats.

The planner owns orchestration, inputs, outputs, diagnostics, and reproducibility.
It does not reimplement these tools solely to keep the pipeline in one process.

## Prebuilt SDKs

A prebuilt Native TypeScript SDK may contain:

- validated SCABI packages;
- target runtime libraries;
- generated adapter archives;
- framework/runtime archives such as a pinned React or Yoga build;
- pinned terminal profiles and Unicode data;
- compiler-compatible IR/native objects where their ABI is stable;
- headers, declarations, resources, and packaging support;
- provenance, SBOM, licenses, signatures, and vulnerability/update metadata.

Prebuilt artifacts are keyed by target, deployment range, compiler/runtime ABI,
SCABI version, provider version, and SDK identity. A near match is not accepted
silently.

SDK creation must review redistribution licenses for vendor headers, metadata,
frameworks, and platform components. The architecture does not assume every
platform SDK can be redistributed.

## Supply chain

Published artifacts require:

- content digests and signed provenance;
- source/generator revision;
- build environment and toolchain identity;
- SBOM and license inventory;
- reproducible unsigned content where platform tools permit it;
- a documented security-update and revocation path;
- separation of build provenance from user-specific signing.

Application reports identify every prebuilt component and dynamic engine.

## Packaging and signing

Packaging consumes declared root artifacts. It may add target metadata,
resources, entitlements, permissions, launch components, and platform-required
signatures.

Configuration merging is schema-aware. Text concatenation of manifests,
property lists, or permissions is not accepted. Conflicts identify both sources
and require an explicit resolution.

Signing credentials are never part of ordinary cache keys or persisted in build
reports. The unsigned package graph remains inspectable separately from the
signing action.

## Build modes

Development and release modes may change optimization, debug information,
instrumentation, and packaging, but not language semantics or ABI contracts.

Development mode favors:

- low optimization;
- rich ownership/callback checks;
- incremental link strategy;
- detailed generated-source retention;
- target-specific reload/restart support.

Release mode may enable:

- optimized LLVM output;
- dead-code and adapter elimination;
- ThinLTO where sound;
- symbol stripping with separate debug artifacts;
- capability minimization;
- resource optimization;
- production signing.

## Reports

Every build can emit a machine-readable and human-readable report containing:

- source and target identity;
- static/dynamic coverage;
- reached native bindings;
- ownership and callback requirements;
- domain and capability graph;
- generated adapters;
- toolchain and SDK snapshot;
- cache hits/misses with invalidation reasons;
- final artifact composition and sizes;
- permissions and signing status;
- warnings about unsafe operations or unverified compatibility.

## Cleaning and refactors

Generated artifacts live outside source roots. A clean operation removes only
declared build outputs and local caches.

Before 1.0, an incompatible IR, SCABI, provider, or artifact change creates a
new cache namespace and deletes old readers from the codebase. Stale cache data
may remain physically until normal eviction, but no compatibility path consumes
it.

## Conformance tests

The build suite includes:

- plan determinism across workspace paths;
- clean build equivalence;
- precise invalidation for source, declaration, target, SDK, and generator
  changes;
- rejection of undeclared outputs and environment inputs;
- generated adapter reproducibility;
- manifest/resource conflict diagnostics;
- cache corruption/schema rejection;
- parallel execution without output races;
- unsigned package reproducibility;
- provenance and SBOM completeness.

## Current implementation boundary

Recorded in [Implementation status](status.md). The rules above are normative
regardless of how much of them is built.