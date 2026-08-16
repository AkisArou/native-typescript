# Working in this repository

Read this before changing anything. The normative rules live in `docs/`; this
file records how to work within them.

## Orientation

- [`docs/architecture.md`](docs/architecture.md) owns system invariants. When
  documents conflict, it wins, and **the conflict is resolved in the documents
  before implementation proceeds**.
- [`docs/status.md`](docs/status.md) is the only place that records what is
  currently built. Specifications stay normative; do not add progress prose to
  them.
- [`docs/roadmap.md`](docs/roadmap.md) owns sequencing and exit gates.

## Verify with the full suite

From a fresh clone:

```bash
git submodule update --init --recursive
pnpm install
pnpm scriptc:install
pnpm build
pnpm test
```

`pnpm test` is the real gate. It shells out to Clang, runs actions inside a
Bubblewrap sandbox, and compiles several TypeScript GTK applications through
**both** the C and LLVM backends into native executables that open real
windows. Roughly 80 seconds with a warm action cache, longer cold. Run it
before every commit; a green subset is not evidence.

The pinned compiler is built by the gates that need it, not by `pnpm build`, so
nothing in the workspace may import its `dist` by path — that would make a
clean checkout fail to typecheck before anything has been built. Reach it
through `loadScriptCExecutablePlanners()` instead.

Host requirements: `clang`, `pkg-config`, `bwrap`, `xvfb-run`, GTK 4, and the
GObject-introspection GIRs in `/usr/share/gir-1.0`. Tests skip cleanly when a
dependency is missing, so check the pass count rather than the exit code alone.

## Rules that are easy to violate

**Fix the owning boundary, not the caller.** If a target reveals a missing
general primitive, it belongs in the compiler, runtime, or binding family — not
patched into the target. GIR machinery lives in `bindgen-gir` precisely because
it is not GTK-specific.

**Unsupported behavior fails precisely.** Never emit a partial projection, a
silent truncation, or a stub. If metadata is outside the implemented algebra,
produce a stable diagnostic. A silently dropped reference is a bug even when
the output still compiles.

**Evidence over inference for ABI facts.** Layout, calling convention, enum
storage, and signedness come from a Clang probe against the real headers. Do
not derive them from GIR, from a size heuristic, or from a type's spelling.

**Pre-1.0 refactors are atomic.** Update every producer and consumer in the
same change, delete the replaced path and its tests, and bump the schema so
incompatible caches are invalidated. No deprecated aliases, no dual readers, no
compatibility shims. Git history is the archive.

**Physical paths never enter a plan.** Artifact definitions carry logical IDs
and content digests; the executor supplies paths. A workspace or SDK location
appearing in a serialized graph is a defect.

## Code style

- Named functions use `function name() {}` declarations, nested helpers
  included. Arrows are for inline callbacks (`.map(...)`, `.filter(...)`,
  thunks).
- Relative imports carry the `.ts` extension; type-only imports use
  `import type`. Source must be erasable TypeScript — Node runs it directly
  through type stripping.
- Plans and snapshots are deeply frozen and canonically ordered. Anything that
  feeds a cache key must be deterministic.
- Comments explain *why* a constraint exists, not what the line does.

## Committing

Commit messages explain the problem and the reasoning, not just the change.
State what was wrong, why the chosen boundary is the right one, and what a
reader would otherwise have to rediscover. Note schema bumps and their
invalidation consequences.

Work happens directly on `main`.
