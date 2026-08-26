import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export const packageRoot = resolve(import.meta.dirname, "..");
export const chromiumRevisionFile = resolve(
  packageRoot,
  "chromium/revision.json",
);
export const chromiumV8RevisionFile = resolve(
  packageRoot,
  "chromium/v8-revision.json",
);
export const chromiumPatchRoot = resolve(packageRoot, "chromium/patches");
export const chromiumOverlayRoot = resolve(packageRoot, "chromium/overlay");
export const chromiumInstallPath =
  "third_party/blink/renderer/native_typescript";

export type ChromiumPatchProfile = "product" | "fixture" | "all";
type ChromiumPatchSeriesProfile = Exclude<ChromiumPatchProfile, "all">;
export type ChromiumPatchRepository = "chromium" | "v8";

export interface ChromiumPatchSpec {
  readonly repository: ChromiumPatchRepository;
  readonly name: string;
  readonly path: string;
  readonly seriesEntry: string;
}

const chromiumPatchProfileFiles = Object.freeze({
  product: "product.series",
  fixture: "fixture.series",
});

export function commandOutput(
  command: string,
  arguments_: readonly string[],
  cwd: string,
): string {
  return execFileSync(command, [...arguments_], {
    cwd,
    encoding: "utf8",
  }).trim();
}

export function runCommand(
  command: string,
  arguments_: readonly string[],
  cwd: string,
): void {
  process.stdout.write(`+ ${[command, ...arguments_].join(" ")}\n`);
  execFileSync(command, [...arguments_], { cwd, stdio: "inherit" });
}

export function runAutoninja(
  depotTools: string,
  arguments_: readonly string[],
  checkout: string,
): void {
  const python = resolve(depotTools, "python-bin/python3");
  const autoninja = resolve(depotTools, "autoninja.py");
  if (!existsSync(python)) {
    throw new Error(`depot_tools bootstrap Python does not exist: ${python}`);
  }
  if (!existsSync(autoninja)) {
    throw new Error(`depot_tools Autoninja entrypoint does not exist: ${autoninja}`);
  }
  runCommand(python, [autoninja, ...arguments_], checkout);
}

export function parsePatchProfile(value: string): ChromiumPatchProfile {
  if (value === "product" || value === "fixture" || value === "all") {
    return value;
  }
  throw new Error(`Invalid Chromium patch profile: ${value}`);
}

export function readPatchSeries(
  profile: ChromiumPatchProfile = "all",
): readonly ChromiumPatchSpec[] {
  const profiles: readonly ChromiumPatchSeriesProfile[] =
    profile === "all" ? ["product", "fixture"] : [profile];
  const names = profiles.flatMap((currentProfile) => {
    const seriesPath = resolve(
      chromiumPatchRoot,
      chromiumPatchProfileFiles[currentProfile],
    );
    return readFileSync(seriesPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  });
  const seen = new Set<string>();
  const patches: ChromiumPatchSpec[] = [];

  for (const seriesEntry of names) {
    const repository: ChromiumPatchRepository = seriesEntry.startsWith("v8/")
      ? "v8"
      : "chromium";
    const name = repository === "v8" ? seriesEntry.slice("v8/".length) : seriesEntry;
    if (
      basename(name) !== name ||
      !name.endsWith(".patch") ||
      seen.has(seriesEntry) ||
      !existsSync(resolve(chromiumPatchRoot, seriesEntry))
    ) {
      throw new Error(`Invalid Chromium patch-series entry: ${seriesEntry}`);
    }
    seen.add(seriesEntry);
    patches.push(Object.freeze({
      repository,
      name,
      path: resolve(chromiumPatchRoot, seriesEntry),
      seriesEntry,
    }));
  }
  return Object.freeze(patches);
}

export function reportError(error: unknown): void {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
