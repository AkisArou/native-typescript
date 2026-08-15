import { isDeepStrictEqual } from "node:util";
import type {
  AdapterInput,
  AbiParameter,
  AbiResult,
  CallableBinding,
  DeclarationReference,
  LinkInput,
  NativeTypeId,
  NativeType,
  ScabiManifest,
} from "@native-typescript/scabi";

export interface ScriptCNativeDeclaration {
  readonly module: string;
  readonly name: string;
}

export type ScriptCNativeIntegerScalar =
  | "i8"
  | "u8"
  | "i16"
  | "u16"
  | "i32"
  | "u32"
  | "i64"
  | "u64"
  | "isize"
  | "usize";

export type ScriptCNativeScalar = ScriptCNativeIntegerScalar | "f64";

export type ScriptCNativeValueType =
  | {
      readonly kind: "nativeScalar";
      readonly scalar: ScriptCNativeScalar;
    }
  | {
      readonly kind: "nativeStruct";
      readonly typeId: string;
    }
  | {
      readonly kind: "nativeHandle";
      readonly typeId: string;
    };

export interface ScriptCNativePointerType {
  readonly kind: "nativePointer";
  readonly pointee: "i8" | "u8";
  readonly const: boolean;
  readonly addressSpace: 0;
}

export interface ScriptCNativeCallbackSignature {
  readonly callingConvention: "c";
  readonly parameters: readonly {
    readonly kind: "nativeScalar";
    readonly scalar: ScriptCNativeScalar;
  }[];
  readonly result:
    | { readonly kind: "nativeScalar"; readonly scalar: ScriptCNativeScalar }
    | { readonly kind: "void" };
  readonly context: { readonly placement: "last" };
}

export interface ScriptCNativeCallbackType {
  readonly kind: "nativeCallback";
  readonly signature: ScriptCNativeCallbackSignature;
}

export interface ScriptCNativeContextType {
  readonly kind: "nativeContext";
  readonly addressSpace: 0;
}

export type ScriptCNativeCallbackArgumentType = {
  readonly kind: "func";
  readonly params: ScriptCNativeCallbackSignature["parameters"];
  readonly ret: ScriptCNativeCallbackSignature["result"];
};

export type ScriptCNativeCallbackContract =
  | {
      readonly lifetime: "call";
      readonly registrationOwner: { readonly kind: "native-call" };
      readonly allowedInvocationExecutors: readonly ["same-as-caller"];
      readonly deliveryExecutor: "same-as-caller";
      readonly synchronousReturn: true;
      readonly transports: readonly { readonly kind: "borrow" }[];
      readonly reentrancy: "required";
      readonly postDisposal: "not-invoked";
      readonly shutdown: "drain";
    }
  | {
      readonly lifetime: "until-cancelled";
      readonly registrationOwner: { readonly kind: "result" };
      readonly cancellationBinding: string;
      readonly allowedInvocationExecutors: readonly (
        | "same-as-caller"
        | "any-attached-thread"
      )[];
      readonly deliveryExecutor: "runtime-owner";
      readonly synchronousReturn: false;
      readonly transports: readonly { readonly kind: "copy" }[];
      readonly reentrancy: "allowed" | "required";
      readonly postDisposal: "not-invoked";
      readonly shutdown: "drain";
    };

export type ScriptCNativeAbiType =
  | ScriptCNativeValueType
  | ScriptCNativePointerType
  | ScriptCNativeCallbackType
  | ScriptCNativeContextType;
export type ScriptCNativeArgumentType =
  | ScriptCNativeValueType
  | { readonly kind: "string" }
  | { readonly kind: "bytes"; readonly elem: "u8" }
  | ScriptCNativeCallbackArgumentType;
export type ScriptCNativeParameterProjection =
  | { readonly kind: "argument"; readonly argument: number }
  | { readonly kind: "utf8CString"; readonly argument: number }
  | { readonly kind: "utf8Data"; readonly argument: number }
  | { readonly kind: "utf8ByteLength"; readonly argument: number }
  | { readonly kind: "bytesData"; readonly argument: number }
  | { readonly kind: "bytesByteLength"; readonly argument: number }
  | { readonly kind: "callbackFunction"; readonly argument: number }
  | { readonly kind: "callbackContext"; readonly argument: number };

export type ScriptCNativeResultProjection =
  | { readonly kind: "direct" }
  | { readonly kind: "utf8CString"; readonly nullable: boolean };

export type ScriptCNativeIrType =
  | ScriptCNativeValueType
  | { readonly kind: "void" };

export type ScriptCNativeResultAbiType =
  | ScriptCNativeValueType
  | ScriptCNativePointerType
  | { readonly kind: "void" };

export type ScriptCNativeErrorContract =
  | { readonly kind: "no-fail" }
  | { readonly kind: "errno"; readonly failureValue: string }
  | { readonly kind: "nullable" };

export interface ScriptCNativeSourceType {
  readonly declaration: ScriptCNativeDeclaration;
  readonly type: ScriptCNativeValueType;
}

export interface ScriptCNativeStructDefinition {
  readonly kind: "struct";
  readonly id: string;
  readonly declaration: ScriptCNativeDeclaration;
  readonly size: number;
  readonly alignment: number;
  readonly packing: "default";
  readonly triviallyCopyable: true;
  readonly destruction: "trivial";
  readonly abi: {
    readonly kind: "indirect";
    readonly alignment: number;
  };
  readonly fields: readonly {
    readonly name: string;
    readonly type: { readonly kind: "nativeScalar"; readonly scalar: ScriptCNativeScalar };
    readonly offset: number;
  }[];
}

export interface ScriptCNativeHandleDefinition {
  readonly kind: "handle";
  readonly id: string;
  readonly declaration: ScriptCNativeDeclaration;
  readonly nativeName: string;
  /** Safety of the foreign resource. The managed handle cell remains owned
   * by the ScriptC runtime thread even when native code shares the resource. */
  readonly threadSafety: "confined" | "shared";
  readonly identity: "none" | "pointer" | "binding" | "platform";
  readonly upcasts: readonly {
    readonly kind: "identity";
    readonly target: string;
  }[];
}

export type ScriptCNativeTypeDefinition =
  | ScriptCNativeStructDefinition
  | ScriptCNativeHandleDefinition;

export interface ScriptCNativeBinding {
  readonly id: string;
  readonly declaration: ScriptCNativeDeclaration;
  readonly entry: { readonly kind: "c-symbol"; readonly symbol: string };
  readonly callingConvention: "c";
  readonly variadic: false;
  readonly sourceCall:
    | { readonly kind: "function" }
    | { readonly kind: "method"; readonly receiverArgument: number };
  /** Failure detection is explicit Native IR data. Backends must snapshot
   * errno immediately after observing the exact failure sentinel. */
  readonly error: ScriptCNativeErrorContract;
  readonly arguments: readonly {
    readonly name: string;
    readonly type: ScriptCNativeArgumentType;
    readonly callback?: ScriptCNativeCallbackContract;
  }[];
  readonly parameters: readonly {
    readonly name: string;
    readonly type: ScriptCNativeAbiType;
    readonly passMode: "value" | "pointer";
    readonly ownership:
      | { readonly kind: "value" }
      | { readonly kind: "borrowed"; readonly scope: "call" }
      | { readonly kind: "owned"; readonly transfer: "to-native" }
      | {
          readonly kind: "callback";
          readonly lifetime: "call" | "until-cancelled";
        };
    readonly projection: ScriptCNativeParameterProjection;
  }[];
  readonly result: {
    readonly type: ScriptCNativeResultAbiType;
    readonly passMode: "value" | "pointer";
    readonly ownership:
      | { readonly kind: "value" }
      | {
          readonly kind: "borrowed";
          readonly scope: "receiver";
          readonly anchor: string;
        }
      | {
          readonly kind: "owned";
          readonly transfer: "to-runtime";
          readonly destructor: string;
        };
    readonly projection: ScriptCNativeResultProjection;
  };
}

export interface ScriptCNativeExport {
  readonly id: string;
  readonly sourceExport: string;
  readonly declaration: ScriptCNativeDeclaration;
  readonly entry: { readonly kind: "c-symbol"; readonly symbol: string };
  readonly callingConvention: "c";
  readonly variadic: false;
  readonly error: { readonly kind: "no-fail" };
  readonly parameters: readonly {
    readonly name: string;
    readonly type: ScriptCNativeValueType;
    readonly passMode: "value";
    readonly ownership: { readonly kind: "value" };
  }[];
  readonly result: {
    readonly type: ScriptCNativeIrType;
    readonly passMode: "value";
    readonly ownership: { readonly kind: "value" };
  };
}

/** The application-level roots for one compiler invocation. Imports are
 * reached native declarations called by TypeScript. Exports pair one SCABI
 * ABI contract with the entry-module function that implements it. */
