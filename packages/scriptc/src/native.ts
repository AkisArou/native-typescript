import type {
  AbiParameter,
  AbiResult,
  CallableBinding,
  DeclarationReference,
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
  | { readonly kind: "utf8Data"; readonly argument: number }
  | { readonly kind: "utf8ByteLength"; readonly argument: number }
  | { readonly kind: "bytesData"; readonly argument: number }
  | { readonly kind: "bytesByteLength"; readonly argument: number }
  | { readonly kind: "callbackFunction"; readonly argument: number }
  | { readonly kind: "callbackContext"; readonly argument: number };

export type ScriptCNativeIrType =
  | ScriptCNativeValueType
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
  readonly threadSafety: "confined";
  readonly identity: "none" | "pointer" | "binding" | "platform";
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
  }[];
  readonly parameters: readonly {
    readonly name: string;
    readonly type: ScriptCNativeAbiType;
    readonly passMode: "value" | "pointer";
    readonly ownership:
      | { readonly kind: "value" }
      | { readonly kind: "borrowed"; readonly scope: "call" }
      | { readonly kind: "owned"; readonly transfer: "to-native" }
      | { readonly kind: "callScoped" };
    readonly projection: ScriptCNativeParameterProjection;
  }[];
  readonly result: {
    readonly type: ScriptCNativeIrType;
    readonly passMode: "value" | "pointer";
    readonly ownership:
      | { readonly kind: "value" }
      | {
          readonly kind: "owned";
          readonly transfer: "to-runtime";
          readonly destructor: string;
        };
  };
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
}

export interface ScriptCNativeTranslationDiagnostic {
  readonly code: "NTS3001" | "NTS3002" | "NTS3003";
  readonly severity: "error";
  readonly path: string;
  readonly message: string;
}

export type ScriptCNativeTranslationResult =
  | {
      readonly ok: true;
      readonly input: ScriptCNativeFrontendInput;
      readonly linkInputIds: readonly string[];
    }
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
  if (position.nullable && !allowNullable) return "nullable values";
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
};

type CallScopedCallbackPair = {
  readonly functionIndex: number;
  readonly contextIndex: number;
  readonly parameterTypeIds: readonly NativeTypeId[];
  readonly resultTypeId: NativeTypeId;
};

function supportedCallScopedCallbackPair(
  manifest: ScabiManifest,
  binding: CallableBinding,
  callbackIndex: number,
): CallScopedCallbackPair | string {
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
  };
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
      marshal.encoding !== "utf-8" ||
      marshal.termination !== "none" ||
      marshal.embeddedNul !== "allow" ||
      marshal.length.kind !== "parameter"
    ) {
      return "only borrowed UTF-8 strings with explicit byte length, no terminator, and embedded NULs allowed are supported";
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
  const lengthIndex = binding.signature.parameters.findIndex(
    (parameter) => parameter.name === marshal.length.parameter,
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
    return `${marshal.kind === "string" ? "UTF-8 byte" : "byte"} length '${marshal.length.parameter}' must name an un-marshalled usize value parameter`;
  }
  return {
    kind: marshal.kind === "string" ? "utf8" : "bytes",
    lengthIndex,
    pointee: pointee.signed ? "i8" : "u8",
  };
}

