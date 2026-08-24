#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { readPinnedChromiumRevision } from "../src/revision.ts";
import {
  type ChromiumPatchProfile,
  chromiumInstallPath,
  chromiumOverlayRoot,
  chromiumPatchRoot,
  commandOutput,
  packageRoot,
  parsePatchProfile,
  readPatchSeries,
  reportError,
  runCommand,
} from "./support.ts";

interface Options {
  readonly checkout: string;
  readonly profile: ChromiumPatchProfile;
  readonly refresh: boolean;
}

function copyTree(sourceRoot: string, destinationRoot: string): void {
  mkdirSync(destinationRoot, { recursive: true });
  const entries = readdirSync(sourceRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      copyTree(
        resolve(sourceRoot, entry.name),
        resolve(destinationRoot, entry.name),
      );
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported overlay entry: ${resolve(sourceRoot, entry.name)}`);
    }
    const source = resolve(sourceRoot, entry.name);
    const destination = resolve(destinationRoot, entry.name);
    if (
      existsSync(destination) &&
      readFileSync(source).equals(readFileSync(destination))
    ) {
      continue;
    }
    copyFileSync(source, destination);
  }
}

function copyOverlay(checkout: string): string {
  const destination = resolve(checkout, chromiumInstallPath);
  copyTree(chromiumOverlayRoot, destination);
  const header = resolve(packageRoot, "prototype/include/nts_web.h");
  const installedHeader = resolve(destination, "nts_web.h");
  if (
    !existsSync(installedHeader) ||
    !readFileSync(header).equals(readFileSync(installedHeader))
  ) {
    copyFileSync(header, installedHeader);
  }
  copyTree(
    resolve(packageRoot, "prototype/src/runtime"),
    resolve(destination, "runtime"),
  );
  copyTree(
    resolve(packageRoot, "prototype/examples/counter"),
    resolve(destination, "counter"),
  );
  copyTree(
    resolve(packageRoot, "prototype/examples/create-element"),
    resolve(destination, "create-element"),
  );
  return destination;
}

function usage(): string {
  return [
    "Usage: node scripts/apply-chromium.ts /path/to/chromium/src",
    "  [--profile product|fixture|all] [--refresh]",
  ].join("\n");
}

function parseOptions(arguments_: readonly string[]): Options | null {
  if (arguments_.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const checkout = arguments_[0];
  if (checkout === undefined || checkout.startsWith("-")) {
    throw new Error(usage());
  }

  let profile: ChromiumPatchProfile = "all";
  let refresh = false;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--refresh") {
      refresh = true;
      continue;
    }
    if (argument !== "--profile") {
      throw new Error(`Unknown argument: ${argument}\n${usage()}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error("--profile requires a value");
    profile = parsePatchProfile(value);
    index += 1;
  }
  return Object.freeze({ checkout: resolve(checkout), profile, refresh });
}

function isKnownRefreshPath(path: string): boolean {
  return path === "content/shell/BUILD.gn" ||
    path === "content/shell/browser/shell_content_browser_client.cc" ||
    path === "content/shell/renderer/shell_content_renderer_client.cc" ||
    path ===
      "third_party/blink/renderer/platform/bindings/exception_state.cc" ||
    path ===
      "third_party/blink/renderer/platform/bindings/exception_state_capture.h" ||
    path.startsWith(`${chromiumInstallPath}/`);
}

function patchCheck(
  checkout: string,
  patch: string,
  reverse: boolean,
): boolean {
  try {
    commandOutput(
      "git",
      ["apply", ...(reverse ? ["--reverse"] : []), "--check", patch],
      checkout,
    );
    return true;
  } catch {
    return false;
  }
}

function main(arguments_: readonly string[]): void {
  const options = parseOptions(arguments_);
  if (options === null) return;

  const { checkout, profile, refresh } = options;
  if (!existsSync(resolve(checkout, ".git"))) {
    throw new Error(`Not a Chromium git checkout: ${checkout}`);
  }

  const pin = readPinnedChromiumRevision().revision;
  const head = commandOutput("git", ["rev-parse", "HEAD"], checkout);
  if (head !== pin) {
    throw new Error(`Chromium revision mismatch: expected ${pin}, got ${head}`);
  }
  const status = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: checkout, encoding: "utf8" },
  ).trimEnd();
  if (status.length > 0 && !refresh) {
    throw new Error(
      "Chromium checkout must be clean before applying the overlay; " +
        "use --refresh only for a checkout previously staged by this command",
    );
  }
  if (refresh) {
    const statusLines = status.length === 0 ? [] : status.split("\n");
    const unknown = statusLines.filter((line) =>
      line.length < 4 || !isKnownRefreshPath(line.slice(3))
    );
    if (unknown.length > 0) {
      throw new Error(
        `Chromium refresh found changes outside the owned fixture:\n${unknown.join("\n")}`,
      );
    }
  }

  const selectedPatches = new Set(readPatchSeries(profile));
  if (refresh) {
    for (const name of readPatchSeries("all")) {
      if (selectedPatches.has(name)) continue;
      const patch = resolve(chromiumPatchRoot, name);
      if (patchCheck(checkout, patch, true)) {
        runCommand("git", ["apply", "--reverse", patch], checkout);
        process.stdout.write(`removed ${name}\n`);
        continue;
      }
      if (!patchCheck(checkout, patch, false)) {
        throw new Error(`Chromium checkout has a partial or conflicting patch: ${name}`);
      }
    }
  }

  for (const name of selectedPatches) {
    const patch = resolve(chromiumPatchRoot, name);
    if (refresh && patchCheck(checkout, patch, true)) {
      process.stdout.write(`already applied ${name}\n`);
      continue;
    }
    if (refresh && !patchCheck(checkout, patch, false)) {
      throw new Error(`Chromium checkout has a partial or conflicting patch: ${name}`);
    }
    runCommand("git", ["apply", "--check", patch], checkout);
    runCommand("git", ["apply", patch], checkout);
    process.stdout.write(`applied ${name}\n`);
  }

  const destination = copyOverlay(checkout);
  process.stdout.write(
    [
      `applied Chromium patch profile: ${profile}`,
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
