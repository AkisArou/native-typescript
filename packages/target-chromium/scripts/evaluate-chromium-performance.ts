#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  defineChromiumPerformanceInput,
  evaluateChromiumPerformance,
} from "../src/performance.ts";
import { reportError } from "./support.ts";

interface Options {
  readonly input: string;
  readonly output: string | undefined;
}

function usage(): string {
  return [
    "Usage: node scripts/evaluate-chromium-performance.ts input.json",
    "  [--output report.json]",
  ].join("\n");
}

function parseOptions(arguments_: readonly string[]): Options | null {
  if (arguments_.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const input = arguments_[0];
  if (input === undefined || input.startsWith("-")) throw new Error(usage());
  let output: string | undefined;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== "--output") {
      throw new Error(`Unknown argument: ${String(argument)}\n${usage()}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error("--output requires a value");
    output = resolve(value);
    index += 1;
  }
  return Object.freeze({ input: resolve(input), output });
}

function main(arguments_: readonly string[]): void {
  const options = parseOptions(arguments_);
  if (options === null) return;
  const input = defineChromiumPerformanceInput(
    JSON.parse(readFileSync(options.input, "utf8")),
  );
  const report = evaluateChromiumPerformance(input);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output === undefined) process.stdout.write(output);
  else writeFileSync(options.output, output, "utf8");
  if (!report.passed) process.exitCode = 1;
}

try {
  main(process.argv.slice(2));
} catch (error) {
  reportError(error);
}
