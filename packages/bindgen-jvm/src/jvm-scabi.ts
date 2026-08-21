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
  SCABI_SCHEMA_VERSION,
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
  JvmSpanElement,
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
    /** Beyond the error-derived edges: what this binding reaches by
     * contract, e.g. a callback registration reaching its cancellation. */
    readonly bindingDependencies?: readonly string[];
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
      dependencies: dependencies([
        ...(input.error !== undefined && "message" in input.error
          ? [input.error.message, input.error.release]
          : []),
        ...(input.bindingDependencies ?? []),
      ]),
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
    /* Ascending by target, not inheritance order: the contract reads this
     * as a SET of valid identity targets, and the ordering is what makes a
     * duplicate target detectable — so it is a real sort rather than a
     * convention about which ancestor comes first. */
    upcasts.sort((left, right) => compareText(left.target, right.target));
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

  /** The TS carrier per span element. */
  const spanCarriers: Readonly<Record<JvmSpanElement, string>> = Object.freeze({
    u8: "Uint8Array",
    i32: "Int32Array",
    f32: "Float32Array",
  });

  /* The physical slot is a byte pointer for EVERY element — the element
   * size is the managed side's business and lives in the marshal — so one
   * pair of pointer types serves the whole family. */
  function needSpanTypes(direction: "argument" | "result"): string {
    types["u8"] ??= Object.freeze({ kind: "integer", signed: false, bits: 8 });
    if (direction === "argument") {
      types["usize"] ??= Object.freeze({
        kind: "integer",
        signed: false,
        bits: "pointer",
      });
      types["const_bytes"] ??= Object.freeze({
        kind: "pointer",
        pointee: "u8",
        mutability: "const",
        nullable: false,
        addressSpace: 0,
      });
      return "const_bytes";
    }
    types["bytes_result"] ??= Object.freeze({
      kind: "pointer",
      pointee: "u8",
      mutability: "mutable",
      nullable: false,
      addressSpace: 0,
    });
    return "bytes_result";
  }

  /* `elem` is stated only when it is not the default the contract reads an
   * absence as. */
  function spanElemField(
    elem: JvmSpanElement,
  ): { readonly elem: JvmSpanElement } | Record<never, never> {
    return elem === "u8" ? {} : { elem };
  }

  function needStringVectorArgumentTypes(): void {
    /* Outer nullability mirrors the position: NULL is an omitted list, not
     * an empty one. Elements are the existing borrowed const string type —
     * non-null, because a NULL slot is the terminator. */
    types["nullable_const_utf8_vector"] ??= Object.freeze({
      kind: "pointer",
      pointee: "const_utf8",
      mutability: "const",
      nullable: true,
      addressSpace: 0,
    });
  }

  function needStringVectorResultTypes(): void {
    /* The element is an owned, NON-null mutable string: a NULL slot is the
     * terminator, so element absence is unrepresentable by construction. */
    types["utf8_owned"] ??= Object.freeze({
      kind: "pointer",
      pointee: "i8",
      mutability: "mutable",
      nullable: false,
      addressSpace: 0,
    });
    types["utf8_vector"] ??= Object.freeze({
      kind: "pointer",
      pointee: "utf8_owned",
      mutability: "mutable",
      nullable: false,
      addressSpace: 0,
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
    if (position.kind === "string-vector") {
      needStringVectorArgumentTypes();
      /* Built for the call out of a managed array the program keeps: the
       * callee may not take it and may not keep it, and frees nothing. */
      return [Object.freeze({
        name: `a${index}`,
        type: "nullable_const_utf8_vector",
        passMode: "pointer" as const,
        nullable: true,
        ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
        marshal: Object.freeze({
          kind: "string-vector" as const,
          encoding: "utf-8" as const,
          termination: "nul" as const,
          embeddedNul: "reject" as const,
        }),
      })];
    }
    if (position.kind === "span") {
      const argType = needSpanTypes("argument");
      /* The span contract admits only a non-null borrowed span, so a null
       * Java array argument is not offered; the adapter copies during the
       * call, exactly as a string crosses. The length names its units
       * because a sibling length in a foreign signature may denominate
       * either way — here it is elements, JNI's only denomination. */
      return [
        Object.freeze({
          name: `a${index}`,
          type: argType,
          passMode: "pointer" as const,
          nullable: false,
          ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
          marshal: Object.freeze({
            kind: "bytes" as const,
            ...spanElemField(position.elem),
            length: Object.freeze({
              kind: "parameter" as const,
              parameter: `a${index}_length`,
              units: "elements" as const,
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
    if (position.kind === "span") return spanCarriers[position.elem];
    if (position.kind === "string-vector") return "string[]";
    return scalarProjections[position.primitive].sourceType;
  }

  /** A vector ARGUMENT may be omitted (NULL is not an empty list), so only
   * the parameter side gains the null arm; the result side stays non-null
   * because a null String[] result refuses at the adapter. */
  function parameterSourceTypeOf(position: JvmAdapterPosition): string {
    return position.kind === "string-vector"
      ? "string[] | null"
      : sourceTypeOf(position);
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
        .map((parameter, position) => `a${position}: ${parameterSourceTypeOf(parameter)}`)
        .join(", ");
      declareMember(
        class_.binaryName,
        first
          ? `  constructor(${parameterList});`
          : `  static ${member}(${parameterList}): ${className};`,
      );
    });
  }

  /* The inward direction: connection machinery once, then one connect
   * binding per selected callback, mirroring the GObject signal contract —
   * receiver-anchored registration, cancellation by disconnect, the handle
   * destructor releasing the record. */
  const connectionTypeId = "jvm.connection";
  const connectionDisconnectId = `${slug}.connection.disconnect`;
  const connectionReleaseId = `${slug}.connection.release`;
  const usesCallbacks = options.adapter.connectionSupport !== null;
  if (usesCallbacks) {
    const support = options.adapter.connectionSupport!;
    types["void_ptr"] ??= Object.freeze({
      kind: "pointer",
      pointee: "void",
      mutability: "mutable",
      nullable: true,
      addressSpace: 0,
    });
    types[connectionTypeId] = Object.freeze({
      kind: "handle",
      nativeName: `nts_jvm_${slug}_connection`,
      threadSafety: "confined",
      identity: "none",
      upcasts: Object.freeze([]),
      destructor: connectionReleaseId,
    });
    declarationTypes[connectionTypeId] = Object.freeze({
      module: ".",
      name: "JvmConnection",
    });
    defineBinding(connectionDisconnectId, callable({
      declaration: "JvmConnection.disconnect",
      kind: "method",
      symbol: support.disconnectSymbol,
      parameters: [
        Object.freeze({
          name: "connection",
          type: connectionTypeId,
          passMode: "pointer" as const,
          nullable: false,
          ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
        }),
      ],
      result: Object.freeze({
        type: "void",
        passMode: "value" as const,
        nullable: false,
        ownership: Object.freeze({ kind: "value" as const }),
      }),
    }));
    defineBinding(connectionReleaseId, callable({
      declaration: "JvmConnection.__release",
      kind: "method",
      symbol: support.releaseSymbol,
      parameters: [
        Object.freeze({
          name: "connection",
          type: connectionTypeId,
          passMode: "pointer" as const,
          nullable: true,
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
    adapterBindings.push(connectionDisconnectId, connectionReleaseId);
  }
  /* A callback payload handle is spelled OPPOSITE to a method argument
   * handle: non-null (the trampoline refuses NULL by name before
   * promoting) and owned with transfer to-runtime, because the adapter
   * promoted the frame-scoped local reference and the managed cell's
   * destructor — derived from the handle type's declared release — gives
   * the promotion back. The queued payload's spelling, and synchronous
   * delivery shares it (fork 0309d850): there is no borrowed handle form
   * in the runtime to want. */
  function callbackPositionParameters(
    position: JvmAdapterPosition,
    index: number,
  ): readonly AbiParameter[] {
    if (position.kind === "handle") {
      return [Object.freeze({
        name: `a${index}`,
        type: selectedTypeIds.get(position.binaryName)!,
        passMode: "pointer" as const,
        nullable: false,
        ownership: Object.freeze({
          kind: "owned" as const,
          transfer: "to-runtime" as const,
        }),
      })];
    }
    return positionParameters(position, index);
  }
  /* The handler's payload type has no null arm, unlike a method argument's. */
  function payloadSourceTypeOf(position: JvmAdapterPosition): string {
    return position.kind === "handle"
      ? classNameOf.get(position.binaryName)!
      : sourceTypeOf(position);
  }
  for (const callback of options.adapter.callbacks) {
    const className = classNameOf.get(callback.className);
    const typeId = selectedTypeIds.get(callback.className);
    if (className === undefined || typeId === undefined) continue;
    const classAnchored = callback.anchor === "class";
    const callbackTypeId =
      `jvm.${idToken(callback.className)}.${callback.name.toLowerCase()}.callback`;
    const bindingId =
      `${slug}.${idToken(callback.className)}.${callback.name.toLowerCase()}`;
    const callbackParameters = callback.parameters.flatMap((position, index) =>
      callbackPositionParameters(position, index)
    );
    types[callbackTypeId] = Object.freeze({
      kind: "callback",
      signature: Object.freeze({
        callingConvention: "c" as const,
        variadic: false as const,
        parameters: Object.freeze(callbackParameters),
        result: Object.freeze({
          /* Answered: the handler's boolean IS the emitting call's result,
           * which is what lets delivery run on the caller's thread with no
           * queue. Told: nothing comes back but the handler still runs
           * during the caller's frame — synchronousReturn with a void ret,
           * the arm fork 3c33818a admitted, because the emitting call
           * observes the handler rather than an answer. Queued: nothing
           * comes back, and delivery runs at the runtime's pump. */
          type: callback.delivery === "answered"
            ? needScalar("boolean")
            : "void",
          passMode: "value" as const,
          nullable: false,
          ownership: Object.freeze({ kind: "value" as const }),
        }),
      }),
      context: Object.freeze({ placement: "last" as const, type: "void_ptr" }),
    });
    /* A class-anchored registration is owned by the PROCESS: there is no
     * receiver whose lifetime bounds it, which is the same fact as having
     * no handle to hand back and no disposal to cancel through. So the
     * binding takes no receiver, returns nothing, and names no
     * cancellation — and a refused second registration travels the error
     * channel, because a call that hands nothing back cannot say
     * "refused" with a value. */
    defineBinding(bindingId, callable({
      declaration: `${className}.${callback.name}`,
      kind: classAnchored ? "static-method" : "method",
      symbol: callback.connectSymbol,
      parameters: [
        ...(classAnchored
          ? []
          : [Object.freeze({
              name: "self",
              type: typeId,
              passMode: "pointer" as const,
              nullable: false,
              ownership: Object.freeze({ kind: "borrowed", scope: "call" }),
            })]),
        Object.freeze({
          name: "callback",
          type: callbackTypeId,
          passMode: "pointer" as const,
          nullable: false,
          ownership: Object.freeze({
            kind: "borrowed" as const,
            scope: "registration" as const,
            /* The anchor names what owns the registration, so it says
             * "process" exactly when nothing does. */
            anchor: classAnchored ? "process" : "self",
          }),
          callback: Object.freeze({
            registrationOwner: classAnchored ? "process" : "self",
            ...(classAnchored
              ? {}
              : { cancellationBinding: connectionDisconnectId }),
            contextParameter: "context",
            allowedInvocationExecutors: Object.freeze([
              Object.freeze({ kind: "same-as-caller" as const }),
            ]),
            synchronousReturn: callback.delivery !== "queued",
            /* A synchronous handler — answered or told — borrows during
             * the call because nothing outlives the frame; a queued one is
             * copied because delivery outlives the emission. */
            arguments: Object.freeze(callbackParameters.map((parameter) =>
              Object.freeze({
                parameter: parameter.name,
                transport: callback.delivery === "queued"
                  ? ("copy" as const)
                  : ("borrow" as const),
              })
            )),
            sourceArguments: Object.freeze([
              /* A queued handler receives its sender; a synchronous one —
               * answered or told — does not: injecting one would mean a
               * managed handle for the length of the call, which a
               * borrowed payload does not have. The same reasoning the
               * GObject contract states, and it does not weaken when
               * nothing comes back. */
              ...(callback.delivery === "queued"
                ? [Object.freeze({ kind: "registration-owner" as const })]
                : []),
              ...callbackParameters.map((parameter) =>
                Object.freeze({
                  kind: "callback-parameter" as const,
                  parameter: parameter.name,
                })
              ),
            ]),
          }),
        }),
        Object.freeze({
          name: "context",
          type: "void_ptr",
          passMode: "pointer" as const,
          nullable: false,
          ownership: Object.freeze({
            kind: "borrowed" as const,
            scope: "registration" as const,
            anchor: "callback",
          }),
        }),
      ],
      result: classAnchored
        ? Object.freeze({
            type: "void",
            passMode: "value" as const,
            nullable: false,
            ownership: Object.freeze({ kind: "value" as const }),
          })
        : Object.freeze({
            type: connectionTypeId,
            passMode: "pointer" as const,
            nullable: true,
            ownership: Object.freeze({
              kind: "owned" as const,
              transfer: "to-runtime" as const,
            }),
          }),
      error: classAnchored
        ? errorContract
        : Object.freeze({ kind: "nullable" as const }),
      /* The error contract's own edges are derived by `callable`; a
       * process-owned registration reaches nothing else, because it has
       * no cancellation to reach. */
      bindingDependencies: classAnchored
        ? []
        : [connectionDisconnectId, connectionReleaseId],
    }));
    adapterBindings.push(bindingId);
    const handlerParameters = [
      /* The queued handler's first argument is its sender. */
      ...(callback.delivery === "queued" ? [`sender: ${className}`] : []),
      ...callback.parameters.map(
        (parameter, position) =>
          `a${position}: ${payloadSourceTypeOf(parameter)}`,
      ),
    ].join(", ");
    declareMember(
      callback.className,
      `  ${classAnchored ? "static " : ""}${callback.name}(callback: (${
        handlerParameters
      }) => ${callback.delivery === "answered" ? "boolean" : "void"}): ${
        classAnchored ? "void" : "JvmConnection"
      };`,
    );
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
             * that ownership and release must agree. The length rides the
             * compiler's own out slot (an absent `length` means exactly
             * that), so a Java string carrying U+0000 crosses as data
             * instead of refusing — a String may always hold one, and no
             * per-method metadata says otherwise. Null on success is an
             * ordinary value; the error-out slot is what reads failure,
             * which is exactly why this coexists with a string result. */
            type: "nullable_utf8",
            passMode: "pointer" as const,
            nullable: true,
            ownership: Object.freeze({ kind: "value" as const }),
            marshal: Object.freeze({
              kind: "string" as const,
              encoding: "utf-8" as const,
              termination: "none" as const,
              embeddedNul: "allow" as const,
              release: "free" as const,
            }),
          }))
        : method.result.kind === "string-vector"
        ? (needStringVectorResultTypes(),
          Object.freeze({
            /* An owned two-level copy the projection consumes; the one
             * release the marshal names frees elements and vector both,
             * which is the adapter's generated spelling. Non-null: a null
             * String[] refuses at the adapter as a named absence, exactly
             * as a null byte[] does. */
            type: "utf8_vector",
            passMode: "pointer" as const,
            nullable: false,
            ownership: Object.freeze({ kind: "value" as const }),
            marshal: Object.freeze({
              kind: "string-vector" as const,
              encoding: "utf-8" as const,
              termination: "nul" as const,
              embeddedNul: "reject" as const,
              release: options.adapter.stringVectorSupport!.releaseSymbol,
            }),
          }))
        : method.result.kind === "span"
        ? Object.freeze({
            /* An owned copy exactly like the string result, with the one
             * new fact stated by absence: the marshal carries no length,
             * because the extent returns in a compiler-owned slot beside
             * the error slot, counting elements by construction. The slot
             * is non-null — a null array refuses at the adapter as a named
             * absence — and free() ends the program's claim on the
             * malloc'd copy. */
            type: needSpanTypes("result"),
            passMode: "pointer" as const,
            nullable: false,
            ownership: Object.freeze({ kind: "value" as const }),
            marshal: Object.freeze({
              kind: "bytes" as const,
              ...spanElemField(method.result.elem),
              mutability: "mutable" as const,
              release: "free",
            }),
          })
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
      .map((parameter, position) => `a${position}: ${parameterSourceTypeOf(parameter)}`)
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
    ...(usesCallbacks
      ? [
          "declare const nativeResourceJvmConnection: unique symbol;",
          "",
          "export interface JvmConnection {",
          "  readonly [nativeResourceJvmConnection]: true;",
          "  disconnect(): void;",
          "}",
          "",
        ]
      : []),
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
    /* Reported, never chosen: a producer states the contract version it
     * was built against. */
    schemaVersion: SCABI_SCHEMA_VERSION,
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
