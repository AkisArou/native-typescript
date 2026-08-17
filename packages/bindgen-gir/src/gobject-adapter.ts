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
  GirParameter,
  GirRecord,
  GirSnapshot,
  GirTransferOwnership,
} from "./gir-model.ts";
import { sourceScalarType, sourceScalarTypes } from "./gobject-scalars.ts";

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
  /** True when the payload is an object the dispatch references for delivery. */
  readonly retained?: boolean;
  readonly nativeType: string;
  /** The GIR type name the payload projects as: a scalar or an enumeration. */
  readonly sourceType: string;
}

/**
 * One `notify::` registration: a class observing one of its own properties.
 *
 * GObject delivers every property change through one signal, `notify`, whose
 * detail names the property — so this is not a signal of its own and carries
 * no payload of its own either. The `GParamSpec` GObject passes says which
 * property changed, which the detail already fixed, so the dispatch drops it
 * and the boundary never sees it. What crosses is the bare fact that the
 * property changed; the handler reads the new value through the getter.
 */
export interface GObjectNotifyAdapter {
  readonly id: string;
  readonly className: string;
  readonly nativeType: string;
  /** The GObject property name, spelled as GIR spells it (`reveal-child`). */
  readonly propertyName: string;
  readonly connectSymbol: string;
  readonly callbackType: string;
}

export interface GObjectSignalConnectionAdapter {
  readonly nativeType: string;
  readonly disconnectSymbol: string;
  readonly connectedSymbol: string;
  readonly releaseSymbol: string;
}

/**
 * One value a method hands back through an output parameter.
 *
 * `sourceName` is the TypeScript spelling the field projects as — a selected
 * record's name, or a branded scalar's. `kind` says which, because the two
 * resolve to a SCABI type by different routes even though the C side treats
 * them identically: both are a field in a generated struct the adapter fills
 * by address.
 */
export interface GObjectValueMethodOutputAdapter {
  readonly kind: "record" | "scalar";
  readonly parameterName: string;
  readonly fieldName: string;
  readonly sourceName: string;
  readonly nativeType: string;
}

/**
 * An input a value-returning method takes before its outputs.
 *
 * The adapter forwards it untouched. Without this a method could only be
 * projected when its outputs were its whole parameter list, which excludes the
 * ordinary shape of asking a question about something —
 * `gtk_tree_view_convert_tree_to_widget_coords(view, x, y, &wx, &wy)`.
 */
export interface GObjectValueMethodInputAdapter {
  readonly kind: "scalar" | "enumeration" | "class";
  readonly parameterName: string;
  readonly sourceName: string;
  readonly nativeType: string;
}

/**
 * A method that fills storage the caller reserves with a boxed record.
 *
 * GTK's own shape for handing one back is to write into a stack value —
 * `gtk_text_buffer_get_start_iter(buffer, &iter)` — which is not a value this
 * boundary can carry, because the record's contents are not readable. The
 * adapter reserves the storage, makes the call, and hands back the record's
 * own `copy` of the result: one owned pointer, released by the `free` that
 * pairs with the `copy` that made it.
 */
export interface GObjectBoxedResultMethodAdapter {
  readonly id: string;
  readonly className: string;
  readonly sourceSymbol: string;
  readonly adapterSymbol: string;
  /** The boxed record's GIR name, and the C spelling of one. */
  readonly resultName: string;
  readonly resultNativeType: string;
  readonly inputs: readonly GObjectValueMethodInputAdapter[];
}

export interface GObjectValueMethodAdapter {
  readonly id: string;
  readonly className: string;
  readonly nativeType: string;
  readonly sourceSymbol: string;
  readonly adapterSymbol: string;
  readonly resultName: string;
  readonly resultNativeType: string;
  readonly inputs: readonly GObjectValueMethodInputAdapter[];
  readonly outputs: readonly GObjectValueMethodOutputAdapter[];
}

/**
 * The pair of entries that read and release a GError, emitted once per
 * namespace when any selected member reports failure through one. They take
 * `void *` because the error object never becomes a source value: the compiler
 * calls them through the error contract, not TypeScript.
 */
export interface GObjectErrorSupportAdapter {
  readonly messageSymbol: string;
  readonly releaseSymbol: string;
}

/**
 * A selected member that reports failure through a GError. The adapter absorbs
 * the trailing `GError **` so the boundary sees a pointer that is null on
 * success, which is the shape the error-object contract describes.
 *
 * The wrapped call's own result is discarded, so this is limited to members
 * whose result carries no information beyond success.
 */
/** The function that drops the reference a handle holds. */
export interface GObjectClassReleaseAdapter {
  readonly className: string;
  readonly releaseSymbol: string;
}

/**
 * A method whose result is an object the callee keeps owning.
 *
 * GIR calls it `transfer-ownership="none"`: the caller may read the object but
 * holds no reference, so it may be finalised at any moment afterwards. The
 * adapter takes one, which makes the result an ordinary owned handle. When the
 * object already has a managed cell the reference is surplus, and the
 * runtime's identity map is what notices and gives it back.
 */
export interface GObjectRetainedResultMethodAdapter {
  readonly id: string;
  readonly className: string;
  readonly resultClassName: string;
  readonly sourceSymbol: string;
  readonly adapterSymbol: string;
}

export interface GObjectThrowingMethodAdapter {
  readonly id: string;
  readonly className: string;
  readonly sourceSymbol: string;
  readonly adapterSymbol: string;
}

