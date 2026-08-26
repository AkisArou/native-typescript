#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  chromiumOverlayRoot,
  packageRoot,
  reportError,
} from "./support.ts";

const forbidden = Object.freeze({
  "v8::Value": "V8 value use",
  "v8::Local": "V8 local-handle use",
  "v8::Global": "V8 persistent-handle use",
  "v8::Object": "V8 object use",
  "v8::Function": "V8 function use",
  "v8::Promise": "V8 promise use",
  "v8::Context": "V8 context use",
  ScriptState: "V8 ScriptState bridge",
  V8Document: "generated V8 DOM wrapper",
  V8Element: "generated V8 DOM wrapper",
  V8Event: "generated V8 DOM wrapper",
  ExecuteScript: "script evaluation",
  EvaluateScript: "script evaluation",
  "eval(": "script evaluation",
});

const allowedV8RuntimeUses = Object.freeze({
  "chromium/overlay/nts_blink_realm.cc": new Set([
    "v8::CollectGarbageAtNativeAllocationCheckpoint",
    "v8::Isolate",
  ]),
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
    const relativePath = relative(packageRoot, path);
    for (const [token, reason] of Object.entries(forbidden)) {
      if (source.includes(token)) {
        failures.push(
          `${relativePath}: ${JSON.stringify(token)}: ${reason}`,
        );
      }
    }
    const allowed = allowedV8RuntimeUses[
      relativePath as keyof typeof allowedV8RuntimeUses
    ] ?? new Set<string>();
    for (const match of source.matchAll(/\bv8::[A-Za-z_]\w*/gu)) {
      const token = match[0]!;
      if (!allowed.has(token)) {
        failures.push(
          `${relativePath}: ${JSON.stringify(token)}: unapproved V8 runtime use`,
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
    "Native Blink bridge contains no V8 value/JavaScript bridge and only approved runtime seams\n",
  );
}

try {
  main();
} catch (error) {
  reportError(error);
}
