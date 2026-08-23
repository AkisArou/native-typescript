# Chromium feasibility package

Status: migrated research specimen; not an implemented target provider

This package is the Native TypeScript home for the direct-Blink feasibility
work originally developed in the temporary `electron-like` repository. It
preserves executable evidence and the pinned Chromium seam without promoting
prototype contracts into the product architecture.

Chromium is an application environment and product host over an ordinary OS/ABI
target. It does not define a new target triple, object format, or compiler
backend.

## What is here

- `chromium/revision.json` pins the investigated Chromium commit.
- `chromium/patches/` contains three repaired research patches.
- `chromium/overlay/` contains the handwritten direct-Blink bridge specimen.
- `prototype/` contains the experimental C ABI, portable slot table, C
  counter, create-element probe, and standalone tests.
- `scripts/` can verify the patches, scan the bridge, or apply the specimen
  to an explicitly supplied clean checkout.
- `src/` validates the committed Chromium revision metadata for later build
  planning.

The package intentionally does not export a `TargetDefinition`. A real
Chromium application profile must preserve the selected Linux, macOS, or
Windows ABI target and compose Chromium-specific artifacts above it.

## Evidence boundary

The repository's normal tests prove:

- the experimental handle table's generation and invalidation behavior;
- the plain-C counter callback/cleanup contract against a fake Web backend;
- compilation of the create-element/DOMException probe;
- absence of forbidden V8/source-evaluation carriers in the handwritten bridge;
- syntactic integrity of the complete patch series;
- validation of the pinned revision and WebIDL provenance input.

The networked patch verifier additionally proves that all three patches apply
to the exact pinned Chromium sources.

No full Chromium GN/Ninja build or rendered interactive counter run has yet
been recorded. The C++ bridge, product host, sandbox placement, real click
delivery, and teardown behavior therefore remain unproven.

## Deliberate prototype boundaries

The following are migration oracles, not permanent contracts:

- `NtsWebHandle`, `NtsHandleTable`, and `NtsWebSubscription`;
- the target-specific result and exception structs;
- UTF-8 as the carrier for every WebIDL string;
- handwritten DOM member wrappers;
- the hard-coded callback token and singleton counter state;
- the counter-specific `content_shell` host patch;
- in-place patching of a disposable Chromium checkout.

The current handle value contains only slot and generation. Two independent
realms can therefore issue colliding values, so the prototype cannot enforce
its declared wrong-realm status. Product work must add realm-wide invalidation
to ScriptC's existing native-handle ownership rather than bless this parallel
table as the managed representation.

The public prototype header was narrowed during migration to operations the
Blink overlay actually defines. The spike had also declared `window`,
`Node.remove`, and `Element.setAttribute` without implementations.

## Product binding boundary

The durable generation flow is:

```text
pinned Blink WebIDL database
        |
        v
bindgen-webidl normalization and call-plan analysis
        |
        +-- TypeScript declarations
        +-- SCABI manifest with Blink extensions
        +-- generated typed C ABI
        +-- generated Blink C++ capsules
        +-- coverage/refusal/provenance report
        |
        v
existing ScriptC declaration + SCABI + Native IR pipeline
```

The normalized WebIDL snapshot may be a deterministic bindgen artifact, but it
is not a second compiler-facing native vocabulary. ScriptC remains the single
owner of Native IR, handles, callback lifetime, exceptions, promises, and
owner-executor semantics.

## Focused commands

From the repository root:

```sh
cmake -S packages/target-chromium/prototype \
  -B /path/on/a-real-filesystem/nts-chromium-prototype
cmake --build /path/on/a-real-filesystem/nts-chromium-prototype
ctest --test-dir /path/on/a-real-filesystem/nts-chromium-prototype \
  --output-on-failure

node packages/target-chromium/scripts/check-no-v8-bridge.ts
```

The following lane downloads the exact patched Chromium input files and is
therefore intentionally not part of the network-free default test suite:

```sh
node packages/target-chromium/scripts/verify-chromium-patches.ts
```

Applying or building the overlay requires a full clean checkout at the pinned
revision:

```sh
node packages/target-chromium/scripts/apply-chromium.ts /path/to/chromium/src
node packages/target-chromium/scripts/build-chromium-counter.ts \
  /path/to/chromium/src
```

Those helpers are research tools. The product build must express checkout
validation, patches, overlays, GN/Ninja tools, outputs, and provenance as
declared artifact-graph inputs and actions.

## Next gates

1. Compile the migrated overlay in the pinned Chromium GN graph.
2. Run the script-free C counter and record real click and teardown behavior.
3. Generate the first reached WebIDL surface into declarations, SCABI, and
   typed Blink capsules.
4. Replace the C oracle with compiled TypeScript through both ScriptC backends.
5. Reconcile Blink object roots with ScriptC handles and prove realm
   invalidation.
6. Prove DOMException conversion, event identity/cancellation, and
   promise/microtask ordering.