export interface GObjectAdapterSource {
  readonly schema: "native-typescript.gobject-adapter-source";
  readonly schemaVersion: 10;
  readonly source: string;
  readonly sourceDigest: string;
  readonly constructors: readonly GObjectConstructorAdapter[];
  readonly signalConnection: GObjectSignalConnectionAdapter | null;
  readonly signals: readonly GObjectSignalAdapter[];
  readonly notifications: readonly GObjectNotifyAdapter[];
  readonly valueMethods: readonly GObjectValueMethodAdapter[];
  readonly boxedResultMethods: readonly GObjectBoxedResultMethodAdapter[];
  readonly errorSupport: GObjectErrorSupportAdapter | null;
  readonly classReleases: readonly GObjectClassReleaseAdapter[];
  readonly retainedResultMethods: readonly GObjectRetainedResultMethodAdapter[];
  readonly throwingMethods: readonly GObjectThrowingMethodAdapter[];
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

/* One statement of what a payload may be. Two diagnostics quote it, and they
 * drifted apart once already: a message that lists what is supported has to
 * come from the same place the support does. */
const signalPayloadFamilies =
  "exact scalar, enumeration, UTF-8, and selected class";

function signalSymbolPart(value: string): string {
  return value.replaceAll("-", "_");
}

function signalParameter(
  parameter: GirCallable["parameters"][number],
  enumerationCTypes: ReadonlyMap<string, string>,
  payloadClasses: ReadonlyMap<string, GirClass>,
  path: string,
  diagnostics: CBindgenDiagnostic[],
): GObjectSignalParameterAdapter | null {
  /* A payload is an exact scalar, an enumeration, a UTF-8 string, or a
   * selected class. The first two are values; the third is copied when the
   * signal fires; the fourth is referenced. Boxed records are still refused:
   * a GBoxed has no reference to take, so surviving a queued delivery would
   * mean copying one, and its copy function is per-type metadata nothing
   * reads yet. */
  const scalar = sourceScalarType(parameter.type);
  const enumerationCType = parameter.type.kind === "named"
    ? enumerationCTypes.get(parameter.type.name)
    : undefined;
  /* A UTF-8 payload is a borrowed C string that GTK may free once emission
   * returns. Delivery is queued, so the runtime copies it when the signal
   * fires rather than holding the pointer — the adapter's job is only to
   * declare it faithfully. */
  const isUtf8 = parameter.type.kind === "named" &&
    parameter.type.name === "utf8" &&
    (parameter.type.cType === "gchar*" || parameter.type.cType === "char*" ||
      parameter.type.cType === "const gchar*" ||
      parameter.type.cType === "const char*");
  /* A GObject payload outlives the emission only if a reference is taken, and
   * delivery is queued, so the dispatch takes one before it hands the pointer
   * over. */
  const payloadClass = parameter.type.kind === "named"
    ? payloadClasses.get(parameter.type.name)
    : undefined;
  const sourceType = scalar?.girName ??
    (isUtf8
      ? "utf8"
      : payloadClass !== undefined && parameter.type.kind === "named"
        ? parameter.type.name
        : enumerationCType === undefined || parameter.type.kind !== "named"
          ? null
          : parameter.type.name);
  /* GIR gives a signal parameter no c:type — a signal is not a C function — so
   * an enumeration payload's spelling comes from the enumeration's own
   * declaration rather than from the parameter that names it. */
  const physical = physicalType(
    parameter.type.cType ?? enumerationCType ??
      (payloadClass === undefined ? null : `${payloadClass.cType}*`),
    `${path}/type`,
    diagnostics,
  );
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
          ? `Only ${signalPayloadFamilies} GObject signal payloads are implemented`
          : "GObject signal payloads must be required non-null input values",
      });
    }
    return null;
  }
  return Object.freeze({
    name: parameter.name,
    ...(payloadClass === undefined ? {} : { retained: true }),
    nativeType: renderCType(physical),
    sourceType,
  });
}

