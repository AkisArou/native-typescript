import { createHash } from "node:crypto";
import {
  SCABI_SCHEMA_VERSION,
  assertScabiManifest,
} from "@native-typescript/scabi";
import type {
  ScabiManifest,
  Sha256Digest,
  TargetIdentity,
} from "@native-typescript/scabi";
import { defineChromiumWebIdlSlice } from "./chromium-webidl.ts";
import type {
  ChromiumWebIdlAttribute,
  ChromiumWebIdlInterface,
  ChromiumWebIdlOperation,
  ChromiumWebIdlSlice,
} from "./chromium-webidl.ts";

export interface ChromiumDomCounterGenerationOptions {
  readonly database: ChromiumWebIdlSlice;
  readonly webIdlDatabaseDigest: Sha256Digest;
  readonly typescriptLibraryDigest: Sha256Digest;
  readonly target: TargetIdentity;
  readonly clangVersion: string;
  readonly generatorRevision: string;
}

export interface ChromiumDomCounterBinding {
  readonly declarations: string;
  readonly capsuleHeader: string;
  readonly capsuleSource: string;
  readonly manifest: ScabiManifest;
}

interface CounterSelection {
  readonly characterDataData: ChromiumWebIdlAttribute;
  readonly documentBody: ChromiumWebIdlAttribute;
  readonly documentCreateElement: ChromiumWebIdlOperation;
  readonly documentCreateTextNode: ChromiumWebIdlOperation;
  readonly elementQuerySelector: ChromiumWebIdlOperation;
  readonly elementSetAttribute: ChromiumWebIdlOperation;
  readonly eventTargetAddEventListener: ChromiumWebIdlOperation;
  readonly htmlElementClick: ChromiumWebIdlOperation;
  readonly nodeAppendChild: ChromiumWebIdlOperation;
  readonly nodeRemoveChild: ChromiumWebIdlOperation;
  readonly interfaces: Readonly<Record<string, ChromiumWebIdlInterface>>;
}

