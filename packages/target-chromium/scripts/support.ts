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

export function readPatchSeries(): readonly string[] {
  const seriesPath = resolve(chromiumPatchRoot, "series");
  const names = readFileSync(seriesPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
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