function generateConstructor(
  namespace: string,
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
  // Qualified by namespace: a class name is unique only within one namespace,
  // and Gio.Application and Gtk.Application link into the same executable.
  const releaseSymbol = `nts_gobject_release_${namespace}_${class_.cSymbolPrefix}`;
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
  namespace: string,
  class_: GirClass,
  callable: GirCallable,
  signalConnection: GObjectSignalConnectionAdapter,
  enumerationCTypes: ReadonlyMap<string, string>,
  payloadClasses: ReadonlyMap<string, GirClass>,
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
    signalParameter(
      parameter,
      enumerationCTypes,
      payloadClasses,
      `${path}/parameters/${index}`,
      diagnostics,
    )
  );
  const validParameters = parameters.filter(
    (parameter): parameter is NonNullable<typeof parameter> => parameter !== null,
  );
  /* A signal that answers `gboolean` is asking whether the handler consumed
   * the event, and the answer has to exist before the emission returns. That
   * is the one non-void result this adapter forwards; anything else would be
   * a value the handler has to construct, which is a different question. */
  const answersBoolean = result !== null && result.kind === "named" &&
    result.name === "gboolean";
  if (
    nativeClass === null ||
    nativeClass.kind !== "named" ||
    result === null ||
    result.kind !== "named" ||
    (result.name !== "void" && !answersBoolean) ||
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
      message:
        `Only non-detailed GObject signals answering void or gboolean, with ` +
        `${signalPayloadFamilies} payloads, are implemented`,
    });
    return null;
  }
  if (validParameters.length !== parameters.length) return null;

  const classPart = class_.cSymbolPrefix;
  const typeStem = `NtsGObject${upperCamel(namespace)}${upperCamel(class_.name)}${upperCamel(callable.name)}`;
  const callbackType = `${typeStem}Callback`;
  const connectionType = `${typeStem}Connection`;
  const connectSymbol = `nts_gobject_connect_${namespace}_${classPart}_${signalPart}`;
  const dispatchSymbol = `nts_gobject_dispatch_${namespace}_${classPart}_${signalPart}`;
  const nativeClassPointer = `${renderCType(nativeClass)} *`;
  const callbackParameters = validParameters.map(
    (parameter, index) =>
      `${parameter.nativeType} parameter_${index.toString().padStart(4, "0")}`,
  );
  const callbackArguments = validParameters.map(
    (_, index) => `parameter_${index.toString().padStart(4, "0")}`,
  );
  const answerType = answersBoolean ? "gboolean" : "void";
  const lines = [
    `typedef ${answerType} (*${callbackType})(${[...callbackParameters, "void *context"].join(", ")});`,
    `typedef struct ${connectionType} {`,
    `  ${signalConnection.nativeType} base;`,
    `  ${callbackType} callback;`,
    "  void *context;",
    `} ${connectionType};`,
    "",
    `static ${answerType} ${dispatchSymbol}(${[`${nativeClassPointer}instance`, ...callbackParameters, "void *opaque"].join(", ")}) {`,
    "  (void)instance;",
    `  ${connectionType} *connection = opaque;`,
    /* Delivery is queued, so an object payload has to survive the emission
     * that produced it. The reference taken here is the one the invocation
     * owns and the runtime gives back.
     *
     * A NULL would be refused downstream anyway — a handle cell cannot be
     * committed over one — but it would be refused as an anonymous runtime
     * trap. GIR promised this payload is present, so the failure says which
     * signal broke that promise. */
    ...validParameters.flatMap((parameter, index) => {
      const slot = `parameter_${index.toString().padStart(4, "0")}`;
      return parameter.retained
        ? [
            `  if (${slot} == NULL) {`,
            `    g_error("${class_.name}::${callable.name} delivered a NULL ` +
              `${parameter.sourceType} payload, which its GIR annotation forbids");`,
            "  }",
            `  g_object_ref(${slot});`,
          ]
        : [];
    }),
    `  ${answersBoolean ? "return " : ""}connection->callback(${[...callbackArguments, "connection->context"].join(", ")});`,
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

function generateNotify(
  namespace: string,
  class_: GirClass,
  propertyName: string,
  signalConnection: GObjectSignalConnectionAdapter,
  diagnostics: CBindgenDiagnostic[],
): {
  readonly adapter: GObjectNotifyAdapter;
  readonly lines: readonly string[];
} | null {
  const path = `${class_.name}/notify/${propertyName}`;
  const nativeClass = physicalType(class_.cType, `${path}/class`, diagnostics);
  if (nativeClass === null || nativeClass.kind !== "named") return null;

  const classPart = class_.cSymbolPrefix;
  const propertyPart = signalSymbolPart(propertyName);
  const typeStem = `NtsGObject${upperCamel(namespace)}${upperCamel(class_.name)}Notify${upperCamel(propertyName)}`;
  const callbackType = `${typeStem}Callback`;
  const connectionType = `${typeStem}Connection`;
  const connectSymbol = `nts_gobject_connect_${namespace}_${classPart}_notify_${propertyPart}`;
  const dispatchSymbol = `nts_gobject_dispatch_${namespace}_${classPart}_notify_${propertyPart}`;
  const nativeClassPointer = `${renderCType(nativeClass)} *`;
  const lines = [
    `typedef void (*${callbackType})(void *context);`,
    `typedef struct ${connectionType} {`,
    `  ${signalConnection.nativeType} base;`,
    `  ${callbackType} callback;`,
    "  void *context;",
    `} ${connectionType};`,
    "",
    `static void ${dispatchSymbol}(${nativeClassPointer}instance, GParamSpec *pspec, void *opaque) {`,
    "  (void)instance;",
    /* The detail on the registration already named the property, so the
     * spec carries nothing this handler could learn from it. Dropping it
     * here is what keeps `GParamSpec` out of the boundary vocabulary. */
    "  (void)pspec;",
    `  ${connectionType} *connection = opaque;`,
    "  connection->callback(connection->context);",
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
    `  connection->base.handler = g_signal_connect(instance, "notify::${propertyName}",`,
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
      id: `${class_.name}.notify.${propertyName}`,
      className: class_.name,
      nativeType: class_.cType,
      propertyName,
      connectSymbol,
      callbackType,
    }),
    lines,
  };
}

/**
 * One argument an adapter forwards untouched.
 *
 * Forwarding is all it does, so what may cross is what already crosses as a
 * plain argument: an exact scalar, a selected enumeration, or a selected
 * object. Shared by every adapter that wraps a call rather than replacing it,
 * so they agree on the answer by construction.
 */
