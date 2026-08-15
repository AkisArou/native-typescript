#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  type ClangAbiEvidenceSnapshot,
  parseClangAbiEvidence,
} from "@native-typescript/bindgen-c";
import { canonicalizeJson } from "@native-typescript/scabi";
import {
  type GtkBindingPackageDescriptor,
  type GtkBindingPackageRequest,
  validateGtkBindingPackageRequest,
} from "./gtk-binding-package.ts";
import { generateGirClangAbiProbe } from "./gir-clang.ts";
import type { GirSnapshot } from "./gir-model.ts";
import { generateGObjectAdapterSource } from "./gobject-adapter.ts";
import { generateGtkScabiPackage } from "./gtk-scabi.ts";

async function readInputs(
  snapshotPath: string,
  requestPath: string,
): Promise<{
  readonly snapshot: GirSnapshot;
  readonly request: GtkBindingPackageRequest;
}> {
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as GirSnapshot;
  if (
    snapshot.schema !== "native-typescript.gir-snapshot" ||
    snapshot.schemaVersion !== 1
  ) {
    throw new Error("Unsupported selected GIR snapshot schema");
  }
  const request = JSON.parse(
    await readFile(requestPath, "utf8"),
  ) as GtkBindingPackageRequest;
  validateGtkBindingPackageRequest(request);
  return { snapshot, request };
}

async function normalizeEvidence(
  snapshotPath: string,
  rawEvidencePath: string,
  requestPath: string,
  outputPath: string,
): Promise<void> {
  const { snapshot, request } = await readInputs(snapshotPath, requestPath);
  const evidence = parseClangAbiEvidence(
    await readFile(rawEvidencePath, "utf8"),
    {
      probe: generateGirClangAbiProbe(snapshot),
      clang: request.clang,
    },
  );
  await writeFile(outputPath, canonicalizeJson(evidence));
}

async function generatePackage(
  snapshotPath: string,
  evidencePath: string,
  requestPath: string,
  outputPath: string,
): Promise<void> {
  const { snapshot, request } = await readInputs(snapshotPath, requestPath);
  const evidence = JSON.parse(
    await readFile(evidencePath, "utf8"),
  ) as ClangAbiEvidenceSnapshot;
  const gobjectAdapter = generateGObjectAdapterSource(snapshot);
  const generated = generateGtkScabiPackage({
    snapshot,
    evidence,
    gobjectAdapter,
    ...request.generation,
  });
  const descriptor: GtkBindingPackageDescriptor = {
    schema: "native-typescript.gtk-binding-package",
    schemaVersion: 1,
    package: request.generation.package,
    target: request.generation.target,
    files: {
      declarations: {
        path: "package.d.ts",
        digest: generated.declarationsDigest,
      },
      manifest: {
        path: "package.scabi.json",
        digest: generated.manifestDigest,
      },
      adapterSource: {
        path: "gobject-adapters.c",
        digest: gobjectAdapter.sourceDigest,
      },
      adapterMetadata: { path: "gobject-adapter.json" },
    },
  };
  const packageJson = {
    name: request.generation.package.name,
    version: request.generation.package.version,
    private: true,
    types: "./package.d.ts",
    nativeTypescript: {
      scabi: "./package.scabi.json",
      adapter: "./gobject-adapters.c",
    },
  };
  await mkdir(outputPath);
  await Promise.all([
    writeFile(`${outputPath}/binding-package.json`, canonicalizeJson(descriptor)),
    writeFile(`${outputPath}/gobject-adapter.json`, canonicalizeJson(gobjectAdapter)),
    writeFile(`${outputPath}/gobject-adapters.c`, gobjectAdapter.source),
    writeFile(`${outputPath}/package.d.ts`, generated.declarations),
    writeFile(`${outputPath}/package.json`, canonicalizeJson(packageJson)),
    writeFile(`${outputPath}/package.scabi.json`, generated.manifestSource),
  ]);
}

async function main(): Promise<void> {
  const [command, snapshotPath, evidencePath, requestPath, outputPath, ...extra] =
    process.argv.slice(2);
  if (
    command === undefined ||
    snapshotPath === undefined ||
    evidencePath === undefined ||
    requestPath === undefined ||
    outputPath === undefined ||
    extra.length > 0
  ) {
    throw new Error(
      "usage: gtk-binding-tool-cli <normalize-evidence|generate-package> " +
        "<snapshot.json> <evidence.json> <request.json> <output>",
    );
  }
  if (command === "normalize-evidence") {
    await normalizeEvidence(snapshotPath, evidencePath, requestPath, outputPath);
    return;
  }
  if (command === "generate-package") {
    await generatePackage(snapshotPath, evidencePath, requestPath, outputPath);
    return;
  }
  throw new Error(`Unknown GTK binding tool command '${command}'`);
}

await main();
