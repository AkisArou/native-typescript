import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export class ArtifactExecutionError extends Error {
  override readonly name = "ArtifactExecutionError";
  readonly actionId: string | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    message: string,
    options: {
      readonly actionId?: string;
      readonly stdout?: string;
      readonly stderr?: string;
    } = {},
  ) {
    super(message);
    this.actionId = options.actionId ?? null;
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
  }
}

async function digestFile(path: string): Promise<{ digest: string; size: number }> {
  const bytes = await readFile(path);
  return {
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size: bytes.byteLength,
  };
}

function updateLength(hash: ReturnType<typeof createHash>, value: number): void {
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(BigInt(value));
  hash.update(encoded);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function digestDirectory(root: string): Promise<{ digest: string; size: number }> {
  const hash = createHash("sha256");
  hash.update("native-typescript.directory.v1\0");
  let size = 0;

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareText(left.name, right.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath =
        relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        const encodedPath = Buffer.from(relativePath, "utf8");
        hash.update("d");
        updateLength(hash, encodedPath.byteLength);
        hash.update(encodedPath);
        await visit(path, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new ArtifactExecutionError(
          `Directory artifact contains unsupported entry ${relativePath}`,
        );
      }
      const bytes = await readFile(path);
      const encodedPath = Buffer.from(relativePath, "utf8");
      hash.update("f");
      updateLength(hash, encodedPath.byteLength);
      hash.update(encodedPath);
      updateLength(hash, bytes.byteLength);
      hash.update(bytes);
      size += bytes.byteLength;
    }
  }

  await visit(root, "");
  return { digest: `sha256:${hash.digest("hex")}`, size };
}

export async function digestArtifactPath(
  path: string,
  entryType: "file" | "directory",
): Promise<{ digest: string; size: number }> {
  const entry = await stat(path);
  if (entryType === "file" && !entry.isFile()) {
    throw new ArtifactExecutionError(`Expected a regular file at ${path}`);
  }
  if (entryType === "directory" && !entry.isDirectory()) {
    throw new ArtifactExecutionError(`Expected a directory at ${path}`);
  }
  return entryType === "file" ? await digestFile(path) : await digestDirectory(path);
}