function forwardedInput(
  parameter: GirParameter,
  index: number,
  enumerationCTypes: ReadonlyMap<string, string>,
  classByName: ReadonlyMap<string, GirClass>,
  path: string,
  diagnostics: CBindgenDiagnostic[],
): GObjectValueMethodInputAdapter | null {
    const named = parameter.type.kind === "named" ? parameter.type : null;
    const scalar = sourceScalarType(parameter.type);
    const enumerationCType = named === null
      ? undefined
      : enumerationCTypes.get(named.name);
    const inputClass = named === null ? undefined : classByName.get(named.name);
    const shared = parameter.kind === "parameter" &&
      parameter.direction === "in" &&
      parameter.transferOwnership === "none" &&
      !parameter.nullable &&
      !parameter.optional &&
      !parameter.callerAllocates &&
      !parameter.skip &&
      parameter.scope === null &&
      parameter.closureParameter === null &&
      parameter.destroyParameter === null &&
      named !== null;
    if (shared && scalar !== undefined && named!.cType !== null &&
      scalar.cTypes.includes(named!.cType)) {
      return Object.freeze({
        kind: "scalar" as const,
        parameterName: parameter.name,
        sourceName: scalar.girName,
        nativeType: scalar.girName,
      });
    }
    /* GIR gives an enumeration parameter no c:type of its own often enough
     * that the spelling comes from the enumeration's declaration, exactly as
     * it does for a signal payload. */
    if (shared && enumerationCType !== undefined &&
      (named!.cType === null || named!.cType === enumerationCType)) {
      return Object.freeze({
        kind: "enumeration" as const,
        parameterName: parameter.name,
        sourceName: named!.name,
        nativeType: enumerationCType,
      });
    }
    /* An object input is borrowed for the duration of the call: the adapter
     * forwards the pointer and takes no reference, because the callee does not
     * keep one either. */
    if (shared && inputClass !== undefined &&
      named!.cType === `${inputClass.cType}*`) {
      return Object.freeze({
        kind: "class" as const,
        parameterName: parameter.name,
        sourceName: inputClass.name,
        nativeType: `${inputClass.cType} *`,
      });
    }
    diagnostics.push({
      code: "NTS5001",
      severity: "error",
      path: `${path}/parameters/${index + 1}`,
      message:
        "Value-return adapter inputs must be exact scalars, selected enumerations, or selected classes",
    });
    return null;
}

/** Whether a method's outputs make it a boxed producer rather than a
 * value-return: exactly one output, naming a record that projects as a
 * handle. Its own rule reports why it does not project. */
function boxedProducerShape(
  callable: GirCallable,
  boxedByName: ReadonlyMap<string, GirClass>,
): boolean {
  const outputs = callable.parameters
    .slice(1)
    .filter((parameter) => parameter.direction === "out");
  const [output] = outputs;
  return outputs.length === 1 && output?.type.kind === "named" &&
    boxedByName.has(output.type.name);
}

function generateBoxedResultMethod(
  class_: GirClass,
  callable: GirCallable,
  boxedByName: ReadonlyMap<string, GirClass>,
  enumerationCTypes: ReadonlyMap<string, string>,
  classByName: ReadonlyMap<string, GirClass>,
  diagnostics: CBindgenDiagnostic[],
): {
  readonly adapter: GObjectBoxedResultMethodAdapter;
  readonly lines: readonly string[];
} | null {
  const path = `${class_.name}/${callable.kind}/${callable.name}`;
  const receiver = callable.parameters[0];
  const declared = callable.parameters.slice(1);
  const outputs = declared.filter((parameter) => parameter.direction === "out");
  const inputParameters = declared.filter(
    (parameter) => parameter.direction !== "out",
  );
  const [output] = outputs;
  const boxed = output?.type.kind === "named"
    ? boxedByName.get(output.type.name)
    : undefined;
  if (outputs.length !== 1 || boxed === undefined) return null;
  if (
    callable.cIdentifier === null ||
    callable.throws ||
    receiver?.kind !== "instance" ||
    !isInstancePointer(receiver.type.cType, class_) ||
    callable.result.type.cType !== "void" ||
    !output!.callerAllocates ||
    output!.transferOwnership !== "none" ||
    output!.type.cType !== `${boxed.cType}*` ||
    output!.skip ||
    boxed.boxed === null
  ) {
    diagnostics.push({
      code: "NTS5001",
      severity: "error",
      path,
      message:
        "A boxed record is handed back by a direct non-throwing void instance " +
        "method that fills one caller-allocated output",
    });
    return null;
  }
  const inputs = inputParameters.map((parameter, index) =>
    forwardedInput(
      parameter,
      index,
      enumerationCTypes,
      classByName,
      path,
      diagnostics,
    )
  );
  if (inputs.some((input) => input === null)) return null;
  const validInputs = inputs.filter(
    (input): input is GObjectValueMethodInputAdapter => input !== null,
  );
  const adapterSymbol = `nts_gobject_boxed_${callable.cIdentifier}`;
  const inputByName = new Map(
    validInputs.map((input) => [input.parameterName, input]),
  );
  const callArguments = declared.map((parameter) =>
    inputByName.has(parameter.name) ? parameter.name : "&value"
  );
  const lines = [
    `${boxed.cType} *${adapterSymbol}(${[
      `${class_.cType} *instance`,
      ...validInputs.map((input) => `${input.nativeType} ${input.parameterName}`),
    ].join(", ")}) {`,
    `  ${boxed.cType} value;`,
    "  memset(&value, 0, sizeof value);",
    `  ${callable.cIdentifier}(${["instance", ...callArguments].join(", ")});`,
    `  return ${boxed.boxed.copy.cIdentifier}(&value);`,
    "}",
    "",
  ];
  return {
    adapter: Object.freeze({
      id: `${class_.name}.method.${callable.name}`,
      className: class_.name,
      sourceSymbol: callable.cIdentifier,
      adapterSymbol,
      resultName: boxed.name,
      resultNativeType: boxed.cType,
      inputs: Object.freeze(validInputs),
    }),
    lines: Object.freeze(lines),
  };
}

