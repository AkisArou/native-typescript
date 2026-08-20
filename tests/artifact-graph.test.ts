import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  ArtifactExecutionError,
  ArtifactGraphPlanningError,
  defineArtifactGraph,
  digestArtifactPath,
  executeArtifactGraph,
  resolveSourceArtifact,
} from "@native-typescript/core";
import type {
  ArtifactActionDefinition,
  ArtifactDefinition,
  ArtifactGraph,
} from "@native-typescript/core";

const fixturePath = join(import.meta.dirname, "fixtures", "artifact-graph.c");
const fixtureHeaders = join(import.meta.dirname, "fixtures", "artifact-headers");
const fixtureHeadersDigest = (await digestArtifactPath(fixtureHeaders, "directory")).digest;
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
    entryType: "file",
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

test("source resolution keeps physical paths outside portable definitions", async () => {
  const resolution = await resolveSourceArtifact({
    id: "source/resolved-main",
    path: fixturePath,
    entryType: "file",
    kind: "source",
    mediaType: "text/x-c",
    target,
    domain: "target",
    cache: "exportable",
    fileName: "main.c",
    logicalPath: "tests/fixtures/artifact-graph.c",
  });

  assert.equal(resolution.sourcePath, resolve(fixturePath));
  assert.equal(
    resolution.artifact.origin.kind === "source"
      ? resolution.artifact.origin.digest
      : undefined,
    digest(fixturePath),
  );
  assert.equal(JSON.stringify(resolution.artifact).includes(fixturePath), false);
  assert.equal(Object.isFrozen(resolution), true);
  assert.equal(Object.isFrozen(resolution.artifact), true);
  assert.equal(Object.isFrozen(resolution.artifact.origin), true);
});

function nativeArtifacts(sourceDigest: string): readonly ArtifactDefinition[] {
  return [
    sourceArtifact(sourceDigest),
    {
      id: "headers/main",
      kind: "source-tree",
      entryType: "directory",
      mediaType: "inode/directory",
      target,
      domain: "target",
      cache: "none",
      origin: {
        kind: "source",
        digest: fixtureHeadersDigest,
        fileName: "artifact-headers",
        logicalPath: "tests/fixtures/artifact-headers",
      },
    },
    {
      id: "object/main",
      kind: "native-object",
      entryType: "file",
      mediaType: "application/x-object",
      target,
      domain: "target",
      cache: "none",
      origin: {
        kind: "action",
        action: "compile/main",
        fileName: "main.o",
      },
    },
    {
      id: "product/main",
      kind: "executable",
      entryType: "file",
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
        { kind: "literal", value: "-I" },
        { kind: "input-path", artifact: "headers/main" },
        { kind: "literal", value: "-c" },
        { kind: "input-path", artifact: "source/main" },
        { kind: "literal", value: "-o" },
        { kind: "output-path", artifact: "object/main" },
      ],
      environment: [],
      inputs: ["source/main", "headers/main"],
      outputs: ["object/main"],
      standardOutput: { kind: "report" },
      workingDirectory: "isolated",
      network: "denied",
      executionPlatform,
      target,
      deterministic: false,
      cacheable: false,
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
      standardOutput: { kind: "report" },
      workingDirectory: "isolated",
      network: "denied",
      executionPlatform,
      target,
      deterministic: false,
      cacheable: false,
    },
  ];
}

function nativeGraph(clangPath: string): ArtifactGraph {
  return defineArtifactGraph({
    artifacts: nativeArtifacts(digest(fixturePath)),
    actions: nativeActions(clangIdentity(clangPath)),
  });
}

function cacheableNativeGraph(clangPath: string): ArtifactGraph {
  return defineArtifactGraph({
    artifacts: nativeArtifacts(digest(fixturePath)).map((artifact) =>
      artifact.origin.kind === "action"
        ? { ...artifact, cache: "local" as const }
        : artifact
    ),
    actions: nativeActions(clangIdentity(clangPath)).map((action) => ({
      ...action,
      deterministic: true,
      cacheable: true,
    })),
  });
}