export interface ScriptCNativeProgramSelection {
  readonly imports: readonly string[];
  readonly exports: readonly {
    readonly bindingId: string;
    readonly sourceExport: string;
  }[];
}

/** Generic input consumed by the ScriptC frontend. It contains no SCABI
 * concepts: source identities prove checker types, target ABI facts resolve
 * generic target-sized types, and the binding table is the exact Native IR
 * contract emitted after reachability. */
export interface ScriptCNativeFrontendInput {
  readonly target: {
    readonly pointerBits: 32 | 64;
    readonly abi: string;
  };
  readonly sourceTypes: readonly ScriptCNativeSourceType[];
  readonly types: readonly ScriptCNativeTypeDefinition[];
  readonly bindings: readonly ScriptCNativeBinding[];
  readonly exports: readonly ScriptCNativeExport[];
}

export interface ScriptCNativeTranslationDiagnostic {
  readonly code: "NTS3001" | "NTS3002" | "NTS3003";
  readonly severity: "error";
  readonly path: string;
  readonly message: string;
}

export interface ScriptCNativeBuildRequirements {
  readonly linkInputs: readonly LinkInput[];
  readonly adapterInputs: readonly AdapterInput[];
}

export interface ScriptCNativeTranslationSuccess {
  readonly ok: true;
  readonly input: ScriptCNativeFrontendInput;
  readonly build: ScriptCNativeBuildRequirements;
}

export type ScriptCNativeTranslationResult =
  | ScriptCNativeTranslationSuccess
  | {
      readonly ok: false;
      readonly diagnostics: readonly ScriptCNativeTranslationDiagnostic[];
    };

function diagnostic(
  code: ScriptCNativeTranslationDiagnostic["code"],
  path: string,
  message: string,
): ScriptCNativeTranslationDiagnostic {
  return Object.freeze({ code, severity: "error", path, message });
}