function generateValueMethod(
  namespace: string,
  class_: GirClass,
  callable: GirCallable,
  recordsByName: ReadonlyMap<string, GirRecord>,
  enumerationCTypes: ReadonlyMap<string, string>,
  classByName: ReadonlyMap<string, GirClass>,
  diagnostics: CBindgenDiagnostic[],
): {
  readonly adapter: GObjectValueMethodAdapter;
  readonly lines: readonly string[];
} | null {
  const path = `${class_.name}/method/${callable.name}`;
  const declared = callable.parameters.slice(1);
  if (declared.every((parameter) => parameter.direction === "in")) return null;
  /* Inputs come first in every GIR signature this projects, but the adapter
   * reconstructs the call from the original order rather than assuming it, so
   * an interleaved signature cannot silently transpose arguments. */
  const inputParameters = declared.filter((parameter) => parameter.direction === "in");
  const outputParameters = declared.filter((parameter) => parameter.direction !== "in");
  const receiver = callable.parameters[0];
  const validReceiver = receiver?.kind === "instance" &&
    receiver.type.kind === "named" &&
    isInstancePointer(receiver.type.cType, class_) &&
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
    /* An output names its scalar by GIR name and spells it as a pointer, so
     * the value-spelling lookup cannot resolve it: `gint` arrives as `int*`. */
    const scalarName = parameter.type.kind === "named" ? parameter.type.name : null;
    const scalar = scalarName === null
      ? undefined
      : sourceScalarTypes.find(({ girName }) => girName === scalarName);
    const shared = parameter.kind === "parameter" &&
      parameter.direction === "out" &&
      !parameter.skip &&
      parameter.scope === null &&
      parameter.closureParameter === null &&
      parameter.destroyParameter === null &&
      parameter.type.kind === "named";
    /* A record output is caller-allocated: the caller owns the storage and the
     * callee fills it. A scalar output is not — GIR says so, and the C is
     * `gint *` rather than a pointer to storage the caller reserved — but the
     * adapter treats both the same way, because a field of the returned struct
     * is caller-allocated storage either way. */
    if (shared && record !== undefined && parameter.callerAllocates) {
      /* The caller owns the storage and the callee writes into it, so nothing
       * is transferred. */
      if (
        parameter.transferOwnership === "none" &&
        parameter.type.cType === `${record.cType}*`
      ) {
        return Object.freeze({
          kind: "record" as const,
          parameterName: parameter.name,
          fieldName: lowerCamel(parameter.name),
          sourceName: record.name,
          nativeType: record.cType,
        });
      }
    } else if (shared && scalar !== undefined && !parameter.callerAllocates) {
      /* A scalar has several accepted C spellings, so the pointee is matched
       * against all of them; the struct field is declared with the GLib
       * typedef the scalar is named for, which is the spelling the probe
       * resolves. */
      const pointee = parameter.type.cType?.endsWith("*") === true
        ? parameter.type.cType.slice(0, -1).trim()
        : null;
      /* GIR writes `full` on a scalar output because the value is copied out,
       * which is the honest annotation and means nothing to release: a gint
       * has no ownership to transfer. Requiring `none` here refused every
       * scalar output GTK declares. */
      if (
        (parameter.transferOwnership === "none" ||
          parameter.transferOwnership === "full") &&
        pointee !== null && scalar.cTypes.includes(pointee)
      ) {
        return Object.freeze({
          kind: "scalar" as const,
          parameterName: parameter.name,
          fieldName: lowerCamel(parameter.name),
          sourceName: scalar.girName,
          nativeType: scalar.girName,
        });
      }
    }
    diagnostics.push({
      code: "NTS5001",
      severity: "error",
      path: `${path}/parameters/${index + 1}`,
      message:
        "Value-return adapter outputs must be caller-allocated records or exact scalars",
    });
    return null;
  });
  const inputs: readonly (GObjectValueMethodInputAdapter | null)[] =
    inputParameters.map((parameter, index) =>
      forwardedInput(
        parameter,
        index,
        enumerationCTypes,
        classByName,
        path,
        diagnostics,
      )
    );
  if (
    callable.cIdentifier === null ||
    callable.throws ||
    !validReceiver ||
    !validResult ||
    outputs.length === 0 ||
    outputs.some((output) => output === null) ||
    inputs.some((input) => input === null)
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
  const validInputs = inputs.filter(
    (input): input is GObjectValueMethodInputAdapter => input !== null,
  );
  const outputByName = new Map(
    validOutputs.map((output) => [output.parameterName, output]),
  );
  /* The wrapped call is rebuilt from the declared order, so an input that
   * follows an output — or sits between two — still lands in the slot the
   * function declared it in. */
  const callArguments = declared.map((parameter) => {
    const output = outputByName.get(parameter.name);
    return output === undefined
      ? parameter.name
      : `&result.${output.fieldName}`;
  });
  const lines = [
    `typedef struct ${resultNativeType} {`,
    ...validOutputs.map((output) => `  ${output.nativeType} ${output.fieldName};`),
    `} ${resultNativeType};`,
    "",
    `${resultNativeType} ${adapterSymbol}(${[
      `${class_.cType} *instance`,
      ...validInputs.map((input) => `${input.nativeType} ${input.parameterName}`),
    ].join(", ")}) {`,
    `  ${resultNativeType} result;`,
    "  memset(&result, 0, sizeof result);",
    `  ${callable.cIdentifier}(${["instance", ...callArguments].join(", ")});`,
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
      inputs: Object.freeze(validInputs),
      outputs: Object.freeze(validOutputs),
    }),
    lines: Object.freeze(lines),
  });
}

