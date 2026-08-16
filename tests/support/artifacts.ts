import { accessSync, constants, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, join } from "node:path";
import { resolveSourceArtifact } from "@native-typescript/core";
import type { ArtifactDefinition } from "@native-typescript/core";

/**
 * Artifact helpers shared by the gates that build real executables. These say
 * nothing about what is being built — they only spell one source tree or one
 * source file as an artifact the graph can name.
 */

export const nativeTarget = "x86_64-unknown-linux-gnu";
export const executionPlatform = "x86_64-linux";

export function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

export function executable(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching explicit PATH entries.
    }
  }
  throw new Error(`Required executable is unavailable: ${name}`);
}

export async function sourceArtifact(options: {
  readonly id: string;
  readonly path: string;
  readonly fileName: string;
  readonly logicalPath: string;
  readonly target?: string;
  readonly domain?: ArtifactDefinition["domain"];
}): Promise<ArtifactDefinition> {
  const resolved = await resolveSourceArtifact({
    id: options.id,
    path: options.path,
    kind: "source-tree",
    entryType: "directory",
    mediaType: "inode/directory",
    target: options.target ?? nativeTarget,
    domain: options.domain ?? "target",
    cache: "exportable",
    fileName: options.fileName,
    logicalPath: options.logicalPath,
  });
  return resolved.artifact;
}

export async function sourceFileArtifact(options: {
  readonly id: string;
  readonly path: string;
  readonly fileName: string;
  readonly logicalPath: string;
  readonly kind: ArtifactDefinition["kind"];
  readonly mediaType: string;
  readonly domain: ArtifactDefinition["domain"];
  readonly cache: ArtifactDefinition["cache"];
  readonly target?: string;
}): Promise<ArtifactDefinition> {
  const resolved = await resolveSourceArtifact({
    id: options.id,
    path: options.path,
    kind: options.kind,
    entryType: "file",
    mediaType: options.mediaType,
    target: options.target ?? nativeTarget,
    domain: options.domain,
    cache: options.cache,
    fileName: options.fileName,
    logicalPath: options.logicalPath,
  });
  return resolved.artifact;
}