function declarationKey(declaration: ScriptCNativeDeclaration): string {
  return `${declaration.module}\u0000${declaration.name}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Compose independently translated packages into one canonical compiler
 * input. Package boundaries remain visible in every nominal id; only exact
 * duplicates are coalesced. Conflicting source identities, native ids, or
 * export roots fail here instead of depending on frontend map insertion
 * order. Build requirements travel with the same composition operation. */
export function composeScriptCNativePrograms(
  programs: readonly [
    ScriptCNativeTranslationSuccess,
    ...ScriptCNativeTranslationSuccess[],
  ],
): ScriptCNativeTranslationResult {
  const diagnostics: ScriptCNativeTranslationDiagnostic[] = [];
  const target = Object.freeze({ ...programs[0].input.target });
  const sourceTypes = new Map<string, ScriptCNativeSourceType>();
  const types = new Map<string, ScriptCNativeTypeDefinition>();
  const bindings = new Map<string, ScriptCNativeBinding>();
  const bindingsByDeclaration = new Map<string, ScriptCNativeBinding>();
  const exports = new Map<string, ScriptCNativeExport>();
  const exportsBySource = new Map<string, ScriptCNativeExport>();
  const linkInputs = new Map<string, LinkInput>();
  const linkInputEdges = new Map<string, Set<string>>();
  const adapterInputs = new Map<string, AdapterInput>();

  const addExact = <Value>(
    entries: Map<string, Value>,
    key: string,
    value: Value,
    path: string,
    identity: string,
  ): void => {
    const existing = entries.get(key);
    if (existing === undefined) {
      entries.set(key, value);
    } else if (!isDeepStrictEqual(existing, value)) {
      diagnostics.push(diagnostic(
        "NTS3002",
        path,
        `Native program ${identity} '${key.replaceAll("\u0000", "::")}' conflicts with another package`,
      ));
    }
  };

  programs.forEach((program, programIndex) => {
    const prefix = `/programs/${programIndex}`;
    if (
      program.input.target.pointerBits !== target.pointerBits ||
      program.input.target.abi !== target.abi
    ) {
      diagnostics.push(diagnostic(
        "NTS3002",
        `${prefix}/input/target`,
        `Native program target ${program.input.target.pointerBits}/${program.input.target.abi} ` +
          `does not match ${target.pointerBits}/${target.abi}`,
      ));
    }
    program.input.sourceTypes.forEach((sourceType, index) => {
      addExact(
        sourceTypes,
        declarationKey(sourceType.declaration),
        sourceType,
        `${prefix}/input/sourceTypes/${index}`,
        "source declaration",
      );
    });
    program.input.types.forEach((type, index) => {
      addExact(types, type.id, type, `${prefix}/input/types/${index}`, "type id");
    });
    program.input.bindings.forEach((binding, index) => {
      const path = `${prefix}/input/bindings/${index}`;
      addExact(bindings, binding.id, binding, path, "binding id");
      addExact(
        bindingsByDeclaration,
        declarationKey(binding.declaration),
        binding,
        path,
        "binding declaration",
      );
    });
    program.input.exports.forEach((nativeExport, index) => {
      const path = `${prefix}/input/exports/${index}`;
      addExact(exports, nativeExport.id, nativeExport, path, "export id");
      addExact(
        exportsBySource,
        nativeExport.sourceExport,
        nativeExport,
        path,
        "source export",
      );
    });
    program.build.linkInputs.forEach((input, index) => {
      const existing = linkInputs.get(input.id);
      if (existing === undefined) {
        linkInputs.set(input.id, input);
        linkInputEdges.set(input.id, new Set());
      } else if (existing.kind !== input.kind || existing.name !== input.name) {
        diagnostics.push(diagnostic(
          "NTS3002",
          `${prefix}/build/linkInputs/${index}`,
          `Native program link input id '${input.id}' conflicts with another package`,
        ));
      }
    });
    for (const before of program.build.linkInputs) {
      for (const after of program.build.linkInputs) {
        if (before.order < after.order && before.id !== after.id) {
          linkInputEdges.get(before.id)?.add(after.id);
        }
      }
    }
    program.build.adapterInputs.forEach((input, index) => {
      addExact(
        adapterInputs,
        input.id,
        input,
        `${prefix}/build/adapterInputs/${index}`,
        "adapter input id",
      );
    });
  });

  const indegree = new Map([...linkInputs.keys()].map((id) => [id, 0]));
  for (const afterIds of linkInputEdges.values()) {
    for (const id of afterIds) indegree.set(id, (indegree.get(id) ?? 0) + 1);
  }
  const ready = [...indegree]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort(compareText);
  const orderedLinkInputs: LinkInput[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    const input = linkInputs.get(id)!;
    orderedLinkInputs.push(Object.freeze({
      ...input,
      order: orderedLinkInputs.length,
    }));
    for (const afterId of linkInputEdges.get(id) ?? []) {
      const remaining = (indegree.get(afterId) ?? 0) - 1;
      indegree.set(afterId, remaining);
      if (remaining === 0) {
        ready.push(afterId);
        ready.sort(compareText);
      }
    }
  }
  if (orderedLinkInputs.length !== linkInputs.size) {
    const cyclic = [...indegree]
      .filter(([, count]) => count > 0)
      .map(([id]) => id)
      .sort(compareText);
    diagnostics.push(diagnostic(
      "NTS3002",
      "/build/linkInputs",
      `Native program link input ordering constraints form a cycle: ${cyclic.join(", ")}`,
    ));
  }
  if (diagnostics.length > 0) {
    return Object.freeze({ ok: false, diagnostics: Object.freeze(diagnostics) });
  }
  const byDeclaration = <Value extends { readonly declaration: ScriptCNativeDeclaration }>(
    left: Value,
    right: Value,
  ): number => compareText(declarationKey(left.declaration), declarationKey(right.declaration));
  return Object.freeze({
    ok: true,
    input: Object.freeze({
      target,
      sourceTypes: Object.freeze([...sourceTypes.values()].sort(byDeclaration)),
      types: Object.freeze([...types.values()].sort((left, right) => compareText(left.id, right.id))),
      bindings: Object.freeze([...bindings.values()].sort((left, right) => compareText(left.id, right.id))),
      exports: Object.freeze([...exports.values()].sort((left, right) =>
        compareText(left.id, right.id) || compareText(left.sourceExport, right.sourceExport)
      )),
    }),
    build: Object.freeze({
      linkInputs: Object.freeze(orderedLinkInputs),
      adapterInputs: Object.freeze([...adapterInputs.values()].sort((left, right) =>
        compareText(left.id, right.id)
      )),
    }),
  });
}

function normalizeDeclaration(
  manifest: ScabiManifest,
  declaration: DeclarationReference,
): ScriptCNativeDeclaration {
  const module =
    declaration.module === "."
      ? manifest.package.name
      : declaration.module.startsWith("./")
        ? `${manifest.package.name}/${declaration.module.slice(2)}`
        : declaration.module;
  return Object.freeze({ module, name: declaration.name });
}

function positionUnsupported(
  position: AbiResult,
  isParameter: boolean,
  type: NativeType | undefined,
  allowNullable = false,
): string | null {
  const handle = type?.kind === "handle";
  if (position.passMode !== (handle ? "pointer" : "value")) {
    return `pass mode '${position.passMode}'`;
  }
  const nonNullManagedHandleArgument =
    handle &&
    isParameter &&
    position.ownership.kind === "owned" &&
    position.ownership.transfer === "to-native";
  if (position.nullable && !allowNullable && !nonNullManagedHandleArgument) {
    return "nullable values";
  }
  const validOwnership = handle
    ? isParameter
      ? (position.ownership.kind === "borrowed" && position.ownership.scope === "call") ||
        (position.ownership.kind === "owned" && position.ownership.transfer === "to-native")
      : position.ownership.kind === "owned" && position.ownership.transfer === "to-runtime"
    : position.ownership.kind === "value";
  if (!validOwnership) {
    return `ownership '${position.ownership.kind}'`;
  }
  if (position.marshal !== undefined) return `marshalling '${position.marshal.kind}'`;
  if (isParameter && (position as AbiParameter).callback !== undefined) {
    return "callback parameters";
  }
  return null;
}

type BorrowedDataParameterPair = {
  readonly kind: "utf8" | "bytes";
  readonly lengthIndex: number;
  readonly pointee: "i8" | "u8";
} | {
  readonly kind: "utf8-c-string";
  readonly pointee: "i8" | "u8";
};

type BorrowedStringResult = {
  readonly pointee: "i8" | "u8";
  readonly nullable: boolean;
  readonly anchor: string;
};

function supportedBorrowedStringResult(
  manifest: ScabiManifest,
  binding: CallableBinding,
): BorrowedStringResult | string {
  const result = binding.signature.result;
  const marshal = result.marshal;
  const pointer = manifest.types[result.type];
  const pointee = pointer?.kind === "pointer"
    ? manifest.types[pointer.pointee]
    : undefined;
  if (
    marshal?.kind !== "string" ||
    marshal.encoding !== "utf-8" ||
    marshal.length.kind !== "nul" ||
    marshal.termination !== "nul" ||
    marshal.embeddedNul !== "reject"
  ) {
    return "only borrowed NUL-terminated UTF-8 string results are supported";
  }
  if (
    result.passMode !== "pointer" ||
    result.ownership.kind !== "borrowed" ||
    result.ownership.scope !== "receiver" ||
    result.ownership.anchor === undefined ||
    pointer?.kind !== "pointer" ||
    pointer.mutability !== "const" ||
    pointer.nullable !== result.nullable ||
    pointer.addressSpace !== 0 ||
    pointee?.kind !== "integer" ||
    pointee.bits !== 8
  ) {
    return "UTF-8 results must be const i8/u8 pointers borrowed from a named receiver with matching nullability";
  }
  const anchorName = result.ownership.anchor;
  const anchor = binding.signature.parameters.find(
    (parameter) => parameter.name === anchorName,
  );
  if (
    binding.kind !== "method" ||
    binding.signature.parameters[0]?.name !== anchorName ||
    anchor === undefined ||
    manifest.types[anchor.type]?.kind !== "handle" ||
    anchor.passMode !== "pointer" ||
    anchor.nullable ||
    anchor.ownership.kind !== "borrowed" ||
    anchor.ownership.scope !== "call"
  ) {
    return `UTF-8 result anchor '${anchorName}' must name the borrowed handle receiver`;
  }
  if (binding.error.kind !== "no-fail") {
    return "borrowed UTF-8 results require a no-fail contract; nullability is a source value";
  }
  return {
    pointee: pointee.signed ? "i8" : "u8",
    nullable: result.nullable,
    anchor: anchorName,
  };
}

type SupportedCallbackPair = {
  readonly functionIndex: number;
  readonly contextIndex: number;
  readonly parameterTypeIds: readonly NativeTypeId[];
  readonly resultTypeId: NativeTypeId;
  readonly contract: ScriptCNativeCallbackContract;
};

function supportedCallScopedCallbackPair(
  manifest: ScabiManifest,
  binding: CallableBinding,
  callbackIndex: number,
): SupportedCallbackPair | string {
  const parameter = binding.signature.parameters[callbackIndex]!;
  const contract = parameter.callback;
  const callbackType = manifest.types[parameter.type];
  if (
    contract === undefined ||
    parameter.passMode !== "pointer" ||
    parameter.nullable ||
    parameter.ownership.kind !== "call-scoped" ||
    parameter.marshal !== undefined ||
    callbackType?.kind !== "callback"
  ) {
    return "callback data must be a non-null call-scoped C callback pointer";
  }
  if (
    contract.lifetime !== "call" ||
    contract.registrationOwner !== "native-call" ||
    contract.cancellationBinding !== undefined ||
    contract.contextParameter === undefined ||
    contract.allowedInvocationExecutors.length !== 1 ||
    contract.allowedInvocationExecutors[0]?.kind !== "same-as-caller" ||
    contract.deliveryExecutor.kind !== "same-as-caller" ||
    !contract.synchronousReturn ||
    contract.reentrancy !== "required" ||
    contract.postDisposal !== "not-invoked" ||
    contract.shutdown !== "drain"
  ) {
    return "only synchronous, reentrant, same-caller call-lifetime callbacks are supported";
  }
  if (
    callbackType.signature.callingConvention !== "c" ||
    callbackType.signature.variadic ||
    callbackType.context.placement !== "last" ||
    callbackType.context.type === undefined
  ) {
    return "callback ABI must be non-variadic C with one trailing typed context pointer";
  }
  const contextIndex = binding.signature.parameters.findIndex(
    (candidate) => candidate.name === contract.contextParameter,
  );
  const context = binding.signature.parameters[contextIndex];
  const contextType = context === undefined ? undefined : manifest.types[context.type];
  const contextPointee = contextType?.kind === "pointer"
    ? manifest.types[contextType.pointee]
    : undefined;
  if (
    contextIndex < 0 ||
    contextIndex === callbackIndex ||
    context === undefined ||
    context.type !== callbackType.context.type ||
    context.passMode !== "pointer" ||
    context.nullable ||
    context.ownership.kind !== "call-scoped" ||
    context.marshal !== undefined ||
    context.callback !== undefined ||
    contextType?.kind !== "pointer" ||
    contextType.addressSpace !== 0 ||
    contextPointee?.kind !== "void"
  ) {
    return `callback context '${contract.contextParameter}' must name a non-null call-scoped address-space-zero void pointer`;
  }
  const supportedScalarPosition = (position: AbiParameter | AbiResult): boolean => {
    const type = manifest.types[position.type];
    return position.passMode === "value" &&
      !position.nullable &&
      position.ownership.kind === "value" &&
      position.marshal === undefined &&
      (!("callback" in position) || position.callback === undefined) &&
      (type?.kind === "integer" || (type?.kind === "float" && type.bits === 64));
  };
  if (
    callbackType.signature.parameters.some((position) => !supportedScalarPosition(position)) ||
    !(manifest.types[callbackType.signature.result.type]?.kind === "void" ||
      supportedScalarPosition(callbackType.signature.result))
  ) {
    return "callback parameters and result must use non-null exact scalar value semantics";
  }
  if (
    contract.arguments.length !== callbackType.signature.parameters.length ||
    contract.arguments.some((argument, index) =>
      argument.parameter !== callbackType.signature.parameters[index]?.name ||
      argument.transport !== "borrow"
    )
  ) {
    return "callback argument transport must borrow every callback parameter in ABI order";
  }
  return {
    functionIndex: callbackIndex,
    contextIndex,
    parameterTypeIds: callbackType.signature.parameters.map((position) => position.type),
    resultTypeId: callbackType.signature.result.type,
    contract: Object.freeze({
      lifetime: "call",
      registrationOwner: Object.freeze({ kind: "native-call" }),
      allowedInvocationExecutors: Object.freeze(["same-as-caller"] as const),
      deliveryExecutor: "same-as-caller",
      synchronousReturn: true,
      transports: Object.freeze(
        contract.arguments.map(() => Object.freeze({ kind: "borrow" } as const)),
      ),
      reentrancy: "required",
      postDisposal: "not-invoked",
      shutdown: "drain",
    }),
  };
}

function supportedRetainedCallbackPair(
  manifest: ScabiManifest,
  binding: CallableBinding,
  callbackIndex: number,
): SupportedCallbackPair | string {
  const parameter = binding.signature.parameters[callbackIndex]!;
  const contract = parameter.callback;
  const callbackType = manifest.types[parameter.type];
  if (
    contract === undefined ||
    parameter.passMode !== "pointer" ||
    parameter.nullable ||
    parameter.ownership.kind !== "borrowed" ||
    parameter.ownership.scope !== "registration" ||
    parameter.ownership.anchor !== "result" ||
    parameter.marshal !== undefined ||
    callbackType?.kind !== "callback"
  ) {
    return "retained callback data must be a non-null registration-borrowed C callback pointer anchored to the result";
  }
  const allowedInvocationExecutors = contract.allowedInvocationExecutors.map(
    (executor) => executor.kind,
  );
  if (
    contract.lifetime !== "until-cancelled" ||
    contract.registrationOwner !== "result" ||
    contract.cancellationBinding === undefined ||
    contract.contextParameter === undefined ||
    allowedInvocationExecutors.length === 0 ||
    allowedInvocationExecutors.some(
      (executor) => executor !== "same-as-caller" && executor !== "any-attached-thread",
    ) ||
    new Set(allowedInvocationExecutors).size !== allowedInvocationExecutors.length ||
    contract.deliveryExecutor.kind !== "runtime-owner" ||
    contract.synchronousReturn ||
    (contract.reentrancy !== "allowed" && contract.reentrancy !== "required") ||
    contract.postDisposal !== "not-invoked" ||
    contract.shutdown !== "drain"
  ) {
    return "only until-cancelled callbacks copied onto the runtime owner with explicit result-owned cancellation are supported";
  }
  if (
    callbackType.signature.callingConvention !== "c" ||
    callbackType.signature.variadic ||
    callbackType.context.placement !== "last" ||
    callbackType.context.type === undefined
  ) {
    return "callback ABI must be non-variadic C with one trailing typed context pointer";
  }
  const contextIndex = binding.signature.parameters.findIndex(
    (candidate) => candidate.name === contract.contextParameter,
  );
  const context = binding.signature.parameters[contextIndex];
  const contextType = context === undefined ? undefined : manifest.types[context.type];
  const contextPointee = contextType?.kind === "pointer"
    ? manifest.types[contextType.pointee]
    : undefined;
  if (
    contextIndex < 0 ||
    contextIndex === callbackIndex ||
    context === undefined ||
    context.type !== callbackType.context.type ||
    context.passMode !== "pointer" ||
    context.nullable ||
    context.ownership.kind !== "borrowed" ||
    context.ownership.scope !== "registration" ||
    context.ownership.anchor !== parameter.name ||
    context.marshal !== undefined ||
    context.callback !== undefined ||
    contextType?.kind !== "pointer" ||
    contextType.addressSpace !== 0 ||
    contextPointee?.kind !== "void"
  ) {
    return `callback context '${contract.contextParameter}' must name a non-null registration-borrowed address-space-zero void pointer anchored to '${parameter.name}'`;
  }
  const supportedScalarPosition = (position: AbiParameter | AbiResult): boolean => {
    const type = manifest.types[position.type];
    return position.passMode === "value" &&
      !position.nullable &&
      position.ownership.kind === "value" &&
      position.marshal === undefined &&
      (!("callback" in position) || position.callback === undefined) &&
      (type?.kind === "integer" || (type?.kind === "float" && type.bits === 64));
  };
  if (
    callbackType.signature.parameters.some((position) => !supportedScalarPosition(position)) ||
    manifest.types[callbackType.signature.result.type]?.kind !== "void"
  ) {
    return "retained callback parameters must be exact scalar values and its result must be void";
  }
  if (
    contract.arguments.length !== callbackType.signature.parameters.length ||
    contract.arguments.some((argument, index) =>
      argument.parameter !== callbackType.signature.parameters[index]?.name ||
      argument.transport !== "copy"
    )
  ) {
    return "retained callback transport must copy every callback parameter in ABI order";
  }
  const result = binding.signature.result;
  if (
    manifest.types[result.type]?.kind !== "handle" ||
    result.passMode !== "pointer" ||
    !result.nullable ||
    result.ownership.kind !== "owned" ||
    result.ownership.transfer !== "to-runtime" ||
    result.ownership.destructor !== contract.cancellationBinding ||
    !binding.dependencies.bindings.includes(contract.cancellationBinding)
  ) {
    return `retained callback registration must return a nullable owned handle cancelled by declared dependency '${contract.cancellationBinding}'`;
  }
  return {
    functionIndex: callbackIndex,
    contextIndex,
    parameterTypeIds: callbackType.signature.parameters.map((position) => position.type),
    resultTypeId: callbackType.signature.result.type,
    contract: Object.freeze({
      lifetime: "until-cancelled",
      registrationOwner: Object.freeze({ kind: "result" }),
      cancellationBinding: `${manifest.package.instance}#${contract.cancellationBinding}`,
      allowedInvocationExecutors: Object.freeze(
        allowedInvocationExecutors as ("same-as-caller" | "any-attached-thread")[],
      ),
      deliveryExecutor: "runtime-owner",
      synchronousReturn: false,
      transports: Object.freeze(
        contract.arguments.map(() => Object.freeze({ kind: "copy" } as const)),
      ),
      reentrancy: contract.reentrancy,
      postDisposal: "not-invoked",
      shutdown: "drain",
    }),
  };
}

