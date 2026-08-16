import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { ArtifactExecutionError } from "@native-typescript/core";
import {
  buildGtkApplication,
  parseGtkApplicationProject,
} from "@native-typescript/target-gtk";

/**
 * `native-typescript build` — the command that turns a project description
 * into a native executable.
 *
 * Everything it knows about GTK it gets from the target package. What belongs
 * here is only what a command line owes its user: locating the project,
 * finding the tools the build needs, reporting a missing one as the thing to
 * install rather than as a stack trace, and putting the product somewhere the
 * user can run it.
 */

export const projectFileName = "native-typescript.json";

interface BuildOptions {
  readonly projectRoot: string;
  readonly outputDirectory: string;
  readonly backend: "c" | "llvm";
  readonly keepIntermediates: boolean;
  /** Absent disables the action cache for this build. */
  readonly cacheDirectory: string | undefined;
}

function locateExecutable(name: string): string | undefined {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching explicit PATH entries.
    }
  }
  return undefined;
}

/* Each of these is a distinct thing to install, so they are reported together
 * rather than one failure per run. */
const requiredTools = [
  ["clang", "clang", "the C compiler every native action runs"],
  ["pkgConfig", "pkg-config", "resolves the GTK SDK"],
  ["sandbox", "bwrap", "bubblewrap, which isolates every build action"],
] as const;

function parseBuildOptions(
  argv: readonly string[],
): BuildOptions | string {
  let projectRoot = process.cwd();
  let outputDirectory: string | undefined;
  let backend: "c" | "llvm" = "c";
  let keepIntermediates = false;
  let cacheDirectory: string | undefined;
  let cacheDisabled = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const value = argv[index + 1];
    if (argument === "--backend") {
      if (value !== "c" && value !== "llvm") {
        return "--backend takes 'c' or 'llvm'";
      }
      backend = value;
      index += 1;
    } else if (argument === "--out") {
      if (value === undefined) return "--out takes a directory";
      outputDirectory = resolve(value);
      index += 1;
    } else if (argument === "--cache") {
      if (value === undefined) return "--cache takes a directory";
      cacheDirectory = resolve(value);
      index += 1;
    } else if (argument === "--no-cache") {
      cacheDisabled = true;
    } else if (argument === "--keep-intermediates") {
      keepIntermediates = true;
    } else if (argument.startsWith("-")) {
      return `Unknown option: ${argument}`;
    } else {
      projectRoot = resolve(argument);
    }
  }
  if (cacheDisabled && cacheDirectory !== undefined) {
    return "--cache and --no-cache cannot both be given";
  }
  return {
    projectRoot,
    outputDirectory: outputDirectory ?? join(projectRoot, "dist"),
    backend,
    keepIntermediates,
    cacheDirectory: cacheDisabled
      ? undefined
      : (cacheDirectory ?? join(projectRoot, ".native-typescript/cache")),
  };
}

export async function runBuild(argv: readonly string[]): Promise<number> {
  const options = parseBuildOptions(argv);
  if (typeof options === "string") {
    process.stderr.write(`${options}\n`);
    return 2;
  }

  const projectPath = join(options.projectRoot, projectFileName);
  if (!existsSync(projectPath)) {
    process.stderr.write(
      `No ${projectFileName} in ${options.projectRoot}\n` +
        `Pass a project directory: native-typescript build <directory>\n`,
    );
    return 1;
  }

  let project;
  try {
    project = parseGtkApplicationProject(readFileSync(projectPath, "utf8"));
  } catch (cause) {
    process.stderr.write(`${projectPath}${(cause as Error).message}\n`);
    return 1;
  }

  const tools: Record<string, string> = { node: process.execPath };
  const missing: string[] = [];
  for (const [key, name, purpose] of requiredTools) {
    const found = locateExecutable(name);
    if (found === undefined) missing.push(`  ${name} — ${purpose}`);
    else tools[key] = found;
  }
  if (missing.length > 0) {
    process.stderr.write(
      `Cannot build: these tools are not on PATH\n${missing.join("\n")}\n`,
    );
    return 1;
  }

  const scratch = mkdtempSync(join(tmpdir(), `nts-build-${project.name}-`));
  try {
    const result = await buildGtkApplication({
      projectRoot: options.projectRoot,
      project,
      scratch,
      backend: options.backend,
      tools: {
        clang: tools["clang"]!,
        node: tools["node"]!,
        pkgConfig: tools["pkgConfig"]!,
        sandbox: tools["sandbox"]!,
      },
      ...(options.cacheDirectory === undefined
        ? {}
        : { cachePath: options.cacheDirectory }),
    });
    mkdirSync(options.outputDirectory, { recursive: true });
    /* The product's path inside the build root is content-addressed. A user
     * asked for a program, not a digest, so it lands under the name the
     * project gave it. */
    const destination = join(options.outputDirectory, project.output);
    copyFileSync(result.productPath, destination);
    process.stdout.write(`${destination}\n`);
    return 0;
  } catch (cause) {
    process.stderr.write(`${(cause as Error).message}\n`);
    /* A failing action's own diagnostics are the answer the user needs. The
     * executor captures them so a sandboxed process cannot write over the
     * build's output, which means someone has to hand them back. */
    if (cause instanceof ArtifactExecutionError) {
      for (const [stream, text] of [
        ["stderr", cause.stderr],
        ["stdout", cause.stdout],
      ] as const) {
        if (text.trim().length === 0) continue;
        process.stderr.write(`\n${cause.actionId ?? "action"} ${stream}:\n`);
        process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
      }
    }
    return 1;
  } finally {
    if (options.keepIntermediates) {
      process.stderr.write(`intermediates: ${scratch}\n`);
    } else {
      rmSync(scratch, { force: true, recursive: true });
    }
  }
}
