/**
 * Generates the JNI adapter C for a selected JVM surface: the bindgen-jvm
 * analogue of gobject-adapter.ts. Each selected member becomes one ordinary
 * C symbol the existing call algebra reaches, materializing the env-table
 * dispatch and method-ID identity behind it. The adapter translates
 * conventions and decides no lifetime: acquisition of a constructed object
 * is normalized to one stable global reference whose release SYMBOL is
 * named, and when it is released stays the compiler's decision.
 *
 * `JNIEnv *` is a thread capability the runtime owns; every adapter takes
 * it rather than acquiring it, because acquisition is a context decision an
 * adapter is not allowed to make.
 *
 * The algebra is deliberately bounded and refuses precisely: JNI primitive
 * scalars and void, selected-class handles, java/lang/String through an
 * exact UTF-16 bridge, byte[] both directions through JNI's Region copy
 * convention (borrowed span in, owned copy out beside a compiler-owned
 * length slot), String[] results as owned NUL-terminated vectors,
 * constructors, and the checked failure channel (pending exception
 * captured to an error-out slot). String[] arguments and the remaining
 * element families are named next slices.
 */

import { createHash } from "node:crypto";
import { JvmGenerationError } from "./jvm-model.ts";
import type {
  JvmClass,
  JvmDiagnostic,
  JvmMethod,
  JvmPrimitive,
  JvmSnapshot,
  JvmTypeReference,
} from "./jvm-model.ts";

/** One adapter position: a JNI primitive scalar, a stable reference to a
 * class this selection projects, a string, or (arguments only) a borrowed
 * byte span — two C slots carrying one Java byte[]. */
export type JvmAdapterPosition =
  | { readonly kind: "primitive"; readonly primitive: JvmPrimitive }
  | { readonly kind: "handle"; readonly binaryName: string }
  | { readonly kind: "string" }
  | { readonly kind: "byte-span" };

/** A byte-span result crosses as an owned copy with a compiler-owned
 * length out slot beside the error slot:
 * `uint8_t *sym(args, size_t *out_length, char **error)`. A string-vector
 * result crosses as an owned NUL-terminated `char **` copy — JNI hands
 * the adapter the length, and the adapter normalizes it into the
 * terminator the contract already speaks. */
export type JvmAdapterResult =
  | { readonly kind: "void" }
  | { readonly kind: "primitive"; readonly primitive: JvmPrimitive }
  | { readonly kind: "handle"; readonly binaryName: string }
  | { readonly kind: "string" }
  | { readonly kind: "byte-span" }
  | { readonly kind: "string-vector" };

export interface JvmConstructorAdapter {
  readonly className: string;
  /** The JNI identity the adapter resolves: ("<init>", descriptor). */
  readonly descriptor: string;
  readonly adapterSymbol: string;
  readonly parameters: readonly JvmAdapterPosition[];
}

export interface JvmMethodAdapter {
  readonly kind: "static" | "instance";
  readonly className: string;
  readonly name: string;
  readonly descriptor: string;
  readonly adapterSymbol: string;
  readonly result: JvmAdapterResult;
  readonly parameters: readonly JvmAdapterPosition[];
}

export interface JvmBindAdapter {
  /** Resolves every class and method ID once; must run before any call. */
  readonly adapterSymbol: string;
  /** The VM-first spelling a target runtime invokes after creating or
   * adopting the JavaVM. */
  readonly bindVmSymbol: string;
}

/**
 * The generated env acquisition every other family calls through: the
 * JavaVM cached at bind time answers GetEnv for the current thread. This is
 * the package's one declared GAP — see its classification.
 */
export interface JvmEnvSupportAdapter {
  readonly helperSymbol: string;
}

export interface JvmReleaseAdapter {
  /** Releases one stable reference of ANY selected class. DeleteGlobalRef
   * is class-blind, and the destructor rule admits a release typed at any
   * identity-upcast target, so the one release lives on the root handle
   * every class upcasts to. */
  readonly adapterSymbol: string;
}

/**
 * The `error-out` support pair, shaped exactly as the landed SCABI contract
 * consumes it: every adapter writes an owned error object into a trailing
 * slot (null on success), `messageSymbol` reads its message, and
 * `releaseSymbol` releases it. The object IS its message — one malloc'd
 * string — so the message read is an identity and the release is free().
 */
export interface JvmErrorSupportAdapter {
  readonly messageSymbol: string;
  readonly releaseSymbol: string;
}

export interface JvmAdapterSource {
  readonly schema: "native-typescript.jvm-adapter-source";
  readonly schemaVersion: 11;
  readonly source: string;
  readonly sourceDigest: string;
  /** Declarations for every public adapter symbol. The ABI probe compiles
   * against this beside jni.h, and an embedding host includes it. */
  readonly header: string;
  readonly headerFileName: string;
  readonly bind: JvmBindAdapter;
  readonly envSupport: JvmEnvSupportAdapter;
  readonly release: JvmReleaseAdapter;
  readonly errorSupport: JvmErrorSupportAdapter;
  /** Present when any position is a java/lang/String: the generated UTF-16
   * bridge both directions cross through. Null when no string crosses. */
  readonly stringSupport: { readonly bridge: "utf-16" } | null;
  /** Present when any position is a byte[]: spans cross by one Region copy
   * in either direction. Null when no span crosses. */
  readonly byteSpanSupport: { readonly region: "copy" } | null;
  /** Present when any result is a String[]: the generated release that
   * frees the owned vector AND its elements, which is what makes one
   * release symbol sufficient for a two-level copy. Null when none. */
  readonly stringVectorSupport: { readonly releaseSymbol: string } | null;
  readonly constructors: readonly JvmConstructorAdapter[];
  readonly staticMethods: readonly JvmMethodAdapter[];
  readonly instanceMethods: readonly JvmMethodAdapter[];
}

/**
 * What one family of generated C is allowed to be — the same rule
 * gobject-adapter.ts enforces, stated per family so that adding one without
 * classifying it does not compile. There is deliberately no `decision` arm.
 */
export type JvmAdapterClassification =
  | {
      readonly kind: "translation";
      readonly custom: string;
    }
  | {
      readonly kind: "gap";
      readonly missing: string;
      readonly cost: string;
    };

type JvmAdapterMetadata =
  | "schema"
  | "schemaVersion"
  | "source"
  | "sourceDigest"
  | "header"
  | "headerFileName";

