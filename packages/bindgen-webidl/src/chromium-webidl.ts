import { createHash } from "node:crypto";
import {
  SCABI_SCHEMA_VERSION,
  assertScabiManifest,
  canonicalizeJson,
} from "@native-typescript/scabi";
import type {
  ScabiManifest,
  Sha256Digest,
  TargetIdentity,
} from "@native-typescript/scabi";

export const CHROMIUM_WEBIDL_SLICE_SCHEMA_VERSION = 2 as const;

export interface ChromiumWebIdlArgument {
  readonly name: string;
  readonly type: string;
  readonly optionality: "required" | "optional" | "variadic";
}

export interface ChromiumWebIdlOperation {
  readonly kind: "operation";
  readonly name: string;
  readonly returnType: string;
  readonly arguments: readonly ChromiumWebIdlArgument[];
  readonly implementedAs: string;
  readonly extendedAttributes: readonly string[];
  readonly static: boolean;
}

export interface ChromiumWebIdlAttribute {
  readonly kind: "attribute";
  readonly name: string;
  readonly type: string;
  readonly implementedAs: string;
  readonly extendedAttributes: readonly string[];
  readonly readonly: boolean;
  readonly static: boolean;
}

export interface ChromiumWebIdlInterface {
  readonly name: string;
  readonly inherited: string | null;
  readonly blinkHeaders: readonly string[];
  readonly attributes: readonly ChromiumWebIdlAttribute[];
  readonly operations: readonly ChromiumWebIdlOperation[];
}

/**
 * A deterministic JSON boundary around Chromium's Python-pickled normalized
 * WebIDL database. The pickle remains Chromium-owned; no JavaScript parser
 * attempts to reinterpret raw IDL or Python object internals.
 */
export interface ChromiumWebIdlSlice {
  readonly schema: "native-typescript.chromium-webidl-slice";
  readonly schemaVersion: typeof CHROMIUM_WEBIDL_SLICE_SCHEMA_VERSION;
  readonly chromiumRevision: string;
  readonly interfaces: readonly ChromiumWebIdlInterface[];
}

export interface ChromiumCreateElementGenerationOptions {
  readonly database: ChromiumWebIdlSlice;
  readonly webIdlDatabaseDigest: Sha256Digest;
  readonly typescriptLibraryDigest: Sha256Digest;
  readonly target: TargetIdentity;
  readonly clangVersion: string;
  readonly generatorRevision: string;
}

export interface ChromiumCreateElementBinding {
  readonly declarations: string;
  readonly capsuleHeader: string;
  readonly capsuleSource: string;
  readonly manifest: ScabiManifest;
}

const commitPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${path} fields must be exactly: ${expected.join(", ")}`);
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
}

function validateArgument(value: unknown, path: string): ChromiumWebIdlArgument {
  assertRecord(value, path);
  assertExactKeys(value, ["name", "optionality", "type"], path);
  assertString(value.name, `${path}/name`);
  assertString(value.type, `${path}/type`);
  if (
    value.optionality !== "required" &&
    value.optionality !== "optional" &&
    value.optionality !== "variadic"
  ) {
    throw new TypeError(`${path}/optionality is unsupported`);
  }
  return value as unknown as ChromiumWebIdlArgument;
}

function validateOperation(value: unknown, path: string): ChromiumWebIdlOperation {
  assertRecord(value, path);
  assertExactKeys(
    value,
    [
      "arguments",
      "extendedAttributes",
      "implementedAs",
      "kind",
      "name",
      "returnType",
      "static",
    ],
    path,
  );
  if (value.kind !== "operation") throw new TypeError(`${path}/kind is unsupported`);
  assertString(value.name, `${path}/name`);
  assertString(value.returnType, `${path}/returnType`);
  assertString(value.implementedAs, `${path}/implementedAs`);
  if (!identifierPattern.test(value.implementedAs)) {
    throw new TypeError(`${path}/implementedAs must be a C++ identifier`);
  }
  if (typeof value.static !== "boolean") {
    throw new TypeError(`${path}/static must be boolean`);
  }
  if (!Array.isArray(value.arguments)) {
    throw new TypeError(`${path}/arguments must be an array`);
  }
  value.arguments.forEach((argument, index) => {
    validateArgument(argument, `${path}/arguments/${index}`);
  });
  if (
    !Array.isArray(value.extendedAttributes) ||
    value.extendedAttributes.some((attribute) => typeof attribute !== "string")
  ) {
    throw new TypeError(`${path}/extendedAttributes must be a string array`);
  }
  const attributes = value.extendedAttributes as string[];
  if (attributes.some((attribute, index) => index > 0 && attributes[index - 1]! >= attribute)) {
    throw new TypeError(`${path}/extendedAttributes must be unique and sorted`);
  }
  return value as unknown as ChromiumWebIdlOperation;
}

function validateAttribute(value: unknown, path: string): ChromiumWebIdlAttribute {
  assertRecord(value, path);
  assertExactKeys(
    value,
    [
      "extendedAttributes",
      "implementedAs",
      "kind",
      "name",
      "readonly",
      "static",
      "type",
    ],
    path,
  );
  if (value.kind !== "attribute") {
    throw new TypeError(`${path}/kind is unsupported`);
  }
  assertString(value.name, `${path}/name`);
  assertString(value.type, `${path}/type`);
  assertString(value.implementedAs, `${path}/implementedAs`);
  if (!identifierPattern.test(value.implementedAs)) {
    throw new TypeError(`${path}/implementedAs must be a C++ identifier`);
  }
  if (typeof value.readonly !== "boolean") {
    throw new TypeError(`${path}/readonly must be boolean`);
  }
  if (typeof value.static !== "boolean") {
    throw new TypeError(`${path}/static must be boolean`);
  }
  if (
    !Array.isArray(value.extendedAttributes) ||
    value.extendedAttributes.some((attribute) => typeof attribute !== "string")
  ) {
    throw new TypeError(`${path}/extendedAttributes must be a string array`);
  }
  const attributes = value.extendedAttributes as string[];
  if (
    attributes.some(
      (attribute, index) => index > 0 && attributes[index - 1]! >= attribute,
    )
  ) {
    throw new TypeError(`${path}/extendedAttributes must be unique and sorted`);
  }
  return value as unknown as ChromiumWebIdlAttribute;
}

function validateInterface(value: unknown, path: string): ChromiumWebIdlInterface {
  assertRecord(value, path);
  assertExactKeys(
    value,
    ["attributes", "blinkHeaders", "inherited", "name", "operations"],
    path,
  );
  assertString(value.name, `${path}/name`);
  if (value.inherited !== null && typeof value.inherited !== "string") {
    throw new TypeError(`${path}/inherited must be a string or null`);
  }
  if (
    !Array.isArray(value.blinkHeaders) ||
    value.blinkHeaders.length === 0 ||
    value.blinkHeaders.some((header) => typeof header !== "string")
  ) {
    throw new TypeError(`${path}/blinkHeaders must be a non-empty string array`);
  }
  const headers = value.blinkHeaders as string[];
  if (headers.some((header, index) => index > 0 && headers[index - 1]! >= header)) {
    throw new TypeError(`${path}/blinkHeaders must be unique and sorted`);
  }
  if (!Array.isArray(value.operations)) {
    throw new TypeError(`${path}/operations must be an array`);
  }
  if (!Array.isArray(value.attributes)) {
    throw new TypeError(`${path}/attributes must be an array`);
  }
  value.attributes.forEach((attribute, index) => {
    validateAttribute(attribute, `${path}/attributes/${index}`);
  });
  value.operations.forEach((operation, index) => {
    validateOperation(operation, `${path}/operations/${index}`);
  });
  return value as unknown as ChromiumWebIdlInterface;
}

export function defineChromiumWebIdlSlice(value: unknown): ChromiumWebIdlSlice {
  assertRecord(value, "Chromium WebIDL slice");
  assertExactKeys(
    value,
    ["chromiumRevision", "interfaces", "schema", "schemaVersion"],
    "Chromium WebIDL slice",
  );
  if (
    value.schema !== "native-typescript.chromium-webidl-slice" ||
    value.schemaVersion !== CHROMIUM_WEBIDL_SLICE_SCHEMA_VERSION
  ) {
    throw new TypeError("Unsupported Chromium WebIDL slice schema");
  }
  if (typeof value.chromiumRevision !== "string" || !commitPattern.test(value.chromiumRevision)) {
    throw new TypeError("Chromium WebIDL slice revision must be a lowercase commit");
  }
  if (!Array.isArray(value.interfaces) || value.interfaces.length === 0) {
    throw new TypeError("Chromium WebIDL slice interfaces must be non-empty");
  }
  value.interfaces.forEach((entry, index) => {
    validateInterface(entry, `Chromium WebIDL slice/interfaces/${index}`);
  });
  const interfaces = value.interfaces as ChromiumWebIdlInterface[];
  if (interfaces.some((entry, index) => index > 0 && interfaces[index - 1]!.name >= entry.name)) {
    throw new TypeError("Chromium WebIDL slice interfaces must be unique and sorted");
  }
  const canonical = JSON.parse(canonicalizeJson(value)) as ChromiumWebIdlSlice;
  return deepFreeze(canonical);
}

export function serializeChromiumWebIdlSlice(value: ChromiumWebIdlSlice): string {
  return `${canonicalizeJson(defineChromiumWebIdlSlice(value))}\n`;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireDigest(value: string, path: string): asserts value is Sha256Digest {
  if (!digestPattern.test(value)) throw new TypeError(`${path} must be a sha256 digest`);
}

function findCreateElement(database: ChromiumWebIdlSlice): ChromiumWebIdlOperation {
  const document = database.interfaces.find(({ name }) => name === "Document");
  if (!document) throw new Error("NTS-WEBIDL-001: Document is absent from the normalized database");
  const candidates = document.operations.filter(({ name }) => name === "createElement");
  const operation = candidates.find(
    (candidate) =>
      candidate.arguments.length === 1 &&
      candidate.arguments[0]?.type === "DOMString",
  );
  if (!operation) {
    throw new Error("NTS-WEBIDL-002: Document.createElement(DOMString) is absent");
  }
  if (
    operation.static ||
    operation.returnType !== "Element" ||
    operation.arguments[0]?.optionality !== "required" ||
    operation.implementedAs !== "CreateElementForBinding" ||
    !operation.extendedAttributes.includes("RaisesException")
  ) {
    throw new Error(
      "NTS-WEBIDL-003: Document.createElement has an unsupported Blink call shape",
    );
  }
  return operation;
}

function generateManifest(
  options: ChromiumCreateElementGenerationOptions,
  declarations: string,
): ScabiManifest {
  if (
    options.target.pointerWidth !== 64 ||
    options.target.endianness !== "little" ||
    options.target.objectFormat !== "elf"
  ) {
    throw new Error(
      "NTS-WEBIDL-004: the first Chromium capsule has ABI evidence only for 64-bit little-endian ELF",
    );
  }
  requireDigest(options.webIdlDatabaseDigest, "webIdlDatabaseDigest");
  requireDigest(options.typescriptLibraryDigest, "typescriptLibraryDigest");
  const declarationsDigest =
    `sha256:${createHash("sha256").update(declarations).digest("hex")}` as Sha256Digest;
  const physical = (
    type:
      | { readonly kind: "void" }
      | { readonly kind: "integer"; readonly bits: number }
      | { readonly kind: "pointer"; readonly addressSpace: number }
      | {
          readonly kind: "struct";
          readonly packed: boolean;
          readonly fields: readonly (
            | { readonly kind: "integer"; readonly bits: number }
            | { readonly kind: "pointer"; readonly addressSpace: number }
          )[];
        },
    flags: {
      readonly alignment?: number;
      readonly byValue?: boolean;
      readonly structureReturn?: boolean;
    } = {},
  ) => ({
    type,
    alignment: flags.alignment ?? null,
    stackAlignment: null,
    extension: null,
    inRegister: false,
    byValue: flags.byValue ?? false,
    structureReturn: flags.structureReturn ?? false,
  });
  const i64Abi = { kind: "integer" as const, bits: 64 };
  const pointerAbi = { kind: "pointer" as const, addressSpace: 0 };
  const indirectAggregatePassing = {
    result: physical({ kind: "void" as const }),
    parameters: [
      physical(pointerAbi, { alignment: 8, structureReturn: true }),
      physical(pointerAbi, { alignment: 8, byValue: true }),
    ],
  };
  const value = {
    schema: "native-typescript.scabi" as const,
    schemaVersion: SCABI_SCHEMA_VERSION,
    package: {
      name: "@native-typescript/web-chromium",
      version: "0.0.0",
      namespace: "web",
      instance: options.database.chromiumRevision,
    },
    target: options.target,
    sdk: {
      vendor: "Chromium",
      name: "Blink",
      version: options.database.chromiumRevision,
      metadataDigest: options.webIdlDatabaseDigest,
      toolchain: "clang",
      toolchainVersion: options.clangVersion,
      toolchainAbi: options.target.abi,
      deploymentTarget: options.target.minimumPlatformVersion,
      modules: ["blink-core"],
    },
    generator: {
      name: "@native-typescript/bindgen-webidl",
      version: "0.0.0",
      revision: options.generatorRevision,
      arguments: ["Document.createElement(DOMString)"],
      inputDigests: [
        options.webIdlDatabaseDigest,
        options.typescriptLibraryDigest,
      ],
    },
    declarations: {
      digest: declarationsDigest,
      types: {
        realm: { module: ".", name: "NTSWebRealm" },
        u64: { module: ".", name: "NTSWebRealmId" },
        u32: { module: ".", name: "number" },
        usize: { module: ".", name: "number" },
        web_status: { module: ".", name: "NTSWebStatus" },
        web_handle: { module: ".", name: "NTSWebHandle" },
        web_scabi_handle_result: {
          module: ".",
          name: "NTSWebScabiHandleResult",
        },
      },
    },
    types: {
      void: { kind: "void" as const },
      u8: { kind: "integer" as const, signed: false, bits: 8 as const },
      u64: { kind: "integer" as const, signed: false, bits: 64 as const },
      u32: { kind: "integer" as const, signed: false, bits: 32 as const },
      usize: { kind: "integer" as const, signed: false, bits: "pointer" as const },
      realm: {
        kind: "handle" as const,
        nativeName: "NtsWebRealm*",
        threadSafety: "confined" as const,
        identity: "pointer" as const,
        upcasts: [],
      },
      const_u8_ptr: {
        kind: "pointer" as const,
        pointee: "u8",
        mutability: "const" as const,
        nullable: false,
        addressSpace: 0,
      },
      web_status: {
        kind: "enum" as const,
        underlying: "u32",
        members: {
          ok: "0",
          invalidArgument: "1",
          invalidHandle: "2",
          wrongRealm: "3",
          wrongSequence: "4",
          contextDestroyed: "5",
          typeError: "6",
          rangeError: "7",
          syntaxError: "8",
          domException: "9",
          operationDisabled: "10",
          outOfMemory: "11",
        },
      },
      web_handle: {
        kind: "struct" as const,
        size: 16,
        alignment: 8,
        packing: "default" as const,
        triviallyCopyable: true,
        destruction: "trivial" as const,
        abiPassing: {
          result: physical({
            kind: "struct" as const,
            packed: false,
            fields: [i64Abi, i64Abi],
          }),
          parameters: [physical(i64Abi), physical(i64Abi)],
        },
        fields: [
          { name: "realm", type: "u64", offset: 0 },
          { name: "slot", type: "u32", offset: 8, conversion: "number" as const },
          {
            name: "generation",
            type: "u32",
            offset: 12,
            conversion: "number" as const,
          },
        ],
      },
      web_scabi_handle_result: {
        kind: "struct" as const,
        size: 24,
        alignment: 8,
        packing: "default" as const,
        triviallyCopyable: true,
        destruction: "trivial" as const,
        abiPassing: indirectAggregatePassing,
        fields: [
          { name: "status", type: "web_status", offset: 0 },
          { name: "value", type: "web_handle", offset: 8 },
        ],
      },
    },
    bindings: {
      web_document_create_element: {
        kind: "function" as const,
        declaration: { module: ".", name: "documentCreateElementRaw" },
        entry: { symbol: "nts_web_document_create_element_scabi" },
        signature: {
          callingConvention: "c" as const,
          variadic: false as const,
          parameters: [
            {
              name: "realm",
              type: "realm",
              passMode: "pointer" as const,
              nullable: false,
              ownership: { kind: "borrowed" as const, scope: "call" as const },
            },
            {
              name: "document",
              type: "web_handle",
              passMode: "value" as const,
              nullable: false,
              ownership: { kind: "value" as const },
            },
            {
              name: "local_name_data",
              type: "const_u8_ptr",
              passMode: "pointer" as const,
              nullable: false,
              ownership: { kind: "borrowed" as const, scope: "call" as const },
              marshal: {
                kind: "string" as const,
                encoding: "utf-8" as const,
                length: {
                  kind: "parameter" as const,
                  parameter: "local_name_length",
                },
                termination: "none" as const,
                embeddedNul: "allow" as const,
              },
            },
            {
              name: "local_name_length",
              type: "usize",
              passMode: "value" as const,
              nullable: false,
              ownership: { kind: "value" as const },
            },
          ],
          result: {
            type: "web_scabi_handle_result",
            passMode: "value" as const,
            nullable: false,
            ownership: { kind: "value" as const },
          },
        },
        thread: {
          // The ScriptC runtime is attached to Blink's renderer sequence; the
          // realm check independently rejects a call from any other sequence.
          executor: { kind: "runtime-owner" as const },
          behavior: "require" as const,
          blocking: false,
        },
        error: { kind: "no-fail" as const },
        dependencies: {
          bindings: [],
          linkInputs: ["chromium_blink"],
          adapterInputs: ["blink_typed_capsules"],
          permissions: [],
        },
      },
    },
    linkInputs: [
      {
        id: "chromium_blink",
        kind: "runtime-component" as const,
        name: "Blink renderer core",
        order: 0,
      },
    ],
    adapterInputs: [
      {
        id: "blink_typed_capsules",
        family: "chromium-webidl",
        language: "c++" as const,
        bindings: ["web_document_create_element"],
        outputs: ["nts_webidl_capsules.h", "nts_webidl_capsules.cc"],
        options: {
          chromiumRevision: options.database.chromiumRevision,
          v8Values: false,
          genericDispatch: false,
        },
      },
    ],
    permissions: [],
    platform: {
      chromium: {
        revision: options.database.chromiumRevision,
        databaseDigest: options.webIdlDatabaseDigest,
        operations: ["Document.createElement(DOMString)"],
      },
    },
  };
  return assertScabiManifest(value);
}

export function generateChromiumCreateElementBinding(
  options: ChromiumCreateElementGenerationOptions,
): ChromiumCreateElementBinding {
  const database = defineChromiumWebIdlSlice(options.database);
  const operation = findCreateElement(database);
  const document = database.interfaces.find(({ name }) => name === "Document")!;
  const documentHeader = document.blinkHeaders.find((header) =>
    header.endsWith("/core/dom/document.h"),
  );
  if (!documentHeader) {
    throw new Error("NTS-WEBIDL-005: Document's Blink implementation header is absent");
  }
  const declarations = [
    "// Generated from lib.dom.d.ts and Chromium normalized WebIDL; do not edit.",
    "declare const nativeScalar: unique symbol;",
    "export type NTSWebRealmId = bigint & {",
    "  readonly [nativeScalar]: \"NTSWebRealmId\";",
    "};",
    "export interface NTSWebHandle {",
    "  readonly realm: NTSWebRealmId;",
    "  readonly slot: number;",
    "  readonly generation: number;",
    "}",
    "export declare enum NTSWebStatus {",
    "  Ok = 0,",
    "  InvalidArgument = 1,",
    "  InvalidHandle = 2,",
    "  WrongRealm = 3,",
    "  WrongSequence = 4,",
    "  ContextDestroyed = 5,",
    "  TypeError = 6,",
    "  RangeError = 7,",
    "  SyntaxError = 8,",
    "  DomException = 9,",
    "  OperationDisabled = 10,",
    "  OutOfMemory = 11,",
    "}",
    "export interface NTSWebScabiHandleResult {",
    "  readonly status: NTSWebStatus;",
    "  readonly value: NTSWebHandle;",
    "}",
    "export declare class NTSWebRealm {",
    "  private readonly __nativeType: unique symbol;",
    "}",
    "export declare function documentCreateElementRaw(",
    "  realm: NTSWebRealm,",
    "  document: NTSWebHandle,",
    "  localName: string,",
    "): NTSWebScabiHandleResult;",
    "export type NTSReachedDocumentCreateElement = (",
    "  receiver: Document,",
    "  localName: string,",
    ") => Element;",
    "",
  ].join("\n");
  const capsuleHeader = [
    "// Generated typed Blink capsule; do not edit.",
    "#ifndef NTS_WEBIDL_CAPSULES_H",
    "#define NTS_WEBIDL_CAPSULES_H",
    "",
    "#include <stddef.h>",
    "#include <stdint.h>",
    "",
    "#include \"third_party/blink/renderer/native_typescript/nts_web.h\"",
    "",
    "namespace blink {",
    "class AtomicString;",
    "class Document;",
    "class Element;",
    "class ExceptionState;",
    "}  // namespace blink",
    "",
    "namespace nts::blink_bridge::generated {",
    "blink::Element* DocumentCreateElement(blink::Document& receiver,",
    "                                      const blink::AtomicString& local_name,",
    "                                      blink::ExceptionState& exception_state);",
    "}",
    "",
    "extern \"C\" NtsWebScabiHandleResult nts_web_document_create_element_scabi(",
    "    NtsWebRealm* realm,",
    "    NtsWebHandle document,",
    "    const uint8_t* local_name,",
    "    size_t local_name_length);",
    "",
    "#endif",
    "",
  ].join("\n");
  const capsuleSource = [
    "// Generated typed Blink capsule; do not edit.",
    "#include \"third_party/blink/renderer/native_typescript/generated/nts_webidl_capsules.h\"",
    "",
    `#include "${documentHeader}"`,
    "#include \"third_party/blink/renderer/core/dom/element.h\"",
    "#include \"third_party/blink/renderer/platform/bindings/exception_state.h\"",
    "#include \"third_party/blink/renderer/platform/wtf/text/atomic_string.h\"",
    "",
    "namespace nts::blink_bridge::generated {",
    "blink::Element* DocumentCreateElement(blink::Document& receiver,",
    "                                      const blink::AtomicString& local_name,",
    "                                      blink::ExceptionState& exception_state) {",
    `  return receiver.${operation.implementedAs}(local_name, exception_state);`,
    "}",
    "}  // namespace nts::blink_bridge::generated",
    "",
    "extern \"C\" NtsWebScabiHandleResult nts_web_document_create_element_scabi(",
    "    NtsWebRealm* realm,",
    "    NtsWebHandle document,",
    "    const uint8_t* local_name,",
    "    size_t local_name_length) {",
    "  const NtsUtf8View local_name_view = {local_name, local_name_length};",
    "  NtsWebHandleResult source =",
    "      nts_web_document_create_element(realm, document, local_name_view);",
    "  const NtsWebScabiHandleResult result = {source.status, source.value};",
    "  nts_web_exception_dispose(&source.exception);",
    "  return result;",
    "}",
    "",
  ].join("\n");
  const result = {
    declarations,
    capsuleHeader,
    capsuleSource,
    manifest: generateManifest({ ...options, database }, declarations),
  };
  return deepFreeze(result);
}
