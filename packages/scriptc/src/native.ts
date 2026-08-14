import type {
  AbiParameter,
  AbiResult,
  CallableBinding,
  DeclarationReference,
  NativeTypeId,
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
  | "u64";

export type ScriptCNativeIrType =
  | {
      readonly kind: "nativeScalar";
      readonly scalar: ScriptCNativeIntegerScalar;
    }
  | { readonly kind: "void" };

export interface ScriptCNativeSourceType {
  readonly declaration: ScriptCNativeDeclaration;
  readonly type: Exclude<ScriptCNativeIrType, { readonly kind: "void" }>;
}

export interface ScriptCNativeBinding {
  readonly id: string;
  readonly declaration: ScriptCNativeDeclaration;
  readonly entry: { readonly kind: "c-symbol"; readonly symbol: string };
  readonly callingConvention: "c";
  readonly variadic: false;
  readonly parameters: readonly {
    readonly name: string;
    readonly type: Exclude<ScriptCNativeIrType, { readonly kind: "void" }>;
    readonly passMode: "value";
  }[];
  readonly result: {
    readonly type: ScriptCNativeIrType;
    readonly passMode: "value";
  };
}

/** Generic input consumed by the ScriptC frontend. It contains no SCABI or
 * target-specific concepts: source identities prove checker types, while
 * the binding table is the exact Native IR contract emitted after
 * reachability. */
export interface ScriptCNativeFrontendInput {
  readonly sourceTypes: readonly ScriptCNativeSourceType[];
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
): string | null {
  if (position.passMode !== "value") return `pass mode '${position.passMode}'`;
  if (position.nullable) return "nullable values";
  if (position.ownership.kind !== "value") {
    return `ownership '${position.ownership.kind}'`;
  }
  if (position.marshal !== undefined) return `marshalling '${position.marshal.kind}'`;
  if (isParameter && (position as AbiParameter).callback !== undefined) {
    return "callback parameters";
  }
  return null;
}

function bindingUnsupported(binding: CallableBinding): string | null {
  if (binding.kind !== "function") return `binding kind '${binding.kind}'`;
  if (binding.entry.kind !== "c-symbol") return `entry kind '${binding.entry.kind}'`;
  if (binding.signature.callingConvention !== "c") {
    return `calling convention '${binding.signature.callingConvention}'`;
  }
  if (binding.signature.variadic !== false) return "variadic calls";
  if (binding.error.kind !== "no-fail") return `error contract '${binding.error.kind}'`;
  if (
    binding.thread.behavior !== "any" ||
    binding.thread.executor.kind !== "any-attached-thread" ||
    binding.thread.blocking
  ) {
    return "thread, executor, or blocking semantics outside the direct-call slice";
  }
  if (
    binding.dependencies.bindings.length > 0 ||
    binding.dependencies.adapterInputs.length > 0 ||
    binding.dependencies.permissions.length > 0
  ) {
    return "binding, adapter, or permission dependencies outside the direct-call slice";
  }
  return null;
}

/** Translate the reachable SCABI bindings supported by ScriptC's current
 * exact-scalar Native IR. Unsupported unreachable records remain inert;
 * requested records fail with a precise manifest path. */
export function translateScabiNativeProgram(
  manifest: ScabiManifest,
  reachableBindingIds: readonly string[],
): ScriptCNativeTranslationResult {
  const diagnostics: ScriptCNativeTranslationDiagnostic[] = [];
  const bindings: ScriptCNativeBinding[] = [];
  const sourceTypes = new Map<NativeTypeId, ScriptCNativeSourceType>();
  const visitedSourceTypes = new Set<NativeTypeId>();
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
    if (
      nativeType.kind !== "integer" ||
      (nativeType.bits !== 8 &&
        nativeType.bits !== 16 &&
        nativeType.bits !== 32 &&
        nativeType.bits !== 64)
    ) {
      diagnostics.push(
        diagnostic(
          "NTS3002",
          path,
          `Native type '${typeId}' is outside ScriptC's exact fixed-width-integer slice`,
        ),
      );
      return null;
    }
    const scalar: ScriptCNativeIntegerScalar =
      `${nativeType.signed ? "i" : "u"}${nativeType.bits}`;
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
  };

  for (const bindingId of [...new Set(reachableBindingIds)].sort()) {
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

    const parameters: Array<ScriptCNativeBinding["parameters"][number]> = [];
    let valid = true;
    for (const [index, parameter] of binding.signature.parameters.entries()) {
      const parameterPath = `${path}/signature/parameters/${index}`;
      const unsupportedPosition = positionUnsupported(parameter, true);
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
      parameters.push(
        Object.freeze({ name: parameter.name, type, passMode: "value" }),
      );
    }

    const resultPath = `${path}/signature/result`;
    const unsupportedResult = positionUnsupported(binding.signature.result, false);
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
        parameters: Object.freeze(parameters),
        result: Object.freeze({ type: resultType, passMode: "value" }),
      }),
    );
  }

  if (diagnostics.length > 0) {
    return Object.freeze({ ok: false, diagnostics: Object.freeze(diagnostics) });
  }
  return Object.freeze({
    ok: true,
    input: Object.freeze({
      sourceTypes: Object.freeze([...sourceTypes.values()]),
      bindings: Object.freeze(bindings),
    }),
    linkInputIds: Object.freeze([...linkInputIds].sort()),
  });
}
