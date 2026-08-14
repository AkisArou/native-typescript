import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  ArtifactExecutionError,
  ArtifactGraphPlanningError,
  defineArtifactGraph,
  executeArtifactGraph,
} from "@native-typescript/core";
import type {
  ArtifactActionDefinition,
  ArtifactDefinition,
  ArtifactGraph,
} from "@native-typescript/core";

const fixturePath = join(import.meta.dirname, "fixtures", "artifact-graph.c");
const target = "x86_64-unknown-linux-gnu";
const executionPlatform = "x86_64-linux";

function digest(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function executable(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching the explicit PATH entries.
    }
  }
  throw new Error(`Required executable is unavailable: ${name}`);
}

function clangIdentity(clangPath: string): {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
} {
  const probe = spawnSync(clangPath, ["--version"], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const version = /clang version ([^\s]+)/u.exec(probe.stdout)?.[1];
  assert.ok(version, `Could not parse Clang version from ${probe.stdout}`);
  return { id: "tool/clang", version, digest: digest(clangPath) };
}

function sourceArtifact(sourceDigest: string): ArtifactDefinition {
  return {
    id: "source/main",
    kind: "source",
    mediaType: "text/x-c",
    target,
    domain: "target",
    cache: "exportable",
    origin: {
      kind: "source",
      digest: sourceDigest,
      fileName: "main.c",
      logicalPath: "tests/fixtures/artifact-graph.c",
    },
  };
}

function nativeArtifacts(sourceDigest: string): readonly ArtifactDefinition[] {
  return [
    sourceArtifact(sourceDigest),
    {
      id: "object/main",
      kind: "native-object",
      mediaType: "application/x-object",
      target,
      domain: "target",
      cache: "exportable",
      origin: {
        kind: "action",
        action: "compile/main",
        fileName: "main.o",
      },
    },
    {
      id: "product/main",
      kind: "executable",
      mediaType: "application/x-executable",
      target,
      domain: "target",
      cache: "exportable",
      origin: {
        kind: "action",
        action: "link/main",
        fileName: "main",
      },
    },
  ];
}

function nativeActions(
  tool: ArtifactActionDefinition["tool"],
): readonly ArtifactActionDefinition[] {
  return [
    {
      id: "compile/main",
      implementation: { id: "native-typescript/clang-compile", version: "1" },
      tool,
      arguments: [
        { kind: "literal", value: "-std=c11" },
        { kind: "literal", value: "-Wall" },
        { kind: "literal", value: "-Wextra" },
        { kind: "literal", value: "-Werror" },
        { kind: "literal", value: "-pedantic" },
        { kind: "literal", value: "-c" },
        { kind: "input-path", artifact: "source/main" },
        { kind: "literal", value: "-o" },
        { kind: "output-path", artifact: "object/main" },
      ],
      environment: [],
      inputs: ["source/main"],
      outputs: ["object/main"],
      workingDirectory: "isolated",
      network: "denied",
      executionPlatform,
      target,
      deterministic: true,
      cacheable: true,
    },
    {
      id: "link/main",
      implementation: { id: "native-typescript/clang-link", version: "1" },
      tool,
      arguments: [
        { kind: "input-path", artifact: "object/main" },
        { kind: "literal", value: "-o" },
        { kind: "output-path", artifact: "product/main" },
      ],
      environment: [],
      inputs: ["object/main"],
      outputs: ["product/main"],
      workingDirectory: "isolated",
      network: "denied",
      executionPlatform,
      target,
      deterministic: true,
      cacheable: true,
    },
  ];
}

function nativeGraph(clangPath: string): ArtifactGraph {
  return defineArtifactGraph({
    artifacts: nativeArtifacts(digest(fixturePath)),
    actions: nativeActions(clangIdentity(clangPath)),
  });
}

test("artifact graph plans canonically and is deeply immutable", () => {
  const clangPath = executable("clang");
  const artifacts = nativeArtifacts(digest(fixturePath));
  const actions = nativeActions(clangIdentity(clangPath));
  const forward = defineArtifactGraph({ artifacts, actions });
  const reverse = defineArtifactGraph({
    artifacts: [...artifacts].reverse(),
    actions: [...actions].reverse(),
  });

  assert.equal(JSON.stringify(forward), JSON.stringify(reverse));
  assert.equal(JSON.stringify(forward).includes(dirname(fixturePath)), false);
  assert.equal(Object.isFrozen(forward), true);
  assert.equal(Object.isFrozen(forward.artifacts), true);
  assert.equal(Object.isFrozen(forward.actions[0]?.arguments), true);
});

test("artifact executor builds and links declared native products", async () => {
  const clangPath = executable("clang");
  const sandboxPath = executable("bwrap");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "native-typescript-artifacts-"));
  const buildRoot = join(temporaryRoot, "build");
  try {
    const report = await executeArtifactGraph(nativeGraph(clangPath), {
      buildRoot,
      sourcePaths: { "source/main": fixturePath },
      tools: { "tool/clang": { path: clangPath } },
      sandbox: { kind: "bubblewrap", path: sandboxPath },
      maxConcurrency: 2,
    });
    const product = report.artifacts.find(({ id }) => id === "product/main");
    assert.ok(product);
    assert.match(product.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(report.actions.map(({ id }) => id), ["compile/main", "link/main"]);

    const run = spawnSync(product.path, [], { encoding: "utf8" });
    assert.equal(run.status, 42, run.stderr);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("artifact planning rejects dependency cycles", () => {
  const clangPath = executable("clang");
  const tool = clangIdentity(clangPath);
  const artifacts: readonly ArtifactDefinition[] = [
    {
      id: "object/a",
      kind: "native-object",
      mediaType: "application/x-object",
      target,
      domain: "target",
      cache: "none",
      origin: { kind: "action", action: "compile/a", fileName: "a.o" },
    },
    {
      id: "object/b",
      kind: "native-object",
      mediaType: "application/x-object",
      target,
      domain: "target",
      cache: "none",
      origin: { kind: "action", action: "compile/b", fileName: "b.o" },
    },
  ];
  const action = (
    id: string,
    input: string,
    output: string,
  ): ArtifactActionDefinition => ({
    id,
    implementation: { id: "test/cycle", version: "1" },
    tool,
    arguments: [
      { kind: "input-path", artifact: input },
      { kind: "output-path", artifact: output },
    ],
    environment: [],
    inputs: [input],
    outputs: [output],
    workingDirectory: "isolated",
    network: "denied",
    executionPlatform,
    target,
    deterministic: true,
    cacheable: false,
  });

  assert.throws(
    () => defineArtifactGraph({
      artifacts,
      actions: [
        action("compile/a", "object/b", "object/a"),
        action("compile/b", "object/a", "object/b"),
      ],
    }),
    (error) => {
      assert.ok(error instanceof ArtifactGraphPlanningError);
      assert.deepEqual(error.diagnostics.map(({ code }) => code), ["NTS2006"]);
      return true;
    },
  );
});

test("artifact executor rejects source and tool content drift", async () => {
  const clangPath = executable("clang");
  const sandboxPath = executable("bwrap");
  const graph = nativeGraph(clangPath);
  const wrongDigestGraph = defineArtifactGraph({
    artifacts: nativeArtifacts(`sha256:${"0".repeat(64)}`),
    actions: graph.actions,
  });
  const temporaryRoot = mkdtempSync(join(tmpdir(), "native-typescript-drift-"));
  try {
    await assert.rejects(
      executeArtifactGraph(wrongDigestGraph, {
        buildRoot: join(temporaryRoot, "source"),
        sourcePaths: { "source/main": fixturePath },
        tools: { "tool/clang": { path: clangPath } },
        sandbox: { kind: "bubblewrap", path: sandboxPath },
      }),
      (error) => error instanceof ArtifactExecutionError && /digest mismatch/u.test(error.message),
    );

    await assert.rejects(
      executeArtifactGraph(graph, {
        buildRoot: join(temporaryRoot, "tool"),
        sourcePaths: { "source/main": fixturePath },
        tools: { "tool/clang": { path: sandboxPath } },
        sandbox: { kind: "bubblewrap", path: sandboxPath },
      }),
      (error) => error instanceof ArtifactExecutionError && /Tool tool\/clang digest mismatch/u.test(error.message),
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("artifact executor rejects undeclared outputs", async () => {
  const shellPath = executable("sh");
  const sandboxPath = executable("bwrap");
  const outputId = "generated/result";
  const graph = defineArtifactGraph({
    artifacts: [
      {
        id: outputId,
        kind: "generated-source",
        mediaType: "text/plain",
        target,
        domain: "host",
        cache: "none",
        origin: {
          kind: "action",
          action: "generate/result",
          fileName: "result.txt",
        },
      },
    ],
    actions: [
      {
        id: "generate/result",
        implementation: { id: "test/undeclared-output", version: "1" },
        tool: { id: "tool/sh", version: "system", digest: digest(shellPath) },
        arguments: [
          { kind: "literal", value: "-c" },
          {
            kind: "literal",
            value: "printf declared > \"$1\"; printf undeclared > outputs/undeclared.txt",
          },
          { kind: "literal", value: "sh" },
          { kind: "output-path", artifact: outputId },
        ],
        environment: [],
        inputs: [],
        outputs: [outputId],
        workingDirectory: "isolated",
        network: "denied",
        executionPlatform,
        target,
        deterministic: true,
        cacheable: false,
      },
    ],
  });
  const temporaryRoot = mkdtempSync(join(tmpdir(), "native-typescript-outputs-"));
  try {
    await assert.rejects(
      executeArtifactGraph(graph, {
        buildRoot: join(temporaryRoot, "build"),
        sourcePaths: {},
        tools: { "tool/sh": { path: shellPath } },
        sandbox: { kind: "bubblewrap", path: sandboxPath },
      }),
      (error) =>
        error instanceof ArtifactExecutionError &&
        /created undeclared output\(s\): undeclared\.txt/u.test(error.message),
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
