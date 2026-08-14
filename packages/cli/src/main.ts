#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { inspectWorkspace } from "@native-typescript/core";

const version = "0.0.0";

function writeHelp(): void {
  process.stdout.write(`native-typescript ${version}

Usage:
  native-typescript <command>

Commands:
  doctor      Verify the local compiler checkout
  help        Show this help

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

function run(args: readonly string[]): number {
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

  process.stderr.write(`Unknown command: ${command}\n`);
  writeHelp();
  return 1;
}

process.exitCode = run(process.argv.slice(2));