/**
 * Wraps a member that reports failure through a GError so the trailing
 * `GError **` never crosses the ABI. The adapter returns the error object, or
 * null on success.
 *
 * The wrapped result is discarded, so only members whose result carries no
 * information beyond success are projected. `gboolean` and `void` qualify;
 * anything else keeps failing precisely rather than silently losing a value.
 */
function generateThrowingMethod(
  class_: GirClass,
  callable: GirCallable,
  diagnostics: CBindgenDiagnostic[],
): {
  readonly adapter: GObjectThrowingMethodAdapter;
  readonly lines: readonly string[];
} | null {
  const path = `${class_.name}/${callable.kind}/${callable.name}`;
  const resultCType = callable.result.type.cType;
  if (resultCType !== "gboolean" && resultCType !== "void") {
    diagnostics.push({
      code: "NTS5001",
      severity: "error",
      path: `${path}/result`,
      message:
        "A GError-reporting member is projected only when its own result is gboolean or void",
    });
    return null;
  }
  if (callable.cIdentifier === null) return null;
  const receiver = callable.parameters[0];
  if (
    receiver?.kind !== "instance" ||
    !isInstancePointer(receiver.type.cType, class_)
  ) {
    diagnostics.push({
      code: "NTS5001",
      severity: "error",
      path: `${path}/receiver`,
      message: "A GError-reporting member needs its own class as the receiver",
    });
    return null;
  }
  const parameters = callable.parameters.slice(1).map((parameter, index) =>
    physicalType(
      parameter.type.cType,
      `${path}/parameters/${index}`,
      diagnostics,
    )
  );
  if (parameters.some((parameter) => parameter === null)) return null;

  const adapterSymbol = `nts_gobject_try_${callable.cIdentifier}`;
  const names = parameters.map(
    (_, index) => `parameter_${index.toString().padStart(4, "0")}`,
  );
  const declarations = parameters.map(
    (parameter, index) => `${renderCType(parameter!)} ${names[index]}`,
  );
  const call =
    `${callable.cIdentifier}(instance` +
    `${names.length > 0 ? `, ${names.join(", ")}` : ""}, &error)`;
  return Object.freeze({
    adapter: Object.freeze({
      id: `${class_.name}.${callable.kind}.${callable.name}`,
      className: class_.name,
      sourceSymbol: callable.cIdentifier,
      adapterSymbol,
    }),
    lines: Object.freeze([
      `void *${adapterSymbol}(${[`${class_.cType} *instance`, ...declarations].join(", ")}) {`,
      "  GError *error = NULL;",
      ...(resultCType === "gboolean"
        ? [`  if (${call}) return NULL;`]
        : [`  ${call};`]),
      "  return error;",
      "}",
      "",
    ]),
  });
}

/**
 * The class a method hands back without a reference, or undefined.
 *
 * Shared with the SCABI projection so both agree on which methods take this
 * path — a class given a destructor nothing names is refused, and a class
 * denied one a projection needs cannot bind.
 */
/**
 * Whether a parameter is the instance this declaration's methods run on.
 *
 * GIR spells a record's non-mutating receiver `const GtkTextIter *` and its
 * mutating one `GtkTextIter *`. Both name the same pointer, and a handle
 * passes the same value either way, so both are the receiver; the constness
 * is a promise the callee makes to itself.
 */
function isInstancePointer(cType: string | null, class_: GirClass): boolean {
  return cType === `${class_.cType}*` ||
    (class_.kind === "record" && cType === `const ${class_.cType}*`);
}

export function borrowedResultClass(
  callable: GirCallable,
  classByName: ReadonlyMap<string, GirClass>,
): GirClass | undefined {
  if (
    callable.throws ||
    callable.cIdentifier === null ||
    callable.result.transferOwnership !== "none" ||
    callable.result.skip ||
    callable.result.scope !== null ||
    callable.result.closureParameter !== null ||
    callable.result.destroyParameter !== null ||
    callable.result.type.kind !== "named"
  ) {
    return undefined;
  }
  const resultClass = classByName.get(callable.result.type.name);
  return resultClass !== undefined &&
      callable.result.type.cType === `${resultClass.cType}*`
    ? resultClass
    : undefined;
}