const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireDigest(value: string, path: string): asserts value is Sha256Digest {
  if (!digestPattern.test(value)) throw new TypeError(`${path} must be a sha256 digest`);
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function requireInterface(
  database: ChromiumWebIdlSlice,
  name: string,
  inherited: string | null,
  code: string,
): ChromiumWebIdlInterface {
  const interface_ = database.interfaces.find((candidate) => candidate.name === name);
  if (interface_ === undefined) {
    throw new Error(`${code}: ${name} is absent from the normalized database`);
  }
  if (interface_.inherited !== inherited) {
    throw new Error(`${code}: ${name} has an unsupported inheritance edge`);
  }
  return interface_;
}

function requireHeader(interface_: ChromiumWebIdlInterface, suffix: string): string {
  const header = interface_.blinkHeaders.find((candidate) => candidate.endsWith(suffix));
  if (header === undefined) {
    throw new Error(
      `NTS-WEBIDL-119: ${interface_.name}'s Blink implementation header is absent`,
    );
  }
  return header;
}

function selectCounterSurface(database: ChromiumWebIdlSlice): CounterSelection {
  const eventTarget = requireInterface(database, "EventTarget", null, "NTS-WEBIDL-101");
  const node = requireInterface(database, "Node", "EventTarget", "NTS-WEBIDL-102");
  const element = requireInterface(database, "Element", "Node", "NTS-WEBIDL-103");
  const htmlElement = requireInterface(database, "HTMLElement", "Element", "NTS-WEBIDL-104");
  const characterData = requireInterface(database, "CharacterData", "Node", "NTS-WEBIDL-105");
  const text = requireInterface(database, "Text", "CharacterData", "NTS-WEBIDL-106");
  const document = requireInterface(database, "Document", "Node", "NTS-WEBIDL-107");

  const data = characterData.attributes.find((candidate) => candidate.name === "data");
  if (
    data === undefined || data.kind !== "attribute" || data.static || data.readonly ||
    data.type !== "[LegacyNullToEmptyString] DOMString" ||
    data.implementedAs !== "data" || !sameStrings(data.extendedAttributes, [])
  ) {
    throw new Error("NTS-WEBIDL-108: CharacterData.data has an unsupported Blink call shape");
  }

  const body = document.attributes.find((candidate) => candidate.name === "body");
  if (
    body === undefined || body.kind !== "attribute" || body.static || body.readonly ||
    body.type !== "HTMLElement?" || body.implementedAs !== "body" ||
    !sameStrings(body.extendedAttributes, [
      "CEReactions",
      "PerWorldBindings",
      "RaisesException",
    ])
  ) {
    throw new Error("NTS-WEBIDL-109: Document.body has an unsupported Blink call shape");
  }

  const createElement = document.operations.find((candidate) =>
    candidate.name === "createElement" && candidate.arguments.length === 1
  );
  if (
    createElement === undefined || createElement.static ||
    createElement.returnType !== "Element" ||
    createElement.arguments[0]?.name !== "localName" ||
    createElement.arguments[0]?.type !== "DOMString" ||
    createElement.arguments[0]?.optionality !== "required" ||
    createElement.implementedAs !== "CreateElementForBinding" ||
    !sameStrings(createElement.extendedAttributes, [
      "ImplementedAs",
      "NewObject",
      "PerWorldBindings",
      "RaisesException",
    ])
  ) {
    throw new Error("NTS-WEBIDL-110: Document.createElement has an unsupported Blink call shape");
  }

  const createTextNode = document.operations.find((candidate) =>
    candidate.name === "createTextNode" && candidate.arguments.length === 1
  );
  if (
    createTextNode === undefined || createTextNode.static ||
    createTextNode.returnType !== "Text" ||
    createTextNode.arguments[0]?.name !== "data" ||
    createTextNode.arguments[0]?.type !== "DOMString" ||
    createTextNode.arguments[0]?.optionality !== "required" ||
    createTextNode.implementedAs !== "createTextNode" ||
    !sameStrings(createTextNode.extendedAttributes, ["NewObject"])
  ) {
    throw new Error("NTS-WEBIDL-111: Document.createTextNode has an unsupported Blink call shape");
  }

  const appendChild = node.operations.find((candidate) =>
    candidate.name === "appendChild" && candidate.arguments.length === 1
  );
  if (
    appendChild === undefined || appendChild.static || appendChild.returnType !== "Node" ||
    appendChild.arguments[0]?.name !== "node" ||
    appendChild.arguments[0]?.type !== "Node" ||
    appendChild.arguments[0]?.optionality !== "required" ||
    appendChild.implementedAs !== "appendChild" ||
    !sameStrings(appendChild.extendedAttributes, [
      "CEReactions",
      "PerWorldBindings",
      "RaisesException",
      "RuntimeCallStatsCounter",
    ])
  ) {
    throw new Error("NTS-WEBIDL-112: Node.appendChild has an unsupported Blink call shape");
  }

  const removeChild = node.operations.find((candidate) =>
    candidate.name === "removeChild" && candidate.arguments.length === 1
  );
  if (
    removeChild === undefined || removeChild.static || removeChild.returnType !== "Node" ||
    removeChild.arguments[0]?.name !== "child" ||
    removeChild.arguments[0]?.type !== "Node" ||
    removeChild.arguments[0]?.optionality !== "required" ||
    removeChild.implementedAs !== "removeChild" ||
    !sameStrings(removeChild.extendedAttributes, [
      "CEReactions",
      "RaisesException",
      "RuntimeCallStatsCounter",
    ])
  ) {
    throw new Error("NTS-WEBIDL-120: Node.removeChild has an unsupported Blink call shape");
  }

  const setAttribute = element.operations.find((candidate) =>
    candidate.name === "setAttribute" &&
    candidate.arguments.length === 2 &&
    candidate.arguments[1]?.type === "DOMString"
  );
  if (
    setAttribute === undefined || setAttribute.static ||
    setAttribute.returnType !== "undefined" ||
    setAttribute.arguments[0]?.name !== "name" ||
    setAttribute.arguments[0]?.type !== "DOMString" ||
    setAttribute.arguments[0]?.optionality !== "required" ||
    setAttribute.arguments[1]?.name !== "value" ||
    setAttribute.arguments[1]?.optionality !== "required" ||
    setAttribute.implementedAs !== "setAttribute" ||
    !sameStrings(setAttribute.extendedAttributes, ["CEReactions", "RaisesException"])
  ) {
    throw new Error("NTS-WEBIDL-121: Element.setAttribute has an unsupported Blink call shape");
  }

  const querySelector = element.operations.find((candidate) =>
    candidate.name === "querySelector" && candidate.arguments.length === 1
  );
  if (
    querySelector === undefined || querySelector.static ||
    querySelector.returnType !== "Element?" ||
    querySelector.arguments[0]?.name !== "selectors" ||
    querySelector.arguments[0]?.type !== "DOMString" ||
    querySelector.arguments[0]?.optionality !== "required" ||
    querySelector.implementedAs !== "querySelector" ||
    !sameStrings(querySelector.extendedAttributes, ["Affects", "RaisesException"])
  ) {
    throw new Error("NTS-WEBIDL-122: Element.querySelector has an unsupported Blink call shape");
  }

  const click = htmlElement.operations.find((candidate) =>
    candidate.name === "click" && candidate.arguments.length === 0
  );
  if (
    click === undefined || click.static || click.returnType !== "void" ||
    click.implementedAs !== "click" ||
    !sameStrings(click.extendedAttributes, ["RuntimeCallStatsCounter"])
  ) {
    throw new Error("NTS-WEBIDL-123: HTMLElement.click has an unsupported Blink call shape");
  }

  const addEventListener = eventTarget.operations.find((candidate) =>
    candidate.name === "addEventListener"
  );
  if (
    addEventListener === undefined || addEventListener.static ||
    addEventListener.returnType !== "undefined" ||
    addEventListener.implementedAs !== "addEventListener" ||
    !sameStrings(addEventListener.extendedAttributes, []) ||
    addEventListener.arguments.length !== 3 ||
    addEventListener.arguments[0]?.name !== "type" ||
    addEventListener.arguments[0]?.type !== "DOMString" ||
    addEventListener.arguments[0]?.optionality !== "required" ||
    addEventListener.arguments[1]?.name !== "listener" ||
    addEventListener.arguments[1]?.type !== "EventListener?" ||
    addEventListener.arguments[1]?.optionality !== "required" ||
    addEventListener.arguments[2]?.name !== "options" ||
    addEventListener.arguments[2]?.type !== "optional (AddEventListenerOptions or boolean)" ||
    addEventListener.arguments[2]?.optionality !== "optional"
  ) {
    throw new Error("NTS-WEBIDL-113: EventTarget.addEventListener has an unsupported Blink call shape");
  }

  return deepFreeze({
    characterDataData: data,
    documentBody: body,
    documentCreateElement: createElement,
    documentCreateTextNode: createTextNode,
    elementQuerySelector: querySelector,
    elementSetAttribute: setAttribute,
    eventTargetAddEventListener: addEventListener,
    htmlElementClick: click,
    nodeAppendChild: appendChild,
    nodeRemoveChild: removeChild,
    interfaces: {
      CharacterData: characterData,
      Document: document,
      Element: element,
      EventTarget: eventTarget,
      HTMLElement: htmlElement,
      Node: node,
      Text: text,
    },
  });
}

function declarations(): string {
  return [
    "// Generated from lib.dom.d.ts and Chromium normalized WebIDL; do not edit.",
    "declare const nativeResource: unique symbol;",
    "export declare abstract class EventTarget {",
    "  readonly [nativeResource]: true;",
    "  listen(type: string, callback: () => void): EventSubscription;",
    "}",
    "export declare abstract class Node extends EventTarget {",
    "  appendChild(node: Node): Node;",
    "  removeChild(child: Node): Node;",
    "}",
    "export declare abstract class Element extends Node {",
    "  querySelector(selectors: string): Element | null;",
    "  setAttribute(name: string, value: string): void;",
    "}",
    "export declare abstract class HTMLElement extends Element {",
    "  click(): void;",
    "}",
    "export declare abstract class CharacterData extends Node {",
    "  set data(value: string);",
    "}",
    "export declare abstract class Text extends CharacterData {}",
    "export declare abstract class Document extends Node {",
    "  get body(): HTMLElement | null;",
    "  createElement(localName: string): Element;",
    "  createTextNode(data: string): Text;",
    "}",
    "export interface EventSubscription {",
    "  readonly [nativeResource]: true;",
    "  dispose(): void;",
    "}",
    "export declare function currentDocument(): Document | null;",
    "",
  ].join("\n");
}

function generateManifest(
  options: ChromiumDomCounterGenerationOptions,
  declarationSource: string,
): ScabiManifest {
  if (
    options.target.pointerWidth !== 64 || options.target.endianness !== "little" ||
    options.target.objectFormat !== "elf"
  ) {
    throw new Error(
      "NTS-WEBIDL-114: the Chromium DOM counter capsule has ABI evidence only for 64-bit little-endian ELF",
    );
  }
  requireDigest(options.webIdlDatabaseDigest, "webIdlDatabaseDigest");
  requireDigest(options.typescriptLibraryDigest, "typescriptLibraryDigest");
  const declarationsDigest =
    `sha256:${createHash("sha256").update(declarationSource).digest("hex")}` as Sha256Digest;

  const value = (type: string, nullable = false) => ({
    type,
    passMode: "value" as const,
    nullable,
    ownership: { kind: "value" as const },
  });
  const borrowedHandle = (name: string, type: string) => ({
    name,
    type,
    passMode: "pointer" as const,
    nullable: false,
    ownership: { kind: "borrowed" as const, scope: "call" as const },
  });
  const ownedHandle = (
    type: string,
    nullable = false,
    frameEntry?: string,
    frameRelease = "nts_web_node_release_frame",
  ) => ({
    type,
    passMode: "pointer" as const,
    nullable,
    ownership: { kind: "owned" as const, transfer: "to-runtime" as const },
    ...(frameEntry === undefined
      ? {}
      : {
          frameBounded: {
            entry: frameEntry,
            release: frameRelease,
          },
        }),
  });
  const utf8Parameters = (stem: string) => [
    {
      name: `${stem}_data`,
      type: "const_u8_ptr",
      passMode: "pointer" as const,
      nullable: false,
      ownership: { kind: "borrowed" as const, scope: "call" as const },
      marshal: {
        kind: "string" as const,
        encoding: "utf-8" as const,
        length: { kind: "parameter" as const, parameter: `${stem}_length` },
        staticIdentity: {
          kind: "parameter" as const,
          parameter: `${stem}_static_identity`,
        },
        termination: "none" as const,
        embeddedNul: "allow" as const,
      },
    },
    {
      name: `${stem}_length`,
      type: "usize",
      passMode: "value" as const,
      nullable: false,
      ownership: { kind: "value" as const },
    },
    {
      name: `${stem}_static_identity`,
      type: "usize",
      passMode: "value" as const,
      nullable: false,
      ownership: { kind: "value" as const },
    },
  ];
  const dependencies = (bindings: readonly string[] = []) => ({
    bindings,
    linkInputs: ["chromium_blink"],
    adapterInputs: ["blink_dom_counter_capsules"],
    permissions: [],
  });
  const callable = (input: {
    readonly kind: "function" | "method" | "getter" | "setter";
    readonly declaration: string;
    readonly symbol: string;
    readonly parameters: readonly unknown[];
    readonly result: unknown;
    readonly error?: unknown;
    readonly bindingDependencies?: readonly string[];
  }) => ({
    kind: input.kind,
    declaration: { module: ".", name: input.declaration },
    entry: { symbol: input.symbol },
    signature: {
      callingConvention: "c" as const,
      variadic: false as const,
      parameters: input.parameters,
      result: input.result,
    },
    thread: {
      executor: { kind: "runtime-owner" as const },
      behavior: "require" as const,
      blocking: false,
    },
    error: input.error ?? { kind: "no-fail" as const },
    dependencies: dependencies(input.bindingDependencies),
  });
  const handleType = (nativeName: string, parent: string | null, destructor: string) => ({
    kind: "handle" as const,
    nativeName,
    threadSafety: "confined" as const,
    identity: "pointer" as const,
    upcasts: parent === null ? [] : [{ kind: "identity" as const, target: parent }],
    destructor,
  });
  const errorContract = {
    kind: "error-out" as const,
    message: "web_error_message",
    release: "web_error_release",
  };
  const errorDependencies = ["web_error_message", "web_error_release"];
  const releaseBinding = (type: string, declaration: string) => callable({
    kind: "method",
    declaration,
    symbol: "nts_web_node_release",
    parameters: [{
      name: "node",
      type,
      passMode: "pointer" as const,
      nullable: false,
      ownership: { kind: "owned" as const, transfer: "to-native" as const },
    }],
    result: value("void"),
  });

  const bindings = {
    web_error_message: callable({
      kind: "getter",
      declaration: "NativeError.message",
      symbol: "nts_web_error_message",
      parameters: [{
        name: "error",
        type: "void_ptr",
        passMode: "pointer",
        nullable: false,
        ownership: { kind: "borrowed", scope: "call" },
      }],
      result: {
        type: "const_u8_ptr",
        passMode: "pointer",
        nullable: false,
        ownership: { kind: "borrowed", scope: "call" },
        marshal: {
          kind: "string",
          encoding: "utf-8",
          length: { kind: "nul" },
          termination: "nul",
          embeddedNul: "reject",
        },
      },
    }),
    web_error_release: callable({
      kind: "method",
      declaration: "NativeError.__release",
      symbol: "nts_web_error_release",
      parameters: [{
        name: "error",
        type: "void_ptr",
        passMode: "pointer",
        nullable: false,
        ownership: { kind: "borrowed", scope: "call" },
      }],
      result: value("void"),
    }),
    web_node_release: releaseBinding("event_target", "EventTarget.__release"),
    web_subscription_release: callable({
      kind: "method",
      declaration: "EventSubscription.dispose",
      symbol: "nts_web_subscription_release",
      parameters: [{
        name: "subscription",
        type: "event_subscription",
        passMode: "pointer",
        nullable: false,
        ownership: { kind: "owned", transfer: "to-native" },
      }],
      result: value("void"),
    }),
    web_current_document: callable({
      kind: "function",
      declaration: "currentDocument",
      symbol: "nts_web_current_document",
      parameters: [],
      result: ownedHandle("document", true, "nts_web_current_document_frame"),
      bindingDependencies: ["web_node_release"],
    }),
    web_document_body: callable({
      kind: "getter",
      declaration: "Document.body",
      symbol: "nts_web_document_body_managed",
      parameters: [borrowedHandle("document", "document")],
      result: ownedHandle(
        "html_element",
        true,
        "nts_web_document_body_frame",
      ),
      bindingDependencies: ["web_node_release"],
    }),
    web_document_create_element: callable({
      kind: "method",
      declaration: "Document.createElement",
      symbol: "nts_web_document_create_element_managed",
      parameters: [
        borrowedHandle("document", "document"),
        ...utf8Parameters("local_name"),
      ],
      result: ownedHandle(
        "element",
        false,
        "nts_web_document_create_element_frame",
      ),
      error: errorContract,
      bindingDependencies: ["web_node_release", ...errorDependencies],
    }),
    web_document_create_text_node: callable({
      kind: "method",
      declaration: "Document.createTextNode",
      symbol: "nts_web_document_create_text_node_managed",
      parameters: [
        borrowedHandle("document", "document"),
        ...utf8Parameters("data"),
      ],
      result: ownedHandle(
        "text",
        false,
        "nts_web_document_create_text_node_frame",
      ),
      bindingDependencies: ["web_node_release"],
    }),
    web_node_append_child: callable({
      kind: "method",
      declaration: "Node.appendChild",
      symbol: "nts_web_node_append_child_managed",
      parameters: [
        borrowedHandle("parent", "node"),
        borrowedHandle("node", "node"),
      ],
      result: ownedHandle("node", false, "nts_web_node_append_child_frame"),
      error: errorContract,
      bindingDependencies: ["web_node_release", ...errorDependencies],
    }),
    web_node_remove_child: callable({
      kind: "method",
      declaration: "Node.removeChild",
      symbol: "nts_web_node_remove_child_managed",
      parameters: [
        borrowedHandle("parent", "node"),
        borrowedHandle("child", "node"),
      ],
      result: ownedHandle("node", false, "nts_web_node_remove_child_frame"),
      error: errorContract,
      bindingDependencies: ["web_node_release", ...errorDependencies],
    }),
    web_element_set_attribute: callable({
      kind: "method",
      declaration: "Element.setAttribute",
      symbol: "nts_web_element_set_attribute",
      parameters: [
        borrowedHandle("element", "element"),
        ...utf8Parameters("name"),
        ...utf8Parameters("value"),
      ],
      result: value("void"),
      error: errorContract,
      bindingDependencies: errorDependencies,
    }),
    web_element_query_selector: callable({
      kind: "method",
      declaration: "Element.querySelector",
      symbol: "nts_web_element_query_selector_managed",
      parameters: [
        borrowedHandle("element", "element"),
        ...utf8Parameters("selectors"),
      ],
      result: ownedHandle(
        "element",
        true,
        "nts_web_element_query_selector_frame",
      ),
      error: errorContract,
      bindingDependencies: ["web_node_release", ...errorDependencies],
    }),
    web_html_element_click: callable({
      kind: "method",
      declaration: "HTMLElement.click",
      symbol: "nts_web_html_element_click",
      parameters: [borrowedHandle("element", "html_element")],
      result: value("void"),
    }),
    web_character_data_set_data: callable({
      kind: "setter",
      declaration: "CharacterData.data",
      symbol: "nts_web_character_data_set_data_managed",
      parameters: [
        borrowedHandle("character_data", "character_data"),
        ...utf8Parameters("data"),
      ],
      result: value("void"),
    }),
    web_event_target_listen: callable({
      kind: "method",
      declaration: "EventTarget.listen",
      symbol: "nts_web_event_target_listen",
      parameters: [
        borrowedHandle("target", "event_target"),
        ...utf8Parameters("type"),
        {
          name: "callback",
          type: "event_callback",
          passMode: "pointer",
          nullable: false,
          ownership: { kind: "borrowed", scope: "registration", anchor: "result" },
          callback: {
            registrationOwner: "result",
            cancellationBinding: "web_subscription_release",
            contextParameter: "context",
            frameBoundedContext: { releaseParameter: "context_release" },
            allowedInvocationExecutors: [{ kind: "same-as-caller" }],
            // DOM dispatch invokes listeners before click()/dispatchEvent()
            // returns. The callback's own return is void, but delivery is
            // still synchronous and must permit same-frame re-entry.
            synchronousReturn: true,
            arguments: [],
            sourceArguments: [],
          },
        },
        {
          name: "context",
          type: "void_ptr",
          passMode: "pointer",
          nullable: false,
          ownership: { kind: "borrowed", scope: "registration", anchor: "callback" },
        },
        {
          name: "context_release",
          type: "context_release_callback",
          passMode: "pointer",
          nullable: true,
          ownership: { kind: "borrowed", scope: "registration", anchor: "callback" },
        },
      ],
      result: ownedHandle(
        "event_subscription",
        true,
        "nts_web_event_target_listen_frame",
        "nts_web_subscription_release_frame",
      ),
      error: { kind: "nullable" },
      bindingDependencies: ["web_subscription_release"],
    }),
  };

  const generatedBindingIds = Object.keys(bindings);
  const manifest = {
    schema: "native-typescript.scabi",
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
      arguments: [
        "CharacterData.data(set)",
        "Document.body(get)",
        "Document.createElement(DOMString)",
        "Document.createTextNode(DOMString)",
        "Element.querySelector(DOMString)",
        "Element.setAttribute(DOMString,DOMString)",
        "EventTarget.addEventListener(payload-free-owned-projection)",
        "HTMLElement.click()",
        "Node.appendChild(Node)",
        "Node.removeChild(Node)",
      ],
      inputDigests: [options.webIdlDatabaseDigest, options.typescriptLibraryDigest],
    },
    declarations: {
      digest: declarationsDigest,
      types: {
        event_target: { module: ".", name: "EventTarget" },
        node: { module: ".", name: "Node" },
        element: { module: ".", name: "Element" },
        html_element: { module: ".", name: "HTMLElement" },
        character_data: { module: ".", name: "CharacterData" },
        text: { module: ".", name: "Text" },
        document: { module: ".", name: "Document" },
        event_subscription: { module: ".", name: "EventSubscription" },
      },
    },
    types: {
      void: { kind: "void" },
      u8: { kind: "integer", signed: false, bits: 8 },
      usize: { kind: "integer", signed: false, bits: "pointer" },
      const_u8_ptr: {
        kind: "pointer",
        pointee: "u8",
        mutability: "const",
        nullable: false,
        addressSpace: 0,
      },
      void_ptr: {
        kind: "pointer",
        pointee: "void",
        mutability: "mutable",
        nullable: true,
        addressSpace: 0,
      },
      event_callback: {
        kind: "callback",
        signature: {
          callingConvention: "c",
          variadic: false,
          parameters: [],
          result: value("void"),
        },
        context: { placement: "last", type: "void_ptr" },
      },
      context_release_callback: {
        kind: "callback",
        signature: {
          callingConvention: "c",
          variadic: false,
          parameters: [{
            name: "context",
            type: "void_ptr",
            passMode: "pointer",
            nullable: false,
            ownership: { kind: "borrowed", scope: "call" },
          }],
          result: value("void"),
        },
        context: { placement: "none" },
      },
      event_target: handleType("NtsWebNode*", null, "web_node_release"),
      node: handleType("NtsWebNode*", "event_target", "web_node_release"),
      element: handleType("NtsWebNode*", "node", "web_node_release"),
      html_element: handleType("NtsWebNode*", "element", "web_node_release"),
      character_data: handleType("NtsWebNode*", "node", "web_node_release"),
      text: handleType("NtsWebNode*", "character_data", "web_node_release"),
      document: handleType("NtsWebNode*", "node", "web_node_release"),
      event_subscription: {
        kind: "handle",
        nativeName: "NtsWebManagedSubscription*",
        threadSafety: "confined",
        identity: "none",
        upcasts: [],
        destructor: "web_subscription_release",
      },
    },
    bindings,
    linkInputs: [{
      id: "chromium_blink",
      kind: "runtime-component",
      name: "Blink renderer core",
      order: 0,
    }],
    adapterInputs: [{
      id: "blink_dom_counter_capsules",
      family: "chromium-webidl",
      language: "c++",
      bindings: generatedBindingIds,
      outputs: [
        "nts_webidl_capsules.h",
        "nts_webidl_capsules.cc",
        "nts_blink_scabi.cc",
      ],
      options: {
        chromiumRevision: options.database.chromiumRevision,
        v8Values: false,
        genericDispatch: false,
        eventProjection: "owned-subscription",
      },
    }],
    permissions: [],
    platform: {
      chromium: {
        revision: options.database.chromiumRevision,
        databaseDigest: options.webIdlDatabaseDigest,
        operations: [
          "CharacterData.data(set)",
          "Document.body(get)",
          "Document.createElement(DOMString)",
          "Document.createTextNode(DOMString)",
          "Element.querySelector(DOMString)",
          "Element.setAttribute(DOMString,DOMString)",
          "EventTarget.addEventListener(payload-free-owned-projection)",
          "HTMLElement.click()",
          "Node.appendChild(Node)",
          "Node.removeChild(Node)",
        ],
      },
    },
  };
  return assertScabiManifest(manifest);
}