export const JVM_ADAPTER_FAMILIES: Readonly<
  Record<
    Exclude<keyof JvmAdapterSource, JvmAdapterMetadata>,
    JvmAdapterClassification
  >
> = Object.freeze({
  bind: {
    kind: "translation",
    custom:
      "a JNI callee is reached through a per-thread function table by a " +
      "method ID resolved from (class, name, descriptor) strings; " +
      "resolution is registration identity performed once, not a call, " +
      "and the JavaVM is cached here because it is process identity. The " +
      "package also announces its bind at image load through the target " +
      "runtime's registration slot when one is linked - a weak reference, " +
      "so a host driving bind directly links without the runtime",
  },
  envSupport: {
    kind: "gap",
    missing:
      "a thread-capability position in the boundary contract, so a call " +
      "could receive the JNIEnv the compiler knows it holds",
    cost:
      "one GetEnv table lookup per adapter call, and every call is legal " +
      "only from a thread already attached to the JVM - the first JNI " +
      "slice's stated constraint. No lifetime or executor is decided here: " +
      "GetEnv answers which env the CURRENT thread already has.",
  },
  release: {
    kind: "translation",
    custom:
      "JNI spells releasing one stable reference DeleteGlobalRef(env, ref); " +
      "the current thread's env is looked up through the declared gap so " +
      "the release is unary, which is what destructor-as-data needs. One " +
      "spelling serves every class because DeleteGlobalRef is class-blind " +
      "and a destructor may consume any identity-upcast target, so the " +
      "release is typed at the root handle. Owner-confined destruction " +
      "already guarantees an attached thread; an unattached one traps.",
  },
  errorSupport: {
    kind: "translation",
    custom:
      "failure is a pending exception, and only a restricted set of JNI " +
      "operations is legal until it is captured or cleared; capture " +
      "materializes the throwable's message into the error-out slot and " +
      "clears, off the hot path, and the message read and release the " +
      "contract names are ordinary C functions over that object",
  },
  stringSupport: {
    kind: "translation",
    custom:
      "JNI's native string encodings are UTF-16 (NewString, " +
      "GetStringRegion) and modified UTF-8, never the contract's UTF-8, so " +
      "the adapter converts exactly in both directions; a Java string " +
      "carrying U+0000 refuses through the error channel because the " +
      "contract rejects embedded NUL, and an unpaired surrogate refuses " +
      "because it has no UTF-8 at all",
  },
  byteSpanSupport: {
    kind: "translation",
    custom:
      "byte[] crosses by JNI's own Region convention in both directions, " +
      "not by decision: an argument becomes a frame-scoped jbyteArray " +
      "(NewByteArray + SetByteArrayRegion, released after the call; a span " +
      "past the jsize bound refuses because no Java array can hold it), " +
      "and a result copies out (GetArrayLength + GetByteArrayRegion) into " +
      "owned storage whose release is free, with its length written to the " +
      "compiler-owned out slot beside the error slot. A null byte[] result " +
      "is a named absence that refuses through the error channel; an empty " +
      "one is a real allocation with length zero",
  },
  stringVectorSupport: {
    kind: "translation",
    custom:
      "a String[] result is a jobjectArray whose length JNI carries on the " +
      "object; the adapter normalizes it into the NUL terminator the " +
      "string-vector contract already speaks, copying each element out " +
      "through the UTF-16 bridge into an owned vector the named release " +
      "frees elements-and-all. A null String[] and a null ELEMENT are both " +
      "named absences that refuse through the error channel - a NULL slot " +
      "is the terminator, so an element's absence has no spelling that " +
      "does not end the vector early",
  },
  constructors: {
    kind: "translation",
    custom:
      "NewObject returns a frame-scoped local reference no neutral handle " +
      "can hold; acquisition is normalized to one stable global reference " +
      "whose release symbol is named, and when it is released stays the " +
      "compiler's decision",
  },
  staticMethods: {
    kind: "translation",
    custom:
      "the call is CallStatic<Type>Method through the env table with a " +
      "cached class reference and method ID; an object result is promoted " +
      "to a stable global reference exactly as a constructor's is",
  },
  instanceMethods: {
    kind: "translation",
    custom:
      "the call is Call<Type>Method through the env table on a stable " +
      "receiver reference with a cached method ID; an object result is a " +
      "frame-scoped local reference, so its acquisition is normalized to a " +
      "stable global reference exactly as a constructor's is",
  },
});

/** The C spelling jni.h gives each JVM primitive; the probe and the
 * manifest both need it, so it is the adapter's exported vocabulary. */
export const jniCTypes: Readonly<Record<JvmPrimitive, string>> = Object.freeze({
  boolean: "jboolean",
  byte: "jbyte",
  char: "jchar",
  short: "jshort",
  int: "jint",
  long: "jlong",
  float: "jfloat",
  double: "jdouble",
});

const jniCallNames: Readonly<Record<JvmPrimitive, string>> = Object.freeze({
  boolean: "Boolean",
  byte: "Byte",
  char: "Char",
  short: "Short",
  int: "Int",
  long: "Long",
  float: "Float",
  double: "Double",
});

function diagnostic(path: string, message: string): JvmDiagnostic {
  return { code: "NTS7001", severity: "error", path, message };
}

function cSafe(binaryName: string): string {
  return binaryName.replace(/[/$]/gu, "_");
}

function descriptorSuffix(descriptor: string): string {
  return createHash("sha256").update(descriptor).digest("hex").slice(0, 8);
}

function renderArrayType(
  type: Extract<JvmTypeReference, { kind: "array" }>,
): string {
  const element = type.element.kind === "primitive"
    ? type.element.name
    : type.element.binaryName;
  return `${element}${"[]".repeat(type.dimensions)}`;
}

/** One position, or null with a precise refusal. A selected class is an
 * ordinary handle; an unselected one is a boundary the caller can move by
 * selecting the class. Arrays admit by element family AND direction:
 * byte[] crosses both ways, String[] comes back as a NUL-terminated
 * vector but does not yet cross inward, and everything else refuses by
 * its family, because each family is its own slice with its own demand. */
