/**
 * Generates the SCABI package for a selected JVM surface: the bindgen-jvm
 * analogue of gobject-scabi.ts, over the flattened adapter symbols
 * jvm-adapter.ts emits. Because every adapter is an ordinary C function,
 * the manifest speaks only vocabulary SCABI already validates and the
 * compiler already lowers — scalars, opaque handles with a named unary
 * destructor, and the error-out contract. Nothing here waits on the
 * boundary-contract work in flight.
 *
 * The slice's algebra mirrors the adapter's: JNI primitive scalars, void,
 * constructors as owned handles, instance receivers, and the checked
 * failure channel. Everything else refuses precisely.
 */

import { createHash } from "node:crypto";
import {
  digestClangAbiEvidence,
  renderCFunctionPointerType,
} from "@native-typescript/bindgen-c";
import type { ClangAbiEvidenceSnapshot } from "@native-typescript/bindgen-c";
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
import { generateJvmAdapterSource } from "./jvm-adapter.ts";
import type {
  JvmAdapterPosition,
  JvmAdapterResult,
  JvmAdapterSource,
  JvmConstructorAdapter,
  JvmMethodAdapter,
} from "./jvm-adapter.ts";
import { generateJvmClangAbiProbe } from "./jvm-clang.ts";
import { JvmGenerationError } from "./jvm-model.ts";
import type {
  JvmDiagnostic,
  JvmPrimitive,
  JvmSnapshot,
} from "./jvm-model.ts";

