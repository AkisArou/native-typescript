import { createHash } from "node:crypto";
import {
  CBindgenError,
  renderCFunctionPointerType,
} from "@native-typescript/bindgen-c";
import type {
  CBindgenDiagnostic,
  ClangFunctionEvidenceSnapshot,
} from "@native-typescript/bindgen-c";
import {
  canonicalizeJson,
  digestScabiManifest,
  parseScabiManifest,
} from "@native-typescript/scabi";
import type {
  AbiParameter,
  AbiResult,
  BindingAvailability,
  CallableBinding,
  LinkInput,
  NativeBinding,
  NativeType,
  PackageIdentity,
  ScabiManifest,
  Sha256Digest,
  TargetIdentity,
} from "@native-typescript/scabi";
import { generateGirClangFunctionProbe } from "./gir-clang.ts";
import type {
  GirCallable,
  GirClass,
  GirParameter,
  GirSnapshot,
  GirTypeReference,
} from "./gir-model.ts";
import { generateGObjectAdapterSource } from "./gobject-adapter.ts";
import type { GObjectAdapterSource } from "./gobject-adapter.ts";

export interface GtkScabiGenerationOptions {
  readonly snapshot: GirSnapshot;
  readonly evidence: ClangFunctionEvidenceSnapshot;
  readonly gobjectAdapter: GObjectAdapterSource;
  readonly package: PackageIdentity;
  readonly target: TargetIdentity;
  readonly sdk: {
    readonly vendor: string;
    readonly name: string;
    readonly version: string;
    readonly deploymentTarget: string;
    readonly modules: readonly string[];
  };
  readonly linkInputs: readonly LinkInput[];
  readonly adapterInput: {
    readonly id: string;
    readonly output: string;
  };
}

export interface GtkScabiPackage {
  readonly schema: "native-typescript.gtk-scabi-package";
  readonly schemaVersion: 1;
  readonly declarations: string;
  readonly declarationsDigest: Sha256Digest;
  readonly manifest: ScabiManifest;
  readonly manifestSource: string;
  readonly manifestDigest: Sha256Digest;
}

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const sourceScalarTypes = Object.freeze([
  Object.freeze({ girName: "gdouble", cType: "double", abiType: "gdouble" }),
  Object.freeze({ girName: "gint", cType: "int", abiType: "gint" }),
]);

function sourceScalarType(
  type: GirTypeReference,
): (typeof sourceScalarTypes)[number] | undefined {
  return type.kind === "named"
    ? sourceScalarTypes.find(
        (scalar) => scalar.girName === type.name && scalar.cType === type.cType,
      )
    : undefined;
}

