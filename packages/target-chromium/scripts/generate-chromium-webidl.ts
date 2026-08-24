#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  defineChromiumWebIdlInput,
  defineChromiumWebIdlSlice,
  generateChromiumCreateElementBinding,
} from "@native-typescript/bindgen-webidl";
import { canonicalizeJson } from "@native-typescript/scabi";
import { packageRoot, reportError } from "./support.ts";

interface GeneratedFile {
  readonly path: string;
  readonly contents: string;
}

function usage(): string {
  return "Usage: node scripts/generate-chromium-webidl.ts [--check]";
}

function generatedFiles(): readonly GeneratedFile[] {
  const webIdlRoot = resolve(packageRoot, "chromium/webidl");
  const generatedRoot = resolve(packageRoot, "chromium/overlay/generated");
  const input = defineChromiumWebIdlInput(
    JSON.parse(readFileSync(resolve(webIdlRoot, "input.json"), "utf8")),
  );
  const database = defineChromiumWebIdlSlice(
    JSON.parse(
      readFileSync(resolve(webIdlRoot, "document-create-element.json"), "utf8"),
    ),
  );
  if (input.chromiumRevision !== database.chromiumRevision) {
    throw new Error("Chromium WebIDL input and normalized database revisions differ");
  }
  const generated = generateChromiumCreateElementBinding({
    database,
    webIdlDatabaseDigest: input.webIdlDatabaseDigest,
    typescriptLibraryDigest: input.typescriptLibraryDigest,
    target: {
      triple: "x86_64-unknown-linux-gnu",
      architecture: "x86_64",
      pointerWidth: 64,
      endianness: "little",
      objectFormat: "elf",
      minimumPlatformVersion: "0",
      abi: "gnu",
      features: [],
    },
    clangVersion: "24.0.0git",
    generatorRevision: "chromium-create-element-v1",
  });
  return Object.freeze([
    Object.freeze({
      path: resolve(webIdlRoot, "reached.d.ts"),
      contents: generated.declarations,
    }),
    Object.freeze({
      path: resolve(webIdlRoot, "package.scabi.json"),
      contents: `${canonicalizeJson(generated.manifest)}\n`,
    }),
    Object.freeze({
      path: resolve(generatedRoot, "nts_webidl_capsules.h"),
      contents: generated.capsuleHeader,
    }),
    Object.freeze({
      path: resolve(generatedRoot, "nts_webidl_capsules.cc"),
      contents: generated.capsuleSource,
    }),
  ]);
}

function main(arguments_: readonly string[]): void {
  if (arguments_.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (arguments_.some((argument) => argument !== "--check")) {
    throw new Error(usage());
  }
  const check = arguments_.includes("--check");
  for (const file of generatedFiles()) {
    if (check) {
      if (!existsSync(file.path) || readFileSync(file.path, "utf8") !== file.contents) {
        throw new Error(`Generated Chromium WebIDL artifact is stale: ${file.path}`);
      }
    } else {
      writeFileSync(file.path, file.contents, "utf8");
      process.stdout.write(`Wrote ${file.path}\n`);
    }
  }
  if (check) process.stdout.write("Chromium WebIDL artifacts are current\n");
}

try {
  main(process.argv.slice(2));
} catch (error) {
  reportError(error);
}
