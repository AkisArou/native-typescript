#!/usr/bin/env node

import { pathToFileURL } from "node:url";
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
  readonly gnArguments: string;
  readonly jobs: number;
  readonly exceptionPath: "stock" | "product";
}

function usage(): string {
  return [
    "Usage: node scripts/build-chromium-counter.ts /path/to/chromium/src",
    "  --depot-tools /path/to/depot_tools",
    "  [--out out/nts-counter] [--gn-args '<GN arguments>'] [--jobs 4]",
    "  [--exception-path stock|product]",
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

  let output = "out/nts-counter";
  let depotTools: string | undefined;
  let jobs = 4;
  let exceptionPath: "stock" | "product" = "product";
  let gnArguments = [
    "is_debug=true",
    "is_component_build=true",
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
      argument !== "--gn-args" &&
      argument !== "--jobs" &&
      argument !== "--exception-path"
    ) {
      throw new Error(`Unknown argument: ${argument}\n${usage()}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    if (argument === "--out") output = value;
    else if (argument === "--depot-tools") depotTools = resolve(value);
    else if (argument === "--gn-args") gnArguments = value;
    else if (argument === "--exception-path") {
      if (value !== "stock" && value !== "product") {
        throw new Error("--exception-path must be stock or product");
      }
      exceptionPath = value;
    } else {
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
    gnArguments,
    jobs,
    exceptionPath,
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
      "--profile",
      options.exceptionPath === "stock" ? "fixture" : "all",
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

  const page = pathToFileURL(
    resolve(packageRoot, "prototype/examples/counter/index.html"),
  );
  process.stdout.write(
    [
      "",
      "Build complete.",
      `Counter page: ${page.href}`,
      "Run the script-free CDP acceptance lane with:",
      `  node scripts/run-chromium-counter.ts ${options.checkout} --out ${options.output} --exception-path ${options.exceptionPath}`,
      "",
    ].join("\n"),
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  reportError(error);
}
