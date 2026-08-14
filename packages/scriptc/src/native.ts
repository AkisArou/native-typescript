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

export type ScriptCNativeAbiType = ScriptCNativeValueType | ScriptCNativePointerType;
export type ScriptCNativeArgumentType = ScriptCNativeValueType | { readonly kind: "string" };
export type ScriptCNativeParameterProjection =
  | { readonly kind: "argument"; readonly argument: number }
  | { readonly kind: "utf8Data"; readonly argument: number }
  | { readonly kind: "utf8ByteLength"; readonly argument: number };

export type ScriptCNativeIrType =
  | ScriptCNativeValueType
  | { readonly kind: "void" };

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
      | { readonly kind: "owned"; readonly transfer: "to-native" };
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
): string | null {
  const handle = type?.kind === "handle";
  if (position.passMode !== (handle ? "pointer" : "value")) {
    return `pass mode '${position.passMode}'`;
  }
  if (position.nullable) return "nullable values";
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

type Utf8ParameterPair = {
  readonly lengthIndex: number;
  readonly pointee: "i8" | "u8";
};

function supportedUtf8Pair(
  manifest: ScabiManifest,
  binding: CallableBinding,
  dataIndex: number,
): Utf8ParameterPair | string {
  const data = binding.signature.parameters[dataIndex]!;
  const marshal = data.marshal;
  if (
    marshal?.kind !== "string" ||
    marshal.encoding !== "utf-8" ||
    marshal.termination !== "none" ||
    marshal.embeddedNul !== "allow" ||
    marshal.length.kind !== "parameter"
  ) {
    return "only borrowed UTF-8 strings with explicit byte length, no terminator, and embedded NULs allowed are supported";
  }
  const pointer = manifest.types[data.type];
  const pointee = pointer?.kind === "pointer" ? manifest.types[pointer.pointee] : undefined;
  if (
    data.passMode !== "pointer" || data.nullable ||
    data.ownership.kind !== "borrowed" || data.ownership.scope !== "call" ||
    data.callback !== undefined ||
    pointer?.kind !== "pointer" || pointer.mutability !== "const" ||
    pointer.nullable || pointer.addressSpace !== 0 ||
    pointee?.kind !== "integer" || pointee.bits !== 8
  ) {
    return "UTF-8 data must be a non-null borrowed const i8/u8 pointer in address space zero";
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
    return `UTF-8 byte length '${marshal.length.parameter}' must name an un-marshalled usize value parameter`;
  }
  return {
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
  if (binding.error.kind !== "no-fail") return `error contract '${binding.error.kind}'`;
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
 * exact-scalar, trivial native-struct, borrowed UTF-8, and owner-confined
 * handle IR.
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
    const utf8ByData = new Map<number, Utf8ParameterPair>();
    const utf8ByLength = new Map<number, Utf8ParameterPair>();
    const directTypes = new Map<number, ScriptCNativeValueType>();
    const argumentByParameter = new Map<number, number>();
    let valid = true;
    for (const [index, parameter] of binding.signature.parameters.entries()) {
      if (parameter.marshal === undefined) continue;
      const pair = supportedUtf8Pair(manifest, binding, index);
      if (typeof pair === "string") {
        diagnostics.push(
          diagnostic("NTS3002", `${path}/signature/parameters/${index}`, pair),
        );
        valid = false;
        continue;
      }
      if (utf8ByLength.has(pair.lengthIndex)) {
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
      utf8ByData.set(index, pair);
      utf8ByLength.set(pair.lengthIndex, pair);
    }
    for (const [index, parameter] of binding.signature.parameters.entries()) {
      const parameterPath = `${path}/signature/parameters/${index}`;
      if (utf8ByLength.has(index)) continue;
      const utf8 = utf8ByData.get(index);
      if (utf8 !== undefined) {
        const argument = sourceArguments.length;
        sourceArguments.push(
          Object.freeze({
            name: parameter.name,
            type: Object.freeze({ kind: "string" }),
          }),
        );
        argumentByParameter.set(index, argument);
        argumentByParameter.set(utf8.lengthIndex, argument);
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
        const utf8Data = utf8ByData.get(index);
        const utf8Length = utf8ByLength.get(index);
        const directType = directTypes.get(index);
        parameters.push(Object.freeze(
          utf8Data !== undefined
            ? {
                name: parameter.name,
                type: Object.freeze({
                  kind: "nativePointer",
                  pointee: utf8Data.pointee,
                  const: true,
                  addressSpace: 0,
                } as const),
                passMode: "pointer",
                ownership: Object.freeze({ kind: "borrowed", scope: "call" } as const),
                projection: Object.freeze({ kind: "utf8Data", argument } as const),
              }
            : utf8Length !== undefined
              ? {
                  name: parameter.name,
                  type: Object.freeze({ kind: "nativeScalar", scalar: "usize" } as const),
                  passMode: "value",
                  ownership: Object.freeze({ kind: "value" } as const),
                  projection: Object.freeze({ kind: "utf8ByteLength", argument } as const),
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
