#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { readPinnedChromiumRevision } from "../src/revision.ts";
import {
  chromiumInstallPath,
  chromiumOverlayRoot,
  chromiumPatchRoot,
  commandOutput,
  packageRoot,
  readPatchSeries,
  reportError,
  runCommand,
} from "./support.ts";

function copyFiles(sourceRoot: string, destinationRoot: string): void {
  mkdirSync(destinationRoot, { recursive: true });
  const entries = readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    copyFileSync(
      resolve(sourceRoot, entry.name),
      resolve(destinationRoot, entry.name),
    );
  }
}

function copyOverlay(checkout: string): string {
  const destination = resolve(checkout, chromiumInstallPath);
  copyFiles(chromiumOverlayRoot, destination);
  copyFileSync(
    resolve(packageRoot, "prototype/include/nts_web.h"),
    resolve(destination, "nts_web.h"),
  );
  copyFiles(
    resolve(packageRoot, "prototype/src/runtime"),
    resolve(destination, "runtime"),
  );
  copyFiles(
    resolve(packageRoot, "prototype/examples/counter"),
    resolve(destination, "counter"),
  );
  return destination;
}

function usage(): string {
  return "Usage: node scripts/apply-chromium.ts /path/to/chromium/src";
}

function main(arguments_: readonly string[]): void {
  if (arguments_.length !== 1 || arguments_[0] === "--help") {
    if (arguments_[0] === "--help") {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    throw new Error(usage());
  }

  const checkout = resolve(arguments_[0]!);
  if (!existsSync(resolve(checkout, ".git"))) {
    throw new Error(`Not a Chromium git checkout: ${checkout}`);
  }

  const pin = readPinnedChromiumRevision().revision;
  const head = commandOutput("git", ["rev-parse", "HEAD"], checkout);
  if (head !== pin) {
    throw new Error(`Chromium revision mismatch: expected ${pin}, got ${head}`);
  }
  if (commandOutput("git", ["status", "--porcelain"], checkout).length > 0) {
    throw new Error("Chromium checkout must be clean before applying the overlay");
  }

  for (const name of readPatchSeries()) {
    const patch = resolve(chromiumPatchRoot, name);
    runCommand("git", ["apply", "--check", patch], checkout);
    runCommand("git", ["apply", patch], checkout);
    process.stdout.write(`applied ${name}\n`);
  }

  const destination = copyOverlay(checkout);
  process.stdout.write(
    [
      `installed Native TypeScript Blink bridge at ${destination}`,
      "GN bridge: //third_party/blink/renderer/native_typescript:nts_blink_bridge",
      "GN counter: //third_party/blink/renderer/native_typescript:nts_counter_example",
      "",
    ].join("\n"),
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  reportError(error);
}
