# SCABI C v1 fixture

This is the permanent acceptance fixture for the first Native TypeScript C ABI
contract. It is intentionally small, but every case remains in the suite as
compiler and runtime support grows.

- `package.d.ts` defines the source-facing declaration contract.
- `package.scabi.json` is the canonical, content-addressable SCABI manifest.
- `include/nts_scabi_fixture.h` is the authoritative native ABI declaration.
- `src/nts_scabi_fixture.c` implements imported native operations.
- `src/layout_probe.c` asks the host C compiler for aggregate layout.
- `src/fixture_test.c` exercises native behavior, ownership, errors, synchronous
  callbacks, retained callbacks, and foreign-thread callback delivery.

Workspace tests validate schema and semantic invariants, check declaration and
header provenance digests, compare aggregate layout with the C compiler, and
compile/run the fixture with strict C11 diagnostics.

The cross-repository ScriptC gate translates and executes the fixture through
both C and LLVM. It covers exact scalars and native boolean results, direct,
indirect, and nested nominal aggregate ABI passing, borrowed strings and bytes, a three-level identity handle
hierarchy, synchronous callbacks, retained same/foreign-thread callbacks,
native errors, and exact destruction under ordinary and sanitizer/reference-
count lanes.

It also covers the shapes a framework boundary needs, which are here because
that gate is the only place this manifest's translation is COMPILED AND RUN
rather than merely validated: a handler that receives an object while running
inside the caller's frame, both telling (`tellWith`) and answering
(`judgeWith`); a registration nothing owns and nothing can cancel
(`noticeWith`); the same registration where the payload may be WITHHELD, so
the handler receives `Counter | null` and tests it (`maybeWith`); UTF-8 whose
length arrives beside the pointer and whose text contains a NUL; and a failure
slot under a sub-word result in both signednesses.

The exported `nts_ts_add_i32` symbol is deliberately declared but not
implemented here. It becomes the first TypeScript-to-C export produced by the
ScriptC Native IR slice.

See [Binding ABI](../../docs/binding-abi.md) for the normative contract.
