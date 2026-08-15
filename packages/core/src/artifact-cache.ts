import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { ArtifactExecutionError, digestArtifactPath } from "./artifact-io.ts";
import type {
  ArtifactActionDefinition,
  ArtifactDefinition,
  MaterializedArtifact,
} from "./artifact-graph.ts";

export interface ArtifactCacheBinding {
  readonly kind: "local";
  readonly path: string;
}

export interface PreparedArtifactCache {
  readonly entriesRoot: string;
}

export interface ArtifactActionCacheContext {
  readonly action: ArtifactActionDefinition;
  readonly artifactsById: ReadonlyMap<string, ArtifactDefinition>;
  readonly materialized: ReadonlyMap<string, MaterializedArtifact>;
}

interface LocalCacheOutput {
  readonly id: string;
  readonly entryType: "file" | "directory";
  readonly digest: string;
  readonly size: number;
  readonly mode: number;
}

interface LocalCacheBlob {
  readonly digest: string;
  readonly size: number;
}

interface LocalCacheManifest {
  readonly schema: "native-typescript.local-action-cache";
  readonly schemaVersion: 1;
  readonly actionKey: string;
  readonly stdout: LocalCacheBlob;
  readonly stderr: LocalCacheBlob;
  readonly outputs: readonly LocalCacheOutput[];
}

export interface RestoredActionCacheEntry {
  readonly stdout: string;
  readonly stderr: string;
  readonly outputs: readonly MaterializedArtifact[];
}

const cacheKeyPattern = /^sha256:[0-9a-f]{64}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const maximumManifestBytes = 1024 * 1024;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function outputCacheName(index: number): string {
  return index.toString(10).padStart(4, "0");
}

function entryRoot(cache: PreparedArtifactCache, cacheKey: string): string {
  return join(cache.entriesRoot, cacheKey.slice("sha256:".length));
}

function corruptCacheError(
  actionId: string,
  cacheKey: string,
  message: string,
): ArtifactExecutionError {
  return new ArtifactExecutionError(
    `Action ${actionId} cache entry ${cacheKey} is corrupt: ${message}`,
    { actionId },
  );
}

function expectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseBlob(
  value: unknown,
  actionId: string,
  cacheKey: string,
  name: string,
): LocalCacheBlob {
  const record = expectRecord(value);
  if (
    record === null ||
    typeof record.digest !== "string" ||
    !digestPattern.test(record.digest) ||
    typeof record.size !== "number" ||
    !Number.isSafeInteger(record.size) ||
    record.size < 0
  ) {
    throw corruptCacheError(actionId, cacheKey, `${name} metadata is invalid`);
  }
  return { digest: record.digest, size: record.size };
}

function parseManifest(
  text: string,
  action: ArtifactActionDefinition,
  cacheKey: string,
): LocalCacheManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw corruptCacheError(action.id, cacheKey, "manifest is not valid JSON");
  }
  const record = expectRecord(parsed);
  if (
    record === null ||
    record.schema !== "native-typescript.local-action-cache" ||
    record.schemaVersion !== 1 ||
    record.actionKey !== cacheKey ||
    !Array.isArray(record.outputs)
  ) {
    throw corruptCacheError(action.id, cacheKey, "manifest schema or identity is invalid");
  }
  if (record.outputs.length !== action.outputs.length) {
    throw corruptCacheError(action.id, cacheKey, "manifest output set is incomplete");
  }
  const outputs: LocalCacheOutput[] = record.outputs.map((value, index) => {
    const output = expectRecord(value);
    const expectedId = action.outputs[index];
    if (
      output === null ||
      typeof output.id !== "string" ||
      output.id !== expectedId ||
      (output.entryType !== "file" && output.entryType !== "directory") ||
      typeof output.digest !== "string" ||
      !digestPattern.test(output.digest) ||
      typeof output.size !== "number" ||
      !Number.isSafeInteger(output.size) ||
      output.size < 0 ||
      typeof output.mode !== "number" ||
      !Number.isSafeInteger(output.mode) ||
      output.mode < 0 ||
      output.mode > 0o7777
    ) {
      throw corruptCacheError(
        action.id,
        cacheKey,
        `manifest output ${expectedId ?? index} is invalid`,
      );
    }
    return {
      id: output.id,
      entryType: output.entryType,
      digest: output.digest,
      size: output.size,
      mode: output.mode,
    };
  });
  return {
    schema: "native-typescript.local-action-cache",
    schemaVersion: 1,
    actionKey: cacheKey,
    stdout: parseBlob(record.stdout, action.id, cacheKey, "stdout"),
    stderr: parseBlob(record.stderr, action.id, cacheKey, "stderr"),
    outputs,
  };
}

async function copyArtifactPath(
  source: string,
  destination: string,
  entryType: "file" | "directory",
  mode: number,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  if (entryType === "file") {
    await copyFile(source, destination);
  } else {
    await cp(source, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
    });
  }
  await chmod(destination, mode);
}

