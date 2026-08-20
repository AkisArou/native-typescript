import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCABI_SCHEMA_VERSION,
  canonicalizeJson,
  parseScabiManifest,
} from "../../packages/scabi/src/index.ts";

const root = import.meta.dirname;
const digest = (path) =>
  `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const declarationsDigest = digest(join(root, "package.d.ts"));
const headerDigest = digest(join(root, "include/nts_gtk_counter.h"));

const linkInputs = [
  ["gtk-counter-runtime", "runtime-component", "gtk-counter-runtime"],
  ["gtk-4", "system-library", "gtk-4"],
  ["pangocairo-1.0", "system-library", "pangocairo-1.0"],
  ["pango-1.0", "system-library", "pango-1.0"],
  ["harfbuzz", "system-library", "harfbuzz"],
  ["gdk_pixbuf-2.0", "system-library", "gdk_pixbuf-2.0"],
  ["cairo-gobject", "system-library", "cairo-gobject"],
  ["cairo", "system-library", "cairo"],
  ["vulkan", "system-library", "vulkan"],
  ["graphene-1.0", "system-library", "graphene-1.0"],
  ["gio-2.0", "system-library", "gio-2.0"],
  ["gobject-2.0", "system-library", "gobject-2.0"],
  ["glib-2.0", "system-library", "glib-2.0"],
].map(([id, kind, name], order) => ({ id, kind, name, order }));
const dependencyIds = linkInputs.map(({ id }) => id);
const dependencies = (bindings = []) => ({
  adapterInputs: [],
  bindings,
  linkInputs: dependencyIds,
  permissions: [],
});
const value = (name, type) => ({
  name,
  nullable: false,
  ownership: { kind: "value" },
  passMode: "value",
  type,
});
const voidResult = {
  nullable: false,
  ownership: { kind: "value" },
  passMode: "value",
  type: "void",
};
const ownerThread = {
  behavior: "require",
  blocking: false,
  executor: { kind: "runtime-owner" },
};
const callable = ({
  declaration,
  symbol,
  kind = "function",
  parameters = [],
  result = voidResult,
  error = { kind: "no-fail" },
  bindings = [],
}) => ({
  declaration: { module: ".", name: declaration },
  dependencies: dependencies(bindings),
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
});
const borrowedCounter = {
  name: "counter",
  nullable: false,
  ownership: { kind: "borrowed", scope: "call" },
  passMode: "pointer",
  type: "gtk_counter",
};

const manifest = {
  adapterInputs: [],
  bindings: {
    complete: callable({
      declaration: "complete",
      symbol: "nts_gtk_counter_complete",
      parameters: [value("value", "i32")],
    }),
    counter_create: callable({
      declaration: "createCounter",
      symbol: "nts_gtk_counter_create",
      kind: "factory",
      bindings: ["counter_destroy"],
      parameters: [
        {
          callback: {
            allowedInvocationExecutors: [{ kind: "same-as-caller" }],
            arguments: [{ parameter: "count", transport: "copy" }],
            cancellationBinding: "counter_destroy",
            contextParameter: "context",
            registrationOwner: "result",
            synchronousReturn: false,
          },
          name: "callback",
          nullable: false,
          ownership: {
            anchor: "result",
            kind: "borrowed",
            scope: "registration",
          },
          passMode: "pointer",
          type: "counter_callback",
        },
        {
          name: "context",
          nullable: false,
          ownership: {
            anchor: "callback",
            kind: "borrowed",
            scope: "registration",
          },
          passMode: "pointer",
          type: "void_ptr",
        },
      ],
      result: {
        nullable: true,
        ownership: {
          // The handle type names its destructor; repeating it on the
          // position is refused, because the two could disagree about the
          // same pointer.
          kind: "owned",
          transfer: "to-runtime",
        },
        passMode: "pointer",
        type: "gtk_counter",
      },
      error: { kind: "nullable" },
    }),
    counter_destroy: callable({
      declaration: "GtkCounter.dispose",
      symbol: "nts_gtk_counter_destroy",
      kind: "method",
      parameters: [{
        name: "counter",
        nullable: true,
        ownership: { kind: "owned", transfer: "to-native" },
        passMode: "pointer",
        type: "gtk_counter",
      }],
    }),
    counter_schedule_click: callable({
      declaration: "GtkCounter.scheduleClick",
      symbol: "nts_gtk_counter_schedule_click",
      kind: "method",
      parameters: [borrowedCounter],
    }),
    counter_close: callable({
      declaration: "closeCounter",
      symbol: "nts_gtk_counter_close",
    }),
  },
  declarations: {
    digest: declarationsDigest,
    types: {
      gtk_counter: { module: ".", name: "GtkCounter" },
      i32: { module: ".", name: "i32" },
    },
  },
  generator: {
    arguments: ["--target=x86_64-unknown-linux-gnu", "--pkg-config=gtk4"],
    inputDigests: [headerDigest],
    name: "native-typescript.gtk-counter-fixture",
    revision: "manual-v1",
    version: "1",
  },
  linkInputs,
  package: {
    instance: "native-typescript.fixture.gtk-counter@0.0.0",
    name: "@native-typescript/gtk-counter-fixture",
    namespace: "native-typescript.fixture.gtk-counter",
    version: "0.0.0",
  },
  permissions: [],
  schema: "native-typescript.scabi",
  schemaVersion: SCABI_SCHEMA_VERSION,
  sdk: {
    deploymentTarget: "x86_64-unknown-linux-gnu",
    metadataDigest: headerDigest,
    modules: ["gtk4", "nts_gtk_counter.h"],
    name: "gtk-counter-fixture",
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
    counter_callback: {
      context: { placement: "last", type: "void_ptr" },
      kind: "callback",
      signature: {
        callingConvention: "c",
        parameters: [value("count", "i32")],
        result: voidResult,
        variadic: false,
      },
    },
    gtk_counter: {
      // Every owner of this handle releases it the same way, so the type is
      // the one honest place to say how.
      destructor: "counter_destroy",
      identity: "pointer",
      kind: "handle",
      nativeName: "NtsGtkCounter",
      threadSafety: "confined",
      upcasts: [],
    },
    i32: { bits: 32, kind: "integer", signed: true },
    void: { kind: "void" },
    void_ptr: {
      addressSpace: 0,
      kind: "pointer",
      mutability: "mutable",
      nullable: true,
      pointee: "void",
    },
  },
};

const source = canonicalizeJson(manifest);
parseScabiManifest(source);
writeFileSync(join(root, "package.scabi.json"), source);
