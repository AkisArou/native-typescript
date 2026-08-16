#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  type ClangAbiEvidenceSnapshot,
  parseClangAbiEvidence,
} from "@native-typescript/bindgen-c";
import { canonicalizeJson } from "@native-typescript/scabi";
import {
  type GirBindingPackageDescriptor,
  type GirBindingPackageRequest,
  validateGirBindingPackageRequest,
} from "./gir-binding-package.ts";
import { generateGirClangAbiProbe } from "./gir-clang.ts";
import type { GirSnapshot } from "./gir-model.ts";
import { generateGObjectAdapterSource } from "./gobject-adapter.ts";
import { generateGObjectScabiPackage } from "./gobject-scabi.ts";
import type { GObjectImportedNamespace } from "./gobject-scabi.ts";

async function readInputs(
  snapshotPath: string,
  requestPath: string,
): Promise<{
  readonly snapshot: GirSnapshot;
  readonly request: GirBindingPackageRequest;
}> {
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as GirSnapshot;
  if (
    snapshot.schema !== "native-typescript.gir-snapshot" ||
    snapshot.schemaVersion !== 3
  ) {
    throw new Error("Unsupported selected GIR snapshot schema");
  }
  const request = JSON.parse(
    await readFile(requestPath, "utf8"),
  ) as GirBindingPackageRequest;
  validateGirBindingPackageRequest(request);
  return { snapshot, request };
}

async function normalizeEvidence(
  snapshotPath: string,
  rawAstPath: string,
  rawLlvmPath: string,
  requestPath: string,
  outputPath: string,
): Promise<void> {
  const { snapshot, request } = await readInputs(snapshotPath, requestPath);
  const gobjectAdapter = generateGObjectAdapterSource(snapshot);
  const evidence = parseClangAbiEvidence(
    await readFile(rawAstPath, "utf8"),
    await readFile(rawLlvmPath, "utf8"),
    {
      probe: generateGirClangAbiProbe(snapshot, gobjectAdapter),
      clang: request.clang,
    },
  );
  await writeFile(outputPath, canonicalizeJson(evidence));
}

async function readImportedNamespaces(
  request: GirBindingPackageRequest,
  snapshotPaths: readonly string[],
): Promise<readonly GObjectImportedNamespace[]> {
  const declared = request.importedNamespaces ?? [];
  if (declared.length !== snapshotPaths.length) {
    throw new Error(
      `Expected ${declared.length} imported GIR snapshot(s), received ${snapshotPaths.length}`,
    );
  }
  const imported: GObjectImportedNamespace[] = [];
  for (const [index, entry] of declared.entries()) {
    const snapshot = JSON.parse(
      await readFile(snapshotPaths[index]!, "utf8"),
    ) as GirSnapshot;
    if (
      snapshot.schema !== "native-typescript.gir-snapshot" ||
      snapshot.schemaVersion !== 3
    ) {
      throw new Error("Unsupported imported GIR snapshot schema");
    }
    // Inputs are positional, so the snapshot must be the one the request says
    // it is rather than whatever the planner happened to wire up.
    if (
      snapshot.namespace.name !== entry.namespace.name ||
      snapshot.namespace.version !== entry.namespace.version
    ) {
      throw new Error(
        `Imported snapshot ${snapshot.namespace.name}-${snapshot.namespace.version} ` +
          `does not match declared ${entry.namespace.name}-${entry.namespace.version}`,
      );
    }
    imported.push({ snapshot, package: entry.package });
  }
  return imported;
}

async function generatePackage(
  snapshotPath: string,
  evidencePath: string,
  requestPath: string,
  outputPath: string,
  importedSnapshotPaths: readonly string[],
): Promise<void> {
  const { snapshot, request } = await readInputs(snapshotPath, requestPath);
  const evidence = JSON.parse(
    await readFile(evidencePath, "utf8"),
  ) as ClangAbiEvidenceSnapshot;
  const gobjectAdapter = generateGObjectAdapterSource(snapshot);
  const importedNamespaces = await readImportedNamespaces(
    request,
    importedSnapshotPaths,
  );
  const generated = generateGObjectScabiPackage({
    snapshot,
    evidence,
    gobjectAdapter,
    importedNamespaces,
    ...request.generation,
  });
  const descriptor: GirBindingPackageDescriptor = {
    schema: "native-typescript.gir-binding-package",
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
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "normalize-evidence") {
    if (arguments_.length !== 5) {
      throw new Error(
        "usage: gtk-binding-tool-cli normalize-evidence " +
          "<snapshot.json> <ast.json> <classification.ll> <request.json> <output>",
      );
    }
    await normalizeEvidence(arguments_[0]!, arguments_[1]!, arguments_[2]!, arguments_[3]!, arguments_[4]!);
    return;
  }
  if (command === "generate-package") {
    if (arguments_.length < 4) {
      throw new Error(
        "usage: gir-binding-tool-cli generate-package " +
          "<snapshot.json> <evidence.json> <request.json> <output> [imported-snapshot.json...]",
      );
    }
    await generatePackage(
      arguments_[0]!,
      arguments_[1]!,
      arguments_[2]!,
      arguments_[3]!,
      arguments_.slice(4),
    );
    return;
  }
  throw new Error(`Unknown GIR binding tool command '${command}'`);
}

await main();
