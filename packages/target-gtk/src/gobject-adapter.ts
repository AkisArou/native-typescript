import { createHash } from "node:crypto";
import {
  CBindgenError,
  parseCTypeCandidate,
  renderCType,
} from "@native-typescript/bindgen-c";
import type {
  CBindgenDiagnostic,
  CTypeCandidate,
} from "@native-typescript/bindgen-c";
import { planCObjectCompilation } from "@native-typescript/core";
import type {
  ArtifactActionDefinition,
  ArtifactActionInputArgument,
  ArtifactDefinition,
} from "@native-typescript/core";
import type {
  GirCallable,
  GirClass,
  GirRecord,
  GirSnapshot,
  GirTransferOwnership,
} from "./gir-model.ts";

export interface GObjectConstructorAdapter {
  readonly id: string;
  readonly className: string;
  readonly nativeType: string;
  readonly sourceSymbol: string;
  readonly adapterSymbol: string;
  readonly releaseSymbol: string;
  readonly sourceTransfer: "none" | "full";
  readonly acquisition: "ref-sink" | "sink-if-floating";
  readonly nullable: boolean;
}

export interface GObjectSignalAdapter {
  readonly id: string;
  readonly className: string;
  readonly nativeType: string;
  readonly signalName: string;
  readonly connectSymbol: string;
  readonly callbackType: string;
  readonly parameters: readonly GObjectSignalParameterAdapter[];
}

export interface GObjectSignalParameterAdapter {
  readonly name: string;
  readonly nativeType: string;
  readonly sourceType: "gdouble" | "gint";
}

export interface GObjectSignalConnectionAdapter {
  readonly nativeType: string;
  readonly disconnectSymbol: string;
  readonly connectedSymbol: string;
  readonly releaseSymbol: string;
}

export interface GObjectValueMethodOutputAdapter {
  readonly parameterName: string;
  readonly fieldName: string;
  readonly recordName: string;
  readonly nativeType: string;
}

export interface GObjectValueMethodAdapter {
  readonly id: string;
  readonly className: string;
  readonly nativeType: string;
  readonly sourceSymbol: string;
  readonly adapterSymbol: string;
  readonly resultName: string;
  readonly resultNativeType: string;
  readonly outputs: readonly GObjectValueMethodOutputAdapter[];
}

export interface GObjectAdapterSource {
  readonly schema: "native-typescript.gobject-adapter-source";
  readonly schemaVersion: 6;
  readonly source: string;
  readonly sourceDigest: string;
  readonly constructors: readonly GObjectConstructorAdapter[];
  readonly signalConnection: GObjectSignalConnectionAdapter | null;
  readonly signals: readonly GObjectSignalAdapter[];
  readonly valueMethods: readonly GObjectValueMethodAdapter[];
}

export interface GObjectAdapterObjectPlan {
  readonly source: ArtifactDefinition;
  readonly object: ArtifactDefinition;
  readonly action: ArtifactActionDefinition;
}

function physicalType(
  cType: string | null,
  path: string,
  diagnostics: CBindgenDiagnostic[],
): CTypeCandidate | null {
  if (cType === null) {
    diagnostics.push({
      code: "NTS5001",
      severity: "error",
      path,
      message: "GObject adapter type has no C spelling",
    });
    return null;
  }
  try {
    return parseCTypeCandidate(cType, path);
  } catch (error) {
    if (!(error instanceof CBindgenError)) throw error;
    diagnostics.push(...error.diagnostics);
    return null;
  }
}

