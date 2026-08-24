import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  CHROMIUM_WEBIDL_INPUT_SCHEMA_VERSION,
  CHROMIUM_WEBIDL_SLICE_SCHEMA_VERSION,
  defineChromiumWebIdlSlice,
  defineChromiumWebIdlInput,
  generateChromiumCreateElementBinding,
  serializeChromiumWebIdlSlice,
  serializeChromiumWebIdlInput,
} from "@native-typescript/bindgen-webidl";
import { canonicalizeJson, validateScabiManifest } from "@native-typescript/scabi";
import { translateScabiNativeProgram } from "@native-typescript/scriptc";

const zeroDigest = `sha256:${"0".repeat(64)}` as const;
const oneDigest = `sha256:${"1".repeat(64)}` as const;
const chromiumPackageRoot = resolve(
  import.meta.dirname,
  "../packages/target-chromium",
);

test("Chromium WebIDL input pins both implementation and source authorities", () => {
  const input = defineChromiumWebIdlInput({
    schemaVersion: CHROMIUM_WEBIDL_INPUT_SCHEMA_VERSION,
    chromiumRevision: "96324a4012fe62f48b9463a67486eeb645bc5c78",
    webIdlDatabaseDigest: zeroDigest,
    typescriptLibraryDigest: oneDigest,
  });

  assert.equal(Object.isFrozen(input), true);
  assert.equal(
    serializeChromiumWebIdlInput(input),
    `{"chromiumRevision":"96324a4012fe62f48b9463a67486eeb645bc5c78","schemaVersion":1,"typescriptLibraryDigest":"${oneDigest}","webIdlDatabaseDigest":"${zeroDigest}"}\n`,
  );
});

test("Chromium WebIDL provenance rejects ambiguous identities", () => {
  assert.throws(
    () =>
      defineChromiumWebIdlInput({
        schemaVersion: CHROMIUM_WEBIDL_INPUT_SCHEMA_VERSION,
        chromiumRevision: "main",
        webIdlDatabaseDigest: zeroDigest,
        typescriptLibraryDigest: oneDigest,
      }),
    /lowercase 40-character commit/u,
  );
  assert.throws(
    () =>
      defineChromiumWebIdlInput({
        schemaVersion: CHROMIUM_WEBIDL_INPUT_SCHEMA_VERSION,
        chromiumRevision: "96324a4012fe62f48b9463a67486eeb645bc5c78",
        webIdlDatabaseDigest: "sha256:not-a-digest" as never,
        typescriptLibraryDigest: oneDigest,
      }),
    /lowercase sha256 digest/u,
  );
  assert.throws(
    () =>
      defineChromiumWebIdlInput({
        schemaVersion: CHROMIUM_WEBIDL_INPUT_SCHEMA_VERSION,
        chromiumRevision: "96324a4012fe62f48b9463a67486eeb645bc5c78",
        webIdlDatabaseDigest: zeroDigest,
        typescriptLibraryDigest: oneDigest,
        unversionedInput: true,
      } as never),
    /fields must be exactly/u,
  );
});

function createElementSlice(implementedAs = "CreateElementForBinding") {
  return defineChromiumWebIdlSlice({
    schema: "native-typescript.chromium-webidl-slice",
    schemaVersion: CHROMIUM_WEBIDL_SLICE_SCHEMA_VERSION,
    chromiumRevision: "96324a4012fe62f48b9463a67486eeb645bc5c78",
    interfaces: [
      {
        name: "Document",
        inherited: "Node",
        blinkHeaders: [
          "third_party/blink/renderer/core/animation/document_animation.h",
          "third_party/blink/renderer/core/dom/document.h",
        ],
        operations: [
          {
            kind: "operation",
            name: "createElement",
            returnType: "Element",
            arguments: [
              {
                name: "localName",
                type: "DOMString",
                optionality: "required",
              },
            ],
            implementedAs,
            extendedAttributes: [
              "ImplementedAs",
              "NewObject",
              "PerWorldBindings",
              "RaisesException",
            ],
            static: false,
          },
          {
            kind: "operation",
            name: "createElement",
            returnType: "Element",
            arguments: [
              {
                name: "localName",
                type: "DOMString",
                optionality: "required",
              },
              {
                name: "options",
                type: "(DOMString or ElementCreationOptions)",
                optionality: "required",
              },
            ],
            implementedAs: "CreateElementForBinding",
            extendedAttributes: ["NewObject", "PerWorldBindings", "RaisesException"],
            static: false,
          },
        ],
      },
    ],
  });
}

test("Chromium normalized WebIDL slice is canonical and closed", () => {
  const slice = createElementSlice();
  assert.equal(Object.isFrozen(slice), true);
  assert.equal(Object.isFrozen(slice.interfaces[0]?.operations), true);
  assert.equal(
    serializeChromiumWebIdlSlice(slice),
    `${JSON.stringify(slice)}\n`,
  );
  assert.throws(
    () =>
      defineChromiumWebIdlSlice({
        ...structuredClone(slice),
        rawIdlPath: "/ambient/Document.idl",
      }),
    /fields must be exactly/u,
  );
});

