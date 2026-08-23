#!/usr/bin/env node

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readPinnedChromiumRevision } from "../src/revision.ts";
import {
  chromiumPatchRoot,
  readPatchSeries,
  reportError,
  runCommand,
} from "./support.ts";

const rawChromiumRoot = "https://raw.githubusercontent.com/chromium/chromium";

function patchInputPaths(patch: string): readonly string[] {
  const paths: string[] = [];
  for (const line of readFileSync(patch, "utf8").split("\n")) {
    if (!line.startsWith("--- ")) continue;
    let value = line.slice(4).split("\t", 1)[0]!;
    if (value === "/dev/null") continue;
    if (value.startsWith("a/")) value = value.slice(2);
    if (
      value.length === 0 ||
      value.startsWith("/") ||
      value.split("/").includes("..")
    ) {
      throw new Error(`Unsafe patch input path in ${patch}: ${value}`);
    }
    if (!paths.includes(value)) paths.push(value);
  }
  return Object.freeze(paths);
}

function rawChromiumUrl(revision: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${rawChromiumRoot}/${revision}/${encodedPath}`;
}

async function download(
  revision: string,
  path: string,
  destination: string,
): Promise<void> {
  const response = await fetch(rawChromiumUrl(revision, path));
  if (!response.ok) {
    throw new Error(
      `Could not download Chromium input ${path}: HTTP ${response.status}`,
    );
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

async function main(): Promise<void> {
  const revision = readPinnedChromiumRevision().revision;
  const patches = readPatchSeries().map((name) =>
    resolve(chromiumPatchRoot, name)
  );
  const inputs = [
    ...new Set(patches.flatMap((patch) => patchInputPaths(patch))),
  ].sort();
  const checkout = mkdtempSync(join(tmpdir(), "nts-chromium-patch-"));

  try {
    await Promise.all(
      inputs.map((path) =>
        download(revision, path, resolve(checkout, path))
      ),
    );
    runCommand("git", ["init", "-q"], checkout);
    runCommand(
      "git",
      ["config", "user.email", "patch-check@example.invalid"],
      checkout,
    );
    runCommand("git", ["config", "user.name", "patch-check"], checkout);
    runCommand("git", ["add", "."], checkout);
    runCommand("git", ["commit", "-qm", "pinned chromium inputs"], checkout);

    for (const patch of patches) {
      runCommand("git", ["apply", "--check", patch], checkout);
      runCommand("git", ["apply", patch], checkout);
      process.stdout.write(`verified ${patch.slice(chromiumPatchRoot.length + 1)}\n`);
    }
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
  process.stdout.write(`all Chromium patches apply to ${revision}\n`);
}

try {
  await main();
} catch (error) {
  reportError(error);
}
