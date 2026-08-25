#!/usr/bin/env node

import { resolve } from "node:path";
import {
  packageRoot,
  reportError,
  runAutoninja,
  runCommand,
} from "./support.ts";

interface Options {
  readonly checkout: string;
  readonly depotTools: string;
  readonly output: string;
  readonly jobs: number;
  readonly gnArguments: string;
}

function usage(): string {
  return [
    "Usage: node scripts/build-chromium-benchmark.ts /path/to/chromium/src",
    "  --depot-tools /path/to/depot_tools",
    "  [--out out/nts-benchmark] [--jobs 4] [--gn-args '<GN arguments>']",
    "",
    "Builds the release benchmark binary; it does not execute a benchmark.",
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
  let output = "out/nts-benchmark";
  let depotTools: string | undefined;
  let jobs = 4;
  let gnArguments = [
    "is_official_build=true",
    "chrome_pgo_phase=0",
    "is_debug=false",
    "is_component_build=false",
    "symbol_level=0",
    "blink_symbol_level=0",
    "v8_symbol_level=0",
    "enable_swiftshader=false",
    "angle_enable_swiftshader=false",
  ].join(" ");
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (
      argument !== "--out" &&
      argument !== "--depot-tools" &&
      argument !== "--jobs" &&
      argument !== "--gn-args"
    ) {
      throw new Error(`Unknown argument: ${argument}\n${usage()}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    if (argument === "--out") output = value;
    else if (argument === "--depot-tools") depotTools = resolve(value);
    else if (argument === "--gn-args") gnArguments = value;
    else {
      jobs = Number(value);
      if (!Number.isInteger(jobs) || jobs < 1 || jobs > 64) {
        throw new Error("--jobs must be an integer from 1 through 64");
      }
    }
    index += 1;
  }
  if (depotTools === undefined) throw new Error(`--depot-tools is required\n${usage()}`);
  return Object.freeze({
    checkout: resolve(checkoutArgument),
    depotTools,
    output,
    jobs,
    gnArguments,
  });
}

function main(arguments_: readonly string[]): void {
  const options = parseOptions(arguments_);
  if (options === null) return;
  runCommand(
    process.execPath,
    [
      resolve(import.meta.dirname, "apply-chromium.ts"),
      options.checkout,
      "--refresh",
    ],
    packageRoot,
  );
  runCommand(
    process.execPath,
    [
      resolve(import.meta.dirname, "build-chromium-benchmark-libraries.ts"),
      options.checkout,
      "--out",
      resolve(options.checkout, options.output, "gen/native_typescript/benchmark"),
    ],
    packageRoot,
  );
  runCommand(
    resolve(options.checkout, "buildtools/linux64/gn"),
    ["gen", options.output, `--args=${options.gnArguments}`],
    options.checkout,
  );
  runAutoninja(
    options.depotTools,
    [
      "-C",
      options.output,
      "-j",
      String(options.jobs),
      "third_party/blink/renderer/native_typescript:nts_blink_bridge",
      "third_party/blink/renderer/native_typescript:nts_counter_host",
    ],
    options.checkout,
  );
  runAutoninja(
    options.depotTools,
    ["-C", options.output, "-j", String(options.jobs), "content_shell"],
    options.checkout,
  );
  process.stdout.write(
    [
      "",
      "Release Chromium benchmark binary built; no benchmark was run.",
      `Before timing, run: node scripts/run-chromium-benchmark.ts ${options.checkout} --out ${options.output} --output /path/to/chromium-benchmark-input.json`,
      "",
    ].join("\n"),
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  reportError(error);
}
