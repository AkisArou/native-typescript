#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, parse, resolve } from "node:path";
import { readPinnedChromiumRevision } from "../src/revision.ts";
import { commandOutput, reportError, runCommand } from "./support.ts";

interface Options {
  readonly checkoutRoot: string;
  readonly depotTools: string;
  readonly runHooks: boolean;
}

function usage(): string {
  return [
    "Usage: node scripts/sync-chromium.ts /path/to/checkout-root",
    "  --depot-tools /path/to/depot_tools [--no-hooks]",
  ].join("\n");
}

function parseOptions(arguments_: readonly string[]): Options | null {
  if (arguments_.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const checkoutArgument = arguments_[0];
  if (checkoutArgument === undefined || checkoutArgument.startsWith("-")) {
    throw new Error(usage());
  }

  let depotTools: string | undefined;
  let runHooks = true;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--no-hooks") {
      runHooks = false;
      continue;
    }
    if (argument !== "--depot-tools") {
      throw new Error(`Unknown argument: ${argument}\n${usage()}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error("--depot-tools requires a value");
    depotTools = resolve(value);
    index += 1;
  }
  if (depotTools === undefined) throw new Error(usage());
  return Object.freeze({
    checkoutRoot: resolve(checkoutArgument),
    depotTools,
    runHooks,
  });
}

function assertNarrowCheckoutRoot(root: string): void {
  const filesystemRoot = parse(root).root;
  if (root === filesystemRoot || root === homedir() || root === dirname(root)) {
    throw new Error(`Refusing unsafe Chromium checkout root: ${root}`);
  }
}

function hasCommit(source: string, revision: string): boolean {
  try {
    commandOutput("git", ["cat-file", "-e", `${revision}^{commit}`], source);
    return true;
  } catch {
    return false;
  }
}

function ensureGclientConfiguration(
  checkoutRoot: string,
  gclient: string,
): void {
  const configuration = resolve(checkoutRoot, ".gclient");
  if (existsSync(configuration)) return;
  const entries = readdirSync(checkoutRoot);
  if (entries.length > 0) {
    throw new Error(
      `Chromium checkout root is non-empty and has no .gclient: ${checkoutRoot}`,
    );
  }

  const repository = readPinnedChromiumRevision().repository;
  const spec = [
    "solutions = [",
    "  {",
    '    "name": "src",',
    `    "url": ${JSON.stringify(repository)},`,
    '    "managed": False,',
    '    "custom_deps": {},',
    '    "custom_vars": {},',
    "  },",
    "]",
  ].join("\n");
  runCommand(gclient, ["config", "--spec", spec], checkoutRoot);
}

function main(arguments_: readonly string[]): void {
  const options = parseOptions(arguments_);
  if (options === null) return;
  assertNarrowCheckoutRoot(options.checkoutRoot);

  const gclient = resolve(options.depotTools, "gclient");
  if (!existsSync(gclient)) {
    throw new Error(`depot_tools gclient does not exist: ${gclient}`);
  }

  mkdirSync(options.checkoutRoot, { recursive: true });
  ensureGclientConfiguration(options.checkoutRoot, gclient);
  const revision = readPinnedChromiumRevision();
  const { repository, revision: pin } = revision;
  const source = resolve(options.checkoutRoot, "src");
  if (!existsSync(resolve(source, ".git"))) {
    if (existsSync(source) && readdirSync(source).length > 0) {
      throw new Error(`Chromium source directory is non-empty: ${source}`);
    }
    mkdirSync(source, { recursive: true });
    runCommand("git", ["init", "--object-format=sha1"], source);
    runCommand("git", ["remote", "add", "origin", repository], source);
  } else {
    const status = commandOutput("git", ["status", "--porcelain"], source);
    if (status.length > 0) {
      throw new Error(`Chromium source checkout must be clean: ${source}`);
    }
  }

  const origin = commandOutput("git", ["remote", "get-url", "origin"], source)
    .replace(/\.git$/u, "");
  if (origin !== repository.replace(/\.git$/u, "")) {
    throw new Error(
      `Chromium origin mismatch: expected ${repository}, got ${origin}`,
    );
  }
  if (!hasCommit(source, pin)) {
    runCommand("git", ["fetch", "origin", pin, "--depth=1"], source);
  }
  runCommand("git", ["checkout", "--detach", pin], source);

  runCommand(
    gclient,
    [
      "sync",
      "--nohooks",
      "--no-history",
      "--delete_unversioned_trees",
    ],
    options.checkoutRoot,
  );

  const head = commandOutput("git", ["rev-parse", "HEAD"], source);
  if (head !== pin) {
    throw new Error(`Chromium revision mismatch: expected ${pin}, got ${head}`);
  }
  if (options.runHooks) runCommand(gclient, ["runhooks"], options.checkoutRoot);
  process.stdout.write(`Chromium checkout is ready at ${source}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  reportError(error);
}
