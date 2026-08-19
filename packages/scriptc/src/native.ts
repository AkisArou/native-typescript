import { isDeepStrictEqual } from "node:util";
import type {
  AdapterInput,
  AbiParameter,
  AbiResult,
  CallableBinding,
  DeclarationReference,
  ErrorContract,
  LinkInput,
  NativeTypeId,
  NativeType,
  NativePhysicalAbiType,
  NativePhysicalAbiValue,
  OwnershipContract,
  ScabiManifest,
} from "@native-typescript/scabi";

/**
 * Whether a contract decides failure by reading the call's own result.
 *
 * The distinction is what lets a failable operation hand something back. A
 * result the source sees transformed — a boolean over an integer, a double
 * widened out of an exact slot, a handle whose NULL means absence — cannot
 * also be the thing a contract inspects, because the two would read the same
 * bytes and disagree about what they mean. A failure that arrives anywhere
 * else reads nothing here and constrains nothing.
 */
export function errorContractReadsResult(error: ErrorContract): boolean {
  return error.kind !== "no-fail" && error.kind !== "error-out";
}

export interface ScriptCNativeDeclaration {
  readonly module: string;
  readonly name: string;
}

/* The native vocabulary is the compiler's, and this is where it enters. Every
 * name below is one the compiler publishes; none is restated here.
 *
 * It used to be restated here, all of it, and record 0006 measures what that
 * cost: two declarations of one format, kept in agreement by review, in two
 * repositories that typecheck independently. The import is by SOURCE PATH and
 * type-only on purpose — the published format is a declaration file, so it
 * carries no runtime value, needs no build of the submodule, and resolves on a
 * clean checkout before anything has been compiled.
 *
 * The `ScriptCNative` names stay because they are this package's public
 * surface; each is an alias of the one declaration rather than a second one. */
import type {
  IrNativeAbiType,
  IrNativeArgumentType,
  IrNativeCallbackArgumentType,
  IrNativeCallbackContract,
  IrNativeCallbackSignature,
  IrNativeCallbackSourceArgument,
  IrNativeCallbackType,
  IrNativeContextType,
  IrNativeErrorContract,
  IrNativeErrorOutType,
  IrNativeFailureDetection,
  IrNativeFailureMessage,
  IrNativeFailureRelease,
  IrNativeIntegerScalar,
  IrNativeParameterProjection,
  IrNativePhysicalAbiType,
  IrNativePhysicalAbiValue,
  IrNativePointerType,
  IrNativeResultAbiType,
  IrNativeResultProjection,
  IrNativeScalar,
  IrNativeValueType,
  NativeFrontendBinding,
  NativeFrontendConstant,
  NativeFrontendExport,
  NativeFrontendInput,
  NativeFrontendOperation,
  NativeHandleDefinition,
  NativeSourceType,
  NativeStructDefinition,
  NativeTypeDefinition,
} from "../../../third_party/scriptc/packages/compiler/src/native-manifest.d.ts";

export type ScriptCNativeAbiType = IrNativeAbiType;
export type ScriptCNativeArgumentType = IrNativeArgumentType;
export type ScriptCNativeBinding = NativeFrontendBinding;
export type ScriptCNativeCallbackArgumentType = IrNativeCallbackArgumentType;
export type ScriptCNativeCallbackContract = IrNativeCallbackContract;
export type ScriptCNativeCallbackSignature = IrNativeCallbackSignature;
export type ScriptCNativeCallbackSourceArgument = IrNativeCallbackSourceArgument;
export type ScriptCNativeCallbackType = IrNativeCallbackType;
export type ScriptCNativeConstant = NativeFrontendConstant;
export type ScriptCNativeContextType = IrNativeContextType;
export type ScriptCNativeErrorContract = IrNativeErrorContract;
export type ScriptCNativeErrorOutType = IrNativeErrorOutType;
export type ScriptCNativeExport = NativeFrontendExport;
export type ScriptCNativeFailureDetection = IrNativeFailureDetection;
export type ScriptCNativeFailureMessage = IrNativeFailureMessage;
export type ScriptCNativeFailureRelease = IrNativeFailureRelease;
export type ScriptCNativeFrontendInput = NativeFrontendInput;
export type ScriptCNativeHandleDefinition = NativeHandleDefinition;
export type ScriptCNativeIntegerScalar = IrNativeIntegerScalar;
export type ScriptCNativeOperation = NativeFrontendOperation;
export type ScriptCNativeParameterProjection = IrNativeParameterProjection;
export type ScriptCNativePhysicalAbiType = IrNativePhysicalAbiType;
export type ScriptCNativePhysicalAbiValue = IrNativePhysicalAbiValue;
export type ScriptCNativePointerType = IrNativePointerType;
export type ScriptCNativeResultAbiType = IrNativeResultAbiType;
export type ScriptCNativeResultProjection = IrNativeResultProjection;
export type ScriptCNativeScalar = IrNativeScalar;
export type ScriptCNativeSourceType = NativeSourceType;
export type ScriptCNativeStructDefinition = NativeStructDefinition;
export type ScriptCNativeTypeDefinition = NativeTypeDefinition;
export type ScriptCNativeValueType = IrNativeValueType;
export type ScriptCNativeIrType =
  | ScriptCNativeValueType
  | { readonly kind: "void" };

function freezePhysicalAbiType(type: NativePhysicalAbiType): ScriptCNativePhysicalAbiType {
  switch (type.kind) {
    case "array":
      return Object.freeze({ ...type, element: freezePhysicalAbiType(type.element) });
    case "vector":
      return Object.freeze({ ...type, element: freezePhysicalAbiType(type.element) });
    case "struct":
      return Object.freeze({ ...type, fields: Object.freeze(type.fields.map(freezePhysicalAbiType)) });
    default:
      return Object.freeze({ ...type });
  }
}

function freezePhysicalAbiValue(value: NativePhysicalAbiValue): ScriptCNativePhysicalAbiValue {
  return Object.freeze({ ...value, type: freezePhysicalAbiType(value.type) });
}

const NO_NATIVE_FAILURE = Object.freeze({
  detect: Object.freeze({ kind: "never" } as const),
  message: Object.freeze({ kind: "none" } as const),
  release: Object.freeze({ kind: "none" } as const),
} as const);

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