function supportedCallbackPair(
  manifest: ScabiManifest,
  binding: CallableBinding,
  callbackIndex: number,
): SupportedCallbackPair | string {
  const lifetime = binding.signature.parameters[callbackIndex]?.callback?.lifetime;
  return lifetime === "call"
    ? supportedCallScopedCallbackPair(manifest, binding, callbackIndex)
    : lifetime === "until-cancelled"
      ? supportedRetainedCallbackPair(manifest, binding, callbackIndex)
      : `callback lifetime '${lifetime ?? "missing"}' is outside the implemented call and until-cancelled slice`;
}

function supportedBorrowedDataPair(
  manifest: ScabiManifest,
  binding: CallableBinding,
  dataIndex: number,
): BorrowedDataParameterPair | string {
  const data = binding.signature.parameters[dataIndex]!;
  const marshal = data.marshal;
  if (marshal?.kind === "string") {
    if (
      marshal.encoding === "utf-8" &&
      marshal.termination === "nul" &&
      marshal.embeddedNul === "reject" &&
      marshal.length.kind === "nul"
    ) {
      const pointer = manifest.types[data.type];
      const pointee = pointer?.kind === "pointer"
        ? manifest.types[pointer.pointee]
        : undefined;
      if (
        data.passMode !== "pointer" || data.nullable ||
        data.ownership.kind !== "borrowed" || data.ownership.scope !== "call" ||
        data.callback !== undefined ||
        pointer?.kind !== "pointer" || pointer.mutability !== "const" ||
        pointer.nullable || pointer.addressSpace !== 0 ||
        pointee?.kind !== "integer" || pointee.bits !== 8
      ) {
        return "NUL-terminated UTF-8 data must be a non-null borrowed const i8/u8 pointer in address space zero";
      }
      return {
        kind: "utf8-c-string",
        pointee: pointee.signed ? "i8" : "u8",
      };
    }
    if (marshal.length.kind === "nul") {
      return "NUL-length strings require UTF-8, NUL termination, and embedded-NUL rejection";
    }
    if (
      marshal.encoding !== "utf-8" ||
      marshal.termination !== "none" ||
      marshal.embeddedNul !== "allow" ||
      marshal.length.kind !== "parameter"
    ) {
      return "only borrowed UTF-8 spans or NUL-terminated strings with embedded-NUL rejection are supported";
    }
  } else if (marshal?.kind === "bytes") {
    if (marshal.mutability !== "const" || marshal.length.kind !== "parameter") {
      return "only borrowed const byte spans with an explicit byte length are supported";
    }
  } else {
    return "only borrowed UTF-8 strings and const byte spans are supported";
  }
  const pointer = manifest.types[data.type];
  const pointee = pointer?.kind === "pointer" ? manifest.types[pointer.pointee] : undefined;
  if (
    data.passMode !== "pointer" || data.nullable ||
    data.ownership.kind !== "borrowed" || data.ownership.scope !== "call" ||
    data.callback !== undefined ||
    pointer?.kind !== "pointer" || pointer.mutability !== "const" ||
    pointer.nullable || pointer.addressSpace !== 0 ||
    pointee?.kind !== "integer" || pointee.bits !== 8 ||
    (marshal.kind === "bytes" && pointee.signed)
  ) {
    return marshal.kind === "string"
      ? "UTF-8 data must be a non-null borrowed const i8/u8 pointer in address space zero"
      : "byte data must be a non-null borrowed const u8 pointer in address space zero";
  }
  const spanLength = marshal.length;
  if (spanLength.kind !== "parameter") {
    return "borrowed spans require an explicit length parameter";
  }
  const lengthIndex = binding.signature.parameters.findIndex(
    (parameter) => parameter.name === spanLength.parameter,
  );
  const length = binding.signature.parameters[lengthIndex];
  const lengthType = length === undefined ? undefined : manifest.types[length.type];
  if (
    lengthIndex < 0 || lengthIndex === dataIndex || length === undefined ||
    length.passMode !== "value" || length.nullable ||
    length.ownership.kind !== "value" || length.marshal !== undefined ||
    length.callback !== undefined ||
    lengthType?.kind !== "integer" || lengthType.signed || lengthType.bits !== "pointer"
  ) {
    return `${marshal.kind === "string" ? "UTF-8 byte" : "byte"} length '${spanLength.parameter}' must name an un-marshalled usize value parameter`;
  }
  return {
    kind: marshal.kind === "string" ? "utf8" : "bytes",
    lengthIndex,
    pointee: pointee.signed ? "i8" : "u8",
  };
}

