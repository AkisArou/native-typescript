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
    "sha256:6f5ab60f38780c3fa86439b7697b7f7c2b12a4495ba5ea0652d6adbece81c462",
  );
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.bindings.subscription_create), true);
  assert.equal(Object.isFrozen(manifest.types.padded), true);
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

test("SCABI rejects aggregate passing alignment beyond the value alignment", () => {
  const padded = manifest.types.padded;
  assert.equal(padded?.kind, "struct");
  if (padded?.kind !== "struct") return;
  const invalid = {
    ...manifest,
    types: {
      ...manifest.types,
      padded: { ...padded, abiPassing: { kind: "indirect" as const, alignment: 16 } },
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
