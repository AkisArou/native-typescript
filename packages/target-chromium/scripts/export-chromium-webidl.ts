#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { commandOutput, reportError } from "./support.ts";

interface Options {
  readonly checkout: string;
  readonly depotTools: string;
  readonly outputDirectory: string;
  readonly output: string | undefined;
}

const pythonExporter = String.raw`
import json
import sys

import web_idl

database = web_idl.Database.read_from_file(sys.argv[1])
revision = sys.argv[2]
document = database.find("Document")
if document is None:
    raise RuntimeError("Document is absent from Chromium's WebIDL database")

operations = []
for operation in document.operations:
    if str(operation.identifier) != "createElement":
        continue
    implemented_as = operation.code_generator_info.property_implemented_as
    operations.append({
        "arguments": [{
            "name": str(argument.identifier),
            "optionality": str(argument.optionality),
            "type": argument.idl_type.syntactic_form,
        } for argument in operation.arguments],
        "extendedAttributes": sorted(operation.extended_attributes.keys()),
        "implementedAs": implemented_as or str(operation.identifier),
        "kind": "operation",
        "name": str(operation.identifier),
        "returnType": operation.return_type.syntactic_form,
        "static": operation.is_static,
    })

operations.sort(key=lambda value: (
    value["name"],
    len(value["arguments"]),
    tuple(argument["type"] for argument in value["arguments"]),
))
inherited = document.inherited
payload = {
    "chromiumRevision": revision,
    "interfaces": [{
        "blinkHeaders": sorted(document.code_generator_info.blink_headers),
        "inherited": str(inherited.identifier) if inherited else None,
        "name": "Document",
        "operations": operations,
    }],
    "schema": "native-typescript.chromium-webidl-slice",
    "schemaVersion": 1,
}
sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
sys.stdout.write("\n")
`;

function usage(): string {
  return [
    "Usage: node scripts/export-chromium-webidl.ts /path/to/chromium/src",
    "  --depot-tools /path/to/depot_tools [--out out/nts-counter]",
    "  [--output /path/to/document-create-element.json]",
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
  let depotTools: string | undefined;
  let outputDirectory = "out/nts-counter";
  let output: string | undefined;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (
      argument !== "--depot-tools" &&
      argument !== "--out" &&
      argument !== "--output"
    ) {
      throw new Error(`Unknown argument: ${argument}\n${usage()}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    if (argument === "--depot-tools") depotTools = resolve(value);
    else if (argument === "--out") outputDirectory = value;
    else output = resolve(value);
    index += 1;
  }
  if (!depotTools) throw new Error("--depot-tools is required");
  return Object.freeze({
    checkout: resolve(checkoutArgument),
    depotTools,
    outputDirectory,
    output,
  });
}

function main(arguments_: readonly string[]): void {
  const options = parseOptions(arguments_);
  if (options === null) return;
  const database = resolve(
    options.checkout,
    options.outputDirectory,
    "gen/third_party/blink/renderer/bindings/web_idl_database.pickle",
  );
  // Chromium's database is a pickle of Chromium-owned Python classes. The
  // depot_tools bootstrap interpreter is therefore the one intentional
  // Python boundary; orchestration and emitted-artifact handling stay in TS.
  // Invoking vpython here would also provision unrelated packages from the
  // ambient .vpython3 spec even though this exporter needs none of them.
  const chromiumPython = resolve(options.depotTools, "python-bin/python3");
  if (!existsSync(database)) {
    throw new Error(`Chromium normalized WebIDL database does not exist: ${database}`);
  }
  if (!existsSync(chromiumPython)) {
    throw new Error(
      `Pinned depot_tools bootstrap Python does not exist: ${chromiumPython}`,
    );
  }
  const revision = commandOutput("git", ["rev-parse", "HEAD"], options.checkout);
  const scripts = resolve(
    options.checkout,
    "third_party/blink/renderer/bindings/scripts",
  );
  const source = execFileSync(
    chromiumPython,
    ["-c", pythonExporter, database, revision],
    {
      cwd: options.checkout,
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: scripts },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (options.output) {
    writeFileSync(options.output, source, "utf8");
    process.stdout.write(`Wrote ${options.output}\n`);
  } else {
    process.stdout.write(source);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  reportError(error);
}