function bindingUnsupported(
  manifest: ScabiManifest,
  bindingId: string,
  binding: CallableBinding,
): string | null {
  if (!["function", "factory", "method"].includes(binding.kind)) {
    return `binding kind '${binding.kind}'`;
  }
  if (binding.kind === "method" && !binding.declaration.name.includes(".")) {
    return "method declaration identity must name its containing type and member";
  }
  if (binding.entry.kind === "adapter-symbol") {
    if (binding.dependencies.adapterInputs.length !== 1) {
      return "adapter-symbol imports require exactly one adapter input";
    }
    const adapterId = binding.dependencies.adapterInputs[0]!;
    const adapter = manifest.adapterInputs.find(({ id }) => id === adapterId);
    if (adapter === undefined || !adapter.bindings.includes(bindingId)) {
      return `adapter input '${adapterId}' does not provide this binding`;
    }
  } else if (binding.dependencies.adapterInputs.length > 0) {
    return "direct C symbols cannot declare adapter inputs";
  }
  if (binding.signature.callingConvention !== "c") {
    return `calling convention '${binding.signature.callingConvention}'`;
  }
  if (binding.signature.variadic !== false) return "variadic calls";
  if (
    binding.error.kind !== "no-fail" &&
    binding.error.kind !== "errno" &&
    binding.error.kind !== "nullable"
  ) {
    return `error contract '${binding.error.kind}'`;
  }
  const directThread =
    (binding.thread.behavior === "any" &&
      binding.thread.executor.kind === "any-attached-thread" &&
      !binding.thread.blocking) ||
    (binding.thread.behavior === "require" &&
      binding.thread.executor.kind === "runtime-owner");
  if (!directThread) {
    return "thread, executor, or blocking semantics outside the direct-call slice";
  }
  if (
    binding.dependencies.permissions.length > 0
  ) {
    return "permission dependencies outside the direct-call slice";
  }
  return null;
}

function exportBindingUnsupported(
  manifest: ScabiManifest,
  bindingId: string,
  binding: CallableBinding,
): string | null {
  if (binding.kind !== "export") return `binding kind '${binding.kind}'`;
  if (binding.entry.kind !== "adapter-symbol") return `entry kind '${binding.entry.kind}'`;
  if (binding.signature.callingConvention !== "c") {
    return `calling convention '${binding.signature.callingConvention}'`;
  }
  if (binding.signature.variadic) return "variadic exports";
  if (binding.error.kind !== "no-fail") {
    return `error contract '${binding.error.kind}'`;
  }
  if (
    binding.thread.blocking ||
    binding.thread.behavior !== "require" ||
    binding.thread.executor.kind !== "runtime-owner"
  ) {
    return "exports currently require direct, nonblocking runtime-owner execution";
  }
  if (
    binding.dependencies.bindings.length > 0 ||
    binding.dependencies.linkInputs.length > 0 ||
    binding.dependencies.permissions.length > 0
  ) {
    return "binding, link, or permission dependencies outside the exact export slice";
  }
  if (binding.dependencies.adapterInputs.length !== 1) {
    return "exact exports require one C-export adapter input";
  }
  const adapterId = binding.dependencies.adapterInputs[0]!;
  const adapter = manifest.adapterInputs.find(({ id }) => id === adapterId);
  if (
    adapter === undefined ||
    adapter.family !== "c-export" ||
    adapter.language !== "c" ||
    !adapter.bindings.includes(bindingId)
  ) {
    return `adapter input '${adapterId}' is not a C-export adapter for this binding`;
  }
  return null;
}

/** Translate the reachable SCABI bindings supported by ScriptC's current
 * exact-scalar, trivial native-struct, borrowed UTF-8/byte-span, and
 * owner-confined handle IR.
 * Unsupported unreachable records remain inert; requested records fail with
 * a precise manifest path. */