function capsuleHeader(): string {
  return [
    "// Generated typed Blink capsules; do not edit.",
    "#ifndef NTS_WEBIDL_CAPSULES_H",
    "#define NTS_WEBIDL_CAPSULES_H",
    "",
    "#include <stddef.h>",
    "#include <stdint.h>",
    "",
    "namespace blink {",
    "class AtomicString;",
    "class CharacterData;",
    "class Document;",
    "class Element;",
    "class ExceptionState;",
    "class HTMLElement;",
    "class Node;",
    "class String;",
    "class Text;",
    "}  // namespace blink",
    "",
    "namespace nts::blink_bridge::generated {",
    "blink::HTMLElement* DocumentBody(blink::Document& receiver);",
    "blink::Element* DocumentCreateElement(blink::Document& receiver,",
    "                                      const blink::AtomicString& local_name,",
    "                                      blink::ExceptionState& exception_state);",
    "blink::Text* DocumentCreateTextNode(blink::Document& receiver,",
    "                                    const blink::String& data);",
    "blink::Node* NodeAppendChild(blink::Node& receiver,",
    "                             blink::Node& node,",
    "                             blink::ExceptionState& exception_state);",
    "blink::Node* NodeRemoveChild(blink::Node& receiver,",
    "                             blink::Node& child,",
    "                             blink::ExceptionState& exception_state);",
    "void ElementSetAttribute(blink::Element& receiver,",
    "                         const blink::AtomicString& name,",
    "                         const blink::AtomicString& value,",
    "                         blink::ExceptionState& exception_state);",
    "blink::Element* ElementQuerySelector(",
    "    blink::Element& receiver,",
    "    const blink::AtomicString& selectors,",
    "    blink::ExceptionState& exception_state);",
    "void HTMLElementClick(blink::HTMLElement& receiver);",
    "void CharacterDataSetData(blink::CharacterData& receiver,",
    "                          const blink::String& data);",
    "}  // namespace nts::blink_bridge::generated",
    "",
    "struct NtsWebNode;",
    "struct NtsWebManagedSubscription;",
    "struct NtsWebError;",
    "using NtsWebEventCallback = void (*)(void* context);",
    "using NtsWebContextRelease = void (*)(void* context);",
    "",
    "extern \"C\" NtsWebNode* nts_web_current_document();",
    "extern \"C\" NtsWebNode* nts_web_current_document_frame();",
    "extern \"C\" NtsWebNode* nts_web_document_body_managed(NtsWebNode* document);",
    "extern \"C\" NtsWebNode* nts_web_document_body_frame(NtsWebNode* document);",
    "extern \"C\" NtsWebNode* nts_web_document_create_element_managed(",
    "    NtsWebNode* document,",
    "    const uint8_t* local_name_data,",
    "    size_t local_name_length,",
    "    size_t local_name_static_identity,",
    "    NtsWebError** error);",
    "extern \"C\" NtsWebNode* nts_web_document_create_element_frame(",
    "    NtsWebNode* document,",
    "    const uint8_t* local_name_data,",
    "    size_t local_name_length,",
    "    size_t local_name_static_identity,",
    "    NtsWebError** error);",
    "extern \"C\" NtsWebNode* nts_web_document_create_text_node_managed(",
    "    NtsWebNode* document, const uint8_t* data, size_t data_length,",
    "    size_t data_static_identity);",
    "extern \"C\" NtsWebNode* nts_web_document_create_text_node_frame(",
    "    NtsWebNode* document, const uint8_t* data, size_t data_length,",
    "    size_t data_static_identity);",
    "extern \"C\" NtsWebNode* nts_web_node_append_child_managed(",
    "    NtsWebNode* parent, NtsWebNode* node, NtsWebError** error);",
    "extern \"C\" NtsWebNode* nts_web_node_append_child_frame(",
    "    NtsWebNode* parent, NtsWebNode* node, NtsWebError** error);",
    "extern \"C\" NtsWebNode* nts_web_node_remove_child_managed(",
    "    NtsWebNode* parent, NtsWebNode* child, NtsWebError** error);",
    "extern \"C\" NtsWebNode* nts_web_node_remove_child_frame(",
    "    NtsWebNode* parent, NtsWebNode* child, NtsWebError** error);",
    "extern \"C\" void nts_web_element_set_attribute(",
    "    NtsWebNode* element,",
    "    const uint8_t* name_data,",
    "    size_t name_length,",
    "    size_t name_static_identity,",
    "    const uint8_t* value_data,",
    "    size_t value_length,",
    "    size_t value_static_identity,",
    "    NtsWebError** error);",
    "extern \"C\" NtsWebNode* nts_web_element_query_selector_managed(",
    "    NtsWebNode* element,",
    "    const uint8_t* selectors_data,",
    "    size_t selectors_length,",
    "    size_t selectors_static_identity,",
    "    NtsWebError** error);",
    "extern \"C\" NtsWebNode* nts_web_element_query_selector_frame(",
    "    NtsWebNode* element,",
    "    const uint8_t* selectors_data,",
    "    size_t selectors_length,",
    "    size_t selectors_static_identity,",
    "    NtsWebError** error);",
    "extern \"C\" void nts_web_html_element_click(NtsWebNode* element);",
    "extern \"C\" void nts_web_character_data_set_data_managed(",
    "    NtsWebNode* character_data, const uint8_t* data, size_t data_length,",
    "    size_t data_static_identity);",
    "extern \"C\" NtsWebManagedSubscription* nts_web_event_target_listen(",
    "    NtsWebNode* target,",
    "    const uint8_t* type_data,",
    "    size_t type_length,",
    "    size_t type_static_identity,",
    "    NtsWebEventCallback callback,",
    "    void* context,",
    "    NtsWebContextRelease context_release);",
    "extern \"C\" NtsWebManagedSubscription* nts_web_event_target_listen_frame(",
    "    NtsWebNode* target,",
    "    const uint8_t* type_data,",
    "    size_t type_length,",
    "    size_t type_static_identity,",
    "    NtsWebEventCallback callback,",
    "    void* context,",
    "    NtsWebContextRelease context_release);",
    "extern \"C\" void nts_web_node_release(NtsWebNode* node);",
    "extern \"C\" void nts_web_node_release_frame(NtsWebNode* node);",
    "extern \"C\" void nts_web_subscription_release(",
    "    NtsWebManagedSubscription* subscription);",
    "extern \"C\" void nts_web_subscription_release_frame(",
    "    NtsWebManagedSubscription* subscription);",
    "extern \"C\" const uint8_t* nts_web_error_message(NtsWebError* error);",
    "extern \"C\" void nts_web_error_release(NtsWebError* error);",
    "",
    "#endif",
    "",
  ].join("\n");
}