function bindingDeclarationKey(binding: ScriptCNativeBinding): string {
  const role = binding.sourceCall.kind === "getter"
    ? "read"
    : binding.sourceCall.kind === "setter"
      ? "write"
      : "call";
  return `${declarationKey(binding.declaration)}\u0000${role}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalConstantValue(
  value: string | number | boolean,
  scalar: ScriptCNativeScalar,
  pointerBits: 32 | 64,
): string | null {
  if (typeof value === "boolean") return null;
  if (scalar === "f64") {
    if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
      return null;
    }
    return String(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) return null;
  } else if (
    value.length > 20 ||
    !/^-?(?:0|[1-9][0-9]*)$/u.test(value) ||
    value === "-0"
  ) {
    return null;
  }
  const numeric = BigInt(value);
  const bits = scalar === "isize" || scalar === "usize"
    ? pointerBits
    : Number(scalar.slice(1));
  const signed = scalar.startsWith("i");
  const minimum = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const maximum = signed
    ? (1n << BigInt(bits - 1)) - 1n
    : (1n << BigInt(bits)) - 1n;
  return numeric < minimum || numeric > maximum ? null : numeric.toString();
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
  const constants = new Map<string, ScriptCNativeConstant>();
  const constantsByDeclaration = new Map<string, ScriptCNativeConstant>();
  const operations = new Map<string, ScriptCNativeOperation>();
  const operationsByDeclaration = new Map<string, ScriptCNativeOperation>();
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
    program.input.constants.forEach((constant, index) => {
      const path = `${prefix}/input/constants/${index}`;
      addExact(constants, constant.id, constant, path, "constant id");
      addExact(
        constantsByDeclaration,
        declarationKey(constant.declaration),
        constant,
        path,
        "constant declaration",
      );
    });
    program.input.operations.forEach((operation, index) => {
      const path = `${prefix}/input/operations/${index}`;
      addExact(operations, operation.id, operation, path, "operation id");
      addExact(
        operationsByDeclaration,
        declarationKey(operation.declaration),
        operation,
        path,
        "operation declaration",
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
        bindingDeclarationKey(binding),
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
  // A package that imports a type emits a reference into the owning package's
  // instance without ever seeing the definition. Composition is the first
  // stage that sees both, so it is where an unresolved or structurally
  // incompatible import has to fail.
  // Every composed identity is `<package instance>#...`, so the set of
  // instances present in the program can be recovered from its ids. A package
  // that reached only a scalar binding still appears, which is what lets an
  // unresolved import distinguish "package absent" from "type not reached".
  const composedInstances = new Set(
    [
      ...types.keys(),
      ...bindings.keys(),
      ...constants.keys(),
      ...operations.keys(),
      ...exports.keys(),
    ].flatMap((id) => {
      const separator = id.indexOf("#");
      return separator < 0 ? [] : [id.slice(0, separator)];
    }),
  );
  for (const type of types.values()) {
    if (type.kind !== "handle") continue;
    for (const [index, upcast] of type.upcasts.entries()) {
      const target = types.get(upcast.target);
      const path = `/input/types/${type.id}/upcasts/${index}/target`;
      if (target === undefined) {
        // Distinguish an absent package from one that is composed but never
        // reached the type. Only the owning package can pull its own type in,
        // so an importer cannot tell these apart on its own.
        const owner = upcast.target.split("#type:")[0] ?? "";
        diagnostics.push(diagnostic(
          "NTS3002",
          path,
          composedInstances.has(owner)
            ? `Native handle upcast target '${upcast.target}' is owned by composed ` +
              `package '${owner}', which did not reach it. Select a binding that ` +
              "reaches the base handle in that package."
            : `Native handle upcast target '${upcast.target}' is not provided by any composed package`,
        ));
        continue;
      }
      if (target.kind !== "handle") {
        diagnostics.push(diagnostic(
          "NTS3002",
          path,
          `Native handle upcast target '${upcast.target}' is not a handle`,
        ));
        continue;
      }
      if (
        target.threadSafety !== type.threadSafety ||
        target.identity !== type.identity
      ) {
        diagnostics.push(diagnostic(
          "NTS3002",
          path,
          `Native handle upcast target '${upcast.target}' does not share the ` +
            "thread-safety and identity contracts of its derived handle",
        ));
      }
    }
  }
  /* A handle's destructor may be the owning package's binding, named by an
   * importer that never saw the definition. Composition is the first stage
   * that sees both, so an unresolved one fails here rather than as an
   * anonymous missing symbol at emission. */
  for (const binding of bindings.values()) {
    const ownership = binding.result.ownership;
    const named = [
      ...(ownership.kind === "owned" && ownership.transfer === "to-runtime"
        ? [ownership.destructor]
        : []),
      ...binding.arguments.flatMap((argument) =>
        argument.callback === undefined
          ? []
          : argument.callback.sourceArguments.flatMap((source) =>
            source.kind === "callback-parameter" && source.destructor !== undefined
              ? [source.destructor]
              : []
          )
      ),
    ];
    for (const destructor of named) {
      if (bindings.has(destructor)) continue;
      const owner = destructor.split("#")[0] ?? "";
      diagnostics.push(diagnostic(
        "NTS3002",
        `/input/bindings/${binding.id}`,
        composedInstances.has(owner)
          ? `Destructor '${destructor}' is owned by composed package '${owner}', ` +
            "which did not reach it. Select a binding that reaches the handle in that package."
          : `Destructor '${destructor}' is not provided by any composed package`,
      ));
    }
  }
  /* Collector visibility is derived per package, but the invariant behind it
   * is global: upcast-connected declarations can denote one managed cell, so
   * the collector must trace all of them or none. Each package propagates over
   * its own upcasts, and only composition can see an edge whose target is
   * owned elsewhere — a package that reached a derived handle without reaching
   * whatever makes its base traceable would otherwise contradict the package
   * that owns the base. Unlike thread-safety and identity this is reconciled
   * rather than rejected: it is a conclusion, not a declared contract. */
  const traceableTypeIds = new Set<string>();
  for (const type of types.values()) {
    if (type.kind === "handle" && type.cycleCollection === "traceable") {
      traceableTypeIds.add(type.id);
    }
  }
  let traceabilityPropagated = true;
  while (traceabilityPropagated) {
    traceabilityPropagated = false;
    for (const type of types.values()) {
      if (type.kind !== "handle") continue;
      for (const upcast of type.upcasts) {
        if (!types.has(upcast.target)) continue;
        if (traceableTypeIds.has(type.id) === traceableTypeIds.has(upcast.target)) {
          continue;
        }
        traceableTypeIds.add(type.id);
        traceableTypeIds.add(upcast.target);
        traceabilityPropagated = true;
      }
    }
  }
  for (const [id, type] of types) {
    if (type.kind !== "handle") continue;
    const cycleCollection = traceableTypeIds.has(id) ? "traceable" : "none";
    if (type.cycleCollection === cycleCollection) continue;
    types.set(id, Object.freeze({ ...type, cycleCollection }));
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
      constants: Object.freeze([...constants.values()].sort((left, right) =>
        compareText(left.id, right.id)
      )),
      operations: Object.freeze([...operations.values()].sort((left, right) =>
        compareText(left.id, right.id)
      )),
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

/**
 * The kind of the type a position names.
 *
 * An imported type is a handle: only a handle may be imported, because a
 * handle is the one thing a signature can carry without its definition — the
 * pointer is the whole representation. The definition is the owning package's,
 * and composition proves it is there and is what this assumed.
 */
function positionTypeKind(
  manifest: ScabiManifest,
  typeId: NativeTypeId,
): NativeType["kind"] | undefined {
  const declared = manifest.types[typeId];
  if (declared !== undefined) return declared.kind;
  return manifest.imports?.[typeId] === undefined ? undefined : "handle";
}

/**
 * The compiler identity of the binding that releases an owned value.
 *
 * A handle names its destructor on its type, because how it is released
 * follows the object rather than the call that produced one — and an imported
 * handle's is the owning package's, restated by the import in the owner's
 * identity because no definition is visible here. Everything else owned names
 * one on the position, where the producer really does decide the free.
 */
function ownedDestructor(
  manifest: ScabiManifest,
  typeId: NativeTypeId,
  ownership: OwnershipContract,
): string | null {
  if (ownership.kind !== "owned" || ownership.transfer !== "to-runtime") return null;
  if (ownership.destructor !== undefined) {
    return `${manifest.package.instance}#${ownership.destructor}`;
  }
  const declared = manifest.types[typeId];
  if (declared !== undefined) {
    return declared.kind === "handle" && declared.destructor !== undefined
      ? `${manifest.package.instance}#${declared.destructor}`
      : null;
  }
  const imported = manifest.imports?.[typeId];
  return imported?.destructor === undefined
    ? null
    : `${imported.package.instance}#${imported.destructor}`;
}

function positionUnsupported(
  position: AbiResult,
  isParameter: boolean,
  kind: NativeType["kind"] | undefined,
  allowNullable = false,
): string | null {
  const handle = kind === "handle";
  if (position.passMode !== (handle ? "pointer" : "value")) {
    return `pass mode '${position.passMode}'`;
  }
  const nonNullManagedHandleArgument =
    handle &&
    isParameter &&
    position.ownership.kind === "owned" &&
    position.ownership.transfer === "to-native";
  // A borrowed handle input may be omitted: the source gains a null arm while
  // the ABI slot stays one pointer.
  const optionalHandleArgument =
    handle &&
    isParameter &&
    position.ownership.kind === "borrowed" &&
    position.ownership.scope === "call";
  if (
    position.nullable &&
    !allowNullable &&
    !nonNullManagedHandleArgument &&
    !optionalHandleArgument
  ) {
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
  readonly nullable: boolean;
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
    (binding.kind !== "method" && binding.kind !== "getter") ||
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

/** The conversions one exact scalar declares.
 *
 * Only the conversions: every arithmetic operation, the trapping ones
 * included, is an ordinary operator expression inside the construction that
 * names its exact type. A conversion has no operator to be — nothing in the
 * syntax names a direction — and it cannot borrow JavaScript's `Number(v)`
 * or `BigInt(n)`, which mean something else here: one rounds silently where
 * this refuses, and the other is arbitrary precision where this slot has a
 * width. */
function scalarOperations(
  manifest: ScabiManifest,
  typeId: NativeTypeId,
  declaration: ScriptCNativeDeclaration,
  type: { readonly kind: "nativeScalar"; readonly scalar: ScriptCNativeScalar },
): readonly ScriptCNativeOperation[] {
  const identity = (member: string) => ({
    id: `${manifest.package.instance}#source-operation/${typeId}/${member}`,
    declaration: Object.freeze({
      module: declaration.module,
      name: `${declaration.name}.${member}`,
    }),
  });
  return Object.freeze([
    Object.freeze({ ...identity("toNumber"), kind: "to-number" as const, type }),
    Object.freeze({ ...identity("fromNumber"), kind: "from-number" as const, type }),
  ]);
}

/** The exact scalars a double carries injectively, so a widening loses
 * nothing and a checked ingress can always be undone by reading the value
 * back. `f64` is the identity case — the slot is the double. */
function widensToNumber(scalar: ScriptCNativeScalar): boolean {
  return scalar === "f32" || scalar === "f64" || scalar === "i8" ||
    scalar === "u8" || scalar === "i16" || scalar === "u16" ||
    scalar === "i32" || scalar === "u32";
}

/** Every scalar a position may carry a number over. The wider integers
 * qualify because both directions are checked: a double that is whole and in
 * range converts exactly however wide the slot is, and reading one answers
 * only when the double denotes the same integer. A struct field is not a
 * position — a field read has nowhere to fail — so it keeps the narrow
 * rule. */
function carriesNumber(scalar: ScriptCNativeScalar): boolean {
  return widensToNumber(scalar) || scalar === "i64" || scalar === "u64" ||
    scalar === "isize" || scalar === "usize";
}

type SupportedCallbackPair = {
  readonly functionIndex: number;
  readonly contextIndex: number;
  readonly parameterTypeIds: readonly NativeTypeId[];
  readonly sourceArguments: readonly (
    | {
        readonly kind: "callback-parameter";
        readonly parameter: number;
        readonly typeId: NativeTypeId;
        /**
         * How the physical value becomes the value the source sees. A scalar
         * is itself; a UTF-8 C string is copied, because a queued delivery
         * outlives the pointer the emitter handed over; a converted integer
         * widens to a plain number when the delivery reads it.
         */
        readonly projection: "direct" | "utf8CString" | "ownedHandle" | "number";
        /** The binding that gives the reference back, for an owned handle. */
        readonly destructor?: string;
      }
    | {
        readonly kind: "registration-owner";
        readonly typeId: NativeTypeId;
      }
  )[];
  readonly resultTypeId: NativeTypeId;
  readonly contract: ScriptCNativeCallbackContract;
};

function supportedCallbackSourceArguments(
  manifest: ScabiManifest,
  binding: CallableBinding,
  callbackType: Extract<NativeType, { readonly kind: "callback" }>,
  contract: NonNullable<AbiParameter["callback"]>,
): SupportedCallbackPair["sourceArguments"] | string {
  const sourceArguments = contract.sourceArguments ??
    callbackType.signature.parameters.map(({ name }) => ({
      kind: "callback-parameter" as const,
      parameter: name,
    }));
  const physicalIndexByName = new Map(
    callbackType.signature.parameters.map((parameter, index) => [parameter.name, index]),
  );
  const projectedPhysical = new Set<number>();
  let ownerProjected = false;
  const result: Array<SupportedCallbackPair["sourceArguments"][number]> = [];
  for (const argument of sourceArguments) {
    if (argument.kind === "callback-parameter") {
      const parameter = physicalIndexByName.get(argument.parameter);
      if (parameter === undefined || projectedPhysical.has(parameter)) {
        return "callback source arguments must project each physical parameter exactly once";
      }
      projectedPhysical.add(parameter);
      const physical = callbackType.signature.parameters[parameter]!;
      const string = borrowedUtf8CString(manifest, physical);
      if (typeof string === "string") return string;
      const owned = positionTypeKind(manifest, physical.type) === "handle"
        ? ownedDestructor(manifest, physical.type, physical.ownership) ?? undefined
        : undefined;
      result.push(Object.freeze({
        kind: "callback-parameter",
        parameter,
        typeId: physical.type,
        projection: owned !== undefined
          ? "ownedHandle"
          : physical.conversion === "number"
            ? "number"
            : string === null
              ? "direct"
              : "utf8CString",
        ...(owned === undefined ? {} : { destructor: owned }),
      }));
      continue;
    }
    if (
      ownerProjected ||
      contract.registrationOwner === "native-call" ||
      contract.registrationOwner === "result"
    ) {
      return "a callback can inject only one receiver registration owner";
    }
    const owner = binding.signature.parameters.find(
      ({ name }) => name === contract.registrationOwner,
    );
    if (owner === undefined) return "callback registration owner does not exist";
    ownerProjected = true;
    result.push(Object.freeze({
      kind: "registration-owner",
      typeId: owner.type,
    }));
  }
  if (projectedPhysical.size !== callbackType.signature.parameters.length) {
    return "callback source arguments must project every physical parameter";
  }
  return Object.freeze(result);
}

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
    contract.registrationOwner !== "native-call" ||
    contract.cancellationBinding !== undefined ||
    contract.contextParameter === undefined ||
    contract.allowedInvocationExecutors.length !== 1 ||
    contract.allowedInvocationExecutors[0]?.kind !== "same-as-caller" ||
    !contract.synchronousReturn
  ) {
    return "only synchronous same-caller call-owned callbacks are supported";
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
  /* An enumeration is its underlying integer at the ABI, and its members are
   * proven constants of that integer. Passing one by value is passing that
   * integer, so a callback payload may name an enumeration wherever it may
   * name the integer it stores. */
  const valueStorage = (typeId: string): NativeType | undefined => {
    const type = manifest.types[typeId];
    return type?.kind === "enum" || type?.kind === "flags"
      ? manifest.types[type.underlying]
      : type;
  };
  const supportedScalarPosition = (position: AbiParameter | AbiResult): boolean => {
    const type = valueStorage(position.type);
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
  const sourceArguments = supportedCallbackSourceArguments(manifest, binding, callbackType, contract);
  if (typeof sourceArguments === "string") return sourceArguments;
  return {
    functionIndex: callbackIndex,
    contextIndex,
    parameterTypeIds: callbackType.signature.parameters.map((position) => position.type),
    sourceArguments,
    resultTypeId: callbackType.signature.result.type,
    contract: Object.freeze({
      owner: Object.freeze({ kind: "call" as const }),
      allowedInvocationExecutors: Object.freeze(["same-as-caller"] as const),
      synchronousReturn: true,
      sourceArguments: Object.freeze(sourceArguments.map((argument) =>
        argument.kind === "callback-parameter"
          ? Object.freeze({
              kind: "callback-parameter" as const,
              parameter: argument.parameter,
              ...(argument.destructor === undefined
                ? {}
                : { destructor: argument.destructor }),
            })
          : Object.freeze({ kind: "registration-owner" as const })
      )),
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
  const registrationOwnerIndex = contract?.registrationOwner === "result"
    ? -1
    : binding.signature.parameters.findIndex(
      ({ name }) => name === contract?.registrationOwner,
    );
  const registrationOwner = registrationOwnerIndex < 0
    ? undefined
    : binding.signature.parameters[registrationOwnerIndex];
  if (
    contract === undefined ||
    parameter.passMode !== "pointer" ||
    parameter.nullable ||
    parameter.ownership.kind !== "borrowed" ||
    parameter.ownership.scope !== "registration" ||
    parameter.ownership.anchor !== contract.registrationOwner ||
    parameter.marshal !== undefined ||
    callbackType?.kind !== "callback"
  ) {
    return "retained callback data must be a non-null registration-borrowed C callback pointer anchored to the result";
  }
  const allowedInvocationExecutors = contract.allowedInvocationExecutors.map(
    (executor) => executor.kind,
  );
  if (
    contract.registrationOwner === "native-call" ||
    (contract.registrationOwner !== "result" &&
      (binding.kind !== "method" ||
        registrationOwnerIndex !== 0 ||
        registrationOwner === undefined ||
        manifest.types[registrationOwner.type]?.kind !== "handle" ||
        registrationOwner.passMode !== "pointer" ||
        registrationOwner.nullable ||
        registrationOwner.ownership.kind !== "borrowed" ||
        registrationOwner.ownership.scope !== "call")) ||
    contract.cancellationBinding === undefined ||
    contract.contextParameter === undefined ||
    allowedInvocationExecutors.length === 0 ||
    allowedInvocationExecutors.some(
      (executor) => executor !== "same-as-caller" && executor !== "any-attached-thread",
    ) ||
    new Set(allowedInvocationExecutors).size !== allowedInvocationExecutors.length
    /* Two deliveries, and the contract no longer states which: the ordinary
     * one queues onto the runtime owner and answers nothing, the answering
     * one runs on the caller's thread because its result is the emitting
     * call's result. `synchronousReturn` is the whole discriminant, so there
     * is nothing left here to disagree with it. */
  ) {
    return "only until-cancelled callbacks delivered onto the runtime owner, or answered on the caller's thread, with explicit result or receiver ownership are supported";
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
  /* An enumeration is its underlying integer at the ABI, and its members are
   * proven constants of that integer. Passing one by value is passing that
   * integer, so a callback payload may name an enumeration wherever it may
   * name the integer it stores. */
  const valueStorage = (typeId: string): NativeType | undefined => {
    const type = manifest.types[typeId];
    return type?.kind === "enum" || type?.kind === "flags"
      ? manifest.types[type.underlying]
      : type;
  };
  const supportedScalarPosition = (position: AbiParameter | AbiResult): boolean => {
    const type = valueStorage(position.type);
    return position.passMode === "value" &&
      !position.nullable &&
      position.ownership.kind === "value" &&
      position.marshal === undefined &&
      (!("callback" in position) || position.callback === undefined) &&
      (type?.kind === "integer" || (type?.kind === "float" && type.bits === 64));
  };
  /* The emitter took a reference before queueing, so the invocation owns one
   * and the destructor gives it back whether the delivery runs or is
   * dropped. */
  function ownedHandlePosition(position: AbiParameter): boolean {
    return manifest.types[position.type]?.kind === "handle" &&
      position.passMode === "pointer" &&
      !position.nullable &&
      position.marshal === undefined &&
      position.callback === undefined &&
      position.ownership.kind === "owned" &&
      position.ownership.transfer === "to-runtime";
  }
  /* A retained payload may also be a borrowed UTF-8 C string. Delivery is
   * queued, so the runtime copies it when the signal fires rather than holding
   * a pointer the emitter is free to reuse. */
  function supportedRetainedPosition(position: AbiParameter): boolean {
    return supportedScalarPosition(position) ||
      ownedHandlePosition(position) ||
      (typeof borrowedUtf8CString(manifest, position) === "object" &&
        !position.nullable);
  }
  /* A registration the native side ASKS: the handler runs during the
   * emitting call and its answer is that call's result. Only values can
   * cross, because nothing here outlives the call — a copied string or a
   * referenced object payload would have no owner — and the answer is a
   * boolean, which is the question a toolkit asks a handler. */
  const answered = contract.synchronousReturn === true;
  const answerType = manifest.types[callbackType.signature.result.type];
  if (answered) {
    const answerStorage = answerType?.kind === "boolean"
      ? manifest.types[answerType.storage]
      : undefined;
    const answerPosition = callbackType.signature.result;
    if (
      callbackType.signature.parameters.some(
        (position) => !supportedScalarPosition(position),
      ) ||
      answerStorage?.kind !== "integer" ||
      answerPosition.passMode !== "value" ||
      answerPosition.nullable ||
      answerPosition.ownership.kind !== "value" ||
      answerPosition.marshal !== undefined
    ) {
      return "a synchronously answered callback takes exact scalar values and answers with an ABI boolean";
    }
    if (
      contract.arguments.some((argument, index) =>
        argument.parameter !== callbackType.signature.parameters[index]?.name ||
        argument.transport !== "borrow"
      )
    ) {
      return "a synchronously answered callback borrows every parameter in ABI order";
    }
    if (allowedInvocationExecutors.some((executor) => executor !== "same-as-caller")) {
      return "a synchronously answered callback is invoked on the caller's thread";
    }
  } else if (
    callbackType.signature.parameters.some(
      (position) => !supportedRetainedPosition(position),
    ) ||
    manifest.types[callbackType.signature.result.type]?.kind !== "void"
  ) {
    return "retained callback parameters must be exact scalar values, borrowed UTF-8 strings, or owned handles, and its result must be void";
  }
  if (
    contract.arguments.length !== callbackType.signature.parameters.length ||
    (!answered && contract.arguments.some((argument, index) =>
      argument.parameter !== callbackType.signature.parameters[index]?.name ||
      argument.transport !== "copy"
    ))
  ) {
    return "retained callback transport must copy every callback parameter in ABI order";
  }
  const sourceArguments = supportedCallbackSourceArguments(manifest, binding, callbackType, contract);
  if (typeof sourceArguments === "string") return sourceArguments;
  if (
    sourceArguments.some(({ kind }) => kind === "registration-owner") &&
    allowedInvocationExecutors.some((executor) => executor !== "same-as-caller")
  ) {
    return "managed registration-owner injection requires same-caller native invocation";
  }
  const result = binding.signature.result;
  if (
    manifest.types[result.type]?.kind !== "handle" ||
    result.passMode !== "pointer" ||
    !result.nullable ||
    result.ownership.kind !== "owned" ||
    result.ownership.transfer !== "to-runtime" ||
    !binding.dependencies.bindings.includes(contract.cancellationBinding)
  ) {
    return `retained callback registration must return a nullable owned handle with declared cancellation dependency '${contract.cancellationBinding}'`;
  }
  const loweredRegistrationOwner = contract.registrationOwner === "result"
    ? Object.freeze({ kind: "result" } as const)
    : Object.freeze({
      kind: "argument" as const,
      argument: registrationOwnerIndex,
    });
  const cancellation = `${manifest.package.instance}#${contract.cancellationBinding}`;
  const loweredSourceArguments = Object.freeze(sourceArguments.map((argument) =>
    argument.kind === "callback-parameter"
      ? Object.freeze({
          kind: "callback-parameter" as const,
          parameter: argument.parameter,
          ...(argument.destructor === undefined
            ? {}
            : { destructor: argument.destructor }),
        })
      : Object.freeze({ kind: "registration-owner" as const })
  ));
  if (answered) {
    return {
      functionIndex: callbackIndex,
      contextIndex,
      parameterTypeIds: callbackType.signature.parameters.map((position) => position.type),
      sourceArguments,
      resultTypeId: callbackType.signature.result.type,
      contract: Object.freeze({
        owner: loweredRegistrationOwner,
        cancellationBinding: cancellation,
        allowedInvocationExecutors: Object.freeze(["same-as-caller"] as const),
        synchronousReturn: true,
        sourceArguments: loweredSourceArguments,
      }),
    };
  }
  return {
    functionIndex: callbackIndex,
    contextIndex,
    parameterTypeIds: callbackType.signature.parameters.map((position) => position.type),
    sourceArguments,
    resultTypeId: callbackType.signature.result.type,
    contract: Object.freeze({
      owner: loweredRegistrationOwner,
      cancellationBinding: cancellation,
      allowedInvocationExecutors: Object.freeze(
        allowedInvocationExecutors as ("same-as-caller" | "any-attached-thread")[],
      ),
      synchronousReturn: false,
      sourceArguments: loweredSourceArguments,
    }),
  };
}

function supportedCallbackPair(
  manifest: ScabiManifest,
  binding: CallableBinding,
  callbackIndex: number,
): SupportedCallbackPair | string {
  /* The owner is the lifetime: the native call owns a call-scoped
   * registration, and anything else owns one that outlives the call. */
  const owner = binding.signature.parameters[callbackIndex]?.callback?.registrationOwner;
  return owner === undefined
    ? "a callback parameter has no registration owner"
    : owner === "native-call"
      ? supportedCallScopedCallbackPair(manifest, binding, callbackIndex)
      : supportedRetainedCallbackPair(manifest, binding, callbackIndex);
}

/**
 * Classifies a borrowed NUL-terminated UTF-8 C string parameter.
 *
 * Returns null when the parameter is not one, a message when it claims to be
 * and is malformed, and the pointee otherwise. Used both for a binding's own
 * argument and for a retained callback's payload, so the two cannot disagree
 * about what a borrowed C string is.
 */
function borrowedUtf8CString(
  manifest: ScabiManifest,
  data: AbiParameter,
): { readonly pointee: "i8" | "u8"; readonly nullable: boolean } | string | null {
  const marshal = data.marshal;
  if (
    marshal?.kind !== "string" ||
    marshal.encoding !== "utf-8" ||
    marshal.termination !== "nul" ||
    marshal.embeddedNul !== "reject" ||
    marshal.length.kind !== "nul"
  ) {
    return null;
  }
  const pointer = manifest.types[data.type];
  const pointee = pointer?.kind === "pointer"
    ? manifest.types[pointer.pointee]
    : undefined;
  if (
    data.passMode !== "pointer" ||
    data.ownership.kind !== "borrowed" || data.ownership.scope !== "call" ||
    data.callback !== undefined ||
    pointer?.kind !== "pointer" || pointer.mutability !== "const" ||
    pointer.nullable !== data.nullable || pointer.addressSpace !== 0 ||
    pointee?.kind !== "integer" || pointee.bits !== 8
  ) {
    return "NUL-terminated UTF-8 data must be a borrowed const i8/u8 pointer in address space zero with matching nullability";
  }
  return { pointee: pointee.signed ? "i8" : "u8", nullable: data.nullable };
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
      const classified = borrowedUtf8CString(manifest, data);
      if (typeof classified === "string") return classified;
      if (classified === null) {
        return "NUL-terminated UTF-8 data must be a borrowed const i8/u8 pointer in address space zero with matching nullability";
      }
      return {
        kind: "utf8-c-string",
        pointee: classified.pointee,
        nullable: classified.nullable,
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
  if (!["function", "constructor", "factory", "method", "getter", "setter"].includes(binding.kind)) {
    return `binding kind '${binding.kind}'`;
  }
  if (binding.kind === "constructor" && binding.declaration.name.includes(".")) {
    return "constructor declaration identity must name its constructed type";
  }
  if (
    (binding.kind === "method" || binding.kind === "getter" || binding.kind === "setter") &&
    !binding.declaration.name.includes(".")
  ) {
    return `${binding.kind} declaration identity must name its containing type and member`;
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
  const constants: ScriptCNativeConstant[] = [];
  /* Keyed by operation id. A flags combine keys on its type because there is
   * exactly one; a scalar's operations key on their own ids. */
  const operations = new Map<string, ScriptCNativeOperation>();
  const bindings: ScriptCNativeBinding[] = [];
  const exports: ScriptCNativeExport[] = [];
  const sourceTypes = new Map<NativeTypeId, ScriptCNativeSourceType>();
  const nativeTypes = new Map<NativeTypeId, ScriptCNativeTypeDefinition>();
  const visitedSourceTypes = new Set<NativeTypeId>();
  const activeTypes = new Set<NativeTypeId>();
  const linkInputIds = new Set<string>();
  const adapterInputIds = new Set<string>();
  const traceableHandleTypeIds = new Set<NativeTypeId>();

  const lowerType = (
    typeId: NativeTypeId,
    path: string,
    sourceVisible = true,
  ): ScriptCNativeIrType | null => {
    const nativeType = manifest.types[typeId];
    if (nativeType === undefined) {
      // An imported type is defined by another package. Its compiler identity
      // is scoped to that package's instance, so the reference is built from
      // the declared owner rather than from this manifest. Composition proves
      // the owner is actually present and that the type is a handle; nothing
      // here can see the definition.
      const imported = manifest.imports?.[typeId];
      if (imported !== undefined) {
        return Object.freeze({
          kind: "nativeHandle",
          typeId: `${imported.package.instance}#type:${imported.type}`,
        } as const);
      }
      diagnostics.push(
        diagnostic("NTS3001", path, `Native type '${typeId}' does not exist`),
      );
      return null;
    }
    if (nativeType.kind === "void") return Object.freeze({ kind: "void" });
    if (nativeType.kind === "enum" || nativeType.kind === "flags") {
      const type = lowerType(nativeType.underlying, `${path}/underlying`, false);
      if (type === null) return null;
      if (
        type.kind !== "nativeScalar" ||
        type.scalar === "f64" || type.scalar === "f32"
      ) {
        diagnostics.push(diagnostic(
          "NTS3002",
          path,
          `Native ${nativeType.kind} type '${typeId}' does not have an exact integer underlying type`,
        ));
        return null;
      }
      const integerType = Object.freeze({
        kind: "nativeScalar",
        scalar: type.scalar,
      } as const);
      if (sourceVisible && !visitedSourceTypes.has(typeId)) {
        visitedSourceTypes.add(typeId);
        const declaration = manifest.declarations.types[typeId];
        if (declaration === undefined) {
          diagnostics.push(diagnostic(
            "NTS3003",
            `/declarations/types/${typeId}`,
            `Reachable native type '${typeId}' has no TypeScript declaration identity`,
          ));
        } else {
          const normalizedDeclaration = normalizeDeclaration(manifest, declaration);
          sourceTypes.set(typeId, Object.freeze({
            declaration: normalizedDeclaration,
            type,
          }));
          /* A flags type reached across a package boundary is defined here
           * for its ABI but declared as its owner's. Its combine belongs to
           * the owner too: synthesising a second one would have two packages
           * declaring the same member, which composition rejects. */
          if (
            nativeType.kind === "flags" &&
            normalizedDeclaration.module === manifest.package.name
          ) {
            operations.set(typeId, Object.freeze({
              id: `${manifest.package.instance}#source-operation/${typeId}/combine`,
              declaration: Object.freeze({
                module: normalizedDeclaration.module,
                name: `${normalizedDeclaration.name}.combine`,
              }),
              kind: "integer-reduce",
              operator: "|",
              type: integerType,
            }));
          }
        }
      }
      return type;
    }
    if (nativeType.kind === "integer" || nativeType.kind === "float") {
      /* A 32-bit float is an ABI carrier with no source form: the compiler
       * admits it in a slot under the number conversion and nowhere else, so
       * it is lowered only where the position is not source-visible. Asking
       * for one as a source type would be asking for a second float
       * precision in the language, which is a different question. */
      if (nativeType.kind === "float" && nativeType.bits === 32 && !sourceVisible) {
        return Object.freeze({ kind: "nativeScalar", scalar: "f32" } as const);
      }
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
      if (sourceVisible && !visitedSourceTypes.has(typeId)) {
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
          const normalizedDeclaration = normalizeDeclaration(manifest, declaration);
          sourceTypes.set(
            typeId,
            Object.freeze({
              declaration: normalizedDeclaration,
              type,
            }),
          );
          /* An exact scalar the source can name also gets the operations no
           * operator expression can carry. They belong to whoever declares
           * the type: synthesising them for a type another package owns
           * would have two packages declaring one member, which composition
           * rejects — the same rule the flags combine follows. */
          if (normalizedDeclaration.module === manifest.package.name) {
            for (const operation of scalarOperations(manifest, typeId, normalizedDeclaration, type)) {
              operations.set(operation.id, operation);
            }
          }
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
        cycleCollection: traceableHandleTypeIds.has(typeId)
          ? "traceable"
          : "none",
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
      nativeType.abiPassing === undefined
    ) {
      diagnostics.push(
        diagnostic(
          "NTS3002",
          path,
          `Native struct '${typeId}' requires default packing, trivial value semantics, and authoritative ABI passing`,
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
      /* A converted field stores its exact scalar and reads as a plain
       * number, so — like a converted parameter — its GLib spelling names no
       * source type. */
      const convertsNumber = field.conversion === "number";
      const fieldType = lowerType(
        field.type,
        `${path}/fields/${index}/type`,
        !convertsNumber,
      );
      if (
        fieldType === null ||
        (fieldType.kind !== "nativeScalar" && fieldType.kind !== "nativeStruct")
      ) {
        if (fieldType !== null) diagnostics.push(diagnostic(
          "NTS3002",
          `${path}/fields/${index}/type`,
          "Native struct fields must be exact scalars or nested native structs",
        ));
        valid = false;
        continue;
      }
      if (
        convertsNumber &&
        (fieldType.kind !== "nativeScalar" || !widensToNumber(fieldType.scalar))
      ) {
        diagnostics.push(diagnostic(
          "NTS3002",
          `${path}/fields/${index}/conversion`,
          "A number conversion requires an integer slot a double carries injectively",
        ));
        valid = false;
        continue;
      }
      fields.push(Object.freeze({
        name: field.name,
        type: fieldType,
        offset: field.offset,
        ...(convertsNumber ? { projection: "number" as const } : {}),
      }));
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
        result: freezePhysicalAbiValue(nativeType.abiPassing.result),
        parameters: Object.freeze(nativeType.abiPassing.parameters.map(freezePhysicalAbiValue)),
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

  /* A receiver-owned registration creates managed owner -> result and
   * result -> closure edges. Mark both nominal handle types collector-
   * visible, then propagate over identity upcasts because all connected
   * declarations can denote the same managed cell. */
  for (const bindingId of reachable) {
    const binding = manifest.bindings[bindingId];
    if (binding === undefined || binding.kind === "constant") continue;
    for (const parameter of binding.signature.parameters) {
      const ownerName = parameter.callback?.registrationOwner;
      if (ownerName === undefined || ownerName === "native-call" || ownerName === "result") {
        continue;
      }
      const owner = binding.signature.parameters.find(({ name }) => name === ownerName);
      if (owner !== undefined && manifest.types[owner.type]?.kind === "handle") {
        traceableHandleTypeIds.add(owner.type);
      }
      if (manifest.types[binding.signature.result.type]?.kind === "handle") {
        traceableHandleTypeIds.add(binding.signature.result.type);
      }
    }
  }
  let traceabilityExpanded = true;
  while (traceabilityExpanded) {
    traceabilityExpanded = false;
    for (const [typeId, type] of Object.entries(manifest.types)) {
      if (type.kind !== "handle") continue;
      for (const upcast of type.upcasts) {
        if (
          traceableHandleTypeIds.has(typeId) !==
          traceableHandleTypeIds.has(upcast.target)
        ) {
          traceableHandleTypeIds.add(typeId);
          traceableHandleTypeIds.add(upcast.target);
          traceabilityExpanded = true;
        }
      }
    }
  }

  /* Every binding a destructor position names, plus every one a handle type
   * names: a handle's release is a destructor because its type says so, and
   * it is one even in a package where nothing happens to own that handle. */
  const destructorIds = new Set<string>(
    Object.values(manifest.types).flatMap((type) =>
      type.kind === "handle" && type.destructor !== undefined ? [type.destructor] : []
    ),
  );
  /** Bindings an error contract names for their symbols. They read and release
   * a foreign error object, so they traffic in raw pointers and are never
   * callable from TypeScript: the emitters declare and call them directly, and
   * translating them as ordinary bindings would fail for the right reason at
   * the wrong place. */
  const errorEntryIds = new Set<string>();
  for (const bindingId of reachable) {
    const binding = manifest.bindings[bindingId];
    if (binding === undefined || binding.kind === "constant") continue;
    const ownership = binding.signature.result.ownership;
    if (
      ownership.kind === "owned" && ownership.transfer === "to-runtime" &&
      ownership.destructor !== undefined
    ) {
      destructorIds.add(ownership.destructor);
    }
    if (binding.error.kind === "error-handle" || binding.error.kind === "error-out") {
      errorEntryIds.add(binding.error.message);
      errorEntryIds.add(binding.error.release);
    }
  }

  for (const bindingId of [...reachable].sort()) {
    if (errorEntryIds.has(bindingId)) continue;
    const path = `/bindings/${bindingId}`;
    const binding = manifest.bindings[bindingId];
    if (binding === undefined) {
      diagnostics.push(
        diagnostic("NTS3001", path, `Native binding '${bindingId}' does not exist`),
      );
      continue;
    }
    if (binding.kind === "constant") {
      if (
        binding.dependencies.bindings.length > 0 ||
        binding.dependencies.linkInputs.length > 0 ||
        binding.dependencies.adapterInputs.length > 0 ||
        binding.dependencies.permissions.length > 0
      ) {
        diagnostics.push(diagnostic(
          "NTS3002",
          `${path}/dependencies`,
          "Compile-time constants cannot carry runtime binding, link, adapter, or permission dependencies",
        ));
        continue;
      }
      const type = lowerType(binding.type, `${path}/type`);
      if (type === null) continue;
      if (type.kind !== "nativeScalar") {
        diagnostics.push(diagnostic(
          "NTS3002",
          `${path}/type`,
          "Compile-time constants require an exact scalar, enum, or flags type",
        ));
        continue;
      }
      const value = canonicalConstantValue(
        binding.value,
        type.scalar,
        manifest.target.pointerWidth,
      );
      if (value === null) {
        diagnostics.push(diagnostic(
          "NTS3002",
          `${path}/value`,
          `Constant value '${String(binding.value)}' is not representable as exact ${type.scalar}`,
        ));
        continue;
      }
      const declaredType = manifest.types[binding.type];
      if (
        (declaredType?.kind === "enum" || declaredType?.kind === "flags") &&
        !Object.values(declaredType.members).includes(value)
      ) {
        diagnostics.push(diagnostic(
          "NTS3002",
          `${path}/value`,
          `${declaredType.kind} constant value '${value}' does not name a declared member`,
        ));
        continue;
      }
      constants.push(Object.freeze({
        id: `${manifest.package.instance}#${bindingId}`,
        declaration: normalizeDeclaration(manifest, binding.declaration),
        type,
        value,
      }));
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
    /* A call the callee takes a handle from is an ordinary call that consumes
     * the reference: the cell gives it up and the handle is spent, the same
     * guarantee an explicit disposal makes. What it may not be is a pointer
     * the callee frees while this side still names it, so the position has to
     * be a required handle passed by pointer. A destructor is the one such
     * call the runtime performs rather than emits: it never receives the
     * source value at all, so its own contract — checked where the ownership
     * that names it is — is what constrains its parameter instead. */
    const consumed = binding.signature.parameters.filter(
      (parameter) =>
        parameter.ownership.kind === "owned" && parameter.ownership.transfer === "to-native",
    );
    if (
      !destructorIds.has(bindingId) &&
      consumed.some((parameter) =>
        manifest.types[parameter.type]?.kind !== "handle" ||
        parameter.passMode !== "pointer" ||
        parameter.nullable ||
        parameter.marshal !== undefined ||
        parameter.callback !== undefined
      )
    ) {
      diagnostics.push(
        diagnostic(
          "NTS3002",
          `${path}/signature/parameters`,
          "An ownership-consuming parameter must be a required handle passed by pointer",
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
    const booleanTypes = new Map<number, {
      readonly storage: ScriptCNativeValueType;
      readonly falseValue: string;
      readonly trueValue: string;
    }>();
    const numberParameters = new Set<number>();
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
      const declaredParameterType = manifest.types[parameter.type];
      if (declaredParameterType?.kind === "boolean") {
        const unsupportedPosition = positionUnsupported(
          parameter,
          true,
          declaredParameterType?.kind,
        );
        if (unsupportedPosition !== null) {
          diagnostics.push(diagnostic("NTS3002", parameterPath, unsupportedPosition));
          valid = false;
          continue;
        }
        const storage = lowerType(
          declaredParameterType.storage,
          `${parameterPath}/type/storage`,
          false,
        );
        if (storage?.kind !== "nativeScalar" || storage.scalar === "f64") {
          diagnostics.push(diagnostic(
            "NTS3002",
            `${parameterPath}/type`,
            "Native boolean storage must lower to an exact integer scalar",
          ));
          valid = false;
          continue;
        }
        const argument = sourceArguments.length;
        sourceArguments.push(Object.freeze({
          name: parameter.name,
          type: Object.freeze({ kind: "bool" } as const),
        }));
        booleanTypes.set(index, Object.freeze({
          storage,
          falseValue: declaredParameterType.falseValue,
          trueValue: declaredParameterType.trueValue,
        }));
        argumentByParameter.set(index, argument);
        continue;
      }
      const borrowed = borrowedByData.get(index);
      if (borrowed !== undefined) {
        const argument = sourceArguments.length;
        sourceArguments.push(
          Object.freeze({
            name: parameter.name,
            type: borrowed.kind === "utf8"
              ? Object.freeze({ kind: "string" } as const)
              : borrowed.kind === "utf8-c-string"
                ? borrowed.nullable
                  ? Object.freeze({ kind: "nullableString" } as const)
                  : Object.freeze({ kind: "string" } as const)
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
        const physicalCallbackParameters: Array<
          ScriptCNativeCallbackSignature["parameters"][number]
        > = [];
        const callbackParameters: Array<
          ScriptCNativeCallbackArgumentType["params"][number]
        > = [];
        let callbackValid = true;
        for (const [callbackIndex, typeId] of callback.parameterTypeIds.entries()) {
          const physical = callback.sourceArguments.find(
            (argument) =>
              argument.kind === "callback-parameter" &&
              argument.parameter === callbackIndex,
          );
          const copiesString = physical?.kind === "callback-parameter" &&
            physical.projection === "utf8CString";
          const ownsHandle = physical?.kind === "callback-parameter" &&
            physical.projection === "ownedHandle";
          /* A converted payload's physical slot is exact and its source view
           * is a plain number, so the GLib spelling names no source type: the
           * transparent alias must not enter the source-type table, where it
           * would re-brand every plain number the checker sees. */
          const widensNumber = physical?.kind === "callback-parameter" &&
            physical.projection === "number";
          /* A pointer has no place in ScriptC's scalar-and-struct slice, so a
           * string payload's physical slot is described directly rather than
           * asked of a lowering that would refuse it. */
          const type = copiesString
            ? null
            : lowerType(
                typeId,
                `${parameterPath}/type/signature/parameters/${callbackIndex}/type`,
                !widensNumber,
              );
          if (ownsHandle) {
            /* The slot carries the referenced pointer; the cell is made from
             * it when the delivery runs. */
            if (type?.kind !== "nativeHandle") {
              callbackValid = false;
              continue;
            }
            physicalCallbackParameters.push(type);
          } else if (copiesString) {
            /* A string payload's physical slot is the pointer the emitter
             * passes; what crosses to the source is the copy made from it. */
            const pointer = manifest.types[typeId];
            const pointee = pointer?.kind === "pointer"
              ? manifest.types[pointer.pointee]
              : undefined;
            physicalCallbackParameters.push(Object.freeze({
              kind: "nativePointer",
              pointee:
                pointee?.kind === "integer" && pointee.signed ? "i8" : "u8",
              const: true,
              addressSpace: 0,
            } as const));
          } else if (type?.kind === "nativeScalar") {
            physicalCallbackParameters.push(type);
          } else {
            if (type !== null) {
              diagnostics.push(
                diagnostic(
                  "NTS3002",
                  `${parameterPath}/type/signature/parameters/${callbackIndex}/type`,
                  "Physical callback parameters must be exact native scalars or borrowed UTF-8 pointers",
                ),
              );
            }
            callbackValid = false;
          }
        }
        for (const [callbackIndex, sourceArgument] of callback.sourceArguments.entries()) {
          if (
            sourceArgument.kind === "callback-parameter" &&
            sourceArgument.projection === "utf8CString"
          ) {
            callbackParameters.push(Object.freeze({ kind: "cstring" } as const));
            continue;
          }
          if (
            sourceArgument.kind === "callback-parameter" &&
            sourceArgument.projection === "number"
          ) {
            /* The queued slot keeps the exact payload; the handler sees the
             * widening the delivery performs when it reads that slot. */
            callbackParameters.push(Object.freeze({ kind: "f64" } as const));
            continue;
          }
          if (
            sourceArgument.kind === "callback-parameter" &&
            sourceArgument.projection === "ownedHandle"
          ) {
            const handle = lowerType(
              sourceArgument.typeId,
              `${parameterPath}/callback/sourceArguments/${callbackIndex}/type`,
            );
            if (handle?.kind !== "nativeHandle") {
              callbackValid = false;
              continue;
            }
            callbackParameters.push(handle);
            continue;
          }
          const type = lowerType(
            sourceArgument.typeId,
            `${parameterPath}/callback/sourceArguments/${callbackIndex}/type`,
          );
          if (
            (sourceArgument.kind === "callback-parameter" && type?.kind !== "nativeScalar") ||
            (sourceArgument.kind === "registration-owner" && type?.kind !== "nativeHandle")
          ) {
            if (type !== null) {
              diagnostics.push(
                diagnostic(
                  "NTS3002",
                  `${parameterPath}/callback/sourceArguments/${callbackIndex}/type`,
                  sourceArgument.kind === "callback-parameter"
                    ? "Physical callback source parameters must be exact native scalars"
                    : "A registration-owner source parameter must be a native handle",
                ),
              );
            }
            callbackValid = false;
          } else if (type?.kind === "nativeScalar" || type?.kind === "nativeHandle") {
            callbackParameters.push(type);
          }
        }
        /* An answering handler returns an ordinary boolean over an ABI
         * boolean's storage: the physical slot is that storage, and the
         * source answer carries the two values it means. */
        const answerBoolean = manifest.types[callback.resultTypeId];
        const answersBoolean = callback.contract.synchronousReturn &&
          answerBoolean?.kind === "boolean";
        const callbackResult = lowerType(
          answersBoolean && answerBoolean?.kind === "boolean"
            ? answerBoolean.storage
            : callback.resultTypeId,
          `${parameterPath}/type/signature/result/type`,
          false,
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
          /* SCABI declares the context's placement; the compiler wants the
           * slot itself, at that position. Only "last" lowers today. */
          parameters: Object.freeze([
            ...physicalCallbackParameters,
            Object.freeze({ kind: "nativeContext", addressSpace: 0 } as const),
          ]),
          result: callbackResult,
        } as const);
        callbackSignatures.set(index, signature);
        let sourceCallbackContract = callback.contract;
        const contractOwner = sourceCallbackContract.owner;
        if (contractOwner.kind === "argument") {
          const ownerArgument = argumentByParameter.get(contractOwner.argument);
          if (ownerArgument === undefined) {
            diagnostics.push(diagnostic(
              "NTS3002",
              `${parameterPath}/callback/owner`,
              "Receiver-owned callbacks require the receiver source argument to precede the callback",
            ));
            valid = false;
            continue;
          }
          sourceCallbackContract = Object.freeze({
            ...(sourceCallbackContract as Extract<
              ScriptCNativeCallbackContract,
              { readonly cancellationBinding: string }
            >),
            owner: Object.freeze({
              kind: "argument" as const,
              argument: ownerArgument,
            }),
          });
        }
        const argument = sourceArguments.length;
        sourceArguments.push(Object.freeze({
          name: parameter.name,
          type: Object.freeze({
            kind: "func",
            params: Object.freeze(callbackParameters),
            ret: answersBoolean && answerBoolean?.kind === "boolean"
              ? Object.freeze({
                  kind: "bool" as const,
                  falseValue: answerBoolean.falseValue,
                  trueValue: answerBoolean.trueValue,
                })
              : signature.result,
          } as const),
          callback: sourceCallbackContract,
        }));
        argumentByParameter.set(index, argument);
        argumentByParameter.set(callback.contextIndex, argument);
        continue;
      }
      if (parameter.marshal !== undefined) continue;
      const unsupportedPosition = positionUnsupported(
        parameter,
        true,
        positionTypeKind(manifest, parameter.type),
      );
      if (unsupportedPosition !== null) {
        diagnostics.push(diagnostic("NTS3002", parameterPath, unsupportedPosition));
        valid = false;
        continue;
      }
      /* A converted parameter's source view is a plain number, so the GLib
       * spelling contributes no source type. Registering the transparent
       * alias would hand the checker a branded reading of ordinary numbers. */
      const convertsNumber = parameter.conversion === "number";
      const type = lowerType(
        parameter.type,
        `${parameterPath}/type`,
        !convertsNumber,
      );
      if (type === null || type.kind === "void") {
        if (type?.kind === "void") {
          diagnostics.push(
            diagnostic("NTS3002", `${parameterPath}/type`, "Parameters cannot have void type"),
          );
        }
        valid = false;
        continue;
      }
      if (convertsNumber) {
        if (type.kind !== "nativeScalar" || !carriesNumber(type.scalar)) {
          diagnostics.push(diagnostic(
            "NTS3002",
            `${parameterPath}/conversion`,
            "A number conversion requires a float or integer slot",
          ));
          valid = false;
          continue;
        }
        numberParameters.add(index);
      }
      directTypes.set(index, type);
      argumentByParameter.set(index, sourceArguments.length);
      // An optional handle keeps its pointer slot; only the source side gains
      // a null arm, so the ABI parameter type stays the handle.
      // Only a borrowed input is genuinely optional. An owned to-native
      // handle is marked nullable in SCABI because the C slot accepts NULL,
      // but the source value is a non-null managed handle — a destructor
      // takes the handle it destroys.
      const optionalHandle =
        type.kind === "nativeHandle" &&
        parameter.nullable &&
        parameter.ownership.kind === "borrowed";
      sourceArguments.push(Object.freeze({
        name: parameter.name,
        type: convertsNumber
          ? Object.freeze({ kind: "f64" } as const)
          : optionalHandle && type.kind === "nativeHandle"
            ? Object.freeze({
                kind: "nullableNativeHandle",
                typeId: type.typeId,
              } as const)
            : type,
      }));
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
            ownership: Object.freeze({ kind: "callback" } as const),
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
            ownership: Object.freeze({ kind: "callback" } as const),
            projection: Object.freeze({ kind: "callbackContext", argument } as const),
          }));
          continue;
        }
        const directType = directTypes.get(index);
        const booleanType = booleanTypes.get(index);
        if (numberParameters.has(index)) {
          parameters.push(Object.freeze({
            name: parameter.name,
            type: directType!,
            passMode: "value",
            ownership: Object.freeze({ kind: "value" } as const),
            projection: Object.freeze({
              kind: "number",
              argument,
              conversion: "checked",
            } as const),
          }));
          continue;
        }
        parameters.push(Object.freeze(
          booleanType !== undefined
            ? {
                name: parameter.name,
                type: booleanType.storage,
                passMode: "value",
                ownership: Object.freeze({ kind: "value" } as const),
                projection: Object.freeze({
                  kind: "boolean",
                  argument,
                  falseValue: booleanType.falseValue,
                  trueValue: booleanType.trueValue,
                } as const),
              }
            : borrowedData !== undefined
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

    /* The error slot is the compiler's, so the manifest does not declare it as
     * a parameter — it declares that failure arrives in one. It is appended
     * last because that is where a `GError **` sits, and the contract above
     * names it by that position. */
    if (binding.error.kind === "error-out") {
      parameters.push(Object.freeze({
        name: "error",
        type: Object.freeze({ kind: "nativeErrorOut", addressSpace: 0 } as const),
        passMode: "pointer",
        ownership: Object.freeze({ kind: "value" } as const),
        projection: Object.freeze({ kind: "errorOut" } as const),
      }));
    }

    const resultPath = `${path}/signature/result`;
    let resultType: ScriptCNativeBinding["result"]["type"] | null = null;
    let resultOwnership: ScriptCNativeBinding["result"]["ownership"] | null = null;
    let resultProjection: ScriptCNativeResultProjection | null = null;
    const declaredResultType = manifest.types[binding.signature.result.type];
    if (binding.error.kind === "error-handle") {
      // The pointer is the error channel, not a source value, so the generic
      // result path — which correctly refuses a source-visible pointer — must
      // not see it.
      const message = manifest.bindings[binding.error.message];
      const release = manifest.bindings[binding.error.release];
      if (
        declaredResultType?.kind !== "pointer" ||
        binding.signature.result.passMode !== "pointer" ||
        binding.signature.result.marshal !== undefined ||
        message === undefined ||
        message.kind === "constant" ||
        release === undefined ||
        release.kind === "constant" ||
        binding.error.message === binding.error.release
      ) {
        diagnostics.push(diagnostic(
          "NTS3002",
          `${path}/error`,
          "error-handle requires a pointer result and distinct message and release bindings",
        ));
        valid = false;
      } else {
        resultType = Object.freeze({
          kind: "nativePointer",
          pointee: "i8",
          const: false,
          addressSpace: 0,
        });
        resultOwnership = Object.freeze({ kind: "value" });
        resultProjection = Object.freeze({ kind: "errorChannel" });
      }
    } else if (binding.signature.result.marshal?.kind === "string") {
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
    } else if (declaredResultType?.kind === "boolean") {
      const booleanType = declaredResultType;
      const unsupportedResult = positionUnsupported(
        binding.signature.result,
        false,
        booleanType.kind,
      );
      if (unsupportedResult !== null) {
        diagnostics.push(diagnostic("NTS3002", resultPath, unsupportedResult));
        valid = false;
      }
      resultType = lowerType(
        booleanType.storage,
        `${resultPath}/type/storage`,
        false,
      );
      if (resultType?.kind !== "nativeScalar" || resultType.scalar === "f64") {
        diagnostics.push(diagnostic(
          "NTS3002",
          `${resultPath}/type`,
          "Native boolean storage must lower to an exact integer scalar",
        ));
        resultType = null;
        valid = false;
      } else {
        resultOwnership = Object.freeze({ kind: "value" });
        resultProjection = Object.freeze({
          kind: "boolean",
          conversion: "exact",
          falseValue: booleanType.falseValue,
          trueValue: booleanType.trueValue,
        });
      }
    } else if (
      manifest.types[binding.signature.result.type]?.kind === "handle" &&
      binding.signature.result.nullable &&
      binding.signature.result.passMode === "pointer" &&
      binding.signature.result.ownership.kind === "owned" &&
      binding.signature.result.ownership.transfer === "to-runtime" &&
      !errorContractReadsResult(binding.error)
    ) {
      /* An owned handle the callee may report as absent, where absence is not
       * a failure. A binding that declares the nullable error contract instead
       * says NULL means the call failed, which is right for a constructor and
       * wrong for a reader: a container with no child has answered.
       *
       * A failure reported in a slot makes no claim about the pointer, so the
       * two coexist: the call may fail, and separately may answer with
       * nothing. */
      const destructor = ownedDestructor(
        manifest,
        binding.signature.result.type,
        binding.signature.result.ownership,
      );
      resultType = lowerType(
        binding.signature.result.type,
        `${resultPath}/type`,
      );
      if (resultType === null || resultType.kind !== "nativeHandle" || destructor === null) {
        diagnostics.push(diagnostic(
          "NTS3002",
          resultPath,
          "A nullable handle result must lower to a native handle its type releases",
        ));
        valid = false;
      } else {
        resultOwnership = Object.freeze({
          kind: "owned",
          transfer: "to-runtime",
          destructor,
        } as const);
        resultProjection = Object.freeze({ kind: "nullableHandle" } as const);
      }
    } else if (binding.signature.result.conversion === "number") {
      /* Widening out is total: every value of the slot is a double, so the
       * projection has no failure arm and needs none. What it does need is a
       * contract that does not read the result, because a sentinel compares
       * the exact scalar the source would never see. Failure arriving in a
       * slot of its own reads nothing here, which is what lets a failable
       * call answer with a count. */
      const unsupportedResult = positionUnsupported(
        binding.signature.result,
        false,
        positionTypeKind(manifest, binding.signature.result.type),
      );
      if (unsupportedResult !== null) {
        diagnostics.push(diagnostic("NTS3002", resultPath, unsupportedResult));
        valid = false;
      }
      resultType = lowerType(
        binding.signature.result.type,
        `${resultPath}/type`,
        false,
      );
      if (
        resultType === null ||
        resultType.kind !== "nativeScalar" ||
        !carriesNumber(resultType.scalar)
      ) {
        diagnostics.push(diagnostic(
          "NTS3002",
          `${resultPath}/conversion`,
          "A number conversion requires a float or integer slot",
        ));
        resultType = null;
        valid = false;
      } else if (errorContractReadsResult(binding.error)) {
        diagnostics.push(diagnostic(
          "NTS3002",
          `${resultPath}/conversion`,
          "A number-converted result requires a contract that does not read the result",
        ));
        resultType = null;
        valid = false;
      } else {
        resultOwnership = Object.freeze({ kind: "value" } as const);
        resultProjection = Object.freeze({ kind: "number" } as const);
      }
    } else {
      const unsupportedResult = positionUnsupported(
        binding.signature.result,
        false,
        positionTypeKind(manifest, binding.signature.result.type),
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
      const destructor = ownedDestructor(
        manifest,
        binding.signature.result.type,
        binding.signature.result.ownership,
      );
      const owns = binding.signature.result.ownership.kind === "owned" &&
        binding.signature.result.ownership.transfer === "to-runtime";
      if (resultType === null || (owns && destructor === null)) {
        if (resultType !== null) {
          diagnostics.push(diagnostic(
            "NTS3002",
            resultPath,
            "An owned result must name the binding that releases it, on the position or on its handle type",
          ));
        }
        valid = false;
      } else {
        resultOwnership = owns
          ? Object.freeze({
              kind: "owned",
              transfer: "to-runtime",
              destructor: destructor!,
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
        sourceCall: binding.kind === "method"
          ? Object.freeze({ kind: "method", receiverArgument: 0 } as const)
          : binding.kind === "getter"
            ? Object.freeze({ kind: "getter", receiverArgument: 0 } as const)
            : binding.kind === "setter"
              ? Object.freeze({
                  kind: "setter",
                  receiverArgument: 0,
                  valueArgument: 1,
                } as const)
          : binding.kind === "constructor"
            ? Object.freeze({ kind: "constructor" } as const)
            : Object.freeze({ kind: "function" } as const),
        error: binding.error.kind === "errno"
          ? Object.freeze({
              detect: Object.freeze({
                kind: "resultEquals",
                value: binding.error.failureValue,
              } as const),
              message: Object.freeze({ kind: "errno" } as const),
              release: Object.freeze({ kind: "none" } as const),
            } as const)
          : binding.error.kind === "nullable"
            ? Object.freeze({
                detect: Object.freeze({ kind: "resultIsNull" } as const),
                message: Object.freeze({ kind: "none" } as const),
                release: Object.freeze({ kind: "none" } as const),
              } as const)
            : binding.error.kind === "error-out"
              ? Object.freeze({
                  /* A SLOT holds the error object, so the result stays the
                   * call's own. The slot is the last physical parameter, which
                   * is where the parameter list below appends it. */
                  detect: Object.freeze({
                    kind: "outParameterIsNotNull",
                    parameter: parameters.length - 1,
                  } as const),
                  message: Object.freeze({
                    kind: "symbol",
                    symbol: (
                      manifest.bindings[binding.error.message] as CallableBinding
                    ).entry.symbol,
                  } as const),
                  release: Object.freeze({
                    kind: "symbol",
                    symbol: (
                      manifest.bindings[binding.error.release] as CallableBinding
                    ).entry.symbol,
                  } as const),
                } as const)
            : binding.error.kind === "error-handle"
              ? Object.freeze({
                  /* The result IS the error object: non-null is failure.
                   * SCABI names bindings; the compiler carries the resolved
                   * symbols its emitters call. */
                  detect: Object.freeze({ kind: "resultIsNotNull" } as const),
                  message: Object.freeze({
                    kind: "symbol",
                    symbol: (
                      manifest.bindings[binding.error.message] as CallableBinding
                    ).entry.symbol,
                  } as const),
                  release: Object.freeze({
                    kind: "symbol",
                    symbol: (
                      manifest.bindings[binding.error.release] as CallableBinding
                    ).entry.symbol,
                  } as const),
                } as const)
              : NO_NATIVE_FAILURE,
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
        positionTypeKind(manifest, parameter.type),
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
      positionTypeKind(manifest, binding.signature.result.type),
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
      error: NO_NATIVE_FAILURE,
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
      constants: Object.freeze(constants),
      operations: Object.freeze([...operations.values()].sort((left, right) =>
        compareText(left.id, right.id)
      )),
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