function cacheableGraph(shellPath: string, value = "cached output"): ArtifactGraph {
  const outputId = "generated/cache-result";
  return defineArtifactGraph({
    artifacts: [
      {
        id: outputId,
        kind: "generated-source",
        entryType: "file",
        mediaType: "text/plain",
        target,
        domain: "host",
        cache: "local",
        origin: {
          kind: "action",
          action: "generate/cache-result",
          fileName: "result.txt",
        },
      },
    ],
    actions: [
      {
        id: "generate/cache-result",
        implementation: { id: "test/cache-result", version: "1" },
        tool: { id: "tool/sh", version: "system", digest: digest(shellPath) },
        arguments: [
          { kind: "literal", value: "-c" },
          {
            kind: "literal",
            value: 'printf "%s" "$1" > "$2"; printf "cache-log\\n"',
          },
          { kind: "literal", value: "sh" },
          { kind: "literal", value },
          { kind: "output-path", artifact: outputId },
        ],
        environment: [],
        inputs: [],
        outputs: [outputId],
        standardOutput: { kind: "report" },
        workingDirectory: "isolated",
        network: "denied",
        executionPlatform,
        target,
        deterministic: true,
        cacheable: true,
      },
    ],
  });
}

function cacheableStandardOutputGraph(shellPath: string): ArtifactGraph {
  const outputId = "metadata/standard-output";
  return defineArtifactGraph({
    artifacts: [
      {
        id: outputId,
        kind: "metadata",
        entryType: "file",
        mediaType: "application/json",
        target,
        domain: "host",
        cache: "local",
        origin: {
          kind: "action",
          action: "capture/standard-output",
          fileName: "metadata.json",
        },
      },
    ],
    actions: [
      {
        id: "capture/standard-output",
        implementation: { id: "test/standard-output", version: "1" },
        tool: { id: "tool/sh", version: "system", digest: digest(shellPath) },
        arguments: [
          { kind: "literal", value: "-c" },
          { kind: "literal", value: 'printf \'{"value":42}\\n\'' },
        ],
        environment: [],
        inputs: [],
        outputs: [outputId],
        standardOutput: { kind: "artifact", artifact: outputId },
        workingDirectory: "isolated",
        network: "denied",
        executionPlatform,
        target,
        deterministic: true,
        cacheable: true,
      },
    ],
  });
}

function cacheableInputGraph(shellPath: string, sourceDigest: string): ArtifactGraph {
  const inputId = "source/cache-input";
  const outputId = "generated/cache-copy";
  return defineArtifactGraph({
    artifacts: [
      {
        id: inputId,
        kind: "source",
        entryType: "file",
        mediaType: "text/plain",
        target,
        domain: "host",
        cache: "exportable",
        origin: {
          kind: "source",
          digest: sourceDigest,
          fileName: "input.txt",
          logicalPath: "tests/fixtures/cache-input.txt",
        },
      },
      {
        id: outputId,
        kind: "generated-source",
        entryType: "file",
        mediaType: "text/plain",
        target,
        domain: "host",
        cache: "local",
        origin: {
          kind: "action",
          action: "generate/cache-copy",
          fileName: "copy.txt",
        },
      },
    ],
    actions: [
      {
        id: "generate/cache-copy",
        implementation: { id: "test/cache-copy", version: "1" },
        tool: { id: "tool/sh", version: "system", digest: digest(shellPath) },
        arguments: [
          { kind: "literal", value: "-c" },
          {
            kind: "literal",
            value: 'IFS= read -r value < "$1"; printf "%s" "$value" > "$2"',
          },
          { kind: "literal", value: "sh" },
          { kind: "input-path", artifact: inputId },
          { kind: "output-path", artifact: outputId },
        ],
        environment: [],
        inputs: [inputId],
        outputs: [outputId],
        standardOutput: { kind: "report" },
        workingDirectory: "isolated",
        network: "denied",
        executionPlatform,
        target,
        deterministic: true,
        cacheable: true,
      },
    ],
  });
}

function cacheableDirectoryGraph(mkdirPath: string): ArtifactGraph {
  const outputId = "generated/cache-directory";
  return defineArtifactGraph({
    artifacts: [
      {
        id: outputId,
        kind: "source-tree",
        entryType: "directory",
        mediaType: "inode/directory",
        target,
        domain: "host",
        cache: "local",
        origin: {
          kind: "action",
          action: "generate/cache-directory",
          fileName: "generated",
        },
      },
    ],
    actions: [
      {
        id: "generate/cache-directory",
        implementation: { id: "test/cache-directory", version: "1" },
        tool: {
          id: "tool/mkdir",
          version: "system",
          digest: digest(mkdirPath),
        },
        arguments: [{ kind: "output-path", artifact: outputId }],
        environment: [],
        inputs: [],
        outputs: [outputId],
        standardOutput: { kind: "report" },
        workingDirectory: "isolated",
        network: "denied",
        executionPlatform,
        target,
        deterministic: true,
        cacheable: true,
      },
    ],
  });
}