test("reached createElement becomes declarations, valid SCABI, and a typed capsule", () => {
  const generated = generateChromiumCreateElementBinding({
    database: createElementSlice(),
    webIdlDatabaseDigest: zeroDigest,
    typescriptLibraryDigest: oneDigest,
    generatorRevision: "chromium-create-element-v1",
    clangVersion: "24.0.0",
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
  });

  assert.equal(validateScabiManifest(generated.manifest).ok, true);
  const binding = generated.manifest.bindings.web_document_create_element;
  assert.ok(binding && binding.kind !== "constant");
  assert.equal(binding.kind, "function");
  assert.equal(binding.entry.symbol, "nts_web_document_create_element_scabi");
  assert.equal(
    translateScabiNativeProgram(generated.manifest, {
      imports: ["web_document_create_element"],
      exports: [],
    }).ok,
    true,
  );
  assert.deepEqual(generated.manifest.types.web_handle, {
    kind: "struct",
    size: 16,
    alignment: 8,
    packing: "default",
    triviallyCopyable: true,
    destruction: "trivial",
    abiPassing: {
      result: {
        type: {
          kind: "struct",
          packed: false,
          fields: [
            { kind: "integer", bits: 64 },
            { kind: "integer", bits: 64 },
          ],
        },
        alignment: null,
        stackAlignment: null,
        extension: null,
        inRegister: false,
        byValue: false,
        structureReturn: false,
      },
      parameters: [
        {
          type: { kind: "integer", bits: 64 },
          alignment: null,
          stackAlignment: null,
          extension: null,
          inRegister: false,
          byValue: false,
          structureReturn: false,
        },
        {
          type: { kind: "integer", bits: 64 },
          alignment: null,
          stackAlignment: null,
          extension: null,
          inRegister: false,
          byValue: false,
          structureReturn: false,
        },
      ],
    },
    fields: [
      { name: "realm", type: "u64", offset: 0 },
      { name: "slot", type: "u32", offset: 8, conversion: "number" },
      {
        name: "generation",
        type: "u32",
        offset: 12,
        conversion: "number",
      },
    ],
  });
  assert.match(generated.declarations, /receiver: Document/u);
  assert.match(
    generated.capsuleSource,
    /receiver\.CreateElementForBinding\(local_name, exception_state\)/u,
  );
  assert.doesNotMatch(
    `${generated.capsuleHeader}\n${generated.capsuleSource}`,
    /\bv8::|generic|malloc|new\s/u,
  );
});

test("Chromium capsule generation refuses implementation drift", () => {
  assert.throws(
    () =>
      generateChromiumCreateElementBinding({
        database: createElementSlice("CreateElementThroughV8"),
        webIdlDatabaseDigest: zeroDigest,
        typescriptLibraryDigest: oneDigest,
        generatorRevision: "chromium-create-element-v1",
        clangVersion: "24.0.0",
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
      }),
    /NTS-WEBIDL-003/u,
  );
});

test("committed Chromium capsule artifacts match the pinned normalized database", () => {
  const webIdlRoot = resolve(chromiumPackageRoot, "chromium/webidl");
  const overlayGeneratedRoot = resolve(
    chromiumPackageRoot,
    "chromium/overlay/generated",
  );
  const database = defineChromiumWebIdlSlice(
    JSON.parse(
      readFileSync(resolve(webIdlRoot, "document-create-element.json"), "utf8"),
    ),
  );
  const input = defineChromiumWebIdlInput(
    JSON.parse(readFileSync(resolve(webIdlRoot, "input.json"), "utf8")),
  );
  const generated = generateChromiumCreateElementBinding({
    database,
    webIdlDatabaseDigest: input.webIdlDatabaseDigest,
    typescriptLibraryDigest: input.typescriptLibraryDigest,
    generatorRevision: "chromium-create-element-v1",
    clangVersion: "24.0.0git",
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
  });

  assert.equal(
    readFileSync(resolve(webIdlRoot, "reached.d.ts"), "utf8"),
    generated.declarations,
  );
  assert.equal(
    readFileSync(resolve(webIdlRoot, "package.scabi.json"), "utf8"),
    `${canonicalizeJson(generated.manifest)}\n`,
  );
  assert.equal(
    readFileSync(resolve(overlayGeneratedRoot, "nts_webidl_capsules.h"), "utf8"),
    generated.capsuleHeader,
  );
  assert.equal(
    readFileSync(resolve(overlayGeneratedRoot, "nts_webidl_capsules.cc"), "utf8"),
    generated.capsuleSource,
  );
});