function positionOf(
  type: JvmTypeReference,
  selectedNames: ReadonlySet<string>,
  path: string,
  what: string,
  role: "parameter" | "result",
  diagnostics: JvmDiagnostic[],
): JvmAdapterPosition | JvmAdapterResult | null {
  if (type.kind === "void") return { kind: "void" };
  if (type.kind === "primitive") {
    return { kind: "primitive", primitive: type.name };
  }
  if (type.kind === "object") {
    if (type.binaryName === "java/lang/String") {
      return { kind: "string" };
    }
    if (selectedNames.has(type.binaryName)) {
      return { kind: "handle", binaryName: type.binaryName };
    }
    diagnostics.push(
      diagnostic(
        path,
        `${what} is object type '${type.binaryName}', which this selection ` +
          "does not project; select the class to move the boundary",
      ),
    );
    return null;
  }
  const isByteArray = type.dimensions === 1 &&
    type.element.kind === "primitive" &&
    type.element.name === "byte";
  if (isByteArray) {
    return { kind: "byte-span" };
  }
  const isStringArray = type.dimensions === 1 &&
    type.element.kind === "object" &&
    type.element.binaryName === "java/lang/String";
  if (isStringArray && role === "result") {
    return { kind: "string-vector" };
  }
  diagnostics.push(
    diagnostic(
      path,
      isStringArray
        ? `${what} is String[], which crosses only as a result today; ` +
          "the string-vector argument projection is a named next slice"
        : `${what} is array type '${renderArrayType(type)}', whose element ` +
          "family is not yet projected",
    ),
  );
  return null;
}

interface ResolvedSignature {
  readonly parameters: readonly JvmAdapterPosition[];
  readonly result: JvmAdapterResult;
}

function resolveSignature(
  method: JvmMethod,
  selectedNames: ReadonlySet<string>,
  path: string,
  diagnostics: JvmDiagnostic[],
): ResolvedSignature | null {
  const parameters: JvmAdapterPosition[] = [];
  let refused = false;
  method.parameters.forEach((parameter, index) => {
    const position = positionOf(
      parameter,
      selectedNames,
      `${path}/parameters/${index}`,
      `Parameter ${index}`,
      "parameter",
      diagnostics,
    );
    if (
      position === null || position.kind === "void" ||
      position.kind === "string-vector"
    ) refused = true;
    else parameters.push(position);
  });
  const result = positionOf(
    method.result,
    selectedNames,
    `${path}/result`,
    "Result",
    "result",
    diagnostics,
  );
  if (result === null || refused) return null;
  return { parameters, result };
}

function positionDeclaration(
  position: JvmAdapterPosition,
  index: number,
): string {
  if (position.kind === "primitive") {
    return `${jniCTypes[position.primitive]} a${index}`;
  }
  if (position.kind === "string") return `const char *a${index}`;
  if (position.kind === "byte-span") {
    /* One source value, two C slots: the bytes marshalling contract pairs a
     * borrowed const pointer with a usize length parameter it names. */
    return `const uint8_t *a${index}, size_t a${index}_length`;
  }
  return `void *a${index}`;
}

export interface JvmAdapterOptions {
  /** Names every generated symbol: nts_jvm_<slug>_... */
  readonly packageSlug: string;
}