export async function prepareArtifactCache(
  binding: ArtifactCacheBinding,
): Promise<PreparedArtifactCache> {
  if (binding.kind !== "local" || !isAbsolute(binding.path)) {
    throw new ArtifactExecutionError(
      "The local artifact cache requires an absolute path",
    );
  }
  await mkdir(binding.path, { recursive: true });
  const root = await realpath(binding.path);
  const entriesRoot = join(root, "v1", "actions");
  await mkdir(entriesRoot, { recursive: true });
  return Object.freeze({ entriesRoot });
}

export function computeActionCacheKey(
  context: ArtifactActionCacheContext,
): string {
  const inputs = context.action.inputs.map((id) => {
    const definition = context.artifactsById.get(id);
    const materialized = context.materialized.get(id);
    if (definition === undefined || materialized === undefined) {
      throw new ArtifactExecutionError(
        `Action ${context.action.id} cannot key unmaterialized input ${id}`,
        { actionId: context.action.id },
      );
    }
    return {
      id,
      entryType: definition.entryType,
      fileName: definition.origin.fileName,
      digest: materialized.digest,
      size: materialized.size,
    };
  });
  const outputs = context.action.outputs.map((id) => {
    const definition = context.artifactsById.get(id);
    if (definition === undefined) {
      throw new ArtifactExecutionError(
        `Action ${context.action.id} cannot key unknown output ${id}`,
        { actionId: context.action.id },
      );
    }
    return {
      id,
      entryType: definition.entryType,
      fileName: definition.origin.fileName,
    };
  });
  const encoded = JSON.stringify({
    schema: "native-typescript.action-key",
    schemaVersion: 1,
    action: context.action,
    inputs,
    outputs,
  });
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}

export async function restoreActionFromCache(options: {
  readonly cache: PreparedArtifactCache;
  readonly context: ArtifactActionCacheContext;
  readonly cacheKey: string;
  readonly outputPaths: ReadonlyMap<string, string>;
}): Promise<RestoredActionCacheEntry | null> {
  if (!cacheKeyPattern.test(options.cacheKey)) {
    throw new ArtifactExecutionError("Action cache key is not canonical", {
      actionId: options.context.action.id,
    });
  }
  const root = entryRoot(options.cache, options.cacheKey);
  let rootEntry;
  try {
    rootEntry = await lstat(root);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw corruptCacheError(
      options.context.action.id,
      options.cacheKey,
      "entry root is not a directory",
    );
  }
  const rootEntries = await readdir(root, { withFileTypes: true });
  if (
    rootEntries.length !== 4 ||
    !rootEntries.some((entry) => entry.name === "manifest.json" && entry.isFile()) ||
    !rootEntries.some((entry) => entry.name === "stdout.log" && entry.isFile()) ||
    !rootEntries.some((entry) => entry.name === "stderr.log" && entry.isFile()) ||
    !rootEntries.some((entry) => entry.name === "outputs" && entry.isDirectory())
  ) {
    throw corruptCacheError(
      options.context.action.id,
      options.cacheKey,
      "entry layout is invalid",
    );
  }
  const manifestPath = join(root, "manifest.json");
  const manifestEntry = await stat(manifestPath);
  if (manifestEntry.size > maximumManifestBytes) {
    throw corruptCacheError(
      options.context.action.id,
      options.cacheKey,
      "manifest exceeds the size limit",
    );
  }
  const manifest = parseManifest(
    await readFile(manifestPath, "utf8"),
    options.context.action,
    options.cacheKey,
  );
  const readLog = async (
    name: "stdout" | "stderr",
    metadata: LocalCacheBlob,
  ): Promise<string> => {
    const path = join(root, `${name}.log`);
    const content = await digestArtifactPath(path, "file");
    if (content.digest !== metadata.digest || content.size !== metadata.size) {
      throw corruptCacheError(
        options.context.action.id,
        options.cacheKey,
        `${name} failed verification`,
      );
    }
    return await readFile(path, "utf8");
  };
  const [stdout, stderr] = await Promise.all([
    readLog("stdout", manifest.stdout),
    readLog("stderr", manifest.stderr),
  ]);
  const outputsRoot = join(root, "outputs");
  const storedEntries = await readdir(outputsRoot, { withFileTypes: true });
  const expectedNames = manifest.outputs.map((_, index) => outputCacheName(index));
  const actualNames = storedEntries.map(({ name }) => name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw corruptCacheError(
      options.context.action.id,
      options.cacheKey,
      "stored output set does not match the manifest",
    );
  }

  const restored: MaterializedArtifact[] = [];
  for (const [index, output] of manifest.outputs.entries()) {
    const expectedDefinition = options.context.artifactsById.get(output.id);
    const destination = options.outputPaths.get(output.id);
    const storedEntry = storedEntries.find(
      ({ name }) => name === outputCacheName(index),
    );
    if (
      expectedDefinition === undefined ||
      destination === undefined ||
      expectedDefinition.entryType !== output.entryType ||
      storedEntry === undefined ||
      (output.entryType === "file" && !storedEntry.isFile()) ||
      (output.entryType === "directory" && !storedEntry.isDirectory())
    ) {
      throw corruptCacheError(
        options.context.action.id,
        options.cacheKey,
        `stored output ${output.id} has the wrong type`,
      );
    }
    const source = join(outputsRoot, outputCacheName(index));
    const sourceEntry = await stat(source);
    const sourceContent = await digestArtifactPath(source, output.entryType);
    if (
      sourceContent.digest !== output.digest ||
      sourceContent.size !== output.size ||
      (sourceEntry.mode & 0o7777) !== output.mode
    ) {
      throw corruptCacheError(
        options.context.action.id,
        options.cacheKey,
        `stored output ${output.id} failed verification`,
      );
    }
    await copyArtifactPath(source, destination, output.entryType, output.mode);
    const restoredContent = await digestArtifactPath(destination, output.entryType);
    if (
      restoredContent.digest !== output.digest ||
      restoredContent.size !== output.size
    ) {
      throw corruptCacheError(
        options.context.action.id,
        options.cacheKey,
        `materialized output ${output.id} failed verification`,
      );
    }
    restored.push(Object.freeze({
      id: output.id,
      path: destination,
      entryType: output.entryType,
      digest: output.digest,
      size: output.size,
    }));
  }
  return Object.freeze({
    stdout,
    stderr,
    outputs: Object.freeze(restored),
  });
}

