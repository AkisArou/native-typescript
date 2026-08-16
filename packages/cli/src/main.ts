#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { inspectWorkspace } from "@native-typescript/core";
import { runBuild } from "./build.ts";

const version = "0.0.0";

function writeHelp(): void {
  process.stdout.write(`native-typescript ${version}

Usage:
  native-typescript <command>

Commands:
  build       Build a project into a native executable
  doctor      Verify the local compiler checkout
  help        Show this help

Build:
  native-typescript build [directory] [options]

  --backend <c|llvm>     Code generation backend (default: c)
  --out <directory>      Where to place the executable (default: <project>/dist)
  --cache <directory>    Action cache location
                         (default: <project>/.native-typescript/cache)
                         Covers binding generation only. Native compilation
                         re-runs every build, and the link — which rebuilds the
                         ScriptC runtime each time — dominates it.
  --no-cache             Run every action, caching nothing
  --keep-intermediates   Leave the scratch tree in place and print its path

Options:
  --help      Show this help
  --version   Show the CLI version
`);
}

function runDoctor(): number {
  const workspace = inspectWorkspace();
  const marker = resolve(workspace.compiler.path, "package.json");

  if (!existsSync(marker)) {
    process.stderr.write(
      `scriptc checkout not found at ${workspace.compiler.path}\n` +
        "Run: git submodule update --init --recursive\n",
    );
    return 1;
  }

  process.stdout.write(
    [
      `Node: ${process.version}`,
      `scriptc: ${workspace.compiler.path}`,
      `branch: ${workspace.compiler.branch}`,
      "status: ready",
      "",
    ].join("\n"),
  );
  return 0;
}

async function run(args: readonly string[]): Promise<number> {
  const command = args[0];

  if (command === undefined || command === "help" || command === "--help") {
    writeHelp();
    return 0;
  }

  if (command === "--version") {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  if (command === "doctor") {
    return runDoctor();
  }

  if (command === "build") {
    return await runBuild(args.slice(1));
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  writeHelp();
  return 1;
}

process.exitCode = await run(process.argv.slice(2));

