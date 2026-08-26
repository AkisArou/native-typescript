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
  type ChromiumPatchRepository,
  type ChromiumPatchSpec,
  type ChromiumPatchProfile,
  chromiumInstallPath,
  chromiumOverlayRoot,
  chromiumV8RevisionFile,
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

function patchCheckout(checkout: string, repository: ChromiumPatchRepository): string {
  return repository === "chromium" ? checkout : resolve(checkout, "v8");
}

function patchKey(patch: ChromiumPatchSpec): string {
  return `${patch.repository}:${patch.name}`;
}

function patchTouchedPaths(patch: ChromiumPatchSpec): readonly string[] {
  const paths = new Set<string>();
  for (const line of readFileSync(patch.path, "utf8").split("\n")) {
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue;
    let value = line.slice(4).split("\t", 1)[0]!;
    if (value === "/dev/null") continue;
    if (value.startsWith("a/") || value.startsWith("b/")) value = value.slice(2);
    paths.add(value);
  }
  return Object.freeze([...paths]);
}

function patchCheck(
  checkout: string,
  patch: ChromiumPatchSpec,
  reverse: boolean,
): boolean {
  try {
    commandOutput(
      "git",
      ["apply", ...(reverse ? ["--reverse"] : []), "--check", patch.path],
      patchCheckout(checkout, patch.repository),
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
  const v8Checkout = patchCheckout(checkout, "v8");
  if (!existsSync(resolve(v8Checkout, ".git"))) {
    throw new Error(`Chromium V8 dependency is not checked out: ${v8Checkout}`);
  }
  const v8Pin = readPinnedChromiumRevision(chromiumV8RevisionFile).revision;
  const v8Head = commandOutput("git", ["rev-parse", "HEAD"], v8Checkout);
  if (v8Head !== v8Pin) {
    throw new Error(`V8 revision mismatch: expected ${v8Pin}, got ${v8Head}`);
  }

  const allPatches = readPatchSeries("all");
  for (const repository of ["chromium", "v8"] as const) {
    const repositoryCheckout = patchCheckout(checkout, repository);
    const status = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd: repositoryCheckout, encoding: "utf8" },
    ).trimEnd();
    if (status.length > 0 && !refresh) {
      throw new Error(
        `${repository === "chromium" ? "Chromium" : "V8"} checkout must be clean ` +
        "before applying the overlay; use --refresh only for a checkout " +
        "previously staged by this command",
      );
    }
    if (!refresh) continue;
    const statusLines = status.length === 0 ? [] : status.split("\n");
    const patchPaths = new Set(
      allPatches
        .filter((patch) => patch.repository === repository)
        .flatMap(patchTouchedPaths),
    );
    const unknown = statusLines.filter((line) => {
      if (line.length < 4) return true;
      const path = line.slice(3);
      return repository === "chromium"
        ? !isKnownRefreshPath(path) && !patchPaths.has(path)
        : !patchPaths.has(path);
    });
    if (unknown.length > 0) {
      throw new Error(
        `${repository === "chromium" ? "Chromium" : "V8"} refresh found ` +
        `changes outside the owned fixture:\n${unknown.join("\n")}`,
      );
    }
  }

  const selectedPatches = new Set(readPatchSeries(profile).map(patchKey));
  if (refresh) {
    for (const patch of allPatches) {
      if (selectedPatches.has(patchKey(patch))) continue;
      const repositoryCheckout = patchCheckout(checkout, patch.repository);
      if (patchCheck(checkout, patch, true)) {
        runCommand("git", ["apply", "--reverse", patch.path], repositoryCheckout);
        process.stdout.write(`removed ${patch.seriesEntry}\n`);
        continue;
      }
      if (!patchCheck(checkout, patch, false)) {
        throw new Error(
          `${patch.repository} checkout has a partial or conflicting patch: ` +
          patch.seriesEntry,
        );
      }
    }
  }

  for (const patch of readPatchSeries(profile)) {
    const repositoryCheckout = patchCheckout(checkout, patch.repository);
    if (refresh && patchCheck(checkout, patch, true)) {
      process.stdout.write(`already applied ${patch.seriesEntry}\n`);
      continue;
    }
    if (refresh && !patchCheck(checkout, patch, false)) {
      throw new Error(
        `${patch.repository} checkout has a partial or conflicting patch: ` +
        patch.seriesEntry,
      );
    }
    runCommand("git", ["apply", "--check", patch.path], repositoryCheckout);
    runCommand("git", ["apply", patch.path], repositoryCheckout);
    process.stdout.write(`applied ${patch.seriesEntry}\n`);
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
