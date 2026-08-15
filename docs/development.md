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

Artifact execution accepts an explicit reusable local cache binding:

```ts
await executeArtifactGraph(graph, {
  // ...source, tool, sandbox, and build-root bindings...
  cache: { kind: "local", path: absoluteCachePath },
});
```

Each build root must be new; the cache root is intentionally reused. Cache hits
are content-verified and do not require the declared tool to be installed. An
invalid or corrupt cache entry fails loudly so it cannot silently replace a
trusted build result.

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
also exercises a receiver-borrowed nullable C-string result, including copying
before a temporary handle is released, and translates the synchronous
call-scoped exact-scalar callback and its
trailing context parameter, plus exact integer `errno` and nullable owned-handle
failures. A three-level native-handle hierarchy verifies that a derived value
reaches a base-typed native call through the same managed cell. Exact
integer-backed native boolean parameters and results verify exact false/true
projection, rejection of undeclared result representations, and exception
propagation across a helper call. A declaration-backed exact constant verifies
that SCABI translation and ScriptC substitution agree without adding a link
symbol. The gate resolves their TypeScript declaration symbols
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
node --test tests/c-bindgen.test.ts tests/gtk-bindgen.test.ts tests/gobject-adapter.test.ts tests/gtk-scabi.test.ts
node --test tests/gir.test.ts
node --test tests/gtk-runtime.test.ts tests/gtk-app.test.ts
```

The C binding tests compile one canonical selected-ABI probe, derive an
authoritative padded-record layout, reject deliberate function, field, and enum
mismatches, and reconcile the real `Gtk.Button`/`Gtk.Window` direct-call surface,
the selected `Gtk.Requisition` layout and calling classification, the generated
nested `WidgetPreferredSize` result, and `GtkOrientation` storage/member
identities against Clang. A cross-target fixture pins direct register expansion on x86-64 SysV,
the AArch64 homogeneous aggregate form, Windows hidden return/indirect input,
and SysV `sret`/`byval`. The SCABI test turns the verified selection and exact
GObject adapter into canonical declarations and a validated manifest, and pins
the immutable evidence-normalization and cacheable binding-package action
contracts, while rejecting tampered provenance and unsupported reached
metadata. The GIR test
validates the compact selected-metadata
contract and, when the system file exists, parses the real `Gtk-4.0.gir`
`Gtk.Button` surface. The runtime test compiles the GLib adapter in plain,
ASan/UBSan, and TSan modes.
The application test builds the ScriptC compiler and the self-contained GTK
host generator tool. Its analysis graph makes sandboxed Clang evidence feed a
deterministic normalization action, then makes that canonical evidence feed the
cacheable action that regenerates selected Widget, Button, and Window
declarations, SCABI, GObject adapters, and a zero-payload signal adapter with a
shared `SignalConnection` ABI as one package directory. The same generated
surface now includes `DrawingArea.resize` with copied exact scalar payloads and
canonical multiword-class ABI names. A second build root
proves that unchanged
package generation is restored from the local cache. The generated surface also
contains the Clang-proven nominal `Orientation` enum and `Box`; the app constructs
`Box(Orientation.Vertical, spacing)` and appends the overlay through both
backends without a runtime enum namespace or native constant symbol. It also
constructs `EventControllerScroll` from the Clang-proven `BothAxes` flags
representation by combining `Vertical | Horizontal` at its native width, then
round-trips and exactly compares its nominal `flags` property. The next planning phase composes
that verified package with the canonical GTK runtime fixture and plans C and
LLVM programs. It snapshots ScriptC's built emitter
and path-free compilation plan as host inputs, emits each program through a
deterministic sandboxed graph action, captures ScriptC's exact native driver
request through its side-effect-free external-build planner, resolves compile
inputs and the system-library closure from `pkg-config`, and materializes the
runtime, wrapper, generated GObject adapter, and final executable through the
same graph. It then proves
`Window.setChild(button)` through generated handle ancestry, projects
both representations through `Widget.setVisible(boolean)`, lowers
`Widget.activate()` from exact `gboolean`, passes branded `gint` dimensions to
`Window.setDefaultSize()`, feeds `Widget.getWidth()` into another native call,
round-trips branded `gdouble` through the `Widget.opacity` property, and
delivers `Button.clicked` through a generated result-owned retained callback.
It also compiles `DrawingArea.resize(sender, width, height)` through both
backends and feeds the copied `gint` values back into generated GTK calls.
It runs both backends against a real GTK/Xvfb event loop. It skips only when the
required Linux x64, GTK 4, Clang, Bubblewrap, GIR, or Xvfb inputs are
unavailable.

Run the workspace checks:

```bash
pnpm build
pnpm test
```

When the scriptc submodule changes, also run the fork's build and relevant
conformance suites. Documentation-only architecture changes should be checked
for broken relative links and conflicting normative terms.