export function translateScabiNativeProgram(
  manifest: ScabiManifest,
  selection: ScriptCNativeProgramSelection,
): ScriptCNativeTranslationResult {
  const diagnostics: ScriptCNativeTranslationDiagnostic[] = [];
  const bindings: ScriptCNativeBinding[] = [];
  const exports: ScriptCNativeExport[] = [];
  const sourceTypes = new Map<NativeTypeId, ScriptCNativeSourceType>();
  const nativeTypes = new Map<NativeTypeId, ScriptCNativeTypeDefinition>();
  const visitedSourceTypes = new Set<NativeTypeId>();
  const activeTypes = new Set<NativeTypeId>();
  const linkInputIds = new Set<string>();
  const adapterInputIds = new Set<string>();

  const lowerType = (
    typeId: NativeTypeId,
    path: string,
  ): ScriptCNativeIrType | null => {
    const nativeType = manifest.types[typeId];
    if (nativeType === undefined) {
      diagnostics.push(
        diagnostic("NTS3001", path, `Native type '${typeId}' does not exist`),
      );
      return null;
    }
    if (nativeType.kind === "void") return Object.freeze({ kind: "void" });
    if (nativeType.kind === "integer" || nativeType.kind === "float") {
      if (nativeType.kind === "float" && nativeType.bits !== 64) {
        diagnostics.push(
          diagnostic(
            "NTS3002",
            path,
            `Native float type '${typeId}' is outside ScriptC's exact f64 slice`,
          ),
        );
        return null;
      }
      const scalar: ScriptCNativeScalar = nativeType.kind === "float"
        ? "f64"
        : nativeType.bits === "pointer"
          ? nativeType.signed
            ? "isize"
            : "usize"
          : `${nativeType.signed ? "i" : "u"}${nativeType.bits}`;
      const type = Object.freeze({ kind: "nativeScalar", scalar } as const);
      if (!visitedSourceTypes.has(typeId)) {
        visitedSourceTypes.add(typeId);
        const declaration = manifest.declarations.types[typeId];
        if (declaration === undefined) {
          diagnostics.push(
            diagnostic(
              "NTS3003",
              `/declarations/types/${typeId}`,
              `Reachable native type '${typeId}' has no TypeScript declaration identity`,
            ),
          );
        } else {
          sourceTypes.set(
            typeId,
            Object.freeze({
              declaration: normalizeDeclaration(manifest, declaration),
              type,
            }),
          );
        }
      }
      return type;
    }
    if (nativeType.kind === "handle") {
      if (nativeType.threadSafety === "sendable") {
        diagnostics.push(
          diagnostic(
            "NTS3002",
            path,
            "Sendable handles require managed ownership transfer between runtime executors",
          ),
        );
        return null;
      }
      const id = `${manifest.package.instance}#type:${typeId}`;
      const type = Object.freeze({ kind: "nativeHandle", typeId: id } as const);
      if (nativeTypes.has(typeId)) return type;
      if (activeTypes.has(typeId)) {
        diagnostics.push(diagnostic(
          "NTS3002",
          path,
          `Native handle '${typeId}' has a recursive upcast graph`,
        ));
        return null;
      }
      const declaration = manifest.declarations.types[typeId];
      if (declaration === undefined) {
        diagnostics.push(
          diagnostic(
            "NTS3003",
            `/declarations/types/${typeId}`,
            `Reachable native type '${typeId}' has no TypeScript declaration identity`,
          ),
        );
        return null;
      }
      activeTypes.add(typeId);
      const upcasts: ScriptCNativeHandleDefinition["upcasts"][number][] = [];
      let valid = true;
      for (const [index, upcast] of nativeType.upcasts.entries()) {
        const target = lowerType(upcast.target, `${path}/upcasts/${index}/target`);
        if (target === null || target.kind !== "nativeHandle") {
          if (target !== null) {
            diagnostics.push(diagnostic(
              "NTS3002",
              `${path}/upcasts/${index}/target`,
              `Native handle upcast target '${upcast.target}' is not a handle`,
            ));
          }
          valid = false;
        } else {
          upcasts.push(Object.freeze({ kind: "identity", target: target.typeId }));
        }
      }
      activeTypes.delete(typeId);
      if (!valid) return null;
      const normalizedDeclaration = normalizeDeclaration(manifest, declaration);
      nativeTypes.set(typeId, Object.freeze({
        kind: "handle",
        id,
        declaration: normalizedDeclaration,
        nativeName: nativeType.nativeName,
        threadSafety: nativeType.threadSafety,
        identity: nativeType.identity,
        upcasts: Object.freeze(upcasts),
      }));
      if (!visitedSourceTypes.has(typeId)) {
        visitedSourceTypes.add(typeId);
        sourceTypes.set(typeId, Object.freeze({ declaration: normalizedDeclaration, type }));
      }
      return type;
    }
    if (nativeType.kind !== "struct") {
      diagnostics.push(
        diagnostic(
          "NTS3002",
          path,
          `Native type '${typeId}' is outside ScriptC's scalar-and-struct slice`,
        ),
      );
      return null;
    }
    if (
      nativeType.packing !== "default" ||
      !nativeType.triviallyCopyable ||
      nativeType.destruction !== "trivial" ||
      nativeType.abiPassing?.kind !== "indirect"
    ) {
      diagnostics.push(
        diagnostic(
          "NTS3002",
          path,
          `Native struct '${typeId}' requires default packing, trivial value semantics, and authoritative indirect ABI passing`,
        ),
      );
      return null;
    }
    if (activeTypes.has(typeId)) {
      diagnostics.push(diagnostic("NTS3002", path, `Native struct '${typeId}' is recursive`));
      return null;
    }
    const id = `${manifest.package.instance}#type:${typeId}`;
    const type = Object.freeze({ kind: "nativeStruct", typeId: id } as const);
    if (nativeTypes.has(typeId)) return type;
    activeTypes.add(typeId);
    const declaration = manifest.declarations.types[typeId];
    if (declaration === undefined) {
      diagnostics.push(
        diagnostic(
          "NTS3003",
          `/declarations/types/${typeId}`,
          `Reachable native type '${typeId}' has no TypeScript declaration identity`,
        ),
      );
      activeTypes.delete(typeId);
      return null;
    }
    const fields: ScriptCNativeStructDefinition["fields"][number][] = [];
    let valid = true;
    for (const [index, field] of nativeType.fields.entries()) {
      if (field.bitField !== undefined) {
        diagnostics.push(diagnostic("NTS3002", `${path}/fields/${index}`, "Bit fields are outside ScriptC's native struct slice"));
        valid = false;
        continue;
      }
      const fieldType = lowerType(field.type, `${path}/fields/${index}/type`);
      if (fieldType === null || fieldType.kind !== "nativeScalar") {
        if (fieldType !== null) {
          diagnostics.push(diagnostic("NTS3002", `${path}/fields/${index}/type`, "Nested native aggregates are not supported yet"));
        }
        valid = false;
        continue;
      }
      fields.push(Object.freeze({ name: field.name, type: fieldType, offset: field.offset }));
    }
    activeTypes.delete(typeId);
    if (!valid) return null;
    const normalizedDeclaration = normalizeDeclaration(manifest, declaration);
    nativeTypes.set(typeId, Object.freeze({
      kind: "struct",
      id,
      declaration: normalizedDeclaration,
      size: nativeType.size,
      alignment: nativeType.alignment,
      packing: "default",
      triviallyCopyable: true,
      destruction: "trivial",
      abi: Object.freeze({
        kind: "indirect",
        alignment: nativeType.abiPassing.alignment,
      }),
      fields: Object.freeze(fields),
    }));
    if (!visitedSourceTypes.has(typeId)) {
      visitedSourceTypes.add(typeId);
      sourceTypes.set(typeId, Object.freeze({ declaration: normalizedDeclaration, type }));
    }
    return type;
  };

  const reachable = new Set(selection.imports);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const bindingId of [...reachable].sort()) {
      const binding = manifest.bindings[bindingId];
      if (
        binding === undefined || binding.kind === "constant" ||
        bindingUnsupported(manifest, bindingId, binding) !== null
      ) {
        continue;
      }
      for (const dependency of binding.dependencies.bindings) {
        if (!reachable.has(dependency)) {
          reachable.add(dependency);
          expanded = true;
        }
      }
    }
  }

  const destructorIds = new Set<string>();
  for (const bindingId of reachable) {
    const binding = manifest.bindings[bindingId];
    if (binding === undefined || binding.kind === "constant") continue;
    const ownership = binding.signature.result.ownership;
    if (ownership.kind === "owned" && ownership.transfer === "to-runtime") {
      destructorIds.add(ownership.destructor);
    }
  }

  for (const bindingId of [...reachable].sort()) {
    const path = `/bindings/${bindingId}`;
    const binding = manifest.bindings[bindingId];
    if (binding === undefined) {
      diagnostics.push(
        diagnostic("NTS3001", path, `Native binding '${bindingId}' does not exist`),
      );
      continue;
    }
    if (binding.kind === "constant") {
      diagnostics.push(
        diagnostic("NTS3002", path, "Constant bindings are outside the direct-call slice"),
      );
      continue;
    }
    const unsupported = bindingUnsupported(manifest, bindingId, binding);
    if (unsupported !== null) {
      diagnostics.push(diagnostic("NTS3002", path, unsupported));
      continue;
    }
    const handlePositions = [
      ...binding.signature.parameters,
      binding.signature.result,
    ].filter((position) => manifest.types[position.type]?.kind === "handle");
    if (
      handlePositions.length > 0 &&
      !(binding.thread.behavior === "require" &&
        binding.thread.executor.kind === "runtime-owner" &&
        (!binding.thread.blocking || destructorIds.has(bindingId)))
    ) {
      diagnostics.push(
        diagnostic(
          "NTS3002",
          `${path}/thread`,
          "Opaque handles require a direct runtime-owner call; only exact destructors may block",
        ),
      );
      continue;
    }
    if (
      binding.signature.parameters.some(
        (parameter) =>
          parameter.ownership.kind === "owned" && parameter.ownership.transfer === "to-native",
      ) &&
      !destructorIds.has(bindingId)
    ) {
      diagnostics.push(
        diagnostic(
          "NTS3002",
          `${path}/signature/parameters`,
          "General ownership-consuming calls are outside the exact-destructor slice",
        ),
      );
      continue;
    }

    const sourceArguments: Array<ScriptCNativeBinding["arguments"][number]> = [];
    const parameters: Array<ScriptCNativeBinding["parameters"][number]> = [];
    const borrowedByData = new Map<number, BorrowedDataParameterPair>();
    const borrowedByLength = new Map<number, BorrowedDataParameterPair>();
    const callbackByFunction = new Map<number, SupportedCallbackPair>();
    const callbackByContext = new Map<number, SupportedCallbackPair>();
    const callbackSignatures = new Map<number, ScriptCNativeCallbackSignature>();
    const directTypes = new Map<number, ScriptCNativeValueType>();
    const argumentByParameter = new Map<number, number>();
    let valid = true;
    for (const [index, parameter] of binding.signature.parameters.entries()) {
      if (parameter.marshal === undefined) continue;
      const pair = supportedBorrowedDataPair(manifest, binding, index);
      if (typeof pair === "string") {
        diagnostics.push(
          diagnostic("NTS3002", `${path}/signature/parameters/${index}`, pair),
        );
        valid = false;
        continue;
      }
      if (pair.kind !== "utf8-c-string" && borrowedByLength.has(pair.lengthIndex)) {
        diagnostics.push(
          diagnostic(
            "NTS3002",
            `${path}/signature/parameters/${index}/marshal/length`,
            "A physical length parameter cannot describe multiple source arguments",
          ),
        );
        valid = false;
        continue;
      }
      borrowedByData.set(index, pair);
      if (pair.kind !== "utf8-c-string") {
        borrowedByLength.set(pair.lengthIndex, pair);
      }
    }
    for (const [index, parameter] of binding.signature.parameters.entries()) {
      if (parameter.callback === undefined) continue;
      const pair = supportedCallbackPair(manifest, binding, index);
      if (typeof pair === "string") {
        diagnostics.push(
          diagnostic("NTS3002", `${path}/signature/parameters/${index}`, pair),
        );
        valid = false;
        continue;
      }
      if (
        callbackByContext.has(pair.contextIndex) ||
        borrowedByData.has(index) ||
        borrowedByLength.has(index) ||
        borrowedByData.has(pair.contextIndex) ||
        borrowedByLength.has(pair.contextIndex)
      ) {
        diagnostics.push(
          diagnostic(
            "NTS3002",
            `${path}/signature/parameters/${index}`,
            "A physical callback or context parameter cannot serve multiple source arguments",
          ),
        );
        valid = false;
        continue;
      }
      callbackByFunction.set(index, pair);
      callbackByContext.set(pair.contextIndex, pair);
    }
    for (const [index, parameter] of binding.signature.parameters.entries()) {
      const parameterPath = `${path}/signature/parameters/${index}`;
      if (borrowedByLength.has(index) || callbackByContext.has(index)) continue;
      const borrowed = borrowedByData.get(index);
      if (borrowed !== undefined) {
        const argument = sourceArguments.length;
        sourceArguments.push(
          Object.freeze({
            name: parameter.name,
            type: borrowed.kind === "utf8" || borrowed.kind === "utf8-c-string"
              ? Object.freeze({ kind: "string" } as const)
              : Object.freeze({ kind: "bytes", elem: "u8" } as const),
          }),
        );
        argumentByParameter.set(index, argument);
        if (borrowed.kind !== "utf8-c-string") {
          argumentByParameter.set(borrowed.lengthIndex, argument);
        }
        continue;
      }
      const callback = callbackByFunction.get(index);
      if (callback !== undefined) {
        const callbackParameters: Array<
          ScriptCNativeCallbackSignature["parameters"][number]
        > = [];
        let callbackValid = true;
        for (const [callbackIndex, typeId] of callback.parameterTypeIds.entries()) {
          const type = lowerType(
            typeId,
            `${parameterPath}/type/signature/parameters/${callbackIndex}/type`,
          );
          if (type?.kind !== "nativeScalar") {
            if (type !== null) {
              diagnostics.push(
                diagnostic(
                  "NTS3002",
                  `${parameterPath}/type/signature/parameters/${callbackIndex}/type`,
                  "Callback parameters must be exact native scalars",
                ),
              );
            }
            callbackValid = false;
          } else {
            callbackParameters.push(type);
          }
        }
        const callbackResult = lowerType(
          callback.resultTypeId,
          `${parameterPath}/type/signature/result/type`,
        );
        if (
          callbackResult === null ||
          (callbackResult.kind !== "nativeScalar" && callbackResult.kind !== "void")
        ) {
          if (callbackResult !== null) {
            diagnostics.push(
              diagnostic(
                "NTS3002",
                `${parameterPath}/type/signature/result/type`,
                "Callback results must be an exact native scalar or void",
              ),
            );
          }
          callbackValid = false;
        }
        if (
          !callbackValid ||
          callbackResult === null ||
          (callbackResult.kind !== "nativeScalar" && callbackResult.kind !== "void")
        ) {
          valid = false;
          continue;
        }
        const signature = Object.freeze({
          callingConvention: "c",
          parameters: Object.freeze(callbackParameters),
          result: callbackResult,
          context: Object.freeze({ placement: "last" } as const),
        } as const);
        callbackSignatures.set(index, signature);
        const argument = sourceArguments.length;
        sourceArguments.push(Object.freeze({
          name: parameter.name,
          type: Object.freeze({
            kind: "func",
            params: signature.parameters,
            ret: signature.result,
          } as const),
          callback: callback.contract,
        }));
        argumentByParameter.set(index, argument);
        argumentByParameter.set(callback.contextIndex, argument);
        continue;
      }
      if (parameter.marshal !== undefined) continue;
      const unsupportedPosition = positionUnsupported(
        parameter,
        true,
        manifest.types[parameter.type],
      );
      if (unsupportedPosition !== null) {
        diagnostics.push(diagnostic("NTS3002", parameterPath, unsupportedPosition));
        valid = false;
        continue;
      }
      const type = lowerType(parameter.type, `${parameterPath}/type`);
      if (type === null || type.kind === "void") {
        if (type?.kind === "void") {
          diagnostics.push(
            diagnostic("NTS3002", `${parameterPath}/type`, "Parameters cannot have void type"),
          );
        }
        valid = false;
        continue;
      }
      directTypes.set(index, type);
      argumentByParameter.set(index, sourceArguments.length);
      sourceArguments.push(Object.freeze({ name: parameter.name, type }));
    }
    if (valid) {
      for (const [index, parameter] of binding.signature.parameters.entries()) {
        const argument = argumentByParameter.get(index);
        if (argument === undefined) {
          diagnostics.push(
            diagnostic(
              "NTS3002",
              `${path}/signature/parameters/${index}`,
              "The parameter has no supported source-to-ABI projection",
            ),
          );
          valid = false;
          continue;
        }
        const borrowedData = borrowedByData.get(index);
        const borrowedLength = borrowedByLength.get(index);
        const callbackFunction = callbackByFunction.get(index);
        if (callbackFunction !== undefined) {
          const signature = callbackSignatures.get(index);
          if (signature === undefined) {
            throw new Error(`missing lowered callback signature for ${bindingId}:${index}`);
          }
          parameters.push(Object.freeze({
            name: parameter.name,
            type: Object.freeze({ kind: "nativeCallback", signature } as const),
            passMode: "pointer",
            ownership: Object.freeze({
              kind: "callback",
              lifetime: callbackFunction.contract.lifetime,
            } as const),
            projection: Object.freeze({ kind: "callbackFunction", argument } as const),
          }));
          continue;
        }
        const callbackContext = callbackByContext.get(index);
        if (callbackContext !== undefined) {
          parameters.push(Object.freeze({
            name: parameter.name,
            type: Object.freeze({ kind: "nativeContext", addressSpace: 0 } as const),
            passMode: "pointer",
            ownership: Object.freeze({
              kind: "callback",
              lifetime: callbackContext.contract.lifetime,
            } as const),
            projection: Object.freeze({ kind: "callbackContext", argument } as const),
          }));
          continue;
        }
        const directType = directTypes.get(index);
        parameters.push(Object.freeze(
          borrowedData !== undefined
            ? {
                name: parameter.name,
                type: Object.freeze({
                  kind: "nativePointer",
                  pointee: borrowedData.pointee,
                  const: true,
                  addressSpace: 0,
                } as const),
                passMode: "pointer",
                ownership: Object.freeze({ kind: "borrowed", scope: "call" } as const),
                projection: Object.freeze({
                  kind: borrowedData.kind === "utf8-c-string"
                    ? "utf8CString"
                    : borrowedData.kind === "utf8"
                      ? "utf8Data"
                      : "bytesData",
                  argument,
                } as const),
              }
            : borrowedLength !== undefined
              ? {
                  name: parameter.name,
                  type: Object.freeze({ kind: "nativeScalar", scalar: "usize" } as const),
                  passMode: "value",
                  ownership: Object.freeze({ kind: "value" } as const),
                  projection: Object.freeze({
                    kind: borrowedLength.kind === "utf8"
                      ? "utf8ByteLength"
                      : "bytesByteLength",
                    argument,
                  } as const),
                }
              : {
                  name: parameter.name,
                  type: directType!,
                  passMode: parameter.passMode as "value" | "pointer",
                  ownership: parameter.ownership.kind === "borrowed"
                    ? Object.freeze({ kind: "borrowed", scope: "call" } as const)
                    : parameter.ownership.kind === "owned"
                      ? Object.freeze({ kind: "owned", transfer: "to-native" } as const)
                      : Object.freeze({ kind: "value" } as const),
                  projection: Object.freeze({ kind: "argument", argument } as const),
                },
        ));
      }
    }

    const resultPath = `${path}/signature/result`;
    let resultType: ScriptCNativeBinding["result"]["type"] | null = null;
    let resultOwnership: ScriptCNativeBinding["result"]["ownership"] | null = null;
    let resultProjection: ScriptCNativeResultProjection | null = null;
    if (binding.signature.result.marshal?.kind === "string") {
      const borrowed = supportedBorrowedStringResult(manifest, binding);
      if (typeof borrowed === "string") {
        diagnostics.push(diagnostic("NTS3002", resultPath, borrowed));
        valid = false;
      } else {
        resultType = Object.freeze({
          kind: "nativePointer",
          pointee: borrowed.pointee,
          const: true,
          addressSpace: 0,
        });
        resultOwnership = Object.freeze({
          kind: "borrowed",
          scope: "receiver",
          anchor: borrowed.anchor,
        });
        resultProjection = Object.freeze({
          kind: "utf8CString",
          nullable: borrowed.nullable,
        });
      }
    } else {
      const unsupportedResult = positionUnsupported(
        binding.signature.result,
        false,
        manifest.types[binding.signature.result.type],
        binding.error.kind === "nullable",
      );
      if (unsupportedResult !== null) {
        diagnostics.push(diagnostic("NTS3002", resultPath, unsupportedResult));
        valid = false;
      }
      resultType = lowerType(
        binding.signature.result.type,
        `${resultPath}/type`,
      );
      if (resultType === null) {
        valid = false;
      } else {
        resultOwnership =
          binding.signature.result.ownership.kind === "owned" &&
            binding.signature.result.ownership.transfer === "to-runtime"
          ? Object.freeze({
              kind: "owned",
              transfer: "to-runtime",
              destructor: `${manifest.package.instance}#${binding.signature.result.ownership.destructor}`,
            } as const)
          : Object.freeze({ kind: "value" } as const);
        resultProjection = Object.freeze({ kind: "direct" });
      }
    }
    if (binding.error.kind === "errno") {
      const nativeResult = manifest.types[binding.signature.result.type];
      if (
        nativeResult?.kind !== "integer" ||
        binding.signature.result.passMode !== "value" ||
        binding.signature.result.ownership.kind !== "value"
      ) {
        diagnostics.push(
          diagnostic(
            "NTS3002",
            `${path}/error`,
            "errno requires an exact integer value result",
          ),
        );
        valid = false;
      } else {
        const bits = nativeResult.bits === "pointer"
          ? manifest.target.pointerWidth
          : nativeResult.bits;
        const value = /^-?(?:0|[1-9][0-9]*)$/.test(binding.error.failureValue) &&
            binding.error.failureValue !== "-0"
          ? BigInt(binding.error.failureValue)
          : null;
        const min = nativeResult.signed ? -(1n << BigInt(bits - 1)) : 0n;
        const max = nativeResult.signed
          ? (1n << BigInt(bits - 1)) - 1n
          : (1n << BigInt(bits)) - 1n;
        if (value === null || value < min || value > max) {
          diagnostics.push(
            diagnostic(
              "NTS3002",
              `${path}/error/failureValue`,
              `errno failureValue must be a canonical decimal ${nativeResult.signed ? "signed" : "unsigned"} ${bits}-bit integer`,
            ),
          );
          valid = false;
        }
      }
    } else if (binding.error.kind === "nullable") {
      if (
        manifest.types[binding.signature.result.type]?.kind !== "handle" ||
        !binding.signature.result.nullable ||
        binding.signature.result.passMode !== "pointer" ||
        binding.signature.result.ownership.kind !== "owned" ||
        binding.signature.result.ownership.transfer !== "to-runtime"
      ) {
        diagnostics.push(
          diagnostic(
            "NTS3002",
            `${path}/error`,
            "nullable requires a nullable owned handle result transferred to the runtime",
          ),
        );
        valid = false;
      }
    }
    if (
      !valid ||
      resultType === null ||
      resultOwnership === null ||
      resultProjection === null
    ) continue;

    for (const id of binding.dependencies.linkInputs) linkInputIds.add(id);
    for (const id of binding.dependencies.adapterInputs) adapterInputIds.add(id);
    bindings.push(
      Object.freeze({
        id: `${manifest.package.instance}#${bindingId}`,
        declaration: normalizeDeclaration(manifest, binding.declaration),
        entry: Object.freeze({ kind: "c-symbol", symbol: binding.entry.symbol }),
        callingConvention: "c",
        variadic: false,
        sourceCall: binding.kind === "method"
          ? Object.freeze({ kind: "method", receiverArgument: 0 } as const)
          : Object.freeze({ kind: "function" } as const),
        error: binding.error.kind === "errno"
          ? Object.freeze({
              kind: "errno",
              failureValue: binding.error.failureValue,
            } as const)
          : binding.error.kind === "nullable"
            ? Object.freeze({ kind: "nullable" } as const)
            : Object.freeze({ kind: "no-fail" } as const),
        arguments: Object.freeze(sourceArguments),
        parameters: Object.freeze(parameters),
        result: Object.freeze({
          type: resultType,
          passMode: binding.signature.result.passMode as "value" | "pointer",
          ownership: resultOwnership,
          projection: resultProjection,
        }),
      }),
    );
  }

  const selectedExportBindings = new Set<string>();
  const orderedExports = selection.exports
    .map((selected, selectionIndex) => ({ selected, selectionIndex }))
    .sort((left, right) =>
      compareText(left.selected.bindingId, right.selected.bindingId) ||
      compareText(left.selected.sourceExport, right.selected.sourceExport)
    );
  for (const { selected, selectionIndex } of orderedExports) {
    const selectionPath = `/selection/exports/${selectionIndex}`;
    if (selectedExportBindings.has(selected.bindingId)) {
      diagnostics.push(diagnostic(
        "NTS3002",
        `${selectionPath}/bindingId`,
        `Native export binding '${selected.bindingId}' is selected more than once`,
      ));
      continue;
    }
    selectedExportBindings.add(selected.bindingId);
    if (selected.sourceExport.length === 0) {
      diagnostics.push(diagnostic(
        "NTS3002",
        `${selectionPath}/sourceExport`,
        "Native export source name cannot be empty",
      ));
      continue;
    }

    const path = `/bindings/${selected.bindingId}`;
    const binding = manifest.bindings[selected.bindingId];
    if (binding === undefined) {
      diagnostics.push(diagnostic(
        "NTS3001",
        path,
        `Native export binding '${selected.bindingId}' does not exist`,
      ));
      continue;
    }
    if (binding.kind === "constant") {
      diagnostics.push(diagnostic("NTS3002", path, "Constants cannot be native exports"));
      continue;
    }
    const unsupported = exportBindingUnsupported(manifest, selected.bindingId, binding);
    if (unsupported !== null) {
      diagnostics.push(diagnostic("NTS3002", path, unsupported));
      continue;
    }

    let valid = true;
    const parameters: ScriptCNativeExport["parameters"][number][] = [];
    for (const [index, parameter] of binding.signature.parameters.entries()) {
      const parameterPath = `${path}/signature/parameters/${index}`;
      const unsupportedPosition = positionUnsupported(
        parameter,
        true,
        manifest.types[parameter.type],
      );
      if (unsupportedPosition !== null) {
        diagnostics.push(diagnostic("NTS3002", parameterPath, unsupportedPosition));
        valid = false;
        continue;
      }
      const type = lowerType(parameter.type, `${parameterPath}/type`);
      if (type === null) {
        valid = false;
      } else if (type.kind !== "nativeScalar") {
        diagnostics.push(diagnostic(
          "NTS3002",
          `${parameterPath}/type`,
          "Native export parameters must be exact scalar values",
        ));
        valid = false;
      } else {
        parameters.push(Object.freeze({
          name: parameter.name,
          type,
          passMode: "value",
          ownership: Object.freeze({ kind: "value" } as const),
        }));
      }
    }

    const resultPath = `${path}/signature/result`;
    const unsupportedResult = positionUnsupported(
      binding.signature.result,
      false,
      manifest.types[binding.signature.result.type],
    );
    if (unsupportedResult !== null) {
      diagnostics.push(diagnostic("NTS3002", resultPath, unsupportedResult));
      valid = false;
    }
    const resultType = lowerType(binding.signature.result.type, `${resultPath}/type`);
    if (resultType === null) {
      valid = false;
    } else if (resultType.kind !== "nativeScalar" && resultType.kind !== "void") {
      diagnostics.push(diagnostic(
        "NTS3002",
        `${resultPath}/type`,
        "Native export results must be an exact scalar value or void",
      ));
      valid = false;
    }
    if (!valid || resultType === null) continue;

    const adapterId = binding.dependencies.adapterInputs[0]!;
    adapterInputIds.add(adapterId);
    exports.push(Object.freeze({
      id: `${manifest.package.instance}#${selected.bindingId}`,
      sourceExport: selected.sourceExport,
      declaration: normalizeDeclaration(manifest, binding.declaration),
      entry: Object.freeze({ kind: "c-symbol", symbol: binding.entry.symbol } as const),
      callingConvention: "c",
      variadic: false,
      error: Object.freeze({ kind: "no-fail" } as const),
      parameters: Object.freeze(parameters),
      result: Object.freeze({
        type: resultType,
        passMode: "value",
        ownership: Object.freeze({ kind: "value" } as const),
      }),
    }));
  }

  if (diagnostics.length > 0) {
    return Object.freeze({ ok: false, diagnostics: Object.freeze(diagnostics) });
  }
  return Object.freeze({
    ok: true,
    input: Object.freeze({
      target: Object.freeze({
        pointerBits: manifest.target.pointerWidth,
        abi: manifest.target.abi,
      }),
      sourceTypes: Object.freeze([...sourceTypes.values()]),
      types: Object.freeze([...nativeTypes.values()]),
      bindings: Object.freeze(bindings),
      exports: Object.freeze(exports),
    }),
    build: Object.freeze({
      linkInputs: Object.freeze(manifest.linkInputs
        .filter(({ id }) => linkInputIds.has(id))
        .sort((left, right) => left.order - right.order || compareText(left.id, right.id))
        .map((input, order) => Object.freeze({ ...input, order }))),
      adapterInputs: Object.freeze(manifest.adapterInputs
        .filter(({ id }) => adapterInputIds.has(id))
        .map((input) => Object.freeze({
          ...input,
          bindings: Object.freeze([...input.bindings]),
          outputs: Object.freeze([...input.outputs]),
          options: Object.freeze({ ...input.options }),
        }))),
    }),
  });
}