function capsuleSource(selection: CounterSelection): string {
  const characterDataHeader = requireHeader(
    selection.interfaces.CharacterData!,
    "/core/dom/character_data.h",
  );
  const documentHeader = requireHeader(
    selection.interfaces.Document!,
    "/core/dom/document.h",
  );
  const nodeHeader = requireHeader(selection.interfaces.Node!, "/core/dom/node.h");
  const textHeader = requireHeader(selection.interfaces.Text!, "/core/dom/text.h");
  return [
    "// Generated typed Blink capsules; do not edit.",
    "#include \"third_party/blink/renderer/native_typescript/generated/nts_webidl_capsules.h\"",
    "",
    `#include "${characterDataHeader}"`,
    `#include "${documentHeader}"`,
    `#include "${nodeHeader}"`,
    `#include "${textHeader}"`,
    "#include \"third_party/blink/renderer/core/dom/element.h\"",
    "#include \"third_party/blink/renderer/core/html/html_element.h\"",
    "#include \"third_party/blink/renderer/platform/bindings/exception_state.h\"",
    "#include \"third_party/blink/renderer/platform/wtf/text/atomic_string.h\"",
    "#include \"third_party/blink/renderer/platform/wtf/text/wtf_string.h\"",
    "",
    "namespace nts::blink_bridge::generated {",
    "blink::HTMLElement* DocumentBody(blink::Document& receiver) {",
    `  return receiver.${selection.documentBody.implementedAs}();`,
    "}",
    "",
    "blink::Element* DocumentCreateElement(blink::Document& receiver,",
    "                                      const blink::AtomicString& local_name,",
    "                                      blink::ExceptionState& exception_state) {",
    `  return receiver.${selection.documentCreateElement.implementedAs}(`,
    "      local_name, exception_state);",
    "}",
    "",
    "blink::Text* DocumentCreateTextNode(blink::Document& receiver,",
    "                                    const blink::String& data) {",
    `  return receiver.${selection.documentCreateTextNode.implementedAs}(data);`,
    "}",
    "",
    "blink::Node* NodeAppendChild(blink::Node& receiver,",
    "                             blink::Node& node,",
    "                             blink::ExceptionState& exception_state) {",
    `  return receiver.${selection.nodeAppendChild.implementedAs}(&node, exception_state);`,
    "}",
    "",
    "blink::Node* NodeRemoveChild(blink::Node& receiver,",
    "                             blink::Node& child,",
    "                             blink::ExceptionState& exception_state) {",
    `  return receiver.${selection.nodeRemoveChild.implementedAs}(&child, exception_state);`,
    "}",
    "",
    "void ElementSetAttribute(blink::Element& receiver,",
    "                         const blink::AtomicString& name,",
    "                         const blink::AtomicString& value,",
    "                         blink::ExceptionState& exception_state) {",
    `  receiver.${selection.elementSetAttribute.implementedAs}(`,
    "      name, value, exception_state);",
    "}",
    "",
    "blink::Element* ElementQuerySelector(",
    "    blink::Element& receiver,",
    "    const blink::AtomicString& selectors,",
    "    blink::ExceptionState& exception_state) {",
    `  return receiver.${selection.elementQuerySelector.implementedAs}(`,
    "      selectors, exception_state);",
    "}",
    "",
    "void HTMLElementClick(blink::HTMLElement& receiver) {",
    `  receiver.${selection.htmlElementClick.implementedAs}();`,
    "}",
    "",
    "void CharacterDataSetData(blink::CharacterData& receiver,",
    "                          const blink::String& data) {",
    `  receiver.set${selection.characterDataData.implementedAs[0]!.toUpperCase()}${selection.characterDataData.implementedAs.slice(1)}(data);`,
    "}",
    "}  // namespace nts::blink_bridge::generated",
    "",
  ].join("\n");
}

export function generateChromiumDomCounterBinding(
  options: ChromiumDomCounterGenerationOptions,
): ChromiumDomCounterBinding {
  const database = defineChromiumWebIdlSlice(options.database);
  const selection = selectCounterSurface(database);
  const declarationSource = declarations();
  return deepFreeze({
    declarations: declarationSource,
    capsuleHeader: capsuleHeader(),
    capsuleSource: capsuleSource(selection),
    manifest: generateManifest({ ...options, database }, declarationSource),
  });
}