function generateRetainedResultMethod(
  class_: GirClass,
  callable: GirCallable,
  resultClass: GirClass,
  diagnostics: CBindgenDiagnostic[],
): {
  readonly adapter: GObjectRetainedResultMethodAdapter;
  readonly lines: readonly string[];
} | null {
  const path = `${class_.name}/${callable.kind}/${callable.name}`;
  const receiver = callable.parameters[0];
  if (
    receiver?.kind !== "instance" ||
    !isInstancePointer(receiver.type.cType, class_)
  ) {
    diagnostics.push({
      code: "NTS5001",
      severity: "error",
      path: `${path}/receiver`,
      message:
        "A method returning a borrowed object needs its own class as the receiver",
    });
    return null;
  }
  const parameters = callable.parameters.slice(1).map((parameter, index) =>
    physicalType(parameter.type.cType, `${path}/parameters/${index}`, diagnostics)
  );
  if (parameters.some((parameter) => parameter === null)) return null;
  const names = parameters.map(
    (_, index) => `parameter_${index.toString().padStart(4, "0")}`,
  );
  const declarations = parameters.map(
    (parameter, index) => `${renderCType(parameter!)} ${names[index]}`,
  );
  const adapterSymbol = `nts_gobject_ref_${callable.cIdentifier!}`;
  return Object.freeze({
    adapter: Object.freeze({
      id: `${class_.name}.${callable.kind}.${callable.name}`,
      className: class_.name,
      resultClassName: resultClass.name,
      sourceSymbol: callable.cIdentifier!,
      adapterSymbol,
    }),
    lines: Object.freeze([
      `${resultClass.cType} *${adapterSymbol}(${[`${class_.cType} *instance`, ...declarations].join(", ")}) {`,
      `  ${resultClass.cType} *value = ${callable.cIdentifier}(${["instance", ...names].join(", ")});`,
      "  /* The caller was given no reference, so one is taken here: a managed",
      "   * cell has to outlive whatever the library does next. */",
      "  return value == NULL ? NULL : g_object_ref(value);",
      "}",
      "",
    ]),
  });
}

