import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export const packageRoot = resolve(import.meta.dirname, "..");
export const chromiumRevisionFile = resolve(
  packageRoot,
  "chromium/revision.json",
);
export const chromiumPatchRoot = resolve(packageRoot, "chromium/patches");
export const chromiumOverlayRoot = resolve(packageRoot, "chromium/overlay");
export const chromiumInstallPath =
  "third_party/blink/renderer/native_typescript";

export type ChromiumPatchProfile = "product" | "fixture" | "all";
type ChromiumPatchSeriesProfile = Exclude<ChromiumPatchProfile, "all">;

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
): readonly string[] {
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

  for (const name of names) {
    if (
      basename(name) !== name ||
      !name.endsWith(".patch") ||
      seen.has(name) ||
      !existsSync(resolve(chromiumPatchRoot, name))
    ) {
      throw new Error(`Invalid Chromium patch-series entry: ${name}`);
    }
    seen.add(name);
  }
  return Object.freeze(names);
}

export function reportError(error: unknown): void {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