function bindingUnsupported(binding: CallableBinding): string | null {
  if (!["function", "factory", "method"].includes(binding.kind)) {
    return `binding kind '${binding.kind}'`;
  }
  if (binding.entry.kind !== "c-symbol") return `entry kind '${binding.entry.kind}'`;
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
    !binding.thread.blocking &&
    ((binding.thread.behavior === "any" && binding.thread.executor.kind === "any-attached-thread") ||
      (binding.thread.behavior === "require" && binding.thread.executor.kind === "runtime-owner"));
  if (!directThread) {
    return "thread, executor, or blocking semantics outside the direct-call slice";
  }
  if (
    binding.dependencies.adapterInputs.length > 0 ||
    binding.dependencies.permissions.length > 0
  ) {
    return "adapter or permission dependencies outside the direct-call slice";
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
  reachableBindingIds: readonly string[],
): ScriptCNativeTranslationResult {
  const diagnostics: ScriptCNativeTranslationDiagnostic[] = [];
  const bindings: ScriptCNativeBinding[] = [];
  const sourceTypes = new Map<NativeTypeId, ScriptCNativeSourceType>();
  const nativeTypes = new Map<NativeTypeId, ScriptCNativeTypeDefinition>();
  const visitedSourceTypes = new Set<NativeTypeId>();
  const activeTypes = new Set<NativeTypeId>();
  const linkInputIds = new Set<string>();

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
      if (nativeType.threadSafety !== "confined") {
        diagnostics.push(
          diagnostic(
            "NTS3002",
            path,
            `Handle thread safety '${nativeType.threadSafety}' is outside the owner-confined slice`,
          ),
        );
        return null;
      }
      const id = `${manifest.package.instance}#type:${typeId}`;
      const type = Object.freeze({ kind: "nativeHandle", typeId: id } as const);
      if (nativeTypes.has(typeId)) return type;
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
      const normalizedDeclaration = normalizeDeclaration(manifest, declaration);
      nativeTypes.set(typeId, Object.freeze({
        kind: "handle",
        id,
        declaration: normalizedDeclaration,
        nativeName: nativeType.nativeName,
        threadSafety: nativeType.threadSafety,
        identity: nativeType.identity,
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

  const reachable = new Set(reachableBindingIds);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const bindingId of [...reachable].sort()) {
      const binding = manifest.bindings[bindingId];
      if (
        binding === undefined || binding.kind === "constant" ||
        bindingUnsupported(binding) !== null
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
    const unsupported = bindingUnsupported(binding);
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
        !binding.thread.blocking)
    ) {
      diagnostics.push(
        diagnostic(
          "NTS3002",
          `${path}/thread`,
          "Opaque handles currently require a direct, nonblocking runtime-owner call",
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
    const callbackByFunction = new Map<number, CallScopedCallbackPair>();
    const callbackByContext = new Map<number, CallScopedCallbackPair>();
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
      if (borrowedByLength.has(pair.lengthIndex)) {
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
      borrowedByLength.set(pair.lengthIndex, pair);
    }
    for (const [index, parameter] of binding.signature.parameters.entries()) {
      if (parameter.callback === undefined) continue;
      const pair = supportedCallScopedCallbackPair(manifest, binding, index);
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
            type: borrowed.kind === "utf8"
              ? Object.freeze({ kind: "string" } as const)
              : Object.freeze({ kind: "bytes", elem: "u8" } as const),
          }),
        );
        argumentByParameter.set(index, argument);
        argumentByParameter.set(borrowed.lengthIndex, argument);
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
            ownership: Object.freeze({ kind: "callScoped" } as const),
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
            ownership: Object.freeze({ kind: "callScoped" } as const),
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
                  kind: borrowedData.kind === "utf8" ? "utf8Data" : "bytesData",
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
    const resultType = lowerType(
      binding.signature.result.type,
      `${resultPath}/type`,
    );
    if (resultType === null) valid = false;
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
    if (!valid || resultType === null) continue;

    for (const id of binding.dependencies.linkInputs) linkInputIds.add(id);
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
          ownership:
            binding.signature.result.ownership.kind === "owned" &&
              binding.signature.result.ownership.transfer === "to-runtime"
            ? Object.freeze({
                kind: "owned",
                transfer: "to-runtime",
                destructor: `${manifest.package.instance}#${binding.signature.result.ownership.destructor}`,
              } as const)
            : Object.freeze({ kind: "value" } as const),
        }),
      }),
    );
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
    }),
    linkInputIds: Object.freeze([...linkInputIds].sort()),
  });
}