export async function publishActionToCache(options: {
  readonly cache: PreparedArtifactCache;
  readonly context: ArtifactActionCacheContext;
  readonly cacheKey: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputs: readonly MaterializedArtifact[];
}): Promise<void> {
  const finalRoot = entryRoot(options.cache, options.cacheKey);
  try {
    const existing = await lstat(finalRoot);
    if (existing.isDirectory() && !existing.isSymbolicLink()) return;
    throw corruptCacheError(
      options.context.action.id,
      options.cacheKey,
      "publication target is not a directory",
    );
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }

  const temporaryRoot = await mkdtemp(join(options.cache.entriesRoot, ".publish-"));
  let published = false;
  try {
    const outputsRoot = join(temporaryRoot, "outputs");
    await mkdir(outputsRoot);
    const outputById = new Map(options.outputs.map((output) => [output.id, output]));
    const manifestOutputs: LocalCacheOutput[] = [];
    for (const [index, outputId] of options.context.action.outputs.entries()) {
      const output = outputById.get(outputId);
      if (output === undefined) {
        throw new ArtifactExecutionError(
          `Action ${options.context.action.id} cannot publish missing output ${outputId}`,
          { actionId: options.context.action.id },
        );
      }
      const outputEntry = await stat(output.path);
      const mode = outputEntry.mode & 0o7777;
      const destination = join(outputsRoot, outputCacheName(index));
      await copyArtifactPath(output.path, destination, output.entryType, mode);
      const copied = await digestArtifactPath(destination, output.entryType);
      if (copied.digest !== output.digest || copied.size !== output.size) {
        throw new ArtifactExecutionError(
          `Action ${options.context.action.id} changed while publishing cache output ${outputId}`,
          { actionId: options.context.action.id },
        );
      }
      manifestOutputs.push({
        id: output.id,
        entryType: output.entryType,
        digest: output.digest,
        size: output.size,
        mode,
      });
    }
    const writeLog = async (
      name: "stdout" | "stderr",
      value: string,
    ): Promise<LocalCacheBlob> => {
      const path = join(temporaryRoot, `${name}.log`);
      await writeFile(path, value, { encoding: "utf8", flag: "wx" });
      return await digestArtifactPath(path, "file");
    };
    const [stdout, stderr] = await Promise.all([
      writeLog("stdout", options.stdout),
      writeLog("stderr", options.stderr),
    ]);
    const manifest: LocalCacheManifest = {
      schema: "native-typescript.local-action-cache",
      schemaVersion: 1,
      actionKey: options.cacheKey,
      stdout,
      stderr,
      outputs: manifestOutputs,
    };
    await writeFile(
      join(temporaryRoot, "manifest.json"),
      `${JSON.stringify(manifest)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    try {
      await rename(temporaryRoot, finalRoot);
      published = true;
    } catch (error) {
      if (
        !isNodeError(error) ||
        (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")
      ) {
        throw error;
      }
      const winner = await lstat(finalRoot);
      if (!winner.isDirectory() || winner.isSymbolicLink()) {
        throw corruptCacheError(
          options.context.action.id,
          options.cacheKey,
          "concurrent publication target is invalid",
        );
      }
    }
  } finally {
    if (!published) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}