export function generateJvmAdapterSource(
  snapshot: JvmSnapshot,
  options: JvmAdapterOptions,
): JvmAdapterSource {
  const diagnostics: JvmDiagnostic[] = [];
  if (!/^[a-z][a-z0-9_]*$/u.test(options.packageSlug)) {
    diagnostics.push(
      diagnostic("packageSlug", "Package slug must be [a-z][a-z0-9_]*"),
    );
    throw new JvmGenerationError(diagnostics);
  }
  const slug = options.packageSlug;
  const prefix = `nts_jvm_${slug}`;

  interface ClassPlan {
    readonly class_: JvmClass;
    readonly classVar: string;
    readonly members: {
      readonly midVar: string;
      readonly name: string;
      readonly descriptor: string;
      readonly static: boolean;
    }[];
  }
  const plans: ClassPlan[] = [];
  const constructors: JvmConstructorAdapter[] = [];
  const staticMethods: JvmMethodAdapter[] = [];
  const instanceMethods: JvmMethodAdapter[] = [];
  const bodies: string[] = [];
  const headerDeclarations: string[] = [];
  const selectedNames: ReadonlySet<string> = new Set(
    snapshot.classes.map(({ binaryName }) => binaryName),
  );
  let usesStrings = false;
  let usesByteSpans = false;
  let usesStringVectors = false;

  /* Releases every bridged local built before `before`, for the path where
   * a later bridge refuses; strings and byte spans clean each other up. */
  function priorBridgeCleanup(
    parameters: readonly JvmAdapterPosition[],
    before: number,
    indent: string,
  ): string[] {
    return parameters.slice(0, before).flatMap((prior, earlier) =>
      prior.kind === "string"
        ? [`${indent}if (js${earlier} != NULL) (*env)->DeleteLocalRef(env, js${earlier});`]
        : prior.kind === "byte-span"
          ? [`${indent}(*env)->DeleteLocalRef(env, ba${earlier});`]
          : []
    );
  }

  /* String and byte[] arguments cross through frame-scoped locals built
   * before the call and released after it: strings through the UTF-16
   * bridge, byte spans through one SetByteArrayRegion copy. */
  function bridgedPrologue(
    parameters: readonly JvmAdapterPosition[],
    zeroReturn: string,
  ): string[] {
    const lines: string[] = [];
    parameters.forEach((parameter, index) => {
      if (parameter.kind === "string") {
        usesStrings = true;
        lines.push(
          `  jstring js${index} = NULL;`,
          `  if (a${index} != NULL) {`,
          `    js${index} = ${prefix}_utf8_to_jstring(env, a${index}, error);`,
          `    if (*error != NULL) {`,
          ...priorBridgeCleanup(parameters, index, "      "),
          `      ${zeroReturn}`,
          `    }`,
          `  }`,
        );
      }
      if (parameter.kind === "byte-span") {
        usesByteSpans = true;
        lines.push(
          /* jsize is jint, so a span longer than INT32_MAX has no Java
           * array; the contract's span is non-null, so there is no null
           * arm. The Region copy's bounds are valid by construction and
           * cannot throw. */
          `  if (a${index}_length > (size_t)INT32_MAX) {`,
          `    *error = ${prefix}_message("byte span exceeds the JVM array bound");`,
          ...priorBridgeCleanup(parameters, index, "    "),
          `    ${zeroReturn}`,
          `  }`,
          `  jbyteArray ba${index} =`,
          `      (*env)->NewByteArray(env, (jsize)a${index}_length);`,
          `  if ((*env)->ExceptionCheck(env)) {`,
          `    ${prefix}_capture(env, error);`,
          ...priorBridgeCleanup(parameters, index, "    "),
          `    ${zeroReturn}`,
          `  }`,
          `  if (ba${index} == NULL) {`,
          `    *error = ${prefix}_message("NewByteArray failed");`,
          ...priorBridgeCleanup(parameters, index, "    "),
          `    ${zeroReturn}`,
          `  }`,
          `  if (a${index}_length > 0) {`,
          `    (*env)->SetByteArrayRegion(env, ba${index}, 0,`,
          `                               (jsize)a${index}_length,`,
          `                               (const jbyte *)a${index});`,
          `  }`,
        );
      }
    });
    return lines;
  }

  function bridgedEpilogue(parameters: readonly JvmAdapterPosition[]): string[] {
    return parameters.flatMap((parameter, index) =>
      parameter.kind === "string"
        ? [`  if (js${index} != NULL) (*env)->DeleteLocalRef(env, js${index});`]
        : parameter.kind === "byte-span"
          ? [`  (*env)->DeleteLocalRef(env, ba${index});`]
          : []
    );
  }

  function argumentOf(parameter: JvmAdapterPosition, index: number): string {
    if (parameter.kind === "handle") return `(jobject)a${index}`;
    if (parameter.kind === "string") return `js${index}`;
    if (parameter.kind === "byte-span") return `ba${index}`;
    return `a${index}`;
  }

  for (const class_ of snapshot.classes) {
    const classToken = cSafe(class_.binaryName);
    const plan: ClassPlan = {
      class_,
      classVar: `${prefix}_cls_${classToken}`,
      members: [],
    };
    const overloadedNames = new Set(
      class_.methods
        .map(({ name }) => name)
        .filter((name, _, all) =>
          all.indexOf(name) !== all.lastIndexOf(name)
        ),
    );
    for (const constructor of class_.constructors) {
      const path = `class/${class_.binaryName}/constructor/${constructor.descriptor}`;
      const signature = resolveSignature(constructor, selectedNames, path, diagnostics);
      if (signature === null) continue;
      const suffix = class_.constructors.length > 1
        ? `_${descriptorSuffix(constructor.descriptor)}`
        : "";
      const midVar = `${prefix}_mid_${classToken}_init${suffix}`;
      plan.members.push({
        midVar,
        name: "<init>",
        descriptor: constructor.descriptor,
        static: false,
      });
      const adapterSymbol = `${prefix}_new_${classToken}${suffix}`;
      const parameterDeclarations = signature.parameters.map(positionDeclaration);
      const argumentList = signature.parameters.map(argumentOf);
      headerDeclarations.push(
        `void *${adapterSymbol}(${[...parameterDeclarations, "char **error"].join(", ")});`,
      );
      bodies.push(
        `/* ${class_.binaryName}.<init>${constructor.descriptor} */`,
        `void *${adapterSymbol}(${[
          ...parameterDeclarations,
          "char **error",
        ].join(", ")}) {`,
        `  JNIEnv *env = ${prefix}_env(error);`,
        `  if (env == NULL) return NULL;`,
        ...bridgedPrologue(signature.parameters, "return NULL;"),
        `  jobject local = (*env)->NewObject(${[
          "env",
          plan.classVar,
          midVar,
          ...argumentList,
        ].join(", ")});`,
        ...bridgedEpilogue(signature.parameters),
        `  if ((*env)->ExceptionCheck(env)) {`,
        `    ${prefix}_capture(env, error);`,
        `    return NULL;`,
        `  }`,
        `  jobject stable = (*env)->NewGlobalRef(env, local);`,
        `  (*env)->DeleteLocalRef(env, local);`,
        `  if (stable == NULL) *error = ${prefix}_message("JNI global reference table exhausted");`,
        `  return stable;`,
        `}`,
        "",
      );
      constructors.push(
        Object.freeze({
          className: class_.binaryName,
          descriptor: constructor.descriptor,
          adapterSymbol,
          parameters: Object.freeze([...signature.parameters]),
        }),
      );
    }
    for (const method of class_.methods) {
      const path = `class/${class_.binaryName}/method/${method.name}`;
      const signature = resolveSignature(method, selectedNames, path, diagnostics);
      if (signature === null) continue;
      const suffix = overloadedNames.has(method.name)
        ? `_${descriptorSuffix(method.descriptor)}`
        : "";
      const midVar = `${prefix}_mid_${classToken}_${method.name}${suffix}`;
      plan.members.push({
        midVar,
        name: method.name,
        descriptor: method.descriptor,
        static: method.access.static,
      });
      const adapterSymbol = `${prefix}_call_${classToken}_${method.name}${suffix}`;
      const result = signature.result;
      if (result.kind === "byte-span") usesByteSpans = true;
      if (result.kind === "string-vector") {
        usesStringVectors = true;
        /* Elements cross through the same bridge single strings do. */
        usesStrings = true;
      }
      const returnType = result.kind === "void"
        ? "void"
        : result.kind === "primitive"
          ? jniCTypes[result.primitive]
          : result.kind === "string"
            ? "char *"
            : result.kind === "byte-span"
              ? "uint8_t *"
              : result.kind === "string-vector"
                ? "char **"
                : "void *";
      const callName = result.kind === "void"
        ? "Void"
        : result.kind === "primitive"
          ? jniCallNames[result.primitive]
          : "Object";
      const zeroReturn = result.kind === "void"
        ? "return;"
        : result.kind === "primitive"
          ? `return (${returnType})0;`
          : "return NULL;";
      const receiver = method.access.static
        ? []
        : ["void *self"];
      const callTarget = method.access.static
        ? plan.classVar
        : "(jobject)self";
      const callFamily = method.access.static ? "CallStatic" : "Call";
      const parameterDeclarations = signature.parameters.map(positionDeclaration);
      const argumentList = signature.parameters.map(argumentOf);
      /* A byte-span result's length comes back beside the pointer, in a
       * compiler-owned out slot placed with the error slot. */
      const trailing = result.kind === "byte-span"
        ? ["size_t *out_length", "char **error"]
        : ["char **error"];
      const call = `(*env)->${callFamily}${callName}Method(${[
        "env",
        callTarget,
        midVar,
        ...argumentList,
      ].join(", ")})`;
      headerDeclarations.push(
        `${returnType}${returnType.endsWith("*") ? "" : " "}${adapterSymbol}(${[
          ...receiver,
          ...parameterDeclarations,
          ...trailing,
        ].join(", ")});`,
      );
      bodies.push(
        `/* ${class_.binaryName}.${method.name}${method.descriptor} */`,
        `${returnType}${returnType.endsWith("*") ? "" : " "}${adapterSymbol}(${[
          ...receiver,
          ...parameterDeclarations,
          ...trailing,
        ].join(", ")}) {`,
        `  JNIEnv *env = ${prefix}_env(error);`,
        `  if (env == NULL) ${zeroReturn}`,
        ...bridgedPrologue(signature.parameters, zeroReturn),
        ...(result.kind === "void"
          ? [
              `  ${call};`,
              ...bridgedEpilogue(signature.parameters),
              `  if ((*env)->ExceptionCheck(env)) ${prefix}_capture(env, error);`,
            ]
          : result.kind === "handle"
            ? [
                /* An object result is a frame-scoped local reference; its
                 * acquisition is normalized exactly as a constructor's. A
                 * NULL local with no exception is a successful null. */
                `  jobject local = ${call};`,
                ...bridgedEpilogue(signature.parameters),
                `  if ((*env)->ExceptionCheck(env)) {`,
                `    ${prefix}_capture(env, error);`,
                `    return NULL;`,
                `  }`,
                `  if (local == NULL) return NULL;`,
                `  jobject stable = (*env)->NewGlobalRef(env, local);`,
                `  (*env)->DeleteLocalRef(env, local);`,
                `  if (stable == NULL) *error = ${prefix}_message("JNI global reference table exhausted");`,
                `  return stable;`,
              ]
            : result.kind === "string"
              ? [
                  /* A string result crosses by copy through the UTF-16
                   * bridge; the Java string itself never survives the call.
                   * NULL with an empty error slot is a successful null. */
                  `  jstring resultString = (jstring)${call};`,
                  ...bridgedEpilogue(signature.parameters),
                  `  if ((*env)->ExceptionCheck(env)) {`,
                  `    ${prefix}_capture(env, error);`,
                  `    return NULL;`,
                  `  }`,
                  `  if (resultString == NULL) return NULL;`,
                  `  char *owned = ${prefix}_jstring_to_utf8(env, resultString, error);`,
                  `  (*env)->DeleteLocalRef(env, resultString);`,
                  `  return owned;`,
                ]
              : result.kind === "string-vector"
                ? [
                    /* A String[] result: JNI carries the length on the
                     * object; the adapter normalizes it into the NUL
                     * terminator the contract speaks, copying elements out
                     * through the UTF-16 bridge. A null String[] and a
                     * null ELEMENT both refuse - a NULL slot IS the
                     * terminator, so an element's absence has no spelling
                     * that does not end the vector early. */
                    `  jobjectArray resultVector = (jobjectArray)${call};`,
                    ...bridgedEpilogue(signature.parameters),
                    `  if ((*env)->ExceptionCheck(env)) {`,
                    `    ${prefix}_capture(env, error);`,
                    `    return NULL;`,
                    `  }`,
                    `  if (resultVector == NULL) {`,
                    `    *error = ${prefix}_message(`,
                    `        "Java method returned a null String[], which the string vector result contract rejects");`,
                    `    return NULL;`,
                    `  }`,
                    `  jsize vectorCount = (*env)->GetArrayLength(env, resultVector);`,
                    `  char **vector =`,
                    `      (char **)calloc((size_t)vectorCount + 1, sizeof(char *));`,
                    `  if (vector == NULL) {`,
                    `    fprintf(stderr, "${prefix}: out of memory copying a String[] result\\n");`,
                    `    abort();`,
                    `  }`,
                    `  for (jsize i = 0; i < vectorCount; i++) {`,
                    `    jstring element =`,
                    `        (jstring)(*env)->GetObjectArrayElement(env, resultVector, i);`,
                    `    if ((*env)->ExceptionCheck(env)) {`,
                    `      ${prefix}_capture(env, error);`,
                    `    } else if (element == NULL) {`,
                    `      *error = ${prefix}_message(`,
                    `          "Java string array carries a null element, which the NUL-terminated vector rejects");`,
                    `    } else {`,
                    `      vector[i] = ${prefix}_jstring_to_utf8(env, element, error);`,
                    `      (*env)->DeleteLocalRef(env, element);`,
                    `    }`,
                    `    if (*error != NULL) {`,
                    `      ${prefix}_strv_free(vector);`,
                    `      (*env)->DeleteLocalRef(env, resultVector);`,
                    `      return NULL;`,
                    `    }`,
                    `  }`,
                    `  (*env)->DeleteLocalRef(env, resultVector);`,
                    `  return vector;`,
                  ]
              : result.kind === "byte-span"
                ? [
                    /* A byte-span result is an owned copy out of JNI's own
                     * Region convention; the array never survives the call.
                     * The contract's span is non-null, so a null byte[] is
                     * a named absence that refuses through the error
                     * channel. An empty array is a real allocation with
                     * length zero, never a null pointer. The Region copy's
                     * bounds are valid by construction and cannot throw. */
                    `  jbyteArray resultArray = (jbyteArray)${call};`,
                    ...bridgedEpilogue(signature.parameters),
                    `  if ((*env)->ExceptionCheck(env)) {`,
                    `    ${prefix}_capture(env, error);`,
                    `    return NULL;`,
                    `  }`,
                    `  if (resultArray == NULL) {`,
                    `    *error = ${prefix}_message(`,
                    `        "Java method returned a null byte[], which the bytes result contract rejects");`,
                    `    return NULL;`,
                    `  }`,
                    `  jsize resultLength = (*env)->GetArrayLength(env, resultArray);`,
                    `  uint8_t *owned =`,
                    `      (uint8_t *)malloc(resultLength > 0 ? (size_t)resultLength : 1);`,
                    `  if (owned == NULL) {`,
                    `    fprintf(stderr, "${prefix}: out of memory copying a byte[] result\\n");`,
                    `    abort();`,
                    `  }`,
                    `  if (resultLength > 0) {`,
                    `    (*env)->GetByteArrayRegion(env, resultArray, 0, resultLength,`,
                    `                               (jbyte *)owned);`,
                    `  }`,
                    `  (*env)->DeleteLocalRef(env, resultArray);`,
                    `  *out_length = (size_t)resultLength;`,
                    `  return owned;`,
                  ]
                : [
                  `  ${returnType} result = ${call};`,
                  ...bridgedEpilogue(signature.parameters),
                  `  if ((*env)->ExceptionCheck(env)) {`,
                  `    ${prefix}_capture(env, error);`,
                  `    return (${returnType})0;`,
                  `  }`,
                  `  return result;`,
                ]),
        `}`,
        "",
      );
      const adapter = Object.freeze({
        kind: method.access.static ? ("static" as const) : ("instance" as const),
        className: class_.binaryName,
        name: method.name,
        descriptor: method.descriptor,
        adapterSymbol,
        result: signature.result,
        parameters: Object.freeze([...signature.parameters]),
      });
      if (method.access.static) staticMethods.push(adapter);
      else instanceMethods.push(adapter);
    }
    if (plan.members.length > 0 || class_.constructors.length > 0) {
      plans.push(plan);
    }
  }
  if (diagnostics.length > 0) throw new JvmGenerationError(diagnostics);

  const bindSymbol = `${prefix}_bind`;
  const errorMessageSymbol = `${prefix}_error_message`;
  const errorReleaseSymbol = `${prefix}_error_release`;
  const envHelperSymbol = `${prefix}_env`;
  const bindVmSymbol = `${prefix}_bind_vm`;
  const releaseSymbol = `${prefix}_release`;
  const strvFreeSymbol = `${prefix}_strv_free`;
  const lines = [
    "/* Generated by @native-typescript/bindgen-jvm. */",
    "#include <jni.h>",
    "#include <stdint.h>",
    "#include <stdio.h>",
    "#include <stdlib.h>",
    "#include <string.h>",
    "",
    `static jclass ${prefix}_cls_throwable;`,
    `static jmethodID ${prefix}_mid_get_message;`,
    ...plans.flatMap((plan) => [
      `static jclass ${plan.classVar};`,
      ...plan.members.map((member) =>
        `static jmethodID ${member.midVar}; /* ${member.name}${member.descriptor} */`
      ),
    ]),
    "",
    "/* The error object the error-out contract carries IS its message: one",
    " * owned C string. The contract's message read is therefore an identity",
    " * and its release is free(). An error object must never be NULL on the",
    " * failure path - NULL in the slot means success - so running out of",
    " * memory while reporting a failure is unrecoverable by construction. */",
    `static char *${prefix}_message(const char *text) {`,
    "  char *owned = strdup(text);",
    "  if (owned == NULL) {",
    `    fprintf(stderr, "${prefix}: out of memory capturing a failure\\n");`,
    "    abort();",
    "  }",
    "  return owned;",
    "}",
    "",
    `const char *${errorMessageSymbol}(void *error) {`,
    "  return (const char *)error;",
    "}",
    "",
    `void ${errorReleaseSymbol}(void *error) {`,
    "  free(error);",
    "}",
    "",
    `static JavaVM *${prefix}_vm;`,
    "",
    "/* The declared gap: the boundary contract has no thread-capability",
    " * position yet, so the env the compiler knows the thread holds is",
    " * looked up here instead of being passed. GetEnv answers which env the",
    " * CURRENT thread already has - nothing is decided - and the first JNI",
    " * slice admits already-attached threads only. */",
    `static JNIEnv *${envHelperSymbol}(char **error) {`,
    "  JNIEnv *env = NULL;",
    `  if (${prefix}_vm == NULL ||`,
    `      (*${prefix}_vm)->GetEnv(${prefix}_vm, (void **)&env,`,
    "                              JNI_VERSION_10) != JNI_OK) {",
    `    *error = ${prefix}_message(`,
    `        "calling thread is not attached to the JVM, or bind has not run");`,
    "    return NULL;",
    "  }",
    "  return env;",
    "}",
    "",
    "/* Pending-exception capture: JNI permits only a restricted set of",
    " * operations while an exception is pending, so it is taken and cleared",
    " * before the message is read. Cold by construction. */",
    `static void ${prefix}_capture(JNIEnv *env, char **error) {`,
    "  *error = NULL;",
    "  if ((*env)->PushLocalFrame(env, 8) < 0) {",
    "    (*env)->ExceptionClear(env);",
    `    *error = ${prefix}_message("JNI local reference capacity exhausted");`,
    "    return;",
    "  }",
    "  jthrowable thrown = (*env)->ExceptionOccurred(env);",
    "  (*env)->ExceptionClear(env);",
    `  if (thrown != NULL && ${prefix}_mid_get_message != NULL) {`,
    "    jstring msg = (jstring)(*env)->CallObjectMethod(",
    `        env, thrown, ${prefix}_mid_get_message);`,
    "    if ((*env)->ExceptionCheck(env)) {",
    "      (*env)->ExceptionClear(env);",
    "    } else if (msg != NULL) {",
    "      const char *utf = (*env)->GetStringUTFChars(env, msg, NULL);",
    "      if (utf != NULL) {",
    `        *error = ${prefix}_message(utf);`,
    "        (*env)->ReleaseStringUTFChars(env, msg, utf);",
    "      }",
    "    }",
    "  }",
    "  (*env)->PopLocalFrame(env, NULL);",
    "  if (*error == NULL) {",
    `    *error = ${prefix}_message("Java exception carried no message");`,
    "  }",
    "}",
    "",
    ...(usesStrings
      ? [
          "/* The UTF-16 bridge. JNI's native encodings are UTF-16 and",
          " * modified UTF-8, never the contract's UTF-8, so both crossings",
          " * convert exactly. Refusals go through the error channel: input",
          " * that is not well-formed UTF-8, a Java string carrying U+0000",
          " * (the contract rejects embedded NUL), or ill-formed UTF-16. */",
          `static jstring ${prefix}_utf8_to_jstring(JNIEnv *env,`,
          "                                         const char *utf8,",
          "                                         char **error) {",
          "  size_t byteLength = strlen(utf8);",
          "  jchar *units = (jchar *)malloc((byteLength + 1) * sizeof(jchar));",
          "  if (units == NULL) {",
          `    fprintf(stderr, "${prefix}: out of memory bridging a string\\n");`,
          "    abort();",
          "  }",
          "  size_t unitCount = 0;",
          "  size_t i = 0;",
          "  while (i < byteLength) {",
          "    unsigned char b0 = (unsigned char)utf8[i];",
          "    uint32_t point;",
          "    size_t width;",
          "    if (b0 < 0x80) { point = b0; width = 1; }",
          "    else if ((b0 & 0xE0) == 0xC0) { point = b0 & 0x1F; width = 2; }",
          "    else if ((b0 & 0xF0) == 0xE0) { point = b0 & 0x0F; width = 3; }",
          "    else if ((b0 & 0xF8) == 0xF0) { point = b0 & 0x07; width = 4; }",
          "    else goto malformed;",
          "    if (i + width > byteLength) goto malformed;",
          "    for (size_t k = 1; k < width; k++) {",
          "      unsigned char cont = (unsigned char)utf8[i + k];",
          "      if ((cont & 0xC0) != 0x80) goto malformed;",
          "      point = (point << 6) | (cont & 0x3F);",
          "    }",
          "    if (width == 2 && point < 0x80) goto malformed;",
          "    if (width == 3 && point < 0x800) goto malformed;",
          "    if (width == 4 && (point < 0x10000 || point > 0x10FFFF)) goto malformed;",
          "    if (point >= 0xD800 && point <= 0xDFFF) goto malformed;",
          "    if (point >= 0x10000) {",
          "      point -= 0x10000;",
          "      units[unitCount++] = (jchar)(0xD800 | (point >> 10));",
          "      units[unitCount++] = (jchar)(0xDC00 | (point & 0x3FF));",
          "    } else {",
          "      units[unitCount++] = (jchar)point;",
          "    }",
          "    i += width;",
          "  }",
          "  {",
          "    jstring made = (*env)->NewString(env, units, (jsize)unitCount);",
          "    free(units);",
          "    if ((*env)->ExceptionCheck(env)) {",
          `      ${prefix}_capture(env, error);`,
          "      return NULL;",
          "    }",
          `    if (made == NULL) *error = ${prefix}_message("NewString failed");`,
          "    return made;",
          "  }",
          "malformed:",
          "  free(units);",
          `  *error = ${prefix}_message("argument is not well-formed UTF-8");`,
          "  return NULL;",
          "}",
          "",
          `static char *${prefix}_jstring_to_utf8(JNIEnv *env, jstring string,`,
          "                                       char **error) {",
          "  jsize unitCount = (*env)->GetStringLength(env, string);",
          "  jchar *units = (jchar *)malloc(((size_t)unitCount + 1) * sizeof(jchar));",
          "  char *bytes = (char *)malloc((size_t)unitCount * 4 + 1);",
          "  size_t written = 0;",
          "  jsize i = 0;",
          "  if (units == NULL || bytes == NULL) {",
          `    fprintf(stderr, "${prefix}: out of memory bridging a string\\n");`,
          "    abort();",
          "  }",
          "  (*env)->GetStringRegion(env, string, 0, unitCount, units);",
          "  if ((*env)->ExceptionCheck(env)) {",
          "    free(units);",
          "    free(bytes);",
          `    ${prefix}_capture(env, error);`,
          "    return NULL;",
          "  }",
          "  for (i = 0; i < unitCount; i++) {",
          "    uint32_t point = units[i];",
          "    if (point == 0) {",
          "      free(units);",
          "      free(bytes);",
          `      *error = ${prefix}_message(`,
          '          "Java string carries an embedded NUL, which the utf-8 "',
          '          "contract rejects");',
          "      return NULL;",
          "    }",
          "    if (point >= 0xD800 && point <= 0xDBFF && i + 1 < unitCount &&",
          "        units[i + 1] >= 0xDC00 && units[i + 1] <= 0xDFFF) {",
          "      point = 0x10000 + ((point - 0xD800) << 10) +",
          "              ((uint32_t)units[i + 1] - 0xDC00);",
          "      i++;",
          "    } else if (point >= 0xD800 && point <= 0xDFFF) {",
          "      free(units);",
          "      free(bytes);",
          `      *error = ${prefix}_message(`,
          '          "Java string is ill-formed UTF-16 (unpaired surrogate)");',
          "      return NULL;",
          "    }",
          "    if (point < 0x80) {",
          "      bytes[written++] = (char)point;",
          "    } else if (point < 0x800) {",
          "      bytes[written++] = (char)(0xC0 | (point >> 6));",
          "      bytes[written++] = (char)(0x80 | (point & 0x3F));",
          "    } else if (point < 0x10000) {",
          "      bytes[written++] = (char)(0xE0 | (point >> 12));",
          "      bytes[written++] = (char)(0x80 | ((point >> 6) & 0x3F));",
          "      bytes[written++] = (char)(0x80 | (point & 0x3F));",
          "    } else {",
          "      bytes[written++] = (char)(0xF0 | (point >> 18));",
          "      bytes[written++] = (char)(0x80 | ((point >> 12) & 0x3F));",
          "      bytes[written++] = (char)(0x80 | ((point >> 6) & 0x3F));",
          "      bytes[written++] = (char)(0x80 | (point & 0x3F));",
          "    }",
          "  }",
          "  bytes[written] = 0;",
          "  free(units);",
          "  return bytes;",
          "}",
          "",
        ]
      : []),
    ...(usesStringVectors
      ? [
          "/* Frees an owned string vector AND its elements: the two-level",
          " * copy has one release symbol, and this is what makes that",
          " * sufficient. Also the partial-cleanup path when a later element",
          " * refuses - calloc keeps the tail NULL, so the walk stops where",
          " * the copy stopped. */",
          `void ${strvFreeSymbol}(char **vector) {`,
          "  if (vector == NULL) return;",
          "  for (size_t i = 0; vector[i] != NULL; i++) free(vector[i]);",
          "  free(vector);",
          "}",
          "",
        ]
      : []),
    "/* The one release: DeleteGlobalRef is class-blind, so one spelling",
    " * serves every stable reference this package hands out, typed at the",
    " * root handle every class identity-upcasts to. */",
    `void ${releaseSymbol}(void *ref) {`,
    "  JNIEnv *env = NULL;",
    `  if (${prefix}_vm == NULL ||`,
    `      (*${prefix}_vm)->GetEnv(${prefix}_vm, (void **)&env,`,
    "                              JNI_VERSION_10) != JNI_OK) {",
    "    /* Owner-confined destruction guarantees an attached thread; an",
    "     * unattached one here is a runtime bug, not a recoverable state. */",
    `    fprintf(stderr, "${prefix}: release on an unattached thread\\n");`,
    "    abort();",
    "  }",
    "  (*env)->DeleteGlobalRef(env, (jobject)ref);",
    "}",
    "",
    `static jclass ${prefix}_resolve_class(JNIEnv *env, const char *name,`,
    "                                      char **error) {",
    "  jclass local = (*env)->FindClass(env, name);",
    "  if ((*env)->ExceptionCheck(env)) {",
    `    ${prefix}_capture(env, error);`,
    "    return NULL;",
    "  }",
    "  jclass stable = (jclass)(*env)->NewGlobalRef(env, local);",
    "  (*env)->DeleteLocalRef(env, local);",
    `  if (stable == NULL) *error = ${prefix}_message("JNI global reference table exhausted");`,
    "  return stable;",
    "}",
    "",
    "/* Registration identity, resolved exactly once before any call. The",
    " * host hands the env in here; the JavaVM it belongs to is process",
    " * identity and is cached for the env lookups every adapter performs. */",
    `jint ${bindSymbol}(JNIEnv *env, char **error) {`,
    "  *error = NULL;",
    `  if ((*env)->GetJavaVM(env, &${prefix}_vm) != 0) {`,
    `    *error = ${prefix}_message("GetJavaVM failed");`,
    "    return -1;",
    "  }",
    `  ${prefix}_cls_throwable =`,
    `      ${prefix}_resolve_class(env, "java/lang/Throwable", error);`,
    `  if (${prefix}_cls_throwable == NULL) return -1;`,
    `  ${prefix}_mid_get_message = (*env)->GetMethodID(`,
    `      env, ${prefix}_cls_throwable, "getMessage",`,
    `      "()Ljava/lang/String;");`,
    `  if ((*env)->ExceptionCheck(env)) { ${prefix}_capture(env, error); return -1; }`,
    ...plans.flatMap((plan) => [
      `  ${plan.classVar} =`,
      `      ${prefix}_resolve_class(env, "${plan.class_.binaryName}", error);`,
      `  if (${plan.classVar} == NULL) return -1;`,
      ...plan.members.flatMap((member) => [
        `  ${member.midVar} = (*env)->${
          member.static ? "GetStaticMethodID" : "GetMethodID"
        }(`,
        `      env, ${plan.classVar}, "${member.name}", "${member.descriptor}");`,
        `  if ((*env)->ExceptionCheck(env)) { ${prefix}_capture(env, error); return -1; }`,
      ]),
    ]),
    "  return 0;",
    "}",
    "",
    "/* The VM-first bind a target runtime calls after creating or adopting",
    " * the JavaVM: caches it, takes the current thread's env, resolves. */",
    `jint ${bindVmSymbol}(JavaVM *vm, char **error) {`,
    "  JNIEnv *env = NULL;",
    `  ${prefix}_vm = vm;`,
    "  if ((*vm)->GetEnv(vm, (void **)&env, JNI_VERSION_10) != JNI_OK) {",
    `    *error = ${prefix}_message(`,
    '        "binding thread is not attached to the JVM");',
    "    return -1;",
    "  }",
    `  return ${bindSymbol}(env, error);`,
    "}",
    "",
    "/* Image-load registration with the target runtime, when one is linked.",
    " * The reference is weak so a host that drives bind itself - a test, an",
    " * embedder - links this adapter without the runtime existing at all. */",
    "extern void nts_jvm_runtime_register(jint (*bind)(JavaVM *, char **))",
    "    __attribute__((weak));",
    `static void __attribute__((constructor)) ${prefix}_autoregister(void) {`,
    "  if (nts_jvm_runtime_register != NULL) {",
    `    nts_jvm_runtime_register(${bindVmSymbol});`,
    "  }",
    "}",
    "",
    ...bodies,
  ];
  const source = lines.join("\n");
  const headerGuard = `NTS_JVM_${slug.toUpperCase()}_ADAPTER_H`;
  const header = [
    "/* Generated by @native-typescript/bindgen-jvm. */",
    `#ifndef ${headerGuard}`,
    `#define ${headerGuard}`,
    "#include <jni.h>",
    /* Byte-span declarations spell size_t and uint8_t; included always so
     * the header's shape does not depend on which families the selection
     * happened to use. */
    "#include <stddef.h>",
    "#include <stdint.h>",
    "",
    `jint ${bindSymbol}(JNIEnv *env, char **error);`,
    `jint ${bindVmSymbol}(JavaVM *vm, char **error);`,
    `void ${releaseSymbol}(void *ref);`,
    ...(usesStringVectors ? [`void ${strvFreeSymbol}(char **vector);`] : []),
    `const char *${errorMessageSymbol}(void *error);`,
    `void ${errorReleaseSymbol}(void *error);`,
    ...headerDeclarations,
    "",
    "#endif",
    "",
  ].join("\n");
  return Object.freeze({
    schema: "native-typescript.jvm-adapter-source",
    schemaVersion: 11,
    header,
    headerFileName: `nts_jvm_${slug}_adapter.h`,
    source,
    sourceDigest: `sha256:${createHash("sha256").update(source).digest("hex")}`,
    bind: Object.freeze({ adapterSymbol: bindSymbol, bindVmSymbol }),
    envSupport: Object.freeze({ helperSymbol: envHelperSymbol }),
    release: Object.freeze({ adapterSymbol: releaseSymbol }),
    errorSupport: Object.freeze({
      messageSymbol: errorMessageSymbol,
      releaseSymbol: errorReleaseSymbol,
    }),
    stringSupport: usesStrings
      ? Object.freeze({ bridge: "utf-16" as const })
      : null,
    byteSpanSupport: usesByteSpans
      ? Object.freeze({ region: "copy" as const })
      : null,
    stringVectorSupport: usesStringVectors
      ? Object.freeze({ releaseSymbol: strvFreeSymbol })
      : null,
    constructors: Object.freeze(constructors),
    staticMethods: Object.freeze(staticMethods),
    instanceMethods: Object.freeze(instanceMethods),
  });
}
