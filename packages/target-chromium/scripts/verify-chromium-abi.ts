#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseClangRecordCallingConventions } from "@native-typescript/bindgen-c";
import type { ClangAbiProbe } from "@native-typescript/bindgen-c";
import { commandOutput, packageRoot, reportError } from "./support.ts";

const targetTriple = "x86_64-unknown-linux-gnu";

function usage(): string {
  return "Usage: node scripts/verify-chromium-abi.ts /path/to/chromium/src";
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function main(arguments_: readonly string[]): void {
  if (arguments_.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const checkoutArgument = arguments_[0];
  if (
    checkoutArgument === undefined ||
    checkoutArgument.startsWith("-") ||
    arguments_.length !== 1
  ) {
    throw new Error(usage());
  }
  const checkout = resolve(checkoutArgument);
  const revision = JSON.parse(
    readFileSync(resolve(packageRoot, "chromium/revision.json"), "utf8"),
  ) as { readonly revision: string };
  if (commandOutput("git", ["rev-parse", "HEAD"], checkout) !== revision.revision) {
    throw new Error("Chromium ABI evidence requires the exact pinned revision");
  }
  const clang = resolve(
    checkout,
    "third_party/llvm-build/Release+Asserts/bin/clang",
  );
  if (!existsSync(clang)) throw new Error(`Pinned Chromium clang is absent: ${clang}`);
  const version = execFileSync(clang, ["--version"], { encoding: "utf8" });
  if (!version.startsWith("clang version 24.0.0git ")) {
    throw new Error(`Unexpected pinned Chromium clang version: ${version.split("\n")[0]}`);
  }
  const source = readFileSync(
    resolve(packageRoot, "prototype/tests/scabi_abi_probe.c"),
    "utf8",
  );
  const sourceDigest = digest(source);
  const probe: ClangAbiProbe = Object.freeze({
    schema: "native-typescript.clang-abi-probe",
    schemaVersion: 3,
    source,
    sourceDigest,
    contractDigest: sourceDigest,
    includes: Object.freeze(["nts_web.h"]),
    functions: Object.freeze([]),
    records: Object.freeze([
      Object.freeze({
        id: "chromium.web-handle",
        typeName: "NtsWebHandle",
        definition: "external",
        fields: Object.freeze([]),
      }),
      Object.freeze({
        id: "chromium.web-scabi-handle-result",
        typeName: "NtsWebScabiHandleResult",
        definition: "external",
        fields: Object.freeze([]),
      }),
    ]),
    enums: Object.freeze([]),
  });
  const llvm = execFileSync(
    clang,
    [
      `--target=${targetTriple}`,
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O0",
      "-S",
      "-emit-llvm",
      "-I",
      resolve(packageRoot, "prototype/include"),
      "-x",
      "c",
      "-o",
      "-",
      "-",
    ],
    { input: source, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  const [handle, result] = parseClangRecordCallingConventions(llvm, probe);
  assert.ok(handle);
  assert.ok(result);
  assert.deepEqual(handle.result.type, {
    kind: "struct",
    packed: false,
    fields: [
      { kind: "integer", bits: 64 },
      { kind: "integer", bits: 64 },
    ],
  });
  assert.deepEqual(handle.parameters.map((parameter) => parameter.type), [
    { kind: "integer", bits: 64 },
    { kind: "integer", bits: 64 },
  ]);
  assert.deepEqual(result.result.type, { kind: "void" });
  assert.equal(result.parameters.length, 2);
  assert.deepEqual(result.parameters[0]?.type, {
    kind: "pointer",
    addressSpace: 0,
  });
  assert.deepEqual(result.parameters[0]?.structureReturn, {
    kind: "named",
    name: "%struct.NtsWebScabiHandleResult",
  });
  assert.equal(result.parameters[0]?.alignment, 8);
  assert.deepEqual(result.parameters[1]?.type, {
    kind: "pointer",
    addressSpace: 0,
  });
  assert.deepEqual(result.parameters[1]?.byValue, {
    kind: "named",
    name: "%struct.NtsWebScabiHandleResult",
  });
  assert.equal(result.parameters[1]?.alignment, 8);
  process.stdout.write(
    "Pinned Chromium clang confirms realm-safe handle layout and SCABI aggregate passing\n",
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  reportError(error);
}
