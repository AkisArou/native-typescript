#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  chromiumOverlayRoot,
  packageRoot,
  reportError,
} from "./support.ts";

const forbidden = Object.freeze({
  "v8::": "V8 value/runtime use",
  ScriptState: "V8 ScriptState bridge",
  V8Document: "generated V8 DOM wrapper",
  V8Element: "generated V8 DOM wrapper",
  V8Event: "generated V8 DOM wrapper",
  ExecuteScript: "script evaluation",
  EvaluateScript: "script evaluation",
  "eval(": "script evaluation",
});

function bridgeSources(root: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...bridgeSources(path));
    else if (/\.(?:c|cc|h)$/u.test(entry.name)) files.push(path);
  }
  return files.sort();
}

function main(): void {
  const failures: string[] = [];
  for (const path of bridgeSources(chromiumOverlayRoot)) {
    const source = readFileSync(path, "utf8");
    for (const [token, reason] of Object.entries(forbidden)) {
      if (source.includes(token)) {
        failures.push(
          `${relative(packageRoot, path)}: ${JSON.stringify(token)}: ${reason}`,
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      [
        "Native Blink bridge violated the V8-free call-path invariant:",
        ...failures.map((failure) => `  ${failure}`),
      ].join("\n"),
    );
  }
  process.stdout.write(
    "Native Blink bridge contains no forbidden V8/JavaScript bridge tokens\n",
  );
}

try {
  main();
} catch (error) {
  reportError(error);
}