function sourceTransfer(
  transfer: GirTransferOwnership,
  path: string,
  diagnostics: CBindgenDiagnostic[],
): "none" | "full" | null {
  if (transfer === "none" || transfer === "full") return transfer;
  diagnostics.push({
    code: "NTS5001",
    severity: "error",
    path,
    message: "GObject constructors cannot transfer container-only ownership",
  });
  return null;
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

function signalSymbolPart(value: string): string {
  return value.replaceAll("-", "_");
}

function signalParameter(
  parameter: GirCallable["parameters"][number],
  path: string,
  diagnostics: CBindgenDiagnostic[],
): GObjectSignalParameterAdapter | null {
  const physical = physicalType(parameter.type.cType, `${path}/type`, diagnostics);
  const sourceType = parameter.type.kind === "named" &&
      parameter.type.name === "gint" &&
      (parameter.type.cType === "int" || parameter.type.cType === "gint")
    ? "gint"
    : parameter.type.kind === "named" &&
        parameter.type.name === "gdouble" &&
        (parameter.type.cType === "double" || parameter.type.cType === "gdouble")
      ? "gdouble"
      : null;
  if (
    physical === null ||
    sourceType === null ||
    parameter.kind !== "parameter" ||
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
    if (physical !== null) {
      diagnostics.push({
        code: "NTS5001",
        severity: "error",
        path,
        message: sourceType === null
          ? "Only exact gint and gdouble GObject signal payloads are implemented"
          : "GObject signal payloads must be required non-null input values",
      });
    }
    return null;
  }
  return Object.freeze({
    name: parameter.name,
    nativeType: renderCType(physical),
    sourceType,
  });
}

function generateConstructor(
  class_: GirClass,
  callable: GirCallable,
  diagnostics: CBindgenDiagnostic[],
): {
  readonly adapter: GObjectConstructorAdapter;
  readonly lines: readonly string[];
} | null {
  const path = `${class_.name}/constructor/${callable.name}`;
  const nativeClass = physicalType(class_.cType, `${path}/class`, diagnostics);
  const sourceResult = physicalType(
    callable.result.type.cType,
    `${path}/result`,
    diagnostics,
  );
  const parameters = callable.parameters.map((parameter, index) =>
    physicalType(parameter.type.cType, `${path}/parameters/${index}`, diagnostics)
  );
  const validParameters = parameters.filter(
    (parameter): parameter is CTypeCandidate => parameter !== null,
  );
  const transfer = sourceTransfer(
    callable.result.transferOwnership,
    `${path}/result/transferOwnership`,
    diagnostics,
  );
  if (
    callable.cIdentifier === null ||
    nativeClass === null ||
    nativeClass.kind !== "named" ||
    sourceResult === null ||
    sourceResult.kind !== "pointer" ||
    validParameters.length !== parameters.length ||
    transfer === null
  ) {
    if (callable.cIdentifier === null) {
      diagnostics.push({
        code: "NTS5001",
        severity: "error",
        path,
        message: "GObject constructor has no C identifier",
      });
    }
    if (nativeClass !== null && nativeClass.kind !== "named") {
      diagnostics.push({
        code: "NTS5001",
        severity: "error",
        path: `${path}/class`,
        message: "GObject class C type must be one named type",
      });
    }
    if (sourceResult !== null && sourceResult.kind !== "pointer") {
      diagnostics.push({
        code: "NTS5001",
        severity: "error",
        path: `${path}/result`,
        message: "GObject constructor result must be a pointer",
      });
    }
    return null;
  }

  const adapterSymbol = `nts_gobject_adopt_${callable.cIdentifier}`;
  const releaseSymbol = `nts_gobject_release_${class_.cSymbolPrefix}`;
  const parameterDeclarations = validParameters.map(
    (parameter, index) => `${renderCType(parameter)} parameter_${index.toString().padStart(4, "0")}`,
  );
  const parameterNames = validParameters.map(
    (_, index) => `parameter_${index.toString().padStart(4, "0")}`,
  );
  const nativeClassPointer = `${renderCType(nativeClass)} *`;
  const lines = [
    `${nativeClassPointer}${adapterSymbol}(${parameterDeclarations.length === 0 ? "void" : parameterDeclarations.join(", ")}) {`,
    `  ${renderCType(sourceResult)} value = ${callable.cIdentifier}(${parameterNames.join(", ")});`,
    "  if (value == NULL) return NULL;",
    ...(transfer === "none"
      ? ["  g_object_ref_sink(value);"]
      : [
          "  if (g_object_is_floating(value)) {",
          "    g_object_ref_sink(value);",
          "  }",
        ]),
    `  return (${nativeClassPointer})value;`,
    "}",
    "",
  ];
  return {
    adapter: Object.freeze({
      id: `${class_.name}.constructor.${callable.name}`,
      className: class_.name,
      nativeType: class_.cType,
      sourceSymbol: callable.cIdentifier,
      adapterSymbol,
      releaseSymbol,
      sourceTransfer: transfer,
      acquisition: transfer === "none" ? "ref-sink" : "sink-if-floating",
      nullable: callable.result.nullable,
    }),
    lines,
  };
}

function generateSignal(
  class_: GirClass,
  callable: GirCallable,
  signalConnection: GObjectSignalConnectionAdapter,
  diagnostics: CBindgenDiagnostic[],
): {
  readonly adapter: GObjectSignalAdapter;
  readonly lines: readonly string[];
} | null {
  const path = `${class_.name}/signal/${callable.name}`;
  const signalPart = signalSymbolPart(callable.name);
  const nativeClass = physicalType(class_.cType, `${path}/class`, diagnostics);
  const result = physicalType(callable.result.type.cType, `${path}/result`, diagnostics);
  const parameters = callable.parameters.map((parameter, index) =>
    signalParameter(parameter, `${path}/parameters/${index}`, diagnostics)
  );
  const validParameters = parameters.filter(
    (parameter): parameter is NonNullable<typeof parameter> => parameter !== null,
  );
  if (
    nativeClass === null ||
    nativeClass.kind !== "named" ||
    result === null ||
    result.kind !== "named" ||
    result.name !== "void" ||
    callable.result.transferOwnership !== "none" ||
    callable.result.nullable ||
    callable.result.skip ||
    callable.result.scope !== null ||
    callable.result.closureParameter !== null ||
    callable.result.destroyParameter !== null ||
    callable.signalDetailed
  ) {
    diagnostics.push({
      code: "NTS5001",
      severity: "error",
      path,
      message: "Only non-detailed void GObject signals with exact scalar payloads are implemented",
    });
    return null;
  }
  if (validParameters.length !== parameters.length) return null;

  const classPart = class_.cSymbolPrefix;
  const typeStem = `NtsGObject${upperCamel(class_.name)}${upperCamel(callable.name)}`;
  const callbackType = `${typeStem}Callback`;
  const connectionType = `${typeStem}Connection`;
  const connectSymbol = `nts_gobject_connect_${classPart}_${signalPart}`;
  const dispatchSymbol = `nts_gobject_dispatch_${classPart}_${signalPart}`;
  const nativeClassPointer = `${renderCType(nativeClass)} *`;
  const callbackParameters = validParameters.map(
    (parameter, index) =>
      `${parameter.nativeType} parameter_${index.toString().padStart(4, "0")}`,
  );
  const callbackArguments = validParameters.map(
    (_, index) => `parameter_${index.toString().padStart(4, "0")}`,
  );
  const lines = [
    `typedef void (*${callbackType})(${[...callbackParameters, "void *context"].join(", ")});`,
    `typedef struct ${connectionType} {`,
    `  ${signalConnection.nativeType} base;`,
    `  ${callbackType} callback;`,
    "  void *context;",
    `} ${connectionType};`,
    "",
    `static void ${dispatchSymbol}(${[`${nativeClassPointer}instance`, ...callbackParameters, "void *opaque"].join(", ")}) {`,
    "  (void)instance;",
    `  ${connectionType} *connection = opaque;`,
    `  connection->callback(${[...callbackArguments, "connection->context"].join(", ")});`,
    "}",
    "",
    `${signalConnection.nativeType} *${connectSymbol}(`,
    `    ${nativeClassPointer}instance, ${callbackType} callback, void *context) {`,
    "  if (instance == NULL || callback == NULL) return NULL;",
    `  ${connectionType} *connection = calloc(1, sizeof *connection);`,
    "  if (connection == NULL) return NULL;",
    "  connection->base.instance = G_OBJECT(g_object_ref(instance));",
    "  connection->callback = callback;",
    "  connection->context = context;",
    `  connection->base.handler = g_signal_connect(instance, "${callable.name}",`,
    `      G_CALLBACK(${dispatchSymbol}), connection);`,
    "  if (connection->base.handler == 0) {",
    "    g_object_unref(connection->base.instance);",
    "    free(connection);",
    "    return NULL;",
    "  }",
    "  return &connection->base;",
    "}",
    "",
  ];
  return {
    adapter: Object.freeze({
      id: `${class_.name}.signal.${callable.name}`,
      className: class_.name,
      nativeType: class_.cType,
      signalName: callable.name,
      connectSymbol,
      callbackType,
      parameters: Object.freeze(validParameters),
    }),
    lines,
  };
}

function generateValueMethod(
  namespace: string,
  class_: GirClass,
  callable: GirCallable,
  recordsByName: ReadonlyMap<string, GirRecord>,
  diagnostics: CBindgenDiagnostic[],
): {
  readonly adapter: GObjectValueMethodAdapter;
  readonly lines: readonly string[];
} | null {
  const path = `${class_.name}/method/${callable.name}`;
  const outputParameters = callable.parameters.slice(1);
  if (outputParameters.every((parameter) => parameter.direction === "in")) return null;
  const receiver = callable.parameters[0];
  const validReceiver = receiver?.kind === "instance" &&
    receiver.type.kind === "named" &&
    receiver.type.cType === `${class_.cType}*` &&
    receiver.direction === "in" &&
    receiver.transferOwnership === "none" &&
    !receiver.nullable &&
    !receiver.optional &&
    !receiver.callerAllocates &&
    !receiver.skip &&
    receiver.scope === null &&
    receiver.closureParameter === null &&
    receiver.destroyParameter === null;
  const validResult = callable.result.type.kind === "named" &&
    callable.result.type.cType === "void" &&
    callable.result.transferOwnership === "none" &&
    !callable.result.nullable &&
    !callable.result.skip &&
    callable.result.scope === null &&
    callable.result.closureParameter === null &&
    callable.result.destroyParameter === null;
  const outputs = outputParameters.map((parameter, index) => {
    const recordName = parameter.type.kind === "named" ? parameter.type.name : null;
    const record = recordName === null ? undefined : recordsByName.get(recordName);
    if (
      parameter.kind !== "parameter" ||
      parameter.direction !== "out" ||
      !parameter.callerAllocates ||
      parameter.transferOwnership !== "none" ||
      parameter.skip ||
      parameter.scope !== null ||
      parameter.closureParameter !== null ||
      parameter.destroyParameter !== null ||
      record === undefined ||
      parameter.type.kind !== "named" ||
      parameter.type.cType !== `${record.cType}*`
    ) {
      diagnostics.push({
        code: "NTS5001",
        severity: "error",
        path: `${path}/parameters/${index + 1}`,
        message: "Value-return adapters require caller-allocated record output parameters",
      });
      return null;
    }
    return Object.freeze({
      parameterName: parameter.name,
      fieldName: `${lowerCamel(parameter.name)}`,
      recordName: record.name,
      nativeType: record.cType,
    });
  });
  if (
    callable.cIdentifier === null ||
    callable.throws ||
    !validReceiver ||
    !validResult ||
    outputs.length === 0 ||
    outputs.some((output) => output === null)
  ) {
    if (callable.cIdentifier === null || callable.throws || !validReceiver || !validResult) {
      diagnostics.push({
        code: "NTS5001",
        severity: "error",
        path,
        message: "Value-return adapters require a direct non-throwing void instance method",
      });
    }
    return null;
  }
  const resultStem = callable.name.startsWith("get_")
    ? callable.name.slice(4)
    : callable.name;
  const resultName = `${class_.name}${upperCamel(resultStem)}`;
  const resultNativeType = `Nts${upperCamel(namespace)}${resultName}`;
  const adapterSymbol = `nts_gobject_value_${callable.cIdentifier}`;
  const validOutputs = outputs.filter(
    (output): output is GObjectValueMethodOutputAdapter => output !== null,
  );
  const lines = [
    `typedef struct ${resultNativeType} {`,
    ...validOutputs.map((output) => `  ${output.nativeType} ${output.fieldName};`),
    `} ${resultNativeType};`,
    "",
    `${resultNativeType} ${adapterSymbol}(${class_.cType} *instance) {`,
    `  ${resultNativeType} result;`,
    "  memset(&result, 0, sizeof result);",
    `  ${callable.cIdentifier}(instance, ${validOutputs.map((output) => `&result.${output.fieldName}`).join(", ")});`,
    "  return result;",
    "}",
    "",
  ];
  return Object.freeze({
    adapter: Object.freeze({
      id: `${class_.name}.method.${callable.name}`,
      className: class_.name,
      nativeType: class_.cType,
      sourceSymbol: callable.cIdentifier,
      adapterSymbol,
      resultName,
      resultNativeType,
      outputs: Object.freeze(validOutputs),
    }),
    lines: Object.freeze(lines),
  });
}

export function generateGObjectAdapterSource(
  snapshot: GirSnapshot,
): GObjectAdapterSource {
  const diagnostics: CBindgenDiagnostic[] = [];
  const constructors: GObjectConstructorAdapter[] = [];
  const signals: GObjectSignalAdapter[] = [];
  const valueMethods: GObjectValueMethodAdapter[] = [];
  const hasSignals = snapshot.classes.some((class_) => class_.signals.length > 0);
  const namespacePart = snapshot.namespace.name.toLowerCase();
  const signalConnection = hasSignals
    ? Object.freeze({
        nativeType: `Nts${upperCamel(snapshot.namespace.name)}SignalConnection`,
        disconnectSymbol: `nts_${namespacePart}_signal_connection_disconnect`,
        connectedSymbol: `nts_${namespacePart}_signal_connection_connected`,
        releaseSymbol: `nts_${namespacePart}_signal_connection_release`,
      })
    : null;
  const lines = [
    "/* Generated by @native-typescript/target-gtk. */",
    ...snapshot.cIncludes.map((include) => `#include <${include}>`),
    "#include <stdlib.h>",
    "#include <string.h>",
    "",
    ...(signalConnection === null
      ? []
      : [
          `typedef struct ${signalConnection.nativeType} {`,
          "  GObject *instance;",
          "  gulong handler;",
          `} ${signalConnection.nativeType};`,
          "",
          `static void nts_${namespacePart}_signal_connection_disconnect_impl(${signalConnection.nativeType} *connection) {`,
          "  if (connection->handler != 0 &&",
          "      g_signal_handler_is_connected(connection->instance, connection->handler)) {",
          "    g_signal_handler_disconnect(connection->instance, connection->handler);",
          "  }",
          "  connection->handler = 0;",
          "}",
          "",
          `gboolean ${signalConnection.connectedSymbol}(const ${signalConnection.nativeType} *connection) {`,
          "  return connection != NULL && connection->handler != 0 &&",
          "      g_signal_handler_is_connected(connection->instance, connection->handler);",
          "}",
          "",
          `void ${signalConnection.disconnectSymbol}(${signalConnection.nativeType} *connection) {`,
          `  if (connection != NULL) nts_${namespacePart}_signal_connection_disconnect_impl(connection);`,
          "}",
          "",
          `void ${signalConnection.releaseSymbol}(${signalConnection.nativeType} *connection) {`,
          "  if (connection == NULL) return;",
          `  nts_${namespacePart}_signal_connection_disconnect_impl(connection);`,
          "  g_object_unref(connection->instance);",
          "  free(connection);",
          "}",
          "",
        ]),
  ];
  const recordsByName = new Map(snapshot.records.map((record) => [record.name, record]));
  for (const class_ of snapshot.classes) {
    const classConstructors: GObjectConstructorAdapter[] = [];
    for (const callable of class_.constructors) {
      const generated = generateConstructor(class_, callable, diagnostics);
      if (generated === null) continue;
      classConstructors.push(generated.adapter);
      constructors.push(generated.adapter);
      lines.push(...generated.lines);
    }
    if (classConstructors.length > 0) {
      const first = classConstructors[0]!;
      lines.push(
        `void ${first.releaseSymbol}(${first.nativeType} *value) {`,
        "  if (value != NULL) g_object_unref(value);",
        "}",
        "",
      );
    }
    for (const callable of class_.signals) {
      const generated = generateSignal(class_, callable, signalConnection!, diagnostics);
      if (generated === null) continue;
      signals.push(generated.adapter);
      lines.push(...generated.lines);
    }
    for (const callable of class_.methods) {
      const generated = generateValueMethod(
        snapshot.namespace.name,
        class_,
        callable,
        recordsByName,
        diagnostics,
      );
      if (generated === null) continue;
      valueMethods.push(generated.adapter);
      lines.push(...generated.lines);
    }
  }
  if (
    constructors.length === 0 &&
    signals.length === 0 &&
    valueMethods.length === 0 &&
    diagnostics.length === 0
  ) {
    diagnostics.push({
      code: "NTS5001",
      severity: "error",
      path: "adapters",
      message: "GObject adapter generation requires a selected constructor, signal, or value method",
    });
  }
  if (diagnostics.length > 0) throw new CBindgenError(diagnostics);

  const source = lines.join("\n");
  return Object.freeze({
    schema: "native-typescript.gobject-adapter-source",
    schemaVersion: 6,
    source,
    sourceDigest: `sha256:${createHash("sha256").update(source).digest("hex")}`,
    constructors: Object.freeze(constructors),
    signalConnection,
    signals: Object.freeze(signals),
    valueMethods: Object.freeze(valueMethods),
  });
}

export function planGObjectAdapterObject(input: {
  readonly adapter: GObjectAdapterSource;
  readonly sourceArtifactId: string;
  readonly objectArtifactId: string;
  readonly actionId: string;
  readonly logicalPath: string;
  readonly artifactFileName: string;
  readonly arguments: readonly ArtifactActionInputArgument[];
  readonly tool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
}): GObjectAdapterObjectPlan {
  const source: ArtifactDefinition = Object.freeze({
    id: input.sourceArtifactId,
    kind: "generated-source",
    entryType: "file",
    mediaType: "text/x-c",
    target: input.target,
    domain: "target",
    cache: "exportable",
    origin: Object.freeze({
      kind: "source",
      digest: input.adapter.sourceDigest,
      fileName: "gobject-adapters.c",
      logicalPath: input.logicalPath,
    }),
  });
  const compilation = planCObjectCompilation({
    actionId: input.actionId,
    artifactId: input.objectArtifactId,
    artifactFileName: input.artifactFileName,
    source: { artifact: input.sourceArtifactId },
    arguments: [
      { kind: "literal", value: "-std=gnu11" },
      { kind: "literal", value: "-Wall" },
      { kind: "literal", value: "-Wextra" },
      { kind: "literal", value: "-Werror" },
      ...input.arguments,
    ],
    tool: input.tool,
    executionPlatform: input.executionPlatform,
    target: input.target,
    deterministic: false,
    cacheable: false,
  });
  return Object.freeze({
    source,
    object: compilation.artifact,
    action: compilation.action,
  });
}
