import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import {
  digestArtifactPath,
} from "./artifact-graph.ts";
import type {
  ArtifactActionInputArgument,
  ArtifactDefinition,
} from "./artifact-graph.ts";

export interface PkgConfigModuleSnapshot {
  readonly name: string;
  readonly version: string;
}

export interface PkgConfigResolverSnapshot {
  readonly pathDigest: string;
  readonly version: string;
}

export interface ResolvedPkgConfigSdk {
  readonly id: string;
  readonly resolver: PkgConfigResolverSnapshot;
  readonly modules: readonly PkgConfigModuleSnapshot[];
  readonly artifacts: readonly ArtifactDefinition[];
  readonly sourcePaths: Readonly<Record<string, string>>;
  readonly compileArguments: readonly ArtifactActionInputArgument[];
  readonly systemLibraries: readonly string[];
}

interface ParsedFragment {
  readonly value: string;
}

function parseFragments(source: string): readonly ParsedFragment[] {
  const fragments: ParsedFragment[] = [];
  let value = "";
  let started = false;
  let quote: "single" | "double" | null = null;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote === null && /\s/u.test(character)) {
      if (started) {
        fragments.push(Object.freeze({ value }));
        value = "";
        started = false;
      }
      continue;
    }
    if (quote === null && (character === "'" || character === "\"")) {
      quote = character === "'" ? "single" : "double";
      started = true;
      continue;
    }
    if (
      (character === "'" && quote === "single") ||
      (character === "\"" && quote === "double")
    ) {
      quote = null;
      continue;
    }
    if (character === "\\" && quote !== "single") {
      index += 1;
      if (index >= source.length) {
        throw new Error("pkg-config emitted a trailing escape");
      }
      value += source[index]!;
      started = true;
      continue;
    }
    value += character;
    started = true;
  }
  if (quote !== null) throw new Error("pkg-config emitted an unterminated quote");
  if (started) fragments.push(Object.freeze({ value }));
  return Object.freeze(fragments);
}

async function runPkgConfig(options: {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(options.executable, [...options.arguments], {
      env: { LC_ALL: "C", ...options.environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(
            `pkg-config ${options.arguments.join(" ")} failed with ${
              signal === null ? `exit code ${code}` : `signal ${signal}`
            }: ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

function takeIncludePath(
  fragments: readonly ParsedFragment[],
  index: number,
): { readonly path: string; readonly consumed: number } | null {
  const value = fragments[index]?.value;
  if (value === undefined) return null;
  if (value === "-I" || value === "-isystem") {
    const path = fragments[index + 1]?.value;
    if (path === undefined || path.length === 0) {
      throw new Error(`pkg-config emitted ${value} without a path`);
    }
    return { path, consumed: 2 };
  }
  if (value.startsWith("-I") && value.length > 2) {
    return { path: value.slice(2), consumed: 1 };
  }
  if (value.startsWith("-isystem") && value.length > 8) {
    return { path: value.slice(8), consumed: 1 };
  }
  return null;
}

export async function resolvePkgConfigSdk(options: {
  readonly id: string;
  readonly executable: string;
  readonly modules: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly target: string;
}): Promise<ResolvedPkgConfigSdk> {
  if (!isAbsolute(options.executable)) {
    throw new Error("pkg-config resolution requires an absolute executable path");
  }
  if (options.modules.length === 0) {
    throw new Error("pkg-config resolution requires at least one module");
  }
  const environment = options.environment ?? {};
  const [resolverContent, resolverVersion, cflags, libraries, ...moduleVersions] =
    await Promise.all([
      digestArtifactPath(options.executable, "file"),
      runPkgConfig({
        executable: options.executable,
        arguments: ["--version"],
        environment,
      }),
      runPkgConfig({
        executable: options.executable,
        arguments: ["--cflags", ...options.modules],
        environment,
      }),
      runPkgConfig({
        executable: options.executable,
        arguments: ["--libs", ...options.modules],
        environment,
      }),
      ...options.modules.map(async (module) => await runPkgConfig({
        executable: options.executable,
        arguments: ["--modversion", module],
        environment,
      })),
    ]);

  const systemLibraries: string[] = [];
  for (const fragment of parseFragments(libraries)) {
    if (!fragment.value.startsWith("-l") || fragment.value.length === 2) {
      throw new Error(
        `pkg-config emitted an unsupported system-library fragment: ${fragment.value}`,
      );
    }
    const name = fragment.value.slice(2);
    if (!/^[A-Za-z0-9_+.-]+$/u.test(name)) {
      throw new Error(`pkg-config emitted an invalid system-library name: ${name}`);
    }
    if (!systemLibraries.includes(name)) systemLibraries.push(name);
  }

  const fragments = parseFragments(cflags);
  const parsed: Array<
    | { readonly kind: "literal"; readonly value: string }
    | { readonly kind: "include"; readonly path: string }
  > = [];
  for (let index = 0; index < fragments.length;) {
    const include = takeIncludePath(fragments, index);
    if (include !== null) {
      parsed.push({ kind: "include", path: include.path });
      index += include.consumed;
      continue;
    }
    const value = fragments[index]!.value;
    if (isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value)) {
      throw new Error(`pkg-config emitted an unclassified absolute path: ${value}`);
    }
    parsed.push({ kind: "literal", value });
    index += 1;
  }

  const includePaths: string[] = [];
  for (const fragment of parsed) {
    if (fragment.kind !== "include") continue;
    const path = await realpath(fragment.path);
    if (!includePaths.includes(path)) includePaths.push(path);
  }
  const resolvedIncludes = await Promise.all(
    includePaths.map(async (path, index) => {
      const artifactId = `sdk/pkg-config/${options.id}/include/${index}`;
      const content = await digestArtifactPath(path, "directory");
      const artifact: ArtifactDefinition = {
        id: artifactId,
        kind: "sdk",
        entryType: "directory",
        mediaType: "inode/directory",
        target: options.target,
        domain: "target",
        cache: "none",
        origin: {
          kind: "source",
          digest: content.digest,
          fileName: `include-${index}`,
          logicalPath: `sdk/pkg-config/${options.id}/include/${index}`,
        },
      };
      return { artifact, path };
    }),
  );
  const artifactIdByPath = new Map(
    resolvedIncludes.map(({ artifact, path }) => [path, artifact.id]),
  );
  const arguments_: ArtifactActionInputArgument[] = [];
  for (const fragment of parsed) {
    if (fragment.kind === "literal") {
      arguments_.push(Object.freeze({ kind: "literal", value: fragment.value }));
      continue;
    }
    const path = await realpath(fragment.path);
    const artifact = artifactIdByPath.get(path);
    if (artifact === undefined) throw new Error(`Lost resolved include directory ${path}`);
    arguments_.push(
      Object.freeze({ kind: "literal", value: "-isystem" }),
      Object.freeze({ kind: "input-path", artifact }),
    );
  }

  return Object.freeze({
    id: options.id,
    resolver: Object.freeze({
      pathDigest: resolverContent.digest,
      version: resolverVersion,
    }),
    modules: Object.freeze(options.modules.map((name, index) => Object.freeze({
      name,
      version: moduleVersions[index]!,
    }))),
    artifacts: Object.freeze(resolvedIncludes.map(({ artifact }) => Object.freeze({
      ...artifact,
      origin: Object.freeze({ ...artifact.origin }),
    }))),
    sourcePaths: Object.freeze(Object.fromEntries(
      resolvedIncludes.map(({ artifact, path }) => [artifact.id, path]),
    )),
    compileArguments: Object.freeze(arguments_),
    systemLibraries: Object.freeze(systemLibraries),
  });
}