function sha256(value: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function diagnostic(path: string, message: string): CBindgenDiagnostic {
  return Object.freeze({ code: "NTS5001", severity: "error", path, message });
}

function upperCamel(value: string): string {
  return value
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

function lowerCamel(value: string): string {
  const upper = upperCamel(value);
  return `${upper[0]?.toLowerCase() ?? ""}${upper.slice(1)}`;
}

function handleTypeId(namespace: string, class_: GirClass): string {
  return `${namespace.toLowerCase()}_${class_.cSymbolPrefix}`;
}

function handleBrand(className: string): string {
  return `nativeResource${upperCamel(className)}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedText(values: readonly string[]): readonly string[] {
  return Object.freeze([...values].sort(compareText));
}

function constructorProjection(
  className: string,
  callableName: string,
): {
  readonly declaration: string;
  readonly kind: "constructor" | "factory";
  readonly member: string;
} {
  if (callableName === "new") {
    return Object.freeze({ declaration: className, kind: "constructor", member: "constructor" });
  }
  const member = lowerCamel(
    callableName.startsWith("new_") ? callableName.slice(4) : callableName,
  );
  return Object.freeze({
    declaration: `${className}.${member}`,
    kind: "factory",
    member,
  });
}

function availability(
  class_: GirClass,
  callable: GirCallable,
): BindingAvailability | undefined {
  const version = callable.version ?? class_.version;
  return version === null
    ? undefined
    : Object.freeze({
        minimumPlatformVersion: version,
        unavailableFeatures: Object.freeze([]),
      });
}

function dependencies(input: {
  readonly bindings?: readonly string[];
  readonly links: readonly string[];
  readonly adapter?: string;
}) {
  return Object.freeze({
    bindings: Object.freeze([...(input.bindings ?? [])]),
    linkInputs: Object.freeze([...input.links]),
    adapterInputs: Object.freeze(input.adapter === undefined ? [] : [input.adapter]),
    permissions: Object.freeze([]),
  });
}

function validateInputs(
  options: GtkScabiGenerationOptions,
  diagnostics: CBindgenDiagnostic[],
): void {
  const probe = generateGirClangFunctionProbe(options.snapshot);
  if (options.evidence.probeDigest !== probe.sourceDigest) {
    diagnostics.push(
      diagnostic(
        "evidence/probeDigest",
        "Clang evidence does not belong to the selected GIR function probe",
      ),
    );
  }
  if (options.evidence.clang.target !== options.target.triple) {
    diagnostics.push(
      diagnostic(
        "evidence/clang/target",
        "Clang evidence target does not match the SCABI target triple",
      ),
    );
  }
  const semanticValue = {
    schema: "native-typescript.clang-function-evidence",
    schemaVersion: 1,
    probeDigest: options.evidence.probeDigest,
    clang: {
      toolId: options.evidence.clang.toolId,
      version: options.evidence.clang.version,
      digest: options.evidence.clang.digest,
      target: options.evidence.clang.target,
    },
    functions: options.evidence.functions.map((function_) => ({
      id: function_.id,
      symbol: function_.symbol,
      expectedType: function_.expectedType,
      clangType: function_.clangType,
    })),
  };
  if (
    !digestPattern.test(options.evidence.semanticDigest) ||
    sha256(JSON.stringify(semanticValue)) !== options.evidence.semanticDigest
  ) {
    diagnostics.push(
      diagnostic("evidence/semanticDigest", "Clang semantic evidence digest is invalid"),
    );
  }
  if (options.evidence.functions.length !== probe.functions.length) {
    diagnostics.push(
      diagnostic("evidence/functions", "Clang evidence has the wrong selected function count"),
    );
  }
  for (const [index, function_] of probe.functions.entries()) {
    const evidence = options.evidence.functions[index];
    if (
      evidence?.id !== function_.id ||
      evidence.symbol !== function_.symbol ||
      evidence.expectedType !== renderCFunctionPointerType(function_, "")
    ) {
      diagnostics.push(
        diagnostic(
          `evidence/functions/${index}`,
          `Clang evidence does not match selected function '${function_.id}'`,
        ),
      );
    }
  }
  if (
    !digestPattern.test(options.gobjectAdapter.sourceDigest) ||
    sha256(options.gobjectAdapter.source) !== options.gobjectAdapter.sourceDigest
  ) {
    diagnostics.push(
      diagnostic("gobjectAdapter/sourceDigest", "GObject adapter source digest is invalid"),
    );
  }
  const expectedAdapter = generateGObjectAdapterSource(options.snapshot);
  if (
    options.gobjectAdapter.schema !== expectedAdapter.schema ||
    options.gobjectAdapter.schemaVersion !== expectedAdapter.schemaVersion ||
    options.gobjectAdapter.source !== expectedAdapter.source ||
    canonicalizeJson(options.gobjectAdapter.constructors) !==
      canonicalizeJson(expectedAdapter.constructors) ||
    canonicalizeJson(options.gobjectAdapter.signalConnection) !==
      canonicalizeJson(expectedAdapter.signalConnection) ||
    canonicalizeJson(options.gobjectAdapter.signals) !==
      canonicalizeJson(expectedAdapter.signals)
  ) {
    diagnostics.push(
      diagnostic(
        "gobjectAdapter",
        "GObject adapter does not belong to the selected GIR snapshot",
      ),
    );
  }
  for (const module of options.snapshot.packages) {
    if (!options.sdk.modules.includes(module)) {
      diagnostics.push(
        diagnostic("sdk/modules", `SDK modules do not include GIR package '${module}'`),
      );
    }
  }
}

function cStringParameter(
  parameter: GirParameter,
  typeId: string,
  path: string,
  diagnostics: CBindgenDiagnostic[],
): AbiParameter | null {
  if (
    parameter.kind !== "parameter" ||
    parameter.type.kind !== "named" ||
    parameter.type.name !== "utf8" ||
    parameter.type.cType !== "const char*" ||
    parameter.direction !== "in" ||
    parameter.transferOwnership !== "none" ||
    parameter.nullable ||
    parameter.optional ||
    parameter.callerAllocates ||
    parameter.skip ||
    parameter.scope !== null ||
    parameter.closureParameter !== null ||
    parameter.destroyParameter !== null
  ) {
    diagnostics.push(
      diagnostic(path, "Only required borrowed const UTF-8 input is implemented"),
    );
    return null;
  }
  return Object.freeze({
    name: parameter.name,
    type: typeId,
    passMode: "pointer",
    nullable: false,
    ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
    marshal: Object.freeze({
      kind: "string",
      encoding: "utf-8",
      length: Object.freeze({ kind: "nul" }),
      termination: "nul",
      embeddedNul: "reject",
    }),
  });
}

function requiredValueParameter(
  parameter: GirParameter,
  type: { readonly girName: string; readonly cType: string; readonly abiType: string },
  path: string,
  diagnostics: CBindgenDiagnostic[],
): AbiParameter | null {
  if (
    parameter.kind !== "parameter" ||
    parameter.type.kind !== "named" ||
    parameter.type.name !== type.girName ||
    parameter.type.cType !== type.cType ||
    parameter.direction !== "in" ||
    parameter.transferOwnership !== "none" ||
    parameter.nullable ||
    parameter.optional ||
    parameter.callerAllocates ||
    parameter.skip ||
    parameter.scope !== null ||
    parameter.closureParameter !== null ||
    parameter.destroyParameter !== null
  ) {
    diagnostics.push(
      diagnostic(path, `Only required non-null ${type.girName} input is implemented`),
    );
    return null;
  }
  return Object.freeze({
    name: parameter.name,
    type: type.abiType,
    passMode: "value",
    nullable: false,
    ownership: Object.freeze({ kind: "value" }),
  });
}

function handleParameter(
  parameter: GirParameter,
  classByName: ReadonlyMap<string, GirClass>,
  typeIdByClass: ReadonlyMap<string, string>,
  path: string,
  diagnostics: CBindgenDiagnostic[],
): { readonly abi: AbiParameter; readonly sourceType: string } | null {
  const className = parameter.type.kind === "named" ? parameter.type.name : null;
  const class_ = className === null ? undefined : classByName.get(className);
  const typeId = className === null ? undefined : typeIdByClass.get(className);
  if (
    parameter.kind !== "parameter" ||
    class_ === undefined ||
    typeId === undefined ||
    parameter.type.kind !== "named" ||
    parameter.type.cType !== `${class_.cType}*` ||
    parameter.direction !== "in" ||
    parameter.transferOwnership !== "none" ||
    parameter.optional ||
    parameter.callerAllocates ||
    parameter.skip ||
    parameter.scope !== null ||
    parameter.closureParameter !== null ||
    parameter.destroyParameter !== null
  ) {
    diagnostics.push(
      diagnostic(path, "Only selected borrowed GObject handle inputs are implemented"),
    );
    return null;
  }
  return Object.freeze({
    abi: Object.freeze({
      name: parameter.name,
      type: typeId,
      passMode: "pointer",
      // A nullable C parameter safely admits this generated non-null source
      // subset. Null exposure needs nullable managed-handle IR of its own.
      nullable: false,
      ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
    }),
    sourceType: class_.name,
  });
}

function methodResult(
  callable: GirCallable,
  receiverName: string,
  nullableUtf8Type: string,
  diagnostics: CBindgenDiagnostic[],
  path: string,
): AbiResult | null {
  const result = callable.result;
  if (result.type.kind === "named" && result.type.cType === "void") {
    if (
      result.transferOwnership !== "none" ||
      result.nullable ||
      result.scope !== null ||
      result.closureParameter !== null ||
      result.destroyParameter !== null
    ) {
      diagnostics.push(diagnostic(path, "Void results must be non-null value results"));
      return null;
    }
    return Object.freeze({
      type: "void",
      passMode: "value",
      nullable: false,
      ownership: Object.freeze({ kind: "value" }),
    });
  }
  if (
    result.type.kind === "named" &&
    result.type.name === "gboolean" &&
    result.type.cType === "gboolean" &&
    result.transferOwnership === "none" &&
    !result.nullable &&
    result.scope === null &&
    result.closureParameter === null &&
    result.destroyParameter === null
  ) {
    return Object.freeze({
      type: "gboolean",
      passMode: "value",
      nullable: false,
      ownership: Object.freeze({ kind: "value" }),
    });
  }
  const scalarType = sourceScalarType(result.type);
  if (
    scalarType !== undefined &&
    result.transferOwnership === "none" &&
    !result.nullable &&
    result.scope === null &&
    result.closureParameter === null &&
    result.destroyParameter === null
  ) {
    return Object.freeze({
      type: scalarType.abiType,
      passMode: "value",
      nullable: false,
      ownership: Object.freeze({ kind: "value" }),
    });
  }
  if (
    result.type.kind === "named" &&
    result.type.name === "utf8" &&
    result.type.cType === "const char*" &&
    result.transferOwnership === "none" &&
    result.scope === null &&
    result.closureParameter === null &&
    result.destroyParameter === null
  ) {
    return Object.freeze({
      type: nullableUtf8Type,
      passMode: "pointer",
      nullable: result.nullable,
      ownership: Object.freeze({
        kind: "borrowed",
        scope: "receiver",
        anchor: receiverName,
      }),
      marshal: Object.freeze({
        kind: "string",
        encoding: "utf-8",
        length: Object.freeze({ kind: "nul" }),
        termination: "nul",
        embeddedNul: "reject",
      }),
    });
  }
  diagnostics.push(diagnostic(
    path,
    "Method result is outside the void/boolean/exact-scalar/borrowed-UTF-8 slice",
  ));
  return null;
}

function isExactInstanceReceiver(
  parameter: GirParameter | undefined,
  class_: GirClass,
): parameter is GirParameter {
  return parameter?.kind === "instance" &&
    parameter.type.kind === "named" &&
    parameter.type.cType === `${class_.cType}*` &&
    parameter.direction === "in" &&
    parameter.transferOwnership === "none" &&
    !parameter.nullable &&
    !parameter.optional &&
    !parameter.callerAllocates &&
    !parameter.skip &&
    parameter.scope === null &&
    parameter.closureParameter === null &&
    parameter.destroyParameter === null;
}

function callableBase(input: {
  readonly declaration: string;
  readonly kind: CallableBinding["kind"];
  readonly entryKind: CallableBinding["entry"]["kind"];
  readonly symbol: string;
  readonly parameters: readonly AbiParameter[];
  readonly result: AbiResult;
  readonly dependencies: CallableBinding["dependencies"];
  readonly availability?: BindingAvailability;
  readonly error?: CallableBinding["error"];
}): CallableBinding {
  return Object.freeze({
    kind: input.kind,
    declaration: Object.freeze({ module: ".", name: input.declaration }),
    entry: Object.freeze({ kind: input.entryKind, symbol: input.symbol }),
    signature: Object.freeze({
      callingConvention: "c",
      variadic: false,
      parameters: Object.freeze([...input.parameters]),
      result: input.result,
    }),
    thread: Object.freeze({
      executor: Object.freeze({ kind: "runtime-owner" }),
      behavior: "require",
      blocking: false,
    }),
    error: input.error ?? Object.freeze({ kind: "no-fail" }),
    dependencies: input.dependencies,
    ...(input.availability === undefined ? {} : { availability: input.availability }),
  });
}

export function generateGtkScabiPackage(
  options: GtkScabiGenerationOptions,
): GtkScabiPackage {
  const diagnostics: CBindgenDiagnostic[] = [];
  validateInputs(options, diagnostics);
  const types: Record<string, NativeType> = {
    const_utf8: Object.freeze({
      kind: "pointer",
      pointee: "i8",
      mutability: "const",
      nullable: false,
      addressSpace: 0,
    }),
    gdouble: Object.freeze({ kind: "float", bits: 64 }),
    i8: Object.freeze({ kind: "integer", signed: true, bits: 8 }),
    gint: Object.freeze({ kind: "integer", signed: true, bits: 32 }),
    gboolean: Object.freeze({
      kind: "boolean",
      storage: "gint",
      falseValue: "0",
      trueValue: "1",
    }),
    nullable_const_utf8: Object.freeze({
      kind: "pointer",
      pointee: "i8",
      mutability: "const",
      nullable: true,
      addressSpace: 0,
    }),
    void: Object.freeze({ kind: "void" }),
  };
  const bindings: Record<string, NativeBinding> = {};
  const declarationTypes: Record<string, { readonly module: "."; readonly name: string }> = {};
  const usedSourceScalars = sourceScalarTypes.filter((scalar) =>
    options.snapshot.classes.some((class_) =>
      class_.methods.some((method) =>
        sourceScalarType(method.result.type)?.abiType === scalar.abiType ||
        method.parameters.some((parameter) =>
          sourceScalarType(parameter.type)?.abiType === scalar.abiType
        )
      )
    )
  );
  for (const scalar of usedSourceScalars) {
    declarationTypes[scalar.abiType] = Object.freeze({
      module: ".",
      name: scalar.girName,
    });
  }
  const classByName = new Map(options.snapshot.classes.map((class_) => [class_.name, class_]));
  const typeIdByClass = new Map(options.snapshot.classes.map((class_) => [
    class_.name,
    handleTypeId(options.snapshot.namespace.name, class_),
  ]));
  const hasSignals = options.snapshot.classes.some((class_) => class_.signals.length > 0);
  const namespacePrefix = options.snapshot.namespace.name.toLowerCase();
  const signalConnectionTypeId = `${namespacePrefix}_signal_connection`;
  const signalDisconnectId = `${namespacePrefix}_signal_connection_disconnect`;
  const signalConnectedId = `${namespacePrefix}_signal_connection_connected`;
  const signalReleaseId = `${namespacePrefix}_signal_connection_release`;
  const signalDisconnectDeclaration = "SignalConnection.disconnect";
  const signalConnectedDeclaration = "SignalConnection.connected";
  const signalReleaseDeclaration = "SignalConnection.__release";
  const declarationLines = [
    ...(usedSourceScalars.length > 0
      ? ["declare const nativeScalar: unique symbol;"]
      : []),
    ...options.snapshot.classes.map((class_) =>
      `declare const ${handleBrand(class_.name)}: unique symbol;`
    ),
    ...(hasSignals ? ["declare const nativeResourceSignalConnection: unique symbol;"] : []),
    "",
    ...(usedSourceScalars.length > 0
      ? [
          ...usedSourceScalars.map((scalar) =>
            `export type ${scalar.girName} = number & { readonly [nativeScalar]: "${scalar.girName}" };`
          ),
          "",
        ]
      : []),
  ];
  const adapterBindings: string[] = [];
  const orderedLinkInputs = [...options.linkInputs].sort(
    (left, right) => left.order - right.order || compareText(left.id, right.id),
  );
  const linkIds = orderedLinkInputs.map(({ id }) => id);
  const adapterByConstructor = new Map(
    options.gobjectAdapter.constructors.map((constructor) => [constructor.id, constructor]),
  );
  const adapterBySignal = new Map(
    options.gobjectAdapter.signals.map((signal) => [signal.id, signal]),
  );
  const declarations = new Set<string>();
  let signalConnectionReady = !hasSignals;
  if (hasSignals) {
    const connection = options.gobjectAdapter.signalConnection;
    const path = `${options.snapshot.namespace.name}/SignalConnection`;
    if (connection === null) {
      diagnostics.push(diagnostic(path, "GObject signal connection adapter is missing"));
    } else if (
      types[signalConnectionTypeId] !== undefined ||
      declarationTypes[signalConnectionTypeId] !== undefined ||
      bindings[signalDisconnectId] !== undefined ||
      bindings[signalConnectedId] !== undefined ||
      bindings[signalReleaseId] !== undefined ||
      declarations.has(signalDisconnectDeclaration) ||
      declarations.has(signalConnectedDeclaration) ||
      declarations.has(signalReleaseDeclaration)
    ) {
      diagnostics.push(diagnostic(path, "Generated signal connection identity collides"));
    } else {
      types[signalConnectionTypeId] = Object.freeze({
        kind: "handle",
        nativeName: connection.nativeType,
        threadSafety: "confined",
        identity: "none",
        upcasts: Object.freeze([]),
      });
      declarationTypes[signalConnectionTypeId] = Object.freeze({
        module: ".",
        name: "SignalConnection",
      });
      bindings[signalDisconnectId] = callableBase({
        declaration: signalDisconnectDeclaration,
        kind: "method",
        entryKind: "adapter-symbol",
        symbol: connection.disconnectSymbol,
        parameters: [Object.freeze({
          name: "connection",
          type: signalConnectionTypeId,
          passMode: "pointer",
          nullable: false,
          ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
        })],
        result: Object.freeze({
          type: "void",
          passMode: "value",
          nullable: false,
          ownership: Object.freeze({ kind: "value" }),
        }),
        dependencies: dependencies({ links: linkIds, adapter: options.adapterInput.id }),
      });
      bindings[signalConnectedId] = callableBase({
        declaration: signalConnectedDeclaration,
        kind: "getter",
        entryKind: "adapter-symbol",
        symbol: connection.connectedSymbol,
        parameters: [Object.freeze({
          name: "connection",
          type: signalConnectionTypeId,
          passMode: "pointer",
          nullable: false,
          ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
        })],
        result: Object.freeze({
          type: "gboolean",
          passMode: "value",
          nullable: false,
          ownership: Object.freeze({ kind: "value" }),
        }),
        dependencies: dependencies({ links: linkIds, adapter: options.adapterInput.id }),
      });
      bindings[signalReleaseId] = callableBase({
        declaration: signalReleaseDeclaration,
        kind: "method",
        entryKind: "adapter-symbol",
        symbol: connection.releaseSymbol,
        parameters: [Object.freeze({
          name: "connection",
          type: signalConnectionTypeId,
          passMode: "pointer",
          nullable: true,
          ownership: Object.freeze({ kind: "owned", transfer: "to-native" }),
        })],
        result: Object.freeze({
          type: "void",
          passMode: "value",
          nullable: false,
          ownership: Object.freeze({ kind: "value" }),
        }),
        dependencies: dependencies({ links: linkIds, adapter: options.adapterInput.id }),
      });
      declarations.add(signalDisconnectDeclaration);
      declarations.add(signalConnectedDeclaration);
      declarations.add(signalReleaseDeclaration);
      adapterBindings.push(signalDisconnectId, signalConnectedId, signalReleaseId);
      declarationLines.push(
        "export interface SignalConnection {",
        "  readonly [nativeResourceSignalConnection]: true;",
        "  readonly connected: boolean;",
        "  disconnect(): void;",
        "}",
        "",
      );
      signalConnectionReady = true;
    }
  }

  for (const class_ of options.snapshot.classes) {
    const classPath = `${options.snapshot.namespace.name}/${class_.name}`;
    const typeId = typeIdByClass.get(class_.name)!;
    const releaseId = `${options.snapshot.namespace.name.toLowerCase()}_${class_.cSymbolPrefix}_release`;
    const releaseDeclaration = `${class_.name}.dispose`;
    if (
      types[typeId] !== undefined ||
      declarationTypes[typeId] !== undefined ||
      (class_.constructors.length > 0 &&
        (bindings[releaseId] !== undefined || declarations.has(releaseDeclaration)))
    ) {
      diagnostics.push(diagnostic(classPath, "Generated GObject class identity collides"));
      continue;
    }
    types[typeId] = Object.freeze({
      kind: "handle",
      nativeName: class_.cType,
      threadSafety: "confined",
      identity: "platform",
      upcasts: Object.freeze(
        class_.parent !== null && typeIdByClass.has(class_.parent)
          ? [Object.freeze({
              kind: "identity" as const,
              target: typeIdByClass.get(class_.parent)!,
            })]
          : [],
      ),
    });
    declarationTypes[typeId] = Object.freeze({ module: ".", name: class_.name });
    if (class_.constructors.length > 0) {
      const firstAdapter = adapterByConstructor.get(
        `${class_.name}.constructor.${class_.constructors[0]!.name}`,
      );
      if (firstAdapter === undefined) {
        diagnostics.push(
          diagnostic(`${classPath}/constructors`, "GObject ownership adapter is missing this class"),
        );
        continue;
      }
      bindings[releaseId] = callableBase({
        declaration: releaseDeclaration,
        kind: "method",
        entryKind: "adapter-symbol",
        symbol: firstAdapter.releaseSymbol,
        parameters: [Object.freeze({
          name: lowerCamel(class_.name),
          type: typeId,
          passMode: "pointer",
          nullable: true,
          ownership: Object.freeze({ kind: "owned", transfer: "to-native" }),
        })],
        result: Object.freeze({
          type: "void",
          passMode: "value",
          nullable: false,
          ownership: Object.freeze({ kind: "value" }),
        }),
        dependencies: dependencies({ links: linkIds, adapter: options.adapterInput.id }),
      });
      declarations.add(releaseDeclaration);
      adapterBindings.push(releaseId);
    }

    const parent = class_.parent === null ? undefined : classByName.get(class_.parent);
    const classLines = [
      `export declare ${class_.abstract ? "abstract " : ""}class ${class_.name}${parent === undefined ? "" : ` extends ${parent.name}`} {`,
      `  readonly [${handleBrand(class_.name)}]: true;`,
    ];
    const constructorLines: string[] = [];
    for (const callable of class_.methods) {
      const path = `${classPath}/method/${callable.name}`;
      if (callable.cIdentifier === null || callable.throws || callable.result.skip) {
        diagnostics.push(diagnostic(path, "Method needs a direct non-throwing C entry"));
        continue;
      }
      const receiver = callable.parameters[0];
      if (!isExactInstanceReceiver(receiver, class_)) {
        diagnostics.push(diagnostic(`${path}/receiver`, "Method receiver does not match its GObject class"));
        continue;
      }
      const sourceParameters: string[] = [];
      const abiParameters: AbiParameter[] = [Object.freeze({
        name: receiver.name,
        type: typeId,
        passMode: "pointer",
        nullable: false,
        ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
      })];
      let valid = true;
      for (const [index, parameter] of callable.parameters.slice(1).entries()) {
        const parameterPath = `${path}/parameters/${index + 1}`;
        const scalar = sourceScalarType(parameter.type);
        if (
          parameter.type.kind === "named" &&
          parameter.type.name === "utf8"
        ) {
          const abi = cStringParameter(parameter, "const_utf8", parameterPath, diagnostics);
          if (abi === null) {
            valid = false;
          } else {
            abiParameters.push(abi);
            sourceParameters.push(`${lowerCamel(parameter.name)}: string`);
          }
        } else if (
          parameter.type.kind === "named" &&
          parameter.type.name === "gboolean"
        ) {
          const abi = requiredValueParameter(
            parameter,
            { girName: "gboolean", cType: "gboolean", abiType: "gboolean" },
            parameterPath,
            diagnostics,
          );
          if (abi === null) {
            valid = false;
          } else {
            abiParameters.push(abi);
            sourceParameters.push(`${lowerCamel(parameter.name)}: boolean`);
          }
        } else if (scalar !== undefined) {
          const abi = requiredValueParameter(
            parameter,
            scalar,
            parameterPath,
            diagnostics,
          );
          if (abi === null) {
            valid = false;
          } else {
            abiParameters.push(abi);
            sourceParameters.push(
              `${lowerCamel(parameter.name)}: ${scalar.girName}`,
            );
          }
        } else {
          const handle = handleParameter(
            parameter,
            classByName,
            typeIdByClass,
            parameterPath,
            diagnostics,
          );
          if (handle === null) {
            valid = false;
          } else {
            abiParameters.push(handle.abi);
            sourceParameters.push(
              `${lowerCamel(parameter.name)}: ${handle.sourceType}`,
            );
          }
        }
      }
      const result = methodResult(
        callable,
        receiver.name,
        callable.result.nullable ? "nullable_const_utf8" : "const_utf8",
        diagnostics,
        `${path}/result`,
      );
      if (!valid || result === null) continue;
      const declaration = `${class_.name}.${lowerCamel(callable.name)}`;
      const bindingId = callable.cIdentifier;
      if (bindings[bindingId] !== undefined || declarations.has(declaration)) {
        diagnostics.push(diagnostic(path, "Generated method identity collides"));
        continue;
      }
      declarations.add(declaration);
      bindings[bindingId] = callableBase({
        declaration,
        kind: "method",
        entryKind: "c-symbol",
        symbol: callable.cIdentifier,
        parameters: abiParameters,
        result,
        dependencies: dependencies({ links: linkIds }),
        availability: availability(class_, callable),
      });
      const scalarResult = sourceScalarType(callable.result.type);
      const sourceResult = callable.result.type.cType === "void"
        ? "void"
        : callable.result.type.kind === "named" &&
            callable.result.type.name === "gboolean"
          ? "boolean"
          : scalarResult !== undefined
            ? scalarResult.girName
            : callable.result.nullable
              ? "string | null"
              : "string";
      classLines.push(
        `  ${lowerCamel(callable.name)}(${sourceParameters.join(", ")}): ${sourceResult};`,
      );
    }
    for (const callable of class_.signals) {
      const path = `${classPath}/signal/${callable.name}`;
      const adapter = adapterBySignal.get(`${class_.name}.signal.${callable.name}`);
      const signalPart = callable.name.replaceAll("-", "_");
      const callbackTypeId = `${namespacePrefix}_${class_.cSymbolPrefix}_${signalPart}_callback`;
      const connectId = `${namespacePrefix}_${class_.cSymbolPrefix}_connect_${signalPart}`;
      const declaration = `${class_.name}.on${upperCamel(callable.name)}`;
      if (adapter === undefined) {
        diagnostics.push(diagnostic(path, "GObject signal adapter is missing this signal"));
        continue;
      }
      if (!signalConnectionReady) continue;
      if (
        types[callbackTypeId] !== undefined ||
        bindings[connectId] !== undefined ||
        declarations.has(declaration)
      ) {
        diagnostics.push(diagnostic(path, "Generated GObject signal identity collides"));
        continue;
      }
      if (types.void_ptr === undefined) {
        types.void_ptr = Object.freeze({
          kind: "pointer",
          pointee: "void",
          mutability: "mutable",
          nullable: true,
          addressSpace: 0,
        });
      }
      types[callbackTypeId] = Object.freeze({
        kind: "callback",
        signature: Object.freeze({
          callingConvention: "c",
          variadic: false,
          parameters: Object.freeze([]),
          result: Object.freeze({
            type: "void",
            passMode: "value",
            nullable: false,
            ownership: Object.freeze({ kind: "value" }),
          }),
        }),
        context: Object.freeze({ placement: "last", type: "void_ptr" }),
      });
      bindings[connectId] = callableBase({
        declaration,
        kind: "method",
        entryKind: "adapter-symbol",
        symbol: adapter.connectSymbol,
        parameters: [
          Object.freeze({
            name: lowerCamel(class_.name),
            type: typeId,
            passMode: "pointer",
            nullable: false,
            ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
          }),
          Object.freeze({
            name: "callback",
            type: callbackTypeId,
            passMode: "pointer",
            nullable: false,
            ownership: Object.freeze({
              kind: "borrowed",
              scope: "registration",
              anchor: lowerCamel(class_.name),
            }),
            callback: Object.freeze({
              lifetime: "until-cancelled",
              registrationOwner: lowerCamel(class_.name),
              cancellationBinding: signalDisconnectId,
              contextParameter: "context",
              allowedInvocationExecutors: Object.freeze([
                Object.freeze({ kind: "same-as-caller" as const }),
              ]),
              deliveryExecutor: Object.freeze({ kind: "runtime-owner" }),
              synchronousReturn: false,
              arguments: Object.freeze([]),
              sourceArguments: Object.freeze([
                Object.freeze({ kind: "registration-owner" as const }),
              ]),
              reentrancy: "allowed",
              postDisposal: "not-invoked",
              shutdown: "drain",
            }),
          }),
          Object.freeze({
            name: "context",
            type: "void_ptr",
            passMode: "pointer",
            nullable: false,
            ownership: Object.freeze({
              kind: "borrowed",
              scope: "registration",
              anchor: "callback",
            }),
          }),
        ],
        result: Object.freeze({
          type: signalConnectionTypeId,
          passMode: "pointer",
          nullable: true,
          ownership: Object.freeze({
            kind: "owned",
            transfer: "to-runtime",
            destructor: signalReleaseId,
          }),
        }),
        error: Object.freeze({ kind: "nullable" }),
        dependencies: dependencies({
          bindings: [signalDisconnectId, signalReleaseId],
          links: linkIds,
          adapter: options.adapterInput.id,
        }),
        availability: availability(class_, callable),
      });
      declarations.add(declaration);
      adapterBindings.push(connectId);
      classLines.push(
        `  on${upperCamel(callable.name)}(callback: (${lowerCamel(class_.name)}: ${class_.name}) => void): SignalConnection;`,
      );
    }
    let hasCanonicalConstructor = false;
    for (const callable of class_.constructors) {
      const path = `${classPath}/constructor/${callable.name}`;
      if (callable.cIdentifier === null || callable.throws || callable.result.skip) {
        diagnostics.push(diagnostic(path, "Constructor needs a direct non-throwing C entry"));
        continue;
      }
      if (
        callable.result.scope !== null ||
        callable.result.closureParameter !== null ||
        callable.result.destroyParameter !== null
      ) {
        diagnostics.push(
          diagnostic(`${path}/result`, "Constructor result callback metadata is unsupported"),
        );
        continue;
      }
      const adapter = adapterByConstructor.get(`${class_.name}.constructor.${callable.name}`);
      if (adapter === undefined) {
        diagnostics.push(diagnostic(path, "GObject ownership adapter is missing this constructor"));
        continue;
      }
      const parameters: AbiParameter[] = [];
      const sourceParameters: string[] = [];
      let valid = true;
      for (const [index, parameter] of callable.parameters.entries()) {
        const abi = cStringParameter(
          parameter,
          "const_utf8",
          `${path}/parameters/${index}`,
          diagnostics,
        );
        if (abi === null) {
          valid = false;
        } else {
          parameters.push(abi);
          sourceParameters.push(`${lowerCamel(parameter.name)}: string`);
        }
      }
      const projection = constructorProjection(class_.name, callable.name);
      if (!identifierPattern.test(projection.member) || declarations.has(projection.declaration)) {
        diagnostics.push(diagnostic(path, "Generated constructor declaration identity collides"));
        valid = false;
      }
      if (!valid) continue;
      declarations.add(projection.declaration);
      const bindingId = callable.cIdentifier;
      if (bindings[bindingId] !== undefined) {
        diagnostics.push(diagnostic(path, "Generated constructor binding identity collides"));
        continue;
      }
      bindings[bindingId] = callableBase({
        declaration: projection.declaration,
        kind: projection.kind,
        entryKind: "adapter-symbol",
        symbol: adapter.adapterSymbol,
        parameters,
        result: Object.freeze({
          type: typeId,
          passMode: "pointer",
          nullable: callable.result.nullable,
          ownership: Object.freeze({
            kind: "owned",
            transfer: "to-runtime",
            destructor: releaseId,
          }),
        }),
        error: callable.result.nullable
          ? Object.freeze({ kind: "nullable" })
          : Object.freeze({ kind: "no-fail" }),
        dependencies: dependencies({
          bindings: [releaseId],
          links: linkIds,
          adapter: options.adapterInput.id,
        }),
        availability: availability(class_, callable),
      });
      adapterBindings.push(bindingId);
      if (projection.kind === "constructor") {
        hasCanonicalConstructor = true;
        constructorLines.push(`  constructor(${sourceParameters.join(", ")});`);
      } else {
        constructorLines.push(
          `  static ${projection.member}(${sourceParameters.join(", ")}): ${class_.name};`,
        );
      }
    }
    if (!hasCanonicalConstructor) {
      constructorLines.unshift(
        `  ${class_.final ? "private" : "protected"} constructor();`,
      );
    }
    classLines.splice(2, 0, ...constructorLines);
    classLines.push("}", "");
    declarationLines.push(...classLines);
  }
  if (diagnostics.length > 0) throw new CBindgenError(diagnostics);

  const declarationSource = `${declarationLines.join("\n").trimEnd()}\n`;
  const declarationsDigest = sha256(declarationSource);
  const metadataDigest = sha256(canonicalizeJson({
    gir: options.snapshot.source.digest,
    clang: options.evidence.semanticDigest,
  }));
  const manifestValue: ScabiManifest = {
    schema: "native-typescript.scabi",
    schemaVersion: 1,
    package: options.package,
    target: {
      ...options.target,
      features: orderedText(options.target.features),
    },
    sdk: {
      ...options.sdk,
      modules: orderedText(options.sdk.modules),
      metadataDigest,
      toolchain: options.evidence.clang.toolId,
      toolchainVersion: options.evidence.clang.version,
      toolchainAbi: options.target.abi,
    },
    generator: {
      name: "native-typescript.gtk-gir",
      version: "1",
      revision: "gtk-scabi-v1",
      arguments: options.snapshot.classes.flatMap((class_) => [
        `--class=${class_.name}`,
        ...class_.constructors.map(({ name }) => `--constructor=${class_.name}.${name}`),
        ...class_.methods.map(({ name }) => `--method=${class_.name}.${name}`),
        ...class_.signals.map(({ name }) => `--signal=${class_.name}.${name}`),
      ]),
      inputDigests: [
        options.snapshot.source.digest as Sha256Digest,
        options.evidence.semanticDigest as Sha256Digest,
        options.gobjectAdapter.sourceDigest as Sha256Digest,
      ],
    },
    declarations: {
      digest: declarationsDigest,
      types: declarationTypes,
    },
    types,
    bindings,
    linkInputs: orderedLinkInputs,
    adapterInputs: [{
      id: options.adapterInput.id,
      family: "gobject-adapters",
      language: "c",
      bindings: [...new Set(adapterBindings)].sort(),
      outputs: [options.adapterInput.output],
      options: {
        sourceDigest: options.gobjectAdapter.sourceDigest,
        schemaVersion: options.gobjectAdapter.schemaVersion,
      },
    }],
    permissions: [],
    platform: {
      family: "gobject",
      namespace: options.snapshot.namespace.name,
      namespaceVersion: options.snapshot.namespace.version,
    },
  };
  const manifestSource = canonicalizeJson(manifestValue);
  const manifest = parseScabiManifest(manifestSource);
  return Object.freeze({
    schema: "native-typescript.gtk-scabi-package",
    schemaVersion: 1,
    declarations: declarationSource,
    declarationsDigest,
    manifest,
    manifestSource,
    manifestDigest: digestScabiManifest(manifest),
  });
}
