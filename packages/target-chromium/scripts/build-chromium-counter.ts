#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { packageRoot, reportError, runCommand } from "./support.ts";

interface Options {
  readonly checkout: string;
  readonly output: string;
  readonly gnArguments: string;
}

function usage(): string {
  return [
    "Usage: node scripts/build-chromium-counter.ts /path/to/chromium/src",
    "  [--out out/nts-counter] [--gn-args 'is_debug=true symbol_level=1']",
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
  let gnArguments = "is_debug=true symbol_level=1";
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument !== "--out" && argument !== "--gn-args") {
      throw new Error(`Unknown argument: ${argument}\n${usage()}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    if (argument === "--out") output = value;
    else gnArguments = value;
    index += 1;
  }

  return Object.freeze({
    checkout: resolve(checkoutArgument),
    output,
    gnArguments,
  });
}

function main(arguments_: readonly string[]): void {
  const options = parseOptions(arguments_);
  if (options === null) return;

  runCommand(
    process.execPath,
    [resolve(import.meta.dirname, "apply-chromium.ts"), options.checkout],
    packageRoot,
  );
  runCommand(
    "gn",
    ["gen", options.output, `--args=${options.gnArguments}`],
    options.checkout,
  );
  runCommand(
    "autoninja",
    ["-C", options.output, "content_shell"],
    options.checkout,
  );

  const page = pathToFileURL(
    resolve(packageRoot, "prototype/examples/counter/index.html"),
  );
  process.stdout.write(
    [
      "",
      "Build complete.",
      "Run the content_shell binary from the Chromium output directory with:",
      `  --native-typescript-counter ${page.href}`,
      "",
    ].join("\n"),
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  reportError(error);
}
