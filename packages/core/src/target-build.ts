/* What every target build assembles before it can plan anything.
 *
 * GTK and JVM each reconstructed this, identically — the two copies of the
 * helpers below differed by one trailing comma. That is the shape a shared
 * fact takes when it has no home: not a disagreement, a coincidence waiting to
 * stop being one, since nothing makes the second copy follow the first.
 *
 * WHAT BELONGS HERE is the part with no per-target asymmetry: a tool's
 * identity, a source tree as an artifact, and the execution environment a
 * graph runs in. Each is a question about THIS MACHINE — which clang, which
 * sandbox, which cache — and the answer cannot differ by target because the
 * question does not mention one.
 *
 * WHAT DOES NOT BELONG HERE, and the boundary matters more than the code:
 * anything a platform is allowed to be stricter about. Link flags are the
 * clearest case — Android requires `-Wl,--no-undefined` while a hosted desktop
 * library genuinely needs the permissive link, because its undefined JNI
 * symbols are supplied by the host that loads it. A common path that
 * normalised those would be choosing for a platform that had already chosen,
 * and the failure would appear as a library that loads everywhere except the
 * device. SDK arguments, product kinds and link lines stay with the target
 * that knows why they are what they are.
 */
import { digestArtifactPath } from "./artifact-io.ts";
import { resolveSourceArtifact } from "./source-artifact.ts";
import type {
  ArtifactActionDefinition,
  ArtifactCacheBinding,
  ArtifactDefinition,
  ArtifactSandboxBinding,
} from "./artifact-graph.ts";

/** A tool's identity, derived from the bytes rather than from what it calls
 * itself.
 *
 * A cache key that named `clang` would collide across two compilers that
 * answer to that name, so the digest IS the version: a build planned against
 * one toolchain can never read an entry produced by another. The short slice
 * is for reports, and the full digest is what decides. */
export async function toolIdentity(
  id: string,
  path: string,
): Promise<ArtifactActionDefinition["tool"]> {
  const content = await digestArtifactPath(path, "file");
  return Object.freeze({
    id,
    version: content.digest.slice(7, 19),
    digest: content.digest,
  });
}

/** A directory as one content-addressed artifact.
 *
 * Whole trees rather than file lists because a runtime is not a list of files
 * an enumeration might miss: adding a source to it must change the artifact,
 * and a digest over the tree says so without anyone maintaining a manifest
 * that can fall behind. */
export async function sourceTreeArtifact(options: {
  readonly id: string;
  readonly path: string;
  readonly fileName: string;
  readonly logicalPath: string;
  readonly target: string;
  readonly domain: ArtifactDefinition["domain"];
}): Promise<ArtifactDefinition> {
  const resolved = await resolveSourceArtifact({
    id: options.id,
    path: options.path,
    kind: "source-tree",
    entryType: "directory",
    mediaType: "inode/directory",
    target: options.target,
    domain: options.domain,
    cache: "exportable",
    fileName: options.fileName,
    logicalPath: options.logicalPath,
  });
  return resolved.artifact;
}

/** The machine-facing half of a build: which tools, which sandbox, which
 * cache. Everything here is settled before a single action is planned, and
 * none of it depends on what is being built. */
export interface TargetBuildEnvironment {
  readonly clangTool: ArtifactActionDefinition["tool"];
  readonly nodeTool: ArtifactActionDefinition["tool"];
  /** Tool paths keyed by identity, as `executeArtifactGraph` wants them. */
  readonly tools: Readonly<Record<string, { readonly path: string }>>;
  readonly sandbox: ArtifactSandboxBinding;
  /** Absent when the caller asked for no cache, which is not the same as an
   * empty one: a build with no cache never reads or writes entries. */
  readonly cache: ArtifactCacheBinding | undefined;
}

export async function resolveTargetBuildEnvironment(input: {
  readonly clang: string;
  readonly node: string;
  readonly sandbox: string;
  readonly cachePath?: string;
}): Promise<TargetBuildEnvironment> {
  const clangTool = await toolIdentity("tool/clang", input.clang);
  const nodeTool = await toolIdentity("tool/node", input.node);
  return Object.freeze({
    clangTool,
    nodeTool,
    tools: Object.freeze({
      [clangTool.id]: { path: input.clang },
      [nodeTool.id]: { path: input.node },
    }),
    sandbox: Object.freeze({ kind: "bubblewrap" as const, path: input.sandbox }),
    cache: input.cachePath === undefined
      ? undefined
      : Object.freeze({ kind: "local" as const, path: input.cachePath }),
  });
}