function cacheEntryRoot(cacheRoot: string, cacheKey: string): string {
  assert.match(cacheKey, /^sha256:[0-9a-f]{64}$/u);
  return join(cacheRoot, "v1", "actions", cacheKey.slice("sha256:".length));
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
  assert.equal(forward.schemaVersion, 2);
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
      sourcePaths: {
        "source/main": fixturePath,
        "headers/main": fixtureHeaders,
      },
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

test("local action cache restores dependent executable products", async () => {
  const clangPath = executable("clang");
  const sandboxPath = executable("bwrap");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "native-typescript-cache-native-"));
  const cacheRoot = join(temporaryRoot, "cache");
  try {
    const graph = cacheableNativeGraph(clangPath);
    const first = await executeArtifactGraph(graph, {
      buildRoot: join(temporaryRoot, "first"),
      sourcePaths: {
        "source/main": fixturePath,
        "headers/main": fixtureHeaders,
      },
      tools: { "tool/clang": { path: clangPath } },
      sandbox: { kind: "bubblewrap", path: sandboxPath },
      cache: { kind: "local", path: cacheRoot },
    });
    assert.deepEqual(first.actions.map(({ status }) => status), ["executed", "executed"]);

    const second = await executeArtifactGraph(graph, {
      buildRoot: join(temporaryRoot, "second"),
      sourcePaths: {
        "source/main": fixturePath,
        "headers/main": fixtureHeaders,
      },
      tools: {},
      sandbox: { kind: "bubblewrap", path: sandboxPath },
      cache: { kind: "local", path: cacheRoot },
    });
    assert.deepEqual(second.actions.map(({ status }) => status), ["cached", "cached"]);
    const product = second.artifacts.find(({ id }) => id === "product/main");
    assert.ok(product);
    const run = spawnSync(product.path, [], { encoding: "utf8" });
    assert.equal(run.status, 42, run.stderr);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("local action cache materializes verified hits without a tool binding", async () => {
  const shellPath = executable("sh");
  const sandboxPath = executable("bwrap");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "native-typescript-cache-hit-"));
  const cacheRoot = join(temporaryRoot, "cache");
  try {
    const graph = cacheableGraph(shellPath);
    const first = await executeArtifactGraph(graph, {
      buildRoot: join(temporaryRoot, "first"),
      sourcePaths: {},
      tools: { "tool/sh": { path: shellPath } },
      sandbox: { kind: "bubblewrap", path: sandboxPath },
      cache: { kind: "local", path: cacheRoot },
    });
    assert.equal(first.actions[0]?.status, "executed");
    assert.match(first.actions[0]?.cacheKey ?? "", /^sha256:[0-9a-f]{64}$/u);
    assert.equal(first.actions[0]?.stdout, "cache-log\n");

    const second = await executeArtifactGraph(graph, {
      buildRoot: join(temporaryRoot, "second"),
      sourcePaths: {},
      tools: {},
      sandbox: { kind: "bubblewrap", path: sandboxPath },
      cache: { kind: "local", path: cacheRoot },
    });
    assert.equal(second.actions[0]?.status, "cached");
    assert.equal(second.actions[0]?.cacheKey, first.actions[0]?.cacheKey);
    assert.equal(second.actions[0]?.stdout, "cache-log\n");
    const product = second.artifacts.find(({ id }) => id === "generated/cache-result");
    assert.ok(product);
    assert.equal(readFileSync(product.path, "utf8"), "cached output");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("standard output is a streamed, verified, cacheable artifact", async () => {
  const shellPath = executable("sh");
  const sandboxPath = executable("bwrap");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "native-typescript-stdout-"));
  const cacheRoot = join(temporaryRoot, "cache");
  try {
    const graph = cacheableStandardOutputGraph(shellPath);
    const first = await executeArtifactGraph(graph, {
      buildRoot: join(temporaryRoot, "first"),
      sourcePaths: {},
      tools: { "tool/sh": { path: shellPath } },
      sandbox: { kind: "bubblewrap", path: sandboxPath },
      cache: { kind: "local", path: cacheRoot },
    });
    assert.equal(first.actions[0]?.status, "executed");
    assert.equal(first.actions[0]?.stdout, "");
    const firstOutput = first.artifacts.find(
      ({ id }) => id === "metadata/standard-output",
    );
    assert.ok(firstOutput);
    assert.equal(readFileSync(firstOutput.path, "utf8"), '{"value":42}\n');

    const second = await executeArtifactGraph(graph, {
      buildRoot: join(temporaryRoot, "second"),
      sourcePaths: {},
      tools: {},
      sandbox: { kind: "bubblewrap", path: sandboxPath },
      cache: { kind: "local", path: cacheRoot },
    });
    assert.equal(second.actions[0]?.status, "cached");
    assert.equal(second.actions[0]?.cacheKey, first.actions[0]?.cacheKey);
    assert.equal(second.actions[0]?.stdout, "");
    const secondOutput = second.artifacts.find(
      ({ id }) => id === "metadata/standard-output",
    );
    assert.ok(secondOutput);
    assert.equal(readFileSync(secondOutput.path, "utf8"), '{"value":42}\n');
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("standard-output artifacts cannot also be command output paths", () => {
  const shellPath = executable("sh");
  const graph = cacheableStandardOutputGraph(shellPath);
  const action = graph.actions[0];
  assert.ok(action);

  assert.throws(
    () => defineArtifactGraph({
      artifacts: graph.artifacts,
      actions: [
        {
          ...action,
          arguments: [
            ...action.arguments,
            { kind: "output-path", artifact: "metadata/standard-output" },
          ],
        },
      ],
    }),
    (error) => {
      assert.ok(error instanceof ArtifactGraphPlanningError);
      assert.deepEqual(error.diagnostics.map(({ code }) => code), ["NTS2008"]);
      return true;
    },
  );
});

test("local action cache rejects corrupted output content", async () => {
  const shellPath = executable("sh");
  const sandboxPath = executable("bwrap");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "native-typescript-cache-corrupt-"));
  const cacheRoot = join(temporaryRoot, "cache");
  try {
    const graph = cacheableGraph(shellPath);
    const first = await executeArtifactGraph(graph, {
      buildRoot: join(temporaryRoot, "first"),
      sourcePaths: {},
      tools: { "tool/sh": { path: shellPath } },
      sandbox: { kind: "bubblewrap", path: sandboxPath },
      cache: { kind: "local", path: cacheRoot },
    });
    const cacheKey = first.actions[0]?.cacheKey;
    assert.ok(cacheKey);
    const outputs = join(cacheEntryRoot(cacheRoot, cacheKey), "outputs");
    const [storedOutput] = readdirSync(outputs);
    assert.ok(storedOutput);
    writeFileSync(join(outputs, storedOutput), "corrupt");

    await assert.rejects(
      executeArtifactGraph(graph, {
        buildRoot: join(temporaryRoot, "second"),
        sourcePaths: {},
        tools: {},
        sandbox: { kind: "bubblewrap", path: sandboxPath },
        cache: { kind: "local", path: cacheRoot },
      }),
      (error) =>
        error instanceof ArtifactExecutionError &&
        /cache entry .* is corrupt: stored output .* failed verification/u.test(error.message),
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("local action cache rejects an unknown manifest schema", async () => {
  const shellPath = executable("sh");
  const sandboxPath = executable("bwrap");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "native-typescript-cache-schema-"));
  const cacheRoot = join(temporaryRoot, "cache");
  try {
    const graph = cacheableGraph(shellPath);
    const first = await executeArtifactGraph(graph, {
      buildRoot: join(temporaryRoot, "first"),
      sourcePaths: {},
      tools: { "tool/sh": { path: shellPath } },
      sandbox: { kind: "bubblewrap", path: sandboxPath },
      cache: { kind: "local", path: cacheRoot },
    });
    const cacheKey = first.actions[0]?.cacheKey;
    assert.ok(cacheKey);
    writeFileSync(
      join(cacheEntryRoot(cacheRoot, cacheKey), "manifest.json"),
      JSON.stringify({
        schema: "native-typescript.local-action-cache",
        schemaVersion: 2,
      }),
    );

    await assert.rejects(
      executeArtifactGraph(graph, {
        buildRoot: join(temporaryRoot, "second"),
        sourcePaths: {},
        tools: {},
        sandbox: { kind: "bubblewrap", path: sandboxPath },
        cache: { kind: "local", path: cacheRoot },
      }),
      (error) =>
        error instanceof ArtifactExecutionError &&
        /manifest schema or identity is invalid/u.test(error.message),
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("concurrent cache publication leaves one complete reusable entry", async () => {
  const shellPath = executable("sh");
  const sandboxPath = executable("bwrap");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "native-typescript-cache-race-"));
  const cacheRoot = join(temporaryRoot, "cache");
  try {
    const graph = cacheableGraph(shellPath, "concurrent output");
    const execute = async (build: string) => await executeArtifactGraph(graph, {
      buildRoot: join(temporaryRoot, build),
      sourcePaths: {},
      tools: { "tool/sh": { path: shellPath } },
      sandbox: { kind: "bubblewrap", path: sandboxPath },
      cache: { kind: "local", path: cacheRoot },
    });
    const [left, right] = await Promise.all([execute("left"), execute("right")]);
    assert.equal(left.actions[0]?.cacheKey, right.actions[0]?.cacheKey);

    const reused = await executeArtifactGraph(graph, {
      buildRoot: join(temporaryRoot, "reused"),
      sourcePaths: {},
      tools: {},
      sandbox: { kind: "bubblewrap", path: sandboxPath },
      cache: { kind: "local", path: cacheRoot },
    });
    assert.equal(reused.actions[0]?.status, "cached");
    const product = reused.artifacts.find(({ id }) => id === "generated/cache-result");
    assert.ok(product);
    assert.equal(readFileSync(product.path, "utf8"), "concurrent output");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("local action cache keys include verified input content", async () => {
  const shellPath = executable("sh");
  const sandboxPath = executable("bwrap");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "native-typescript-cache-input-"));
  const cacheRoot = join(temporaryRoot, "cache");
  const sourcePath = join(temporaryRoot, "input.txt");
  try {
    writeFileSync(sourcePath, "one\n");
    const first = await executeArtifactGraph(
      cacheableInputGraph(shellPath, digest(sourcePath)),
      {
        buildRoot: join(temporaryRoot, "first"),
        sourcePaths: { "source/cache-input": sourcePath },
        tools: { "tool/sh": { path: shellPath } },
        sandbox: { kind: "bubblewrap", path: sandboxPath },
        cache: { kind: "local", path: cacheRoot },
      },
    );

    writeFileSync(sourcePath, "two\n");
    const secondGraph = cacheableInputGraph(shellPath, digest(sourcePath));
    const second = await executeArtifactGraph(secondGraph, {
      buildRoot: join(temporaryRoot, "second"),
      sourcePaths: { "source/cache-input": sourcePath },
      tools: { "tool/sh": { path: shellPath } },
      sandbox: { kind: "bubblewrap", path: sandboxPath },
      cache: { kind: "local", path: cacheRoot },
    });
    assert.equal(second.actions[0]?.status, "executed");
    assert.notEqual(second.actions[0]?.cacheKey, first.actions[0]?.cacheKey);

    const third = await executeArtifactGraph(secondGraph, {
      buildRoot: join(temporaryRoot, "third"),
      sourcePaths: { "source/cache-input": sourcePath },
      tools: {},
      sandbox: { kind: "bubblewrap", path: sandboxPath },
      cache: { kind: "local", path: cacheRoot },
    });
    assert.equal(third.actions[0]?.status, "cached");
    const product = third.artifacts.find(({ id }) => id === "generated/cache-copy");
    assert.ok(product);
    assert.equal(readFileSync(product.path, "utf8"), "two");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("local action cache preserves directory outputs", async () => {
  const mkdirPath = executable("mkdir");
  const sandboxPath = executable("bwrap");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "native-typescript-cache-tree-"));
  const cacheRoot = join(temporaryRoot, "cache");
  try {
    const graph = cacheableDirectoryGraph(mkdirPath);
    await executeArtifactGraph(graph, {
      buildRoot: join(temporaryRoot, "first"),
      sourcePaths: {},
      tools: { "tool/mkdir": { path: mkdirPath } },
      sandbox: { kind: "bubblewrap", path: sandboxPath },
      cache: { kind: "local", path: cacheRoot },
    });
    const second = await executeArtifactGraph(graph, {
      buildRoot: join(temporaryRoot, "second"),
      sourcePaths: {},
      tools: {},
      sandbox: { kind: "bubblewrap", path: sandboxPath },
      cache: { kind: "local", path: cacheRoot },
    });
    assert.equal(second.actions[0]?.status, "cached");
    const output = second.artifacts.find(({ id }) => id === "generated/cache-directory");
    assert.ok(output);
    assert.equal(statSync(output.path).isDirectory(), true);
    assert.deepEqual(readdirSync(output.path), []);
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
      entryType: "file",
      mediaType: "application/x-object",
      target,
      domain: "target",
      cache: "none",
      origin: { kind: "action", action: "compile/a", fileName: "a.o" },
    },
    {
      id: "object/b",
      kind: "native-object",
      entryType: "file",
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
    standardOutput: { kind: "report" },
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

test("artifact planning requires storage for every cacheable output", () => {
  const clangPath = executable("clang");
  const actions = nativeActions(clangIdentity(clangPath));
  const compile = actions[0]!;
  assert.throws(
    () => defineArtifactGraph({
      artifacts: nativeArtifacts(digest(fixturePath)),
      actions: [
        { ...compile, deterministic: true, cacheable: true },
        actions[1]!,
      ],
    }),
    (error) => {
      assert.ok(error instanceof ArtifactGraphPlanningError);
      assert.deepEqual(error.diagnostics.map(({ code }) => code), ["NTS2007"]);
      return true;
    },
  );
});

test("artifact planning rejects traversing a directory input", () => {
  const clangPath = executable("clang");
  const actions = nativeActions(clangIdentity(clangPath));
  const compile = actions[0]!;
  const invalidCompile: ArtifactActionDefinition = {
    ...compile,
    arguments: compile.arguments.map((argument) =>
      argument.kind === "input-path" && argument.artifact === "headers/main"
        ? { ...argument, path: "../value.h" }
        : argument
    ),
  };

  assert.throws(
    () => defineArtifactGraph({
      artifacts: nativeArtifacts(digest(fixturePath)),
      actions: [invalidCompile, actions[1]!],
    }),
    (error) => {
      assert.ok(error instanceof ArtifactGraphPlanningError);
      assert.deepEqual(error.diagnostics.map(({ code }) => code), ["NTS2008"]);
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
        sourcePaths: {
          "source/main": fixturePath,
          "headers/main": fixtureHeaders,
        },
        tools: { "tool/clang": { path: clangPath } },
        sandbox: { kind: "bubblewrap", path: sandboxPath },
      }),
      (error) => error instanceof ArtifactExecutionError && /digest mismatch/u.test(error.message),
    );

    await assert.rejects(
      executeArtifactGraph(graph, {
        buildRoot: join(temporaryRoot, "tool"),
        sourcePaths: {
          "source/main": fixturePath,
          "headers/main": fixtureHeaders,
        },
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
        entryType: "file",
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
        standardOutput: { kind: "report" },
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

/**
 * A graph whose action reads a file nobody declared and says so.
 *
 * The cache key covers declared inputs, and this action has none. What makes a
 * cached result trustworthy is the dependency list: the action writes the path
 * it read, and the entry is reused only while that file is unchanged.
 */
function undeclaredDependencyGraph(
  shellPath: string,
  headerPath: string,
): ArtifactGraph {
  const outputId = "generated/undeclared-copy";
  return defineArtifactGraph({
    artifacts: [
      {
        id: outputId,
        kind: "generated-source",
        entryType: "file",
        mediaType: "text/plain",
        target,
        domain: "host",
        cache: "local",
        origin: {
          kind: "action",
          action: "copy/undeclared",
          fileName: "copy.txt",
        },
      },
    ],
    actions: [
      {
        id: "copy/undeclared",
        implementation: { id: "test/undeclared", version: "1" },
        tool: { id: "tool/sh", version: "system", digest: digest(shellPath) },
        arguments: [
          { kind: "literal", value: "-c" },
          {
            kind: "literal",
            value: 'cat "$1" > "$2"; printf "out: %s\\n" "$1" > "$3"',
          },
          { kind: "literal", value: "sh" },
          { kind: "literal", value: headerPath },
          { kind: "output-path", artifact: outputId },
          { kind: "dependency-path" },
        ],
        environment: [],
        inputs: [],
        outputs: [outputId],
        standardOutput: { kind: "report" },
        workingDirectory: "isolated",
        network: "denied",
        executionPlatform,
        target,
        deterministic: true,
        cacheable: true,
        recordsDependencies: true,
      },
    ],
  });
}

test(
  "a cached action is reused only while the files it read are unchanged",
  { skip: process.platform !== "linux" },
  async () => {
    const shellPath = executable("sh");
    const sandboxPath = executable("bwrap");
    const scratch = mkdtempSync(join(tmpdir(), "nts-undeclared-"));
    try {
      const headerPath = join(scratch, "undeclared.txt");
      writeFileSync(headerPath, "first");
      const graph = undeclaredDependencyGraph(shellPath, headerPath);
      const bindings = {
        sourcePaths: {},
        tools: { "tool/sh": { path: shellPath } },
        sandbox: { kind: "bubblewrap" as const, path: sandboxPath },
        cache: { kind: "local" as const, path: join(scratch, "cache") },
      };
      const read = (report: Awaited<ReturnType<typeof executeArtifactGraph>>): string =>
        readFileSync(
          report.artifacts.find(({ id }) => id === "generated/undeclared-copy")!.path,
          "utf8",
        );

      const first = await executeArtifactGraph(graph, {
        ...bindings,
        buildRoot: join(scratch, "build-1"),
      });
      assert.equal(first.actions[0]?.status, "executed");
      assert.equal(read(first), "first");

      // Nothing changed: the recorded file still matches, so the entry stands.
      const second = await executeArtifactGraph(graph, {
        ...bindings,
        buildRoot: join(scratch, "build-2"),
      });
      assert.equal(second.actions[0]?.status, "cached");
      assert.equal(read(second), "first");

      /* The file the action read changed. No declared input did, so the cache
       * key is identical — only the recorded dependency can tell. */
      writeFileSync(headerPath, "second");
      const third = await executeArtifactGraph(graph, {
        ...bindings,
        buildRoot: join(scratch, "build-3"),
      });
      assert.equal(third.actions[0]?.status, "executed");
      assert.equal(read(third), "second");

      // And the fresh result is what gets reused from then on.
      const fourth = await executeArtifactGraph(graph, {
        ...bindings,
        buildRoot: join(scratch, "build-4"),
      });
      assert.equal(fourth.actions[0]?.status, "cached");
      assert.equal(read(fourth), "second");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test(
  "an action that records no dependencies is never published as reusable",
  { skip: process.platform !== "linux" },
  async () => {
    /* The list is the whole basis for trusting the entry. A tool that promised
     * one and wrote nothing has not earned a cache entry, so the action runs
     * every time instead of being reused on a promise it did not keep. */
    const shellPath = executable("sh");
    const sandboxPath = executable("bwrap");
    const scratch = mkdtempSync(join(tmpdir(), "nts-nodeps-"));
    try {
      const graph = defineArtifactGraph({
        artifacts: [
          {
            id: "generated/silent",
            kind: "generated-source",
            entryType: "file",
            mediaType: "text/plain",
            target,
            domain: "host",
            cache: "local",
            origin: {
              kind: "action",
              action: "generate/silent",
              fileName: "silent.txt",
            },
          },
        ],
        actions: [
          {
            id: "generate/silent",
            implementation: { id: "test/silent", version: "1" },
            tool: { id: "tool/sh", version: "system", digest: digest(shellPath) },
            arguments: [
              { kind: "literal", value: "-c" },
              { kind: "literal", value: 'printf "quiet" > "$1"' },
              { kind: "literal", value: "sh" },
              { kind: "output-path", artifact: "generated/silent" },
              { kind: "dependency-path" },
            ],
            environment: [],
            inputs: [],
            outputs: ["generated/silent"],
            standardOutput: { kind: "report" },
            workingDirectory: "isolated",
            network: "denied",
            executionPlatform,
            target,
            deterministic: true,
            cacheable: true,
            recordsDependencies: true,
          },
        ],
      });
      const bindings = {
        sourcePaths: {},
        tools: { "tool/sh": { path: shellPath } },
        sandbox: { kind: "bubblewrap" as const, path: sandboxPath },
        cache: { kind: "local" as const, path: join(scratch, "cache") },
      };
      for (const run of [1, 2]) {
        const report = await executeArtifactGraph(graph, {
          ...bindings,
          buildRoot: join(scratch, `build-${run}`),
        });
        assert.equal(report.actions[0]?.status, "executed", `run ${run}`);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test("a directory artifact's digest notices a file becoming executable", async () => {
  /* A cache keyed on content must distinguish trees that behave differently.
   * The digest hashed entry type, path, byte length, and bytes — so a tree
   * whose `bin/tool` was executable digested identically to one where it was
   * not, and a hit on either could return the other. The ROOT's mode was
   * recorded and restored; nothing below it was.
   *
   * The executable bit rather than the whole mode: permissions vary with the
   * umask that happened to be set, so hashing them would make a digest depend
   * on the machine that produced it. A umask never adds execute. */
  const scratch = mkdtempSync(join(tmpdir(), "nts-dir-digest-"));
  try {
    const tree = join(scratch, "tree");
    mkdirSync(join(tree, "bin"), { recursive: true });
    const tool = join(tree, "bin", "tool");
    writeFileSync(tool, "#!/bin/sh\nexit 0\n");

    chmodSync(tool, 0o644);
    const plain = (await digestArtifactPath(tree, "directory")).digest;
    chmodSync(tool, 0o755);
    const executable = (await digestArtifactPath(tree, "directory")).digest;

    assert.notEqual(
      plain,
      executable,
      "identical bytes with a different executable bit must not share a digest",
    );

    /* And the bit is the only thing that moved: restoring it restores the
     * digest, so this is not merely hashing something unstable. */
    chmodSync(tool, 0o644);
    assert.equal((await digestArtifactPath(tree, "directory")).digest, plain);
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
});

/** A graph whose one action runs `sh -c <script>` under the sandbox and
 * captures its standard output as the product. Enough to exercise execution
 * POLICY — deadlines, output bounds, refusals — without a compiler in the
 * way. */
function shellGraph(shellPath: string, script: string): ArtifactGraph {
  const outputId = "metadata/policy";
  return defineArtifactGraph({
    artifacts: [
      {
        id: outputId,
        kind: "metadata",
        entryType: "file",
        mediaType: "application/json",
        target,
        domain: "host",
        cache: "none",
        origin: {
          kind: "action",
          action: "run/shell",
          fileName: "metadata.json",
        },
      },
    ],
    actions: [
      {
        id: "run/shell",
        implementation: { id: "test/policy", version: "1" },
        tool: { id: "tool/sh", version: "system", digest: digest(shellPath) },
        arguments: [
          { kind: "literal", value: "-c" },
          { kind: "literal", value: script },
        ],
        environment: [],
        inputs: [],
        outputs: [outputId],
        standardOutput: { kind: "artifact", artifact: outputId },
        workingDirectory: "isolated",
        network: "denied",
        executionPlatform,
        target,
        deterministic: false,
        cacheable: false,
      },
    ],
  });
}

test("an action that never finishes is ended by its deadline", async () => {
  /* Without this a wedged tool blocks its executor forever and the graph
   * reports nothing at all, rather than one failed action. */
  const shellPath = executable("sh");
  const sandboxPath = executable("bwrap");
  const root = mkdtempSync(join(tmpdir(), "nts-timeout-"));
  try {
    const started = Date.now();
    await assert.rejects(
      executeArtifactGraph(shellGraph(shellPath, "sleep 60"), {
        buildRoot: join(root, "build"),
        sourcePaths: {},
        tools: { "tool/sh": { path: shellPath } },
        sandbox: { kind: "bubblewrap", path: sandboxPath },
        actionTimeoutMs: 1500,
      }),
      /exceeded its 1500ms deadline/u,
    );
    /* Ended by the deadline rather than by the sleep finishing. */
    assert.ok(Date.now() - started < 30_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a noisy action cannot exhaust the build process, and says it was cut", async () => {
  /* The capture was an unbounded string, so one runaway tool could take the
   * whole build down with it. Truncation ANNOUNCES itself: output that
   * silently stops sends the reader looking for a cause that is not there. */
  const shellPath = executable("sh");
  const sandboxPath = executable("bwrap");
  const root = mkdtempSync(join(tmpdir(), "nts-noise-"));
  try {
    await assert.rejects(
      executeArtifactGraph(
        shellGraph(shellPath, "yes ' padding padding padding' | head -c 400000 1>&2; exit 3"),
        {
          buildRoot: join(root, "build"),
          sourcePaths: {},
          tools: { "tool/sh": { path: shellPath } },
          sandbox: { kind: "bubblewrap", path: sandboxPath },
          maximumCapturedBytes: 4096,
        },
      ),
      (error: unknown) => {
        const detail = error as { stderr?: string };
        assert.ok(detail.stderr !== undefined);
        assert.ok(
          detail.stderr.length < 20_000,
          `captured ${detail.stderr.length} bytes despite a 4096-byte bound`,
        );
        assert.match(detail.stderr, /\[truncated at 4096 bytes\]/u);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("execution options are refused rather than clamped", async () => {
  /* A caller asking for a zero deadline has a bug. Substituting a working
   * value hides it until the build behaves inexplicably. */
  const shellPath = executable("sh");
  const sandboxPath = executable("bwrap");
  const root = mkdtempSync(join(tmpdir(), "nts-policy-"));
  try {
    for (const [options, pattern] of [
      [{ actionTimeoutMs: 0 }, /actionTimeoutMs must be a positive safe integer/u],
      [{ actionTimeoutMs: 1.5 }, /actionTimeoutMs must be a positive safe integer/u],
      [{ maximumCapturedBytes: -1 }, /maximumCapturedBytes must be a positive safe integer/u],
    ] as const) {
      await assert.rejects(
        executeArtifactGraph(shellGraph(shellPath, "true"), {
          buildRoot: join(root, `build-${JSON.stringify(options)}`),
          sourcePaths: {},
          tools: { "tool/sh": { path: shellPath } },
          sandbox: { kind: "bubblewrap", path: sandboxPath },
          ...options,
        }),
        pattern,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