export function generateGObjectAdapterSource(
  snapshot: GirSnapshot,
  /* The namespaces this one imports. A payload may name an enumeration
   * another namespace owns — `EventControllerKey::key-pressed` carries a
   * `Gdk.ModifierType` — and GIR spells such a reference with no `c:type` of
   * its own, so the spelling has to come from the declaration that owns it. */
  importedSnapshots: readonly GirSnapshot[] = [],
): GObjectAdapterSource {
  const diagnostics: CBindgenDiagnostic[] = [];
  const constructors: GObjectConstructorAdapter[] = [];
  const signals: GObjectSignalAdapter[] = [];
  const notifications: GObjectNotifyAdapter[] = [];
  const valueMethods: GObjectValueMethodAdapter[] = [];
  const boxedResultMethods: GObjectBoxedResultMethodAdapter[] = [];
  /* A `notify::` registration is a signal connection like any other, so it
   * needs the same shared connection type even when no GIR signal is
   * selected. */
  const declaredClasses = [
    ...snapshot.classes,
    ...snapshot.interfaces,
    ...snapshot.boxedRecords,
  ];
  const hasSignals = declaredClasses.some((class_) =>
    class_.signals.length > 0 || class_.notify.length > 0
  );
  /* Only a selected enumeration projects. An unselected one has no members and
   * no proven storage, so a payload naming it is refused like any other
   * unprojectable type. */
  const enumerationCTypes: ReadonlyMap<string, string> = new Map([
    ...snapshot.enumerations.flatMap((enumeration) => [
      [enumeration.name, enumeration.cType] as const,
      /* GIR normally spells a same-namespace reference bare; a
       * self-qualified spelling names the same declaration. */
      [`${snapshot.namespace.name}.${enumeration.name}`, enumeration.cType] as const,
    ]),
    ...importedSnapshots.flatMap((imported) =>
      imported.enumerations.map((enumeration) =>
        [
          `${imported.namespace.name}.${enumeration.name}`,
          enumeration.cType,
        ] as const
      )
    ),
  ]);
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
    "/* Generated by @native-typescript/bindgen-gir. */",
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
  const throwingMethods: GObjectThrowingMethodAdapter[] = [];
  const classReleases: GObjectClassReleaseAdapter[] = [];
  const retainedResultMethods: GObjectRetainedResultMethodAdapter[] = [];
  const hasThrowingMethods = declaredClasses.some((class_) =>
    class_.methods.some((callable) => callable.throws)
  );
  const errorSupport: GObjectErrorSupportAdapter | null = hasThrowingMethods
    ? Object.freeze({
        messageSymbol: `nts_${namespacePart}_error_message`,
        releaseSymbol: `nts_${namespacePart}_error_free`,
      })
    : null;
  if (errorSupport !== null) {
    // One pair per namespace. They take void * because the error object is
    // never a source value: the compiler calls them through the contract.
    lines.push(
      `const char *${errorSupport.messageSymbol}(void *error) {`,
      "  return ((GError *)error)->message;",
      "}",
      "",
      `void ${errorSupport.releaseSymbol}(void *error) {`,
      "  g_error_free((GError *)error);",
      "}",
      "",
    );
  }
  const recordsByName = new Map(snapshot.records.map((record) => [record.name, record]));
  /* Keyed as GIR spells the reference: bare for this namespace's own, and
   * qualified for an imported one, which is how a result naming another
   * namespace's object resolves to the class that describes it. The adapter
   * needs only its C spelling, which is the same fact either way. */
  const classByName = new Map([
    ...declaredClasses.map((class_) => [class_.name, class_] as const),
    ...importedSnapshots.flatMap((imported) =>
      [
        ...imported.classes,
        ...imported.interfaces,
        ...imported.boxedRecords,
      ].map((class_) =>
        [`${imported.namespace.name}.${class_.name}`, class_] as const
      )
    ),
  ]);
  /* Every projected class gets a release. How a GObject is released is a
   * property of the object — one `g_object_unref` ends this program's claim
   * on it, whatever produced the reference — so the handle type names this
   * symbol as its destructor, and a type that names one is never a release
   * nobody named. That is also what lets another package own an object this
   * one declares: it imports the type, and the destructor comes with it. */
  const boxedByName = new Map([
    ...snapshot.boxedRecords.map((record) => [record.name, record] as const),
    ...importedSnapshots.flatMap((imported) =>
      imported.boxedRecords.map((record) =>
        [`${imported.namespace.name}.${record.name}`, record] as const
      )
    ),
  ]);
  const releasedClasses = new Set<string>(
    /* A boxed record is not released by a reference count: its own `free` is
     * the destructor its type names, so there is nothing to generate. */
    declaredClasses
      .filter((class_) => class_.kind !== "record")
      .map((class_) => class_.name),
  );
  for (const class_ of declaredClasses) {
    const classConstructors: GObjectConstructorAdapter[] = [];
    for (const callable of class_.constructors) {
      const generated = generateConstructor(
        namespacePart,
        class_,
        callable,
        diagnostics,
      );
      if (generated === null) continue;
      classConstructors.push(generated.adapter);
      constructors.push(generated.adapter);
      lines.push(...generated.lines);
    }
    if (releasedClasses.has(class_.name)) {
      /* Qualified by namespace: a class name is unique only within one, and
       * Gio.Application and Gtk.Application link into the same executable. */
      const releaseSymbol =
        `nts_gobject_release_${namespacePart}_${class_.cSymbolPrefix}`;
      classReleases.push(Object.freeze({
        className: class_.name,
        releaseSymbol,
      }));
      lines.push(
        `void ${releaseSymbol}(${class_.cType} *value) {`,
        "  if (value != NULL) g_object_unref(value);",
        "}",
        "",
      );
    }
    for (const callable of class_.signals) {
      const generated = generateSignal(
        namespacePart,
        class_,
        callable,
        signalConnection!,
        enumerationCTypes,
        classByName,
        diagnostics,
      );
      if (generated === null) continue;
      signals.push(generated.adapter);
      lines.push(...generated.lines);
    }
    for (const propertyName of class_.notify) {
      const generated = generateNotify(
        namespacePart,
        class_,
        propertyName,
        signalConnection!,
        diagnostics,
      );
      if (generated === null) continue;
      notifications.push(generated.adapter);
      lines.push(...generated.lines);
    }
    for (const callable of class_.methods) {
      if (callable.throws) {
        const generated = generateThrowingMethod(class_, callable, diagnostics);
        if (generated === null) continue;
        throwingMethods.push(generated.adapter);
        lines.push(...generated.lines);
        continue;
      }
      const resultClass = borrowedResultClass(callable, classByName);
      if (resultClass !== undefined) {
        const referenced = generateRetainedResultMethod(
          class_,
          callable,
          resultClass,
          diagnostics,
        );
        if (referenced === null) continue;
        retainedResultMethods.push(referenced.adapter);
        lines.push(...referenced.lines);
        continue;
      }
      /* A caller-allocated output whose type is a boxed record is the one
       * output the value-return shape cannot carry: its contents are not
       * readable, so it leaves as an owned pointer rather than as a field. */
      const boxedResult = generateBoxedResultMethod(
        class_,
        callable,
        boxedByName,
        enumerationCTypes,
        classByName,
        diagnostics,
      );
      if (boxedResult !== null) {
        boxedResultMethods.push(boxedResult.adapter);
        lines.push(...boxedResult.lines);
        continue;
      }
      if (boxedProducerShape(callable, boxedByName)) continue;
      const generated = generateValueMethod(
        snapshot.namespace.name,
        class_,
        callable,
        recordsByName,
        enumerationCTypes,
        classByName,
        diagnostics,
      );
      if (generated === null) continue;
      valueMethods.push(generated.adapter);
      lines.push(...generated.lines);
    }
  }
  /* An empty adapter is not a mistake and never was a reliable sign of one.
   * Every member that fails to project reports itself, and a member that
   * needs no wrapper — a direct call, or a boxed record whose free is already
   * a destructor — produces nothing here because that is what it should
   * produce. */
  if (diagnostics.length > 0) throw new CBindgenError(diagnostics);

  const source = lines.join("\n");
  return Object.freeze({
    schema: "native-typescript.gobject-adapter-source",
    schemaVersion: 10,
    source,
    sourceDigest: `sha256:${createHash("sha256").update(source).digest("hex")}`,
    constructors: Object.freeze(constructors),
    signalConnection,
    signals: Object.freeze(signals),
    notifications: Object.freeze(notifications),
    valueMethods: Object.freeze(valueMethods),
    boxedResultMethods: Object.freeze(boxedResultMethods),
    errorSupport,
    classReleases: Object.freeze(classReleases),
    retainedResultMethods: Object.freeze(retainedResultMethods),
    throwingMethods: Object.freeze(throwingMethods),
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
      /* The adapter wraps whatever the application selected, including members
       * the library has deprecated. Their deprecation is carried to the
       * caller in the generated declaration; refusing to compile the wrapper
       * would refuse the binding itself, and for a reason that says nothing
       * about whether the call works. */
      { kind: "literal", value: "-Wno-deprecated-declarations" },
      ...input.arguments,
    ],
    tool: input.tool,
    executionPlatform: input.executionPlatform,
    target: input.target,
    deterministic: true,
    cacheable: true,
  });
  return Object.freeze({
    source,
    object: compilation.artifact,
    action: compilation.action,
  });
}
