import { resolve } from "node:path";
import type { ArtifactDefinition } from "./artifact-graph.ts";
import { digestArtifactPath } from "./artifact-io.ts";

export interface SourceArtifactResolution {
  readonly artifact: ArtifactDefinition;
  readonly sourcePath: string;
}

export async function resolveSourceArtifact(input: {
  readonly id: string;
  readonly path: string;
  readonly entryType: "file" | "directory";
  readonly kind: ArtifactDefinition["kind"];
  readonly mediaType: string;
  readonly target: string;
  readonly domain: ArtifactDefinition["domain"];
  readonly cache: ArtifactDefinition["cache"];
  readonly fileName: string;
  readonly logicalPath: string;
}): Promise<SourceArtifactResolution> {
  const sourcePath = resolve(input.path);
  const content = await digestArtifactPath(sourcePath, input.entryType);
  return Object.freeze({
    artifact: Object.freeze({
      id: input.id,
      kind: input.kind,
      entryType: input.entryType,
      mediaType: input.mediaType,
      target: input.target,
      domain: input.domain,
      cache: input.cache,
      origin: Object.freeze({
        kind: "source",
        digest: content.digest,
        fileName: input.fileName,
        logicalPath: input.logicalPath,
      }),
    }),
    sourcePath,
  });
}