export interface JvmScabiGenerationOptions {
  readonly snapshot: JvmSnapshot;
  readonly adapter: JvmAdapterSource;
  readonly packageSlug: string;
  readonly evidence: ClangAbiEvidenceSnapshot;
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

export interface JvmScabiPackage {
  readonly schema: "native-typescript.jvm-scabi-package";
  readonly schemaVersion: 1;
  readonly declarations: string;
  readonly declarationsDigest: Sha256Digest;
  readonly manifest: ScabiManifest;
  readonly manifestSource: string;
  readonly manifestDigest: Sha256Digest;
}

function sha256(value: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function diagnostic(path: string, message: string): JvmDiagnostic {
  return { code: "NTS7001", severity: "error", path, message };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * SCABI ids are lowercase dotted tokens. Java identifiers are case-
 * sensitive, so lowering can collide; a collision is refused rather than
 * mangled, because an id that survives only by accident of hashing is an
 * id nobody can predict.
 */
function idToken(value: string): string {
  return value
    .replace(/[/$]/gu, ".")
    .replace(/[^A-Za-z0-9.]/gu, "-")
    .toLowerCase();
}

/** The scalar's manifest type, its TS carrier, and its conversion policy. */
const scalarProjections: Readonly<
  Record<
    JvmPrimitive,
    {
      readonly type: NativeType;
      readonly sourceType: string;
      readonly conversion: "number" | null;
      readonly needs?: readonly (readonly [string, NativeType])[];
    }
  >
> = Object.freeze({
  boolean: {
    type: { kind: "boolean", storage: "u8", falseValue: "0", trueValue: "1" },
    sourceType: "boolean",
    conversion: null,
    needs: [["u8", { kind: "integer", signed: false, bits: 8 }]],
  },
  byte: {
    type: { kind: "integer", signed: true, bits: 8 },
    sourceType: "jbyte",
    conversion: "number",
  },
  char: {
    type: { kind: "integer", signed: false, bits: 16 },
    sourceType: "jchar",
    conversion: "number",
  },
  short: {
    type: { kind: "integer", signed: true, bits: 16 },
    sourceType: "jshort",
    conversion: "number",
  },
  int: {
    type: { kind: "integer", signed: true, bits: 32 },
    sourceType: "jint",
    conversion: "number",
  },
  long: {
    type: { kind: "integer", signed: true, bits: 64 },
    sourceType: "jlong",
    conversion: null,
  },
  /* Floats mirror gdouble's reasoning: the crossing converts nothing, so a
   * brand would forbid arithmetic while protecting no representation. Only
   * the 64-bit integer keeps its exact branded carrier. */
  float: { type: { kind: "float", bits: 32 }, sourceType: "jfloat", conversion: "number" },
  double: { type: { kind: "float", bits: 64 }, sourceType: "jdouble", conversion: "number" },
});

function scalarTypeId(primitive: JvmPrimitive): string {
  return `j${primitive}`;
}

/**
 * The evidence must belong to exactly this adapter: same probe, same
 * toolchain target, same per-symbol signatures. Mirrors gobject-scabi's
 * validateInputs, including regenerating the adapter to prove the one
 * passed in is the one the snapshot produces.
 */
function validateInputs(
  options: JvmScabiGenerationOptions,
  diagnostics: JvmDiagnostic[],
): void {
  const expectedAdapter = generateJvmAdapterSource(options.snapshot, {
    packageSlug: options.packageSlug,
  });
  if (canonicalizeJson(expectedAdapter) !== canonicalizeJson(options.adapter)) {
    diagnostics.push(
      diagnostic(
        "adapter",
        "Adapter source does not match what this snapshot generates",
      ),
    );
    return;
  }
  const probe = generateJvmClangAbiProbe(options.adapter);
  if (
    options.evidence.schema !== "native-typescript.clang-abi-evidence" ||
    options.evidence.schemaVersion !== 3
  ) {
    diagnostics.push(
      diagnostic("evidence/schemaVersion", "Unsupported Clang ABI evidence schema"),
    );
  }
  if (options.evidence.probeDigest !== probe.sourceDigest) {
    diagnostics.push(
      diagnostic(
        "evidence/probeDigest",
        "Clang evidence does not belong to this adapter's ABI probe",
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
  if (digestClangAbiEvidence(options.evidence) !== options.evidence.semanticDigest) {
    diagnostics.push(
      diagnostic("evidence/semanticDigest", "Clang semantic evidence digest is invalid"),
    );
  }
  if (options.evidence.functions.length !== probe.functions.length) {
    diagnostics.push(
      diagnostic("evidence/functions", "Clang evidence has the wrong function count"),
    );
    return;
  }
  probe.functions.forEach((function_, index) => {
    const evidence = options.evidence.functions[index];
    if (
      evidence === undefined ||
      evidence.symbol !== function_.symbol ||
      evidence.expectedType !== renderCFunctionPointerType(function_, "")
    ) {
      diagnostics.push(
        diagnostic(
          `evidence/functions/${index}`,
          `Clang evidence disagrees with probe symbol '${function_.symbol}'`,
        ),
      );
    }
  });
}

export function generateJvmScabiPackage(
  options: JvmScabiGenerationOptions,
): JvmScabiPackage {
  const diagnostics: JvmDiagnostic[] = [];
  validateInputs(options, diagnostics);
  if (diagnostics.length > 0) throw new JvmGenerationError(diagnostics);

  const slug = options.packageSlug;
  const types: Record<string, NativeType> = {
    void: Object.freeze({ kind: "void" }),
    i8: Object.freeze({ kind: "integer", signed: true, bits: 8 }),
    const_utf8: Object.freeze({
      kind: "pointer",
      pointee: "i8",
      mutability: "const",
      nullable: false,
      addressSpace: 0,
    }),
    /* The error-out object: one owned C string, opaque to the source. */
    jvm_error: Object.freeze({
      kind: "pointer",
      pointee: "i8",
      mutability: "mutable",
      nullable: true,
      addressSpace: 0,
    }),
  };
  const bindings: Record<string, NativeBinding> = {};
  function defineBinding(id: string, binding: NativeBinding): void {
    if (bindings[id] !== undefined) {
      diagnostics.push(
        diagnostic(`bindings/${id}`, "Two members lower to the same binding id"),
      );
      return;
    }
    bindings[id] = binding;
  }
  const declarationTypes: Record<
    string,
    { readonly module: string; readonly name: string }
  > = {};
  const adapterBindings: string[] = [];
  const linkIds = options.linkInputs.map(({ id }) => id);
  const errorMessageBindingId = `${slug}.error.message`;
  const errorReleaseBindingId = `${slug}.error.release`;

  function needScalar(primitive: JvmPrimitive): string {
    const id = scalarTypeId(primitive);
    if (types[id] === undefined) {
      const projection = scalarProjections[primitive];
      for (const [needId, needType] of projection.needs ?? []) {
        types[needId] ??= Object.freeze(needType);
      }
      types[id] = Object.freeze(projection.type);
    }
    return id;
  }

  function dependencies(
    bindingIds: readonly string[] = [],
  ): CallableBinding["dependencies"] {
    return Object.freeze({
      bindings: Object.freeze([...bindingIds].sort(compareText)),
      linkInputs: Object.freeze([...linkIds]),
      adapterInputs: Object.freeze([options.adapterInput.id]),
      permissions: Object.freeze([]),
    });
  }

  function callable(input: {
    readonly declaration: string;
    readonly kind: CallableBinding["kind"];
    readonly symbol: string;
    readonly parameters: readonly AbiParameter[];
    readonly result: AbiResult;
    readonly error?: CallableBinding["error"];
    readonly availability?: BindingAvailability;
  }): CallableBinding {
    return Object.freeze({
      kind: input.kind,
      declaration: Object.freeze({ module: ".", name: input.declaration }),
      entry: Object.freeze({ symbol: input.symbol }),
      signature: Object.freeze({
        callingConvention: "c" as const,
        variadic: false as const,
        parameters: Object.freeze([...input.parameters]),
        result: input.result,
      }),
      thread: Object.freeze({
        executor: Object.freeze({ kind: "runtime-owner" as const }),
        behavior: "require" as const,
        blocking: false,
      }),
      error: input.error ?? Object.freeze({ kind: "no-fail" as const }),
      /* A failable binding reaches its error's message and release, so the
       * dependency edge is derived from the contract, never restated. */
      dependencies: dependencies(
        input.error !== undefined && "message" in input.error
          ? [input.error.message, input.error.release]
          : [],
      ),
      ...(input.availability === undefined ? {} : { availability: input.availability }),
    });
  }

  const errorParameter: AbiParameter = Object.freeze({
    name: "error",
    type: "jvm_error",
    passMode: "pointer",
    nullable: false,
    ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
  });
  defineBinding(errorMessageBindingId, callable({
    declaration: "NativeError.message",
    kind: "getter",
    symbol: options.adapter.errorSupport.messageSymbol,
    parameters: [errorParameter],
    result: Object.freeze({
      type: "const_utf8",
      passMode: "pointer",
      nullable: false,
      ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
    }),
  }));
  defineBinding(errorReleaseBindingId, callable({
    declaration: "NativeError.__release",
    kind: "method",
    symbol: options.adapter.errorSupport.releaseSymbol,
    parameters: [errorParameter],
    result: Object.freeze({
      type: "void",
      passMode: "value",
      nullable: false,
      ownership: Object.freeze({ kind: "value" }),
    }),
  }));
  adapterBindings.push(errorMessageBindingId, errorReleaseBindingId);
  const errorContract = Object.freeze({
    kind: "error-out" as const,
    message: errorMessageBindingId,
    release: errorReleaseBindingId,
  });

  /* One root handle every class upcasts to, and the ONE release, typed at
   * it: DeleteGlobalRef is class-blind, and a destructor may consume any
   * identity-upcast target, so every class handle names this binding.
   * jvm.object itself carries no destructor field — nothing returns an
   * owned bare jvm.object. */
  types["jvm.object"] = Object.freeze({
    kind: "handle",
    nativeName: "jobject",
    threadSafety: "confined",
    identity: "none",
    upcasts: Object.freeze([]),
  });
  declarationTypes["jvm.object"] = Object.freeze({ module: ".", name: "JvmObject" });
  const objectReleaseBindingId = `${slug}.object.release`;
  defineBinding(objectReleaseBindingId, callable({
    declaration: "JvmObject.__release",
    kind: "method",
    symbol: options.adapter.release.adapterSymbol,
    parameters: [
      Object.freeze({
        name: "instance",
        type: "jvm.object",
        passMode: "pointer" as const,
        /* A destructor CONSUMES the reference it releases; the runtime
         * never calls one without a live handle. */
        nullable: false,
        ownership: Object.freeze({ kind: "owned" as const, transfer: "to-native" as const }),
      }),
    ],
    result: Object.freeze({
      type: "void",
      passMode: "value" as const,
      nullable: false,
      ownership: Object.freeze({ kind: "value" as const }),
    }),
  }));
  adapterBindings.push(objectReleaseBindingId);

  /* Class handles: TS names are the last segment of the binary name, with
   * nesting flattened; a collision is refused rather than mangled. */
  const classNames = new Map<string, string>();
  const selectedTypeIds = new Map<string, string>();
  for (const class_ of options.snapshot.classes) {
    const simple = class_.binaryName
      .slice(class_.binaryName.lastIndexOf("/") + 1)
      .replace(/\$/gu, "");
    const existing = classNames.get(simple);
    if (existing !== undefined) {
      diagnostics.push(
        diagnostic(
          `class/${class_.binaryName}`,
          `TypeScript name '${simple}' collides with '${existing}'`,
        ),
      );
      continue;
    }
    classNames.set(simple, class_.binaryName);
    selectedTypeIds.set(class_.binaryName, `jvm.${idToken(class_.binaryName)}`);
  }
  if (diagnostics.length > 0) throw new JvmGenerationError(diagnostics);

  const classNameOf = new Map(
    [...classNames.entries()].map(([simple, binary]) => [binary, simple]),
  );
  for (const class_ of options.snapshot.classes) {
    const typeId = selectedTypeIds.get(class_.binaryName)!;
    const upcasts: { readonly kind: "identity"; readonly target: string }[] = [];
    let ancestor = class_.superclass;
    while (ancestor !== null && ancestor.kind === "internal") {
      const ancestorId = selectedTypeIds.get(ancestor.binaryName);
      if (ancestorId === undefined) break;
      upcasts.push(Object.freeze({ kind: "identity" as const, target: ancestorId }));
      ancestor = options.snapshot.classes.find(
        ({ binaryName }) => binaryName === ancestor!.binaryName,
      )?.superclass ?? null;
    }
    upcasts.push(Object.freeze({ kind: "identity" as const, target: "jvm.object" }));
    types[typeId] = Object.freeze({
      kind: "handle",
      nativeName: class_.binaryName,
      threadSafety: "confined",
      identity: "none",
      upcasts: Object.freeze(upcasts),
      /* The shared release: valid for this type because the upcast chain
       * ends at the release's own parameter type. */
      destructor: objectReleaseBindingId,
    });
    declarationTypes[typeId] = Object.freeze({
      module: ".",
      name: classNameOf.get(class_.binaryName)!,
    });
  }

  const stringMarshal = Object.freeze({
    kind: "string" as const,
    encoding: "utf-8" as const,
    length: Object.freeze({ kind: "nul" as const }),
    termination: "nul" as const,
    embeddedNul: "reject" as const,
  });

  function needStringTypes(): void {
    types["nullable_const_utf8"] ??= Object.freeze({
      kind: "pointer",
      pointee: "i8",
      mutability: "const",
      nullable: true,
      addressSpace: 0,
    });
    types["nullable_utf8"] ??= Object.freeze({
      kind: "pointer",
      pointee: "i8",
      mutability: "mutable",
      nullable: true,
      addressSpace: 0,
    });
  }

  function needByteSpanTypes(): void {
    types["u8"] ??= Object.freeze({ kind: "integer", signed: false, bits: 8 });
    types["const_bytes"] ??= Object.freeze({
      kind: "pointer",
      pointee: "u8",
      mutability: "const",
      nullable: false,
      addressSpace: 0,
    });
    types["usize"] ??= Object.freeze({
      kind: "integer",
      signed: false,
      bits: "pointer",
    });
  }

  /** One adapter position's manifest parameters — one slot for every
   * family except a byte span, whose single source value crosses as the
   * bytes contract's pair: a borrowed const pointer plus the usize length
   * parameter the marshal names. */
  function positionParameters(
    position: JvmAdapterPosition,
    index: number,
  ): readonly AbiParameter[] {
    if (position.kind === "string") {
      needStringTypes();
      /* The adapter copies during the call through the UTF-16 bridge, so
       * the caller's buffer is borrowed for exactly the call. */
      return [Object.freeze({
        name: `a${index}`,
        type: "nullable_const_utf8",
        passMode: "pointer",
        nullable: true,
        ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
        marshal: stringMarshal,
      })];
    }
    if (position.kind === "byte-span") {
      needByteSpanTypes();
      /* The bytes contract admits only a non-null borrowed span, so a null
       * Java byte[] argument is not offered; the adapter copies during the
       * call, exactly as a string crosses. */
      return [
        Object.freeze({
          name: `a${index}`,
          type: "const_bytes",
          passMode: "pointer" as const,
          nullable: false,
          ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
          marshal: Object.freeze({
            kind: "bytes" as const,
            length: Object.freeze({
              kind: "parameter" as const,
              parameter: `a${index}_length`,
            }),
            mutability: "const" as const,
          }),
        }),
        Object.freeze({
          name: `a${index}_length`,
          type: "usize",
          passMode: "value" as const,
          nullable: false,
          ownership: Object.freeze({ kind: "value" as const }),
        }),
      ];
    }
    if (position.kind === "handle") {
      /* Java's type system says any reference may be null, and the class
       * file carries no narrower fact, so the honest slot is nullable. */
      return [Object.freeze({
        name: `a${index}`,
        type: selectedTypeIds.get(position.binaryName)!,
        passMode: "pointer",
        nullable: true,
        ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
      })];
    }
    const projection = scalarProjections[position.primitive];
    return [Object.freeze({
      name: `a${index}`,
      type: needScalar(position.primitive),
      passMode: "value",
      nullable: false,
      ownership: Object.freeze({ kind: "value" }),
      ...(projection.conversion === null ? {} : { conversion: projection.conversion }),
    })];
  }

  const declarationsByClass = new Map<string, string[]>();
  function declareMember(binaryName: string, line: string): void {
    const lines = declarationsByClass.get(binaryName) ?? [];
    lines.push(line);
    declarationsByClass.set(binaryName, lines);
  }

  function sourceTypeOf(
    position: JvmAdapterPosition | Exclude<JvmAdapterResult, { kind: "void" }>,
  ): string {
    if (position.kind === "handle") {
      return `${classNameOf.get(position.binaryName)!} | null`;
    }
    if (position.kind === "string") return "string | null";
    /* Two physical slots, one source value: the view and its byteLength. */
    if (position.kind === "byte-span") return "Uint8Array";
    return scalarProjections[position.primitive].sourceType;
  }

  /* Constructors: the first selected one is THE constructor; the rest are
   * factories named by their descriptor hash, because TypeScript declares
   * one constructor and Java identity for the others is the descriptor. */
  for (const class_ of options.snapshot.classes) {
    const className = classNameOf.get(class_.binaryName)!;
    const typeId = selectedTypeIds.get(class_.binaryName)!;
    const adapters = options.adapter.constructors
      .filter((constructor) => constructor.className === class_.binaryName)
      .sort((left, right) => compareText(left.descriptor, right.descriptor));
    adapters.forEach((constructor: JvmConstructorAdapter, index: number) => {
      const first = index === 0;
      const suffix = constructor.adapterSymbol.match(/_([0-9a-f]{8})$/u)?.[1];
      const member = first ? "constructor" : `new_${suffix ?? index}`;
      const bindingId = `${slug}.${idToken(class_.binaryName)}.${member.toLowerCase()}`;
      defineBinding(bindingId, callable({
        declaration: first ? className : `${className}.${member}`,
        kind: first ? "constructor" : "factory",
        symbol: constructor.adapterSymbol,
        parameters: constructor.parameters.flatMap(positionParameters),
        result: Object.freeze({
          type: typeId,
          passMode: "pointer",
          nullable: false,
          ownership: Object.freeze({ kind: "owned", transfer: "to-runtime" }),
        }),
        error: errorContract,
      }));
      adapterBindings.push(bindingId);
      const parameterList = constructor.parameters
        .map((parameter, position) => `a${position}: ${sourceTypeOf(parameter)}`)
        .join(", ");
      declareMember(
        class_.binaryName,
        first
          ? `  constructor(${parameterList});`
          : `  static ${member}(${parameterList}): ${className};`,
      );
    });
  }

  const methodAdapters = [
    ...options.adapter.staticMethods,
    ...options.adapter.instanceMethods,
  ].sort((left, right) =>
    compareText(left.className, right.className) ||
    compareText(left.name, right.name) ||
    compareText(left.descriptor, right.descriptor)
  );
  const memberNames = new Set<string>();
  for (const method of methodAdapters as readonly JvmMethodAdapter[]) {
    const className = classNameOf.get(method.className);
    const typeId = selectedTypeIds.get(method.className);
    if (className === undefined || typeId === undefined) continue;
    if (method.result.kind === "byte-span") {
      /* The adapter emits this result and the compiler lowers it; the
       * manifest arm is the scabi bytes RESULT contract, which is landing
       * separately. Deferred, not unsupported — delete this refusal when
       * that contract lands. */
      diagnostics.push(diagnostic(
        `class/${method.className}/method/${method.name}`,
        "Result is byte[], which waits on the scabi bytes result contract",
      ));
      continue;
    }
    const suffix = method.adapterSymbol.match(/_([0-9a-f]{8})$/u)?.[1];
    const baseName = method.name;
    const memberKey = `${method.className}.${baseName}`;
    const member = memberNames.has(memberKey)
      ? `${baseName}_${suffix ?? "overload"}`
      : baseName;
    memberNames.add(memberKey);
    const bindingId = `${slug}.${idToken(method.className)}.${member.toLowerCase()}`;
    const receiver: AbiParameter[] = method.kind === "static"
      ? []
      : [
          Object.freeze({
            name: "self",
            type: typeId,
            passMode: "pointer" as const,
            nullable: false,
            ownership: Object.freeze({
              kind: "borrowed" as const,
              scope: "call" as const,
            }),
          }),
        ];
    const projection = method.result.kind === "primitive"
      ? scalarProjections[method.result.primitive]
      : null;
    defineBinding(bindingId, callable({
      declaration: `${className}.${member}`,
      kind: method.kind === "static" ? "static-method" : "method",
      symbol: method.adapterSymbol,
      parameters: [
        ...receiver,
        ...method.parameters.flatMap(positionParameters),
      ],
      result: method.result.kind === "string"
        ? (needStringTypes(),
          Object.freeze({
            /* An owned copy the projection consumes: ownership is a value
             * and the marshal names free() as its release, per the v6 rule
             * that ownership and release must agree. Null on success is an
             * ordinary value; the error-out slot is what reads failure,
             * which is exactly why this coexists with a string result. */
            type: "nullable_utf8",
            passMode: "pointer" as const,
            nullable: true,
            ownership: Object.freeze({ kind: "value" as const }),
            marshal: Object.freeze({ ...stringMarshal, release: "free" }),
          }))
        : method.result.kind === "handle"
        ? Object.freeze({
            type: selectedTypeIds.get(method.result.binaryName)!,
            passMode: "pointer" as const,
            /* A Java method may return null on success; the error slot is
             * what distinguishes failure, so null is an ordinary value. */
            nullable: true,
            ownership: Object.freeze({ kind: "owned" as const, transfer: "to-runtime" as const }),
          })
        : Object.freeze({
            type: method.result.kind === "void"
              ? "void"
              : needScalar(method.result.primitive),
            passMode: "value" as const,
            nullable: false,
            ownership: Object.freeze({ kind: "value" as const }),
            ...(projection === null || projection.conversion === null
              ? {}
              : { conversion: projection.conversion }),
          }),
      error: errorContract,
    }));
    adapterBindings.push(bindingId);
    const parameterList = method.parameters
      .map((parameter, position) => `a${position}: ${sourceTypeOf(parameter)}`)
      .join(", ");
    const resultType = method.result.kind === "void"
      ? "void"
      : sourceTypeOf(method.result);
    declareMember(
      method.className,
      `  ${method.kind === "static" ? "static " : ""}${member}(${parameterList}): ${resultType};`,
    );
  }
  if (diagnostics.length > 0) throw new JvmGenerationError(diagnostics);

  /* Scalar spellings stay in every signature because they say what the
   * value means. Converted scalars are transparent number aliases; jlong is
   * the one exact branded carrier, mirroring gint64's reasoning. */
  const usedScalarIds = Object.keys(types)
    .filter((id) => /^j(boolean|byte|char|short|int|long|float|double)$/u.test(id))
    .sort(compareText);
  const convertedScalarIds = usedScalarIds.filter(
    (id) => id !== "jlong" && id !== "jboolean",
  );
  const usesJlong = usedScalarIds.includes("jlong");
  if (usesJlong) {
    declarationTypes["jlong"] = Object.freeze({ module: ".", name: "jlong" });
  }
  const declarationLines: string[] = [
    ...(usesJlong ? ["declare const nativeScalar: unique symbol;", ""] : []),
    ...convertedScalarIds.map((id) => `export type ${id} = number;`),
    ...(usesJlong
      ? [
          'export type jlong = bigint & { readonly [nativeScalar]: "jlong" };',
          "",
          "export declare namespace jlong {",
          "  function toNumber(value: jlong): number;",
          "  function fromNumber(value: number): jlong;",
          "}",
        ]
      : []),
    ...(convertedScalarIds.length > 0 || usesJlong ? [""] : []),
  ];
  for (const class_ of options.snapshot.classes) {
    const className = classNameOf.get(class_.binaryName)!;
    const parent = class_.superclass !== null &&
        class_.superclass.kind === "internal"
      ? classNameOf.get(class_.superclass.binaryName)
      : undefined;
    declarationLines.push(
      `export declare class ${className}${parent === undefined ? "" : ` extends ${parent}`} {`,
      ...(declarationsByClass.get(class_.binaryName) ?? []),
      "}",
      "",
    );
  }
  const declarationSource = `${declarationLines.join("\n").trimEnd()}\n`;
  const declarationsDigest = sha256(declarationSource);
  const metadataDigest = sha256(canonicalizeJson({
    sources: options.snapshot.sources,
    clang: options.evidence.semanticDigest,
  }));

  const manifestValue: ScabiManifest = {
    schema: "native-typescript.scabi",
    /* v7: the bytes marshalling contract gained an optional release and an
     * optional length, for the span that comes back beside a compiler-owned
     * length slot. */
    schemaVersion: 7,
    package: options.package,
    target: {
      ...options.target,
      features: [...options.target.features].sort(compareText),
    },
    sdk: {
      ...options.sdk,
      modules: [...options.sdk.modules].sort(compareText),
      metadataDigest,
      toolchain: options.evidence.clang.toolId,
      toolchainVersion: options.evidence.clang.version,
      toolchainAbi: options.target.abi,
    },
    generator: {
      name: "native-typescript.bindgen-jvm",
      version: "1",
      revision: "jvm-scabi-v1",
      arguments: options.snapshot.classes.flatMap((class_) => [
        `--class=${class_.binaryName}`,
        ...class_.constructors.map(({ descriptor }) =>
          `--constructor=${class_.binaryName}.${descriptor}`
        ),
        ...class_.methods.map(({ name, descriptor }) =>
          `--method=${class_.binaryName}.${name}${descriptor}`
        ),
      ]),
      inputDigests: [
        ...options.snapshot.sources.map(({ digest }) => digest as Sha256Digest),
        options.evidence.semanticDigest as Sha256Digest,
        options.adapter.sourceDigest as Sha256Digest,
      ],
    },
    declarations: {
      digest: declarationsDigest,
      types: declarationTypes,
    },
    types,
    bindings,
    linkInputs: [...options.linkInputs].sort((left, right) =>
      left.order - right.order || compareText(left.id, right.id)
    ),
    adapterInputs: [{
      id: options.adapterInput.id,
      family: "jvm-adapters",
      language: "c",
      bindings: [...new Set(adapterBindings)].sort(compareText),
      outputs: [options.adapterInput.output],
      options: {
        sourceDigest: options.adapter.sourceDigest,
        schemaVersion: options.adapter.schemaVersion,
        bind: options.adapter.bind.adapterSymbol,
      },
    }],
    permissions: [],
    platform: {
      family: "jvm",
      packageSlug: slug,
    },
  };
  const manifestSource = canonicalizeJson(manifestValue);
  const manifest = parseScabiManifest(manifestSource);
  return Object.freeze({
    schema: "native-typescript.jvm-scabi-package",
    schemaVersion: 1,
    declarations: declarationSource,
    declarationsDigest,
    manifest,
    manifestSource,
    manifestDigest: digestScabiManifest(manifest),
  });
}
