import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  CHROMIUM_WEBIDL_INPUT_SCHEMA_VERSION,
  CHROMIUM_WEBIDL_SLICE_SCHEMA_VERSION,
  defineChromiumWebIdlSlice,
  defineChromiumWebIdlInput,
  generateChromiumCreateElementBinding,
  generateChromiumDomCounterBinding,
  serializeChromiumWebIdlSlice,
  serializeChromiumWebIdlInput,
} from "@native-typescript/bindgen-webidl";
import { canonicalizeJson, validateScabiManifest } from "@native-typescript/scabi";
import {
  loadScriptCLibraryPlanners,
  scriptCCompilerDistribution,
  type ScriptCLibraryCompilationPlan,
  translateScabiNativeProgram,
} from "@native-typescript/scriptc";

interface ScriptCLibraryEmitter {
  readonly emitLibraryCompilationPlan: (
    plan: ScriptCLibraryCompilationPlan,
  ) => string;
}

const zeroDigest = `sha256:${"0".repeat(64)}` as const;
const oneDigest = `sha256:${"1".repeat(64)}` as const;
const chromiumPackageRoot = resolve(
  import.meta.dirname,
  "../packages/target-chromium",
);

function collectRecords(
  value: unknown,
  predicate: (record: Readonly<Record<string, unknown>>) => boolean,
  output: Readonly<Record<string, unknown>>[] = [],
): Readonly<Record<string, unknown>>[] {
  if (value === null || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) collectRecords(item, predicate, output);
    return output;
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (predicate(record)) output.push(record);
  for (const child of Object.values(record)) {
    collectRecords(child, predicate, output);
  }
  return output;
}

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
        attributes: [],
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
      readFileSync(resolve(webIdlRoot, "dom-counter.json"), "utf8"),
    ),
  );
  const input = defineChromiumWebIdlInput(
    JSON.parse(readFileSync(resolve(webIdlRoot, "input.json"), "utf8")),
  );
  const generated = generateChromiumDomCounterBinding({
    database,
    webIdlDatabaseDigest: input.webIdlDatabaseDigest,
    typescriptLibraryDigest: input.typescriptLibraryDigest,
    generatorRevision: "chromium-dom-counter-v1",
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

  const imports = [
    "web_current_document",
    "web_document_body",
    "web_document_create_element",
    "web_document_create_text_node",
    "web_node_append_child",
    "web_node_remove_child",
    "web_element_set_attribute",
    "web_element_query_selector",
    "web_html_element_click",
    "web_character_data_set_data",
    "web_event_target_listen",
    "web_subscription_release",
  ];
  const translated = translateScabiNativeProgram(generated.manifest, {
    imports,
    exports: [],
  });
  assert.equal(
    translated.ok,
    true,
    translated.ok ? undefined : JSON.stringify(translated.diagnostics),
  );
  assert.deepEqual(generated.manifest.types.text, {
    kind: "handle",
    nativeName: "NtsWebNode*",
    threadSafety: "confined",
    identity: "pointer",
    upcasts: [{ kind: "identity", target: "character_data" }],
    destructor: "web_node_release",
  });
  const listen = generated.manifest.bindings.web_event_target_listen;
  assert.ok(listen && listen.kind === "method");
  if (listen && listen.kind === "method") {
    const callback = listen.signature.parameters.find(
      (parameter) => parameter.name === "callback",
    );
    assert.equal(callback?.callback?.registrationOwner, "result");
    assert.equal(
      callback?.callback?.cancellationBinding,
      "web_subscription_release",
    );
    assert.deepEqual(callback?.callback?.frameBoundedContext, {
      releaseParameter: "context_release",
    });
    assert.deepEqual(listen.signature.result.frameBounded, {
      entry: "nts_web_event_target_listen_frame",
      release: "nts_web_subscription_release_frame",
    });
  }
  if (translated.ok) {
    const translatedListen = translated.input.bindings.find(
      (binding) => binding.id.endsWith("#web_event_target_listen"),
    );
    assert.ok(translatedListen);
    assert.equal(
      translatedListen.parameters.filter(
        (parameter) => parameter.projection.kind === "callbackContextRelease",
      ).length,
      1,
    );
  }
  assert.match(generated.declarations, /createTextNode\(data: string\): Text/u);
  assert.match(generated.declarations, /listen\(type: string, callback:/u);
  assert.match(generated.capsuleHeader, /nts_web_event_target_listen_frame/u);
  assert.match(generated.capsuleHeader, /nts_web_subscription_release_frame/u);
  assert.doesNotMatch(
    `${generated.capsuleHeader}\n${generated.capsuleSource}`,
    /\bv8::|genericDispatch|malloc|new\s/u,
  );
});

test("DOM counter generation refuses a changed CharacterData string policy", () => {
  const database = JSON.parse(
    readFileSync(
      resolve(chromiumPackageRoot, "chromium/webidl/dom-counter.json"),
      "utf8",
    ),
  );
  const data = database.interfaces
    .find((interface_: { name: string }) => interface_.name === "CharacterData")
    .attributes.find((attribute: { name: string }) => attribute.name === "data");
  data.type = "DOMString";
  assert.throws(
    () =>
      generateChromiumDomCounterBinding({
        database,
        webIdlDatabaseDigest: zeroDigest,
        typescriptLibraryDigest: oneDigest,
        generatorRevision: "chromium-dom-counter-v1",
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
      }),
    /NTS-WEBIDL-108/u,
  );
});

test("compiled DOM counter plans through both ScriptC backends", async () => {
  const webIdlRoot = resolve(chromiumPackageRoot, "chromium/webidl");
  const manifest = JSON.parse(
    readFileSync(resolve(webIdlRoot, "package.scabi.json"), "utf8"),
  );
  const native = translateScabiNativeProgram(manifest, {
    imports: [
      "web_current_document",
      "web_document_body",
      "web_document_create_element",
      "web_document_create_text_node",
      "web_node_append_child",
      "web_node_remove_child",
      "web_element_set_attribute",
      "web_element_query_selector",
      "web_html_element_click",
      "web_character_data_set_data",
      "web_event_target_listen",
      "web_subscription_release",
    ],
    exports: [],
  });
  assert.equal(
    native.ok,
    true,
    native.ok ? undefined : JSON.stringify(native.diagnostics),
  );
  if (!native.ok) return;

  const { planLibraryCompilation } = await loadScriptCLibraryPlanners();
  const compiler = await import(
    pathToFileURL(resolve(scriptCCompilerDistribution(), "index.js")).href
  ) as Partial<ScriptCLibraryEmitter>;
  assert.equal(typeof compiler.emitLibraryCompilationPlan, "function");
  for (const backend of ["c", "llvm"] as const) {
    const planned = await planLibraryCompilation({
      profilePath: resolve(
        chromiumPackageRoot,
        `counter/scriptc/profile-${backend}.json`,
      ),
      externalTypes: {
        "@native-typescript/web-chromium": resolve(webIdlRoot, "reached.d.ts"),
      },
      native: native.input,
    });
    assert.equal(
      planned.ok,
      true,
      planned.ok ? undefined : JSON.stringify(planned.diagnostics),
    );
    if (planned.ok) {
      const plannedIr = JSON.parse(planned.plan.ir) as unknown;
      const listenerCalls = collectRecords(
        plannedIr,
        (record) =>
          record.kind === "nativeCall" &&
          typeof record.binding === "string" &&
          record.binding.endsWith("#web_event_target_listen"),
      );
      assert.equal(listenerCalls.length, 1);
      assert.equal(
        listenerCalls[0]?.resultMode,
        undefined,
        "a listener stored across exported start/stop calls must retain stable ScriptC and Oilpan ownership",
      );
      const frameListenerResources = collectRecords(
        plannedIr,
        (record) =>
          typeof record.nativeFrame === "object" &&
          record.nativeFrame !== null &&
          (record.nativeFrame as Record<string, unknown>).release ===
            "nts_web_subscription_release_frame",
      );
      assert.equal(frameListenerResources.length, 0);

      const generated = compiler.emitLibraryCompilationPlan!(planned.plan);
      assert.match(
        generated,
        /scr_native_handle_prepare_direct_callback_fused/u,
      );
      if (backend === "c") {
        assert.match(generated, /=\s*nts_web_event_target_listen\(/u);
        assert.doesNotMatch(
          generated,
          /=\s*nts_web_event_target_listen_frame\(/u,
        );
      } else {
        assert.match(generated, /call ptr @nts_web_event_target_listen\(/u);
        assert.doesNotMatch(
          generated,
          /call ptr @nts_web_event_target_listen_frame\(/u,
        );
      }
      assert.deepEqual(planned.plan.nativeBuild.localizeSymbols, [
        `nts_chromium_counter_scriptc_${backend}_init`,
        `nts_chromium_counter_scriptc_${backend}_set_panic_sink`,
        `nts_chromium_counter_scriptc_${backend}_collect`,
        `nts_chromium_counter_scriptc_${backend}_hosted_scheduler_configure`,
        `nts_chromium_counter_scriptc_${backend}_hosted_scheduler_stop`,
        `nts_chromium_counter_scriptc_${backend}_start`,
        `nts_chromium_counter_scriptc_${backend}_stop`,
      ]);
    }
  }
});
