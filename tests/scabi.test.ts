import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  ScabiValidationError,
  canonicalizeJson,
  digestScabiManifest,
  parseScabiManifest,
  validateScabiManifest,
} from "@native-typescript/scabi";

const repositoryRoot = resolve(import.meta.dirname, "..");
const fixtureRoot = resolve(repositoryRoot, "fixtures/scabi-c-v1");
const manifestSource = readFileSync(
  resolve(fixtureRoot, "package.scabi.json"),
  "utf8",
);
const manifest = parseScabiManifest(manifestSource);

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function validationCodes(value: unknown): readonly string[] {
  const result = validateScabiManifest(value);
  assert.equal(result.ok, false);
  return result.diagnostics.map(({ code }) => code);
}

interface ExecutionResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function compileAndRun(
  sources: readonly string[],
  compilerOptions: readonly string[] = [],
): ExecutionResult {
  const buildDirectory = mkdtempSync(join(tmpdir(), "nts-scabi-c-v1-"));
  const executable = resolve(buildDirectory, "fixture");
  const compiler = process.env.CC ?? "cc";

  try {
    const compilation = spawnSync(
      compiler,
      [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pedantic",
        "-pthread",
        ...compilerOptions,
        `-I${resolve(fixtureRoot, "include")}`,
        ...sources.map((source) => resolve(fixtureRoot, "src", source)),
        "-o",
        executable,
      ],
      { encoding: "utf8" },
    );
    assert.equal(compilation.status, 0, compilation.stderr);

    const execution = spawnSync(executable, [], { encoding: "utf8" });
    return {
      status: execution.status,
      stdout: execution.stdout,
      stderr: execution.stderr,
    };
  } finally {
    rmSync(buildDirectory, { force: true, recursive: true });
  }
}

test("SCABI fixture is canonical, immutable, and content-addressable", () => {
  assert.equal(canonicalizeJson(manifest), manifestSource);
  assert.equal(
    digestScabiManifest(manifest),
    "sha256:c6ca0249316ff439aef499c028a99390339072e5dcb147ac414ebb155f029e8a",
  );
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.bindings.subscription_create), true);
  assert.equal(Object.isFrozen(manifest.bindings.counter_label), true);
  assert.equal(Object.isFrozen(manifest.types.padded), true);
});

test("SCABI handle upcasts are explicit, canonical, and representation-safe", () => {
  const hierarchy = structuredClone(manifest);
  Object.assign(hierarchy.types, {
    base_handle: {
      kind: "handle" as const,
      nativeName: "BaseHandle",
      threadSafety: "confined" as const,
      identity: "pointer" as const,
      upcasts: [],
    },
    derived_handle: {
      kind: "handle" as const,
      nativeName: "DerivedHandle",
      threadSafety: "confined" as const,
      identity: "pointer" as const,
      upcasts: [{ kind: "identity" as const, target: "base_handle" }],
    },
  });
  assert.equal(validateScabiManifest(hierarchy).ok, true);

  const wrongKind = structuredClone(hierarchy);
  const wrongKindDerived = wrongKind.types.derived_handle;
  assert.equal(wrongKindDerived?.kind, "handle");
  if (wrongKindDerived?.kind !== "handle") return;
  Object.assign(wrongKindDerived, {
    upcasts: [{ kind: "identity" as const, target: "i32" }],
  });
  assert.deepEqual(validationCodes(wrongKind), ["NTS2021"]);

  const incompatible = structuredClone(hierarchy);
  const incompatibleBase = incompatible.types.base_handle;
  assert.equal(incompatibleBase?.kind, "handle");
  if (incompatibleBase?.kind !== "handle") return;
  Object.assign(incompatibleBase, { identity: "platform" as const });
  assert.deepEqual(validationCodes(incompatible), ["NTS2021"]);

  const cyclic = structuredClone(hierarchy);
  const cyclicBase = cyclic.types.base_handle;
  assert.equal(cyclicBase?.kind, "handle");
  if (cyclicBase?.kind !== "handle") return;
  Object.assign(cyclicBase, {
    upcasts: [{ kind: "identity" as const, target: "derived_handle" }],
  });
  assert.deepEqual(validationCodes(cyclic), ["NTS2021"]);
});

test("SCABI fixture provenance matches declarations and header", () => {
  const declarationDigest = sha256File(resolve(fixtureRoot, "package.d.ts"));
  const headerDigest = sha256File(
    resolve(fixtureRoot, "include/nts_scabi_fixture.h"),
  );

  assert.equal(manifest.declarations.digest, declarationDigest);
  assert.deepEqual(manifest.declarations.types.i32, {
    module: ".",
    name: "i32",
  });
  assert.equal(manifest.sdk.metadataDigest, headerDigest);
  assert.deepEqual(manifest.generator.inputDigests, [headerDigest]);
});

test("SCABI admits only coherent implicit-length C strings", () => {
  const cString = structuredClone(manifest);
  const binding = cString.bindings.hash_utf8;
  assert.notEqual(binding?.kind, "constant");
  if (binding === undefined || binding.kind === "constant") return;
  const data = binding.signature.parameters[0];
  assert.equal(data?.marshal?.kind, "string");
  if (data?.marshal?.kind !== "string") return;
  Object.assign(data.marshal, {
    length: { kind: "nul" as const },
    termination: "nul" as const,
    embeddedNul: "reject" as const,
  });
  Object.assign(binding.signature, {
    parameters: binding.signature.parameters.slice(0, 1),
  });
  assert.equal(validateScabiManifest(cString).ok, true);

  Object.assign(data.marshal, { embeddedNul: "allow" as const });
  assert.deepEqual(validationCodes(cString), ["NTS2021"]);
});

