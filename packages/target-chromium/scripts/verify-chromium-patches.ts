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
  type ChromiumPatchProfile,
  type ChromiumPatchRepository,
  chromiumV8RevisionFile,
  parsePatchProfile,
  readPatchSeries,
  reportError,
  runCommand,
} from "./support.ts";

const rawRepositoryRoots = Object.freeze({
  chromium: "https://raw.githubusercontent.com/chromium/chromium",
  v8: "https://raw.githubusercontent.com/v8/v8",
});

function usage(): string {
  return [
    "Usage: node scripts/verify-chromium-patches.ts",
    "  [--profile product|fixture|all]",
  ].join("\n");
}

function parseProfile(
  arguments_: readonly string[],
): ChromiumPatchProfile | null {
  if (arguments_.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  if (arguments_.length === 0) return "all";
  if (arguments_.length !== 2 || arguments_[0] !== "--profile") {
    throw new Error(usage());
  }
  return parsePatchProfile(arguments_[1]!);
}

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

function rawRepositoryUrl(
  repository: ChromiumPatchRepository,
  revision: string,
  path: string,
): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${rawRepositoryRoots[repository]}/${revision}/${encodedPath}`;
}

async function download(
  repository: ChromiumPatchRepository,
  revision: string,
  path: string,
  destination: string,
): Promise<void> {
  const response = await fetch(rawRepositoryUrl(repository, revision, path));
  if (!response.ok) {
    throw new Error(
      `Could not download ${repository} input ${path}: HTTP ${response.status}`,
    );
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

async function main(arguments_: readonly string[]): Promise<void> {
  const profile = parseProfile(arguments_);
  if (profile === null) return;
  const revisions = Object.freeze({
    chromium: readPinnedChromiumRevision().revision,
    v8: readPinnedChromiumRevision(chromiumV8RevisionFile).revision,
  });
  const patches = readPatchSeries(profile);
  if (patches.length === 0) {
    process.stdout.write(
      `the ${profile} Chromium patch profile declares no patches\n`,
    );
    return;
  }
  const checkout = mkdtempSync(join(tmpdir(), "nts-chromium-patch-"));

  try {
    for (const repository of ["chromium", "v8"] as const) {
      const repositoryPatches = patches.filter(
        (patch) => patch.repository === repository,
      );
      if (repositoryPatches.length === 0) continue;
      const repositoryCheckout = resolve(checkout, repository);
      const inputs = [
        ...new Set(repositoryPatches.flatMap((patch) => patchInputPaths(patch.path))),
      ].sort();
      await Promise.all(
        inputs.map((path) =>
          download(
            repository,
            revisions[repository],
            path,
            resolve(repositoryCheckout, path),
          )
        ),
      );
      mkdirSync(repositoryCheckout, { recursive: true });
      runCommand("git", ["init", "-q"], repositoryCheckout);
      runCommand(
        "git",
        ["config", "user.email", "patch-check@example.invalid"],
        repositoryCheckout,
      );
      runCommand(
        "git",
        ["config", "user.name", "patch-check"],
        repositoryCheckout,
      );
      runCommand("git", ["add", "."], repositoryCheckout);
      runCommand(
        "git",
        ["commit", "-qm", `pinned ${repository} inputs`],
        repositoryCheckout,
      );

      for (const patch of repositoryPatches) {
        runCommand("git", ["apply", "--check", patch.path], repositoryCheckout);
        runCommand("git", ["apply", patch.path], repositoryCheckout);
        process.stdout.write(`verified ${patch.seriesEntry}\n`);
      }
    }
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
  process.stdout.write(
    `the ${profile} Chromium patch profile applies to Chromium ` +
    `${revisions.chromium} and V8 ${revisions.v8}\n`,
  );
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  reportError(error);
}
