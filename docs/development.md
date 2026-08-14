# Development

## Architecture first

The documents linked from the repository README are normative. Implementation
changes must name the contract they implement or update that contract in the
same change. If a target reveals a missing general primitive, fix the owning
compiler/runtime boundary before adding target-specific behavior.

Before 1.0, refactors are atomic migrations:

- update all in-repository producers and consumers;
- delete the replaced code path and its obsolete tests;
- invalidate incompatible caches and schemas;
- do not add deprecated aliases, dual readers, or legacy feature flags.

Git history preserves the old design. The active tree should express only the
current one.

## Prerequisites

The repository pins Node.js in `.tool-versions` and pnpm in `package.json`.
Enable Corepack once for the selected Node installation, then initialize the
workspace:

```bash
corepack enable pnpm
git submodule update --init --recursive
pnpm install --frozen-lockfile
```

The parent pnpm workspace intentionally excludes `third_party/scriptc`.
Install its dependencies separately:

```bash
pnpm scriptc:install
```

## Workspace commands

```bash
pnpm build
pnpm test
pnpm native-typescript --help
pnpm native-typescript doctor
```

Node runs the workspace's `.ts` source directly through built-in type
stripping. During development, run execution and type checking in separate
terminals:

```bash
pnpm dev
pnpm build:watch
```

Source executed by Node must use erasable TypeScript syntax. Use explicit
`.ts` extensions for relative imports and `import type` for type-only imports.

## Updating scriptc

The fork keeps `main` as an unmodified mirror of `vercel-labs/scriptc`. Project
changes live on `native-typescript`, which is the branch pinned by the
submodule.

Configure the upstream remote once per submodule clone:

```bash
git -C third_party/scriptc remote add upstream https://github.com/vercel-labs/scriptc.git
```

To incorporate upstream work:

```bash
git -C third_party/scriptc fetch upstream main
git -C third_party/scriptc push origin upstream/main:main
git -C third_party/scriptc switch native-typescript
git -C third_party/scriptc merge upstream/main
pnpm scriptc:install
pnpm scriptc:build
pnpm scriptc:test
git -C third_party/scriptc push origin native-typescript
git add third_party/scriptc
```

Resolve merge conflicts inside the submodule before running validation. The
parent repository records an exact scriptc commit, so commit and push the
updated gitlink only after the fork branch is validated and pushed.

## Changing scriptc

Do not assume that a documented scriptc limitation is permanent. Classify it
using [scriptc evolution](scriptc-evolution.md), reduce it to a conformance
fixture, and decide whether the behavior belongs in the language IR, Native IR,
runtime, target provider, adapter, or framework.

Generally reusable compiler/runtime work belongs in the fork. Platform binding,
adapter, orchestration, and packaging work belongs in this repository. Fork
commits should remain focused and independently testable so they can be proposed
upstream or replaced cleanly by later upstream work.

## Validation before commit

The focused cross-repository Native IR/SCABI gate translates the fixture's
reached fixed- and pointer-width integer bindings, padded by-value struct,
borrowed UTF-8 and `Uint8Array`/Buffer input, and owned opaque handle. It
also translates the synchronous call-scoped exact-scalar callback and its
trailing context parameter, plus exact integer `errno` and nullable owned-handle
failures. It resolves their TypeScript declaration symbols
and links the resulting source-lowered programs against the permanent C fixture
through both ScriptC backends:

```sh
pnpm scriptc:test:native-ir
SCRIPTC_SAN=1 pnpm scriptc:test:native-ir
```

Run it whenever Native IR, SCABI scalar, aggregate, marshalling, handle,
callback, or error bindings, either backend, or the fixture's C implementation
changes. The sanitizer form compiles both the ScriptC runtime and fixture with
AddressSanitizer and enables the runtime reference-count audit.

The retained-callback foundation has a separate threaded queue/lifecycle gate:

```sh
pnpm scriptc:test:owner-gateway
pnpm scriptc:test:callback-token
pnpm scriptc:test:callback-table
pnpm scriptc:test:callback-handle
```

The gateway command builds and runs its runtime fixture both normally and with
AddressSanitizer/UndefinedBehaviorSanitizer. Run it whenever gateway admission,
waking, drain ordering, lifecycle, or event ownership changes. The token gate
adds concurrent close/admission coverage and exact invocation-lease accounting;
on Linux it also runs under ThreadSanitizer.

The table gate verifies explicit anchor rooting, closing-entry delivery,
generation-safe slot reuse, reentrant unlink-before-release teardown, and exact
release after cancellation plus the final lease. It runs under the same three
sanitizer modes as the token gate.

The handle gate verifies the result-owned cancellation order, rejection of a
callback attempted by the foreign destructor, delivery of an earlier lease,
and alias-safe repeated disposal. Native-handle runtime changes must also pass
the fork's full `tests/harness/native-ir.test.ts` suite for both backends.

The GTK owner-loop and native-application gates are:

```sh
node --test tests/gtk-runtime.test.ts tests/gtk-app.test.ts
```

The first test compiles the GLib adapter in plain, ASan/UBSan, and TSan modes.
The second builds the ScriptC compiler, translates the canonical GTK fixture
manifest, compiles its adapter objects, emits C and LLVM executables, and runs
both against a real GTK/Xvfb event loop. It skips only when Linux x64, GTK 4, or
Xvfb is unavailable.

Run the workspace checks:

```bash
pnpm build
pnpm test
```

When the scriptc submodule changes, also run the fork's build and relevant
conformance suites. Documentation-only architecture changes should be checked
for broken relative links and conflicting normative terms.
