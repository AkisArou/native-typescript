import { createHash } from "node:crypto";
import { assertScabiManifest } from "@native-typescript/scabi";
import type {
  ScabiManifest,
  Sha256Digest,
  TargetIdentity,
} from "@native-typescript/scabi";

export const chromiumBenchmarkNativeDeclarations =
  "export declare function createElementOnce(): number;\n";

export interface ChromiumBenchmarkNativeManifestOptions {
  readonly chromiumRevision: string;
  readonly clangVersion: string;
  readonly metadataDigest: Sha256Digest;
  readonly target: TargetIdentity;
}

export function createChromiumBenchmarkNativeManifest(
  options: ChromiumBenchmarkNativeManifestOptions,
): ScabiManifest {
  const declarationsDigest =
    `sha256:${createHash("sha256")
      .update(chromiumBenchmarkNativeDeclarations)
      .digest("hex")}` as Sha256Digest;
  return assertScabiManifest({
    schema: "native-typescript.scabi",
    schemaVersion: 13,
    package: {
      name: "@native-typescript/chromium-benchmark-native",
      version: "0.0.0",
      namespace: "chromium_benchmark",
      instance: options.chromiumRevision,
    },
    target: options.target,
    sdk: {
      vendor: "Chromium",
      name: "Blink benchmark fixture",
      version: options.chromiumRevision,
      metadataDigest: options.metadataDigest,
      toolchain: "clang",
      toolchainVersion: options.clangVersion,
      toolchainAbi: options.target.abi,
      deploymentTarget: options.target.minimumPlatformVersion,
      modules: ["blink-core"],
    },
    generator: {
      name: "@native-typescript/target-chromium",
      version: "0.0.0",
      revision: "chromium-benchmark-native-v1",
      arguments: ["create-element-once"],
      inputDigests: [options.metadataDigest],
    },
    declarations: {
      digest: declarationsDigest,
      types: {
        u32: { module: ".", name: "number" },
      },
    },
    types: {
      void: { kind: "void" },
      u32: { kind: "integer", signed: false, bits: 32 },
    },
    bindings: {
      create_element_once: {
        kind: "function",
        declaration: { module: ".", name: "createElementOnce" },
        entry: { symbol: "nts_chromium_benchmark_create_element_once" },
        signature: {
          callingConvention: "c",
          variadic: false,
          parameters: [],
          result: {
            type: "u32",
            passMode: "value",
            nullable: false,
            ownership: { kind: "value" },
            conversion: "number",
          },
        },
        thread: {
          executor: { kind: "runtime-owner" },
          behavior: "require",
          blocking: false,
        },
        error: { kind: "no-fail" },
        dependencies: {
          bindings: [],
          linkInputs: ["chromium_blink_benchmark"],
          adapterInputs: [],
          permissions: [],
        },
      },
    },
    linkInputs: [
      {
        id: "chromium_blink_benchmark",
        kind: "runtime-component",
        name: "Blink benchmark fixture",
        order: 0,
      },
    ],
    adapterInputs: [],
    permissions: [],
    platform: {
      chromium: {
        revision: options.chromiumRevision,
        fixture: "create-element-once",
      },
    },
  });
}
