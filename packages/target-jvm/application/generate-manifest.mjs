import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCABI_SCHEMA_VERSION,
  canonicalizeJson,
  parseScabiManifest,
} from "../../scabi/src/index.ts";

const root = import.meta.dirname;
const runtime = join(root, "..", "runtime");

function digest(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

const declarationsDigest = digest(join(root, "package.d.ts"));
const headerDigest = digest(join(runtime, "nts_jvm_runtime.h"));

/* Only the runtime component is this package's own; libjvm enters the link
 * as an artifact the application build supplies, because it lives outside
 * the default linker path and a path may not enter a manifest. */
const linkInputs = [
  ["jvm-application-runtime", "runtime-component", "jvm-application-runtime"],
].map(([id, kind, name], order) => ({ id, kind, name, order }));

const voidResult = {
  nullable: false,
  ownership: { kind: "value" },
  passMode: "value",
  type: "void",
};

/* Start creates the VM on the calling thread, which becomes the owner
 * executor's thread; stop and complete only touch runtime bookkeeping. */
const ownerThread = {
  behavior: "require",
  blocking: false,
  executor: { kind: "runtime-owner" },
};

const errorOut = {
  kind: "error-out",
  message: "application_error_message",
  release: "application_error_release",
};

function callable({ declaration, symbol, kind = "function", parameters = [], result = voidResult, error = { kind: "no-fail" }, bindings = [] }) {
  return {
    declaration: { module: ".", name: declaration },
    dependencies: {
      adapterInputs: [],
      bindings,
      linkInputs: linkInputs.map(({ id }) => id),
      permissions: [],
    },
    entry: { symbol },
    error,
    kind,
    signature: {
      callingConvention: "c",
      parameters,
      result,
      variadic: false,
    },
    thread: ownerThread,
  };
}

const errorParameter = {
  name: "error",
  nullable: false,
  ownership: { kind: "borrowed", scope: "call" },
  passMode: "pointer",
  type: "jvm_error",
};

const manifest = {
  adapterInputs: [],
  bindings: {
    application_complete: callable({
      declaration: "applicationComplete",
      symbol: "nts_jvm_application_complete",
      parameters: [
        {
          conversion: "number",
          name: "code",
          nullable: false,
          ownership: { kind: "value" },
          passMode: "value",
          type: "i32",
        },
      ],
    }),
    application_error_message: callable({
      declaration: "NativeError.message",
      kind: "getter",
      symbol: "nts_jvm_application_error_message",
      parameters: [errorParameter],
      result: {
        nullable: false,
        ownership: { kind: "borrowed", scope: "call" },
        passMode: "pointer",
        type: "const_utf8",
      },
    }),
    application_error_release: callable({
      declaration: "NativeError.__release",
      kind: "method",
      symbol: "nts_jvm_application_error_release",
      parameters: [errorParameter],
    }),
    application_start: callable({
      declaration: "applicationStart",
      symbol: "nts_jvm_application_start",
      error: errorOut,
      bindings: ["application_error_message", "application_error_release"],
    }),
    application_stop: callable({
      declaration: "applicationStop",
      symbol: "nts_jvm_application_stop",
    }),
  },
  declarations: {
    digest: declarationsDigest,
    types: {},
  },
  generator: {
    arguments: ["--target=x86_64-unknown-linux-gnu"],
    inputDigests: [headerDigest],
    name: "native-typescript.target-jvm.application",
    revision: "manual-v1",
    version: "1",
  },
  linkInputs,
  package: {
    instance: "native-typescript.target.jvm.application@0.0.0",
    name: "@native-typescript/jvm-application",
    namespace: "native-typescript.target.jvm.application",
    version: "0.0.0",
  },
  permissions: [],
  schema: "native-typescript.scabi",
  /* Reported, never chosen: the version this generator was built against. */
  schemaVersion: SCABI_SCHEMA_VERSION,
  sdk: {
    deploymentTarget: "x86_64-unknown-linux-gnu",
    metadataDigest: headerDigest,
    modules: ["jni", "nts_jvm_runtime.h"],
    name: "jvm-application",
    toolchain: "clang",
    toolchainAbi: "sysv-amd64",
    toolchainVersion: "c11",
    vendor: "native-typescript",
    version: "1",
  },
  target: {
    abi: "sysv-amd64",
    architecture: "x86_64",
    endianness: "little",
    features: ["jvm"],
    minimumPlatformVersion: "glibc-2.17",
    objectFormat: "elf",
    pointerWidth: 64,
    triple: "x86_64-unknown-linux-gnu",
  },
  types: {
    const_utf8: {
      addressSpace: 0,
      kind: "pointer",
      mutability: "const",
      nullable: false,
      pointee: "i8",
    },
    i32: { bits: 32, kind: "integer", signed: true },
    i8: { bits: 8, kind: "integer", signed: true },
    jvm_error: {
      addressSpace: 0,
      kind: "pointer",
      mutability: "mutable",
      nullable: true,
      pointee: "i8",
    },
    void: { kind: "void" },
  },
};

const source = canonicalizeJson(manifest);
parseScabiManifest(source);
writeFileSync(join(root, "package.scabi.json"), source);