test(
  "C fixture executes scalar, aggregate, ownership, error, and callback contracts",
  { skip: process.platform !== "linux" || process.arch !== "x64" },
  () => {
    const execution = compileAndRun([
      "nts_scabi_fixture.c",
      "fixture_test.c",
    ]);
    assert.equal(execution.status, 0, execution.stderr);
  },
);

test(
  "C fixture is clean under address and undefined-behavior sanitizers",
  { skip: process.platform !== "linux" || process.arch !== "x64" },
  () => {
    const execution = compileAndRun(
      ["nts_scabi_fixture.c", "fixture_test.c"],
      ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"],
    );
    assert.equal(execution.status, 0, execution.stderr);
  },
);

test(
  "authoritative C layout agrees with the SCABI aggregate",
  { skip: process.platform !== "linux" || process.arch !== "x64" },
  () => {
    const execution = compileAndRun(["layout_probe.c"]);
    assert.equal(execution.status, 0, execution.stderr);

    const layout = JSON.parse(execution.stdout) as {
      readonly alignment: number;
      readonly fields: Readonly<Record<string, number>>;
      readonly size: number;
    };
    const padded = manifest.types.padded;
    assert.equal(padded?.kind, "struct");
    if (padded?.kind !== "struct") {
      return;
    }

    assert.equal(padded.alignment, layout.alignment);
    assert.equal(padded.size, layout.size);
    assert.deepEqual(
      Object.fromEntries(padded.fields.map((field) => [field.name, field.offset])),
      layout.fields,
    );
  },
);

test("SCABI rejects non-canonical source", () => {
  assert.throws(
    () => parseScabiManifest(`${JSON.stringify(manifest, null, 2)}\n`),
    (error: unknown) => {
      assert.ok(error instanceof ScabiValidationError);
      assert.deepEqual(error.diagnostics.map(({ code }) => code), ["NTS2003"]);
      return true;
    },
  );
});

test("canonical JSON rejects values without a portable JSON representation", () => {
  assert.throws(() => canonicalizeJson({ value: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalizeJson({ value: undefined }), /undefined/);
  assert.throws(() => canonicalizeJson("\ud800"), /unpaired surrogate/);
});

test("SCABI rejects a layout that omits required tail storage", () => {
  const padded = manifest.types.padded;
  assert.equal(padded?.kind, "struct");
  if (padded?.kind !== "struct") {
    return;
  }
  const invalid = {
    ...manifest,
    types: {
      ...manifest.types,
      padded: { ...padded, size: 16 },
    },
  };

  assert.deepEqual(validationCodes(invalid), ["NTS2020"]);
});

test("SCABI rejects a void aggregate result without leading structure-return storage", () => {
  const padded = manifest.types.padded;
  assert.equal(padded?.kind, "struct");
  if (padded?.kind !== "struct") return;
  const invalid = {
    ...manifest,
    types: {
      ...manifest.types,
      padded: {
        ...padded,
        abiPassing: padded.abiPassing === undefined
          ? undefined
          : {
              ...padded.abiPassing,
              parameters: padded.abiPassing.parameters.map((parameter, index) =>
                index === 0 ? { ...parameter, structureReturn: false } : parameter
              ),
            },
      },
    },
  };

  assert.deepEqual(validationCodes(invalid), ["NTS2020"]);
});

test("SCABI rejects unknown and ambiguous source type identities", () => {
  const unknown = {
    ...manifest,
    declarations: {
      ...manifest.declarations,
      types: {
        ...manifest.declarations.types,
        ghost: { module: ".", name: "Ghost" },
      },
    },
  };
  assert.deepEqual(validationCodes(unknown), ["NTS2010"]);

  const duplicate = {
    ...manifest,
    declarations: {
      ...manifest.declarations,
      types: {
        ...manifest.declarations.types,
        u32: manifest.declarations.types.i32,
      },
    },
  };
  assert.deepEqual(validationCodes(duplicate), ["NTS2021"]);
});

test("SCABI rejects implicit ownership for a native pointer", () => {
  const allocation = manifest.bindings.bytes_allocate;
  assert.notEqual(allocation?.kind, "constant");
  if (allocation === undefined || allocation.kind === "constant") {
    return;
  }
  const invalid = {
    ...manifest,
    bindings: {
      ...manifest.bindings,
      bytes_allocate: {
        ...allocation,
        signature: {
          ...allocation.signature,
          result: {
            ...allocation.signature.result,
            ownership: { kind: "value" },
          },
        },
      },
    },
  };

  assert.deepEqual(validationCodes(invalid), ["NTS2030"]);
});

test("SCABI rejects borrowed arguments at foreign callback ingress", () => {
  const subscribe = manifest.bindings.subscription_create;
  assert.notEqual(subscribe?.kind, "constant");
  if (subscribe === undefined || subscribe.kind === "constant") {
    return;
  }
  const [callback, context] = subscribe.signature.parameters;
  assert.notEqual(callback?.callback, undefined);
  if (callback?.callback === undefined || context === undefined) {
    return;
  }
  const invalid = {
    ...manifest,
    bindings: {
      ...manifest.bindings,
      subscription_create: {
        ...subscribe,
        signature: {
          ...subscribe.signature,
          parameters: [
            {
              ...callback,
              callback: {
                ...callback.callback,
                arguments: [{ parameter: "value", transport: "borrow" }],
              },
            },
            context,
          ],
        },
      },
    },
  };

  assert.deepEqual(validationCodes(invalid), ["NTS2040"]);
});
