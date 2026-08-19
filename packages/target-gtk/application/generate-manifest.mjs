import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalizeJson,
  parseScabiManifest,
} from "../../scabi/src/index.ts";

const root = import.meta.dirname;
const runtime = join(root, "..", "runtime");

function digest(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

const declarationsDigest = digest(join(root, "package.d.ts"));
const headerDigest = digest(join(runtime, "nts_gtk_application.h"));

/* The bootstrap links against the same GTK stack an application does, so the
 * lists merge rather than extend when the two packages compose. Only the
 * runtime component is this package's own. */
const linkInputs = [
  ["gtk-application-runtime", "runtime-component", "gtk-application-runtime"],
  ["gtk-4", "system-library", "gtk-4"],
  ["gio-2.0", "system-library", "gio-2.0"],
  ["gobject-2.0", "system-library", "gobject-2.0"],
  ["glib-2.0", "system-library", "glib-2.0"],
].map(([id, kind, name], order) => ({ id, kind, name, order }));

const voidResult = {
  nullable: false,
  ownership: { kind: "value" },
  passMode: "value",
  type: "void",
};

/* Both entry points touch GTK and the owner runtime's own bookkeeping, so both
 * are confined to the thread that owns the runtime. Neither blocks: start
 * attaches a source and returns, and quit only sets a flag the loop reads. */
const ownerThread = {
  behavior: "require",
  blocking: false,
  executor: { kind: "runtime-owner" },
};

function callable({ declaration, symbol, result = voidResult }) {
  return {
    declaration: { module: ".", name: declaration },
    dependencies: {
      adapterInputs: [],
      bindings: [],
      linkInputs: linkInputs.map(({ id }) => id),
      permissions: [],
    },
    entry: { symbol },
    error: { kind: "no-fail" },
    kind: "function",
    signature: {
      callingConvention: "c",
      parameters: [],
      result,
      variadic: false,
    },
    thread: ownerThread,
  };
}

const manifest = {
  adapterInputs: [],
  bindings: {
    application_quit: callable({
      declaration: "applicationQuit",
      symbol: "nts_gtk_application_quit",
    }),
    application_start: callable({
      declaration: "applicationStart",
      symbol: "nts_gtk_application_start",
      result: {
        nullable: false,
        ownership: { kind: "value" },
        passMode: "value",
        type: "native_boolean",
      },
    }),
  },
  declarations: {
    digest: declarationsDigest,
    types: {},
  },
  generator: {
    arguments: ["--target=x86_64-unknown-linux-gnu", "--pkg-config=gtk4"],
    inputDigests: [headerDigest],
    name: "native-typescript.target-gtk.application",
    revision: "manual-v1",
    version: "1",
  },
  linkInputs,
  package: {
    instance: "native-typescript.target.gtk.application@0.0.0",
    name: "@native-typescript/gtk-application",
    namespace: "native-typescript.target.gtk.application",
    version: "0.0.0",
  },
  permissions: [],
  schema: "native-typescript.scabi",
  schemaVersion: 6,
  sdk: {
    deploymentTarget: "x86_64-unknown-linux-gnu",
    metadataDigest: headerDigest,
    modules: ["gtk4", "nts_gtk_application.h"],
    name: "gtk-application",
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
    features: ["gtk4", "glib-main-context"],
    minimumPlatformVersion: "glibc-2.17",
    objectFormat: "elf",
    pointerWidth: 64,
    triple: "x86_64-unknown-linux-gnu",
  },
  types: {
    /* C's _Bool occupies one byte under the SysV ABI, and the bootstrap
     * returns stdbool's bool rather than a gboolean. */
    native_boolean: {
      falseValue: "0",
      kind: "boolean",
      storage: "u8",
      trueValue: "1",
    },
    u8: { bits: 8, kind: "integer", signed: false },
    void: { kind: "void" },
  },
};

const source = canonicalizeJson(manifest);
parseScabiManifest(source);
writeFileSync(join(root, "package.scabi.json"), source);
