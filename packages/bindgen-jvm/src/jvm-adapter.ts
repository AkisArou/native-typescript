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
 * exact UTF-16 bridge, byte[]/int[]/float[] both directions through JNI's
 * Region copy convention (borrowed span in, owned copy out beside a
 * compiler-owned length slot, every length an element count), String[]
 * both directions as NUL-terminated vectors (borrowed in, owned copy
 * out), constructors, and the checked failure channel (pending exception
 * captured to an error-out slot). The remaining element families refuse
 * naming exactly what each is missing.
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

/** The span elements the compiler runtime carries for this platform: Java
 * has no unsigned arrays, so u32 never appears here even though the
 * runtime holds it. */
export type JvmSpanElement = "u8" | "i32" | "f32";

/** One adapter position: a JNI primitive scalar, a stable reference to a
 * class this selection projects, a string, a borrowed typed span (two C
 * slots carrying one Java primitive array), or a borrowed NUL-terminated
 * string vector carrying one Java String[]. */
export type JvmAdapterPosition =
  | { readonly kind: "primitive"; readonly primitive: JvmPrimitive }
  | { readonly kind: "handle"; readonly binaryName: string }
  | { readonly kind: "string" }
  | { readonly kind: "span"; readonly elem: JvmSpanElement }
  | { readonly kind: "string-vector" };

/** A span result crosses as an owned copy with a compiler-owned length
 * out slot beside the error slot, counting ELEMENTS by construction:
 * `uint8_t *sym(args, size_t *out_length, char **error)` — a byte pointer
 * for every element, the element living in the marshal. A string result
 * rides the same slot shape (`char *sym(args, size_t *out_length,
 * char **error)`) counting BYTES, which is what lets a Java string
 * carrying U+0000 cross as data instead of refusing. A string-vector
 * result crosses as an owned NUL-terminated `char **` copy — JNI hands
 * the adapter the length, and the adapter normalizes it into the
 * terminator the contract already speaks. */
export type JvmAdapterResult =
  | { readonly kind: "void" }
  | { readonly kind: "primitive"; readonly primitive: JvmPrimitive }
  | { readonly kind: "handle"; readonly binaryName: string }
  | { readonly kind: "string" }
  | { readonly kind: "span"; readonly elem: JvmSpanElement }
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
 *
 * Every generated GetEnv speaks JNI_VERSION_1_6: nothing the adapter emits
 * is newer than JNI 1.2, 1_6 is the floor both HotSpot and ART accept, and
 * Android's jni.h defines nothing later — a JNI_VERSION_10 that compiles
 * against a desktop JDK fails against the NDK sysroot's header.
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

/** One callback registration point: a native method whose implementation
 * TypeScript provides. An ANSWERED one (boolean result) runs during the
 * emitting call on the caller's thread because its boolean is that call's
 * result; a TOLD one (void result, selected synchronous) runs the same way
 * and returns having done nothing else — the lifecycle shape, where the
 * caller observes the handler rather than an answer; a QUEUED one (void
 * result, selected queued) is delivered at the runtime's pump. */
export interface JvmCallbackAdapter {
  readonly className: string;
  readonly name: string;
  readonly descriptor: string;
  readonly connectSymbol: string;
  /** The handler's arguments in order. A class-anchored registration
   * leads with the RECEIVER, because one registration answers for every
   * instance and nothing else would say which one called. */
  readonly parameters: readonly JvmAdapterPosition[];
  readonly delivery: "answered" | "told" | "queued";
  /** What the registration attaches to; see JvmCallbackAnchor. */
  readonly anchor: "instance" | "class";
}

/** The shared connection machinery, present when any callback is selected:
 * disconnect cancels a live registration, release is the connection
 * handle's destructor (cancelling first if still live). */
export interface JvmConnectionSupportAdapter {
  readonly disconnectSymbol: string;
  readonly releaseSymbol: string;
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
  readonly schemaVersion: 18;
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
  /** Present when any position is a primitive array (byte[], int[],
   * float[]): spans cross by one Region copy in either direction. Null
   * when no span crosses. */
  readonly spanSupport: { readonly region: "copy" } | null;
  /** Present when any result is a String[]: the generated release that
   * frees the owned vector AND its elements, which is what makes one
   * release symbol sufficient for a two-level copy. Null when none. */
  readonly stringVectorSupport: { readonly releaseSymbol: string } | null;
  /** Present when any callback is selected. */
  readonly connectionSupport: JvmConnectionSupportAdapter | null;
  readonly constructors: readonly JvmConstructorAdapter[];
  readonly staticMethods: readonly JvmMethodAdapter[];
  readonly instanceMethods: readonly JvmMethodAdapter[];
  readonly callbacks: readonly JvmCallbackAdapter[];
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
      "the adapter converts exactly in both directions; a string RESULT " +
      "carries its byte count in the compiler's length slot, so a Java " +
      "string holding U+0000 crosses as data, while a NUL-terminated " +
      "position (a string-vector element) still refuses U+0000 because " +
      "termination leaves it no representation; an unpaired surrogate " +
      "refuses in every position because it has no UTF-8 at all",
  },
  spanSupport: {
    kind: "translation",
    custom:
      "primitive arrays cross by JNI's own Region convention in both " +
      "directions, not by decision: an argument becomes a frame-scoped " +
      "typed array (New<Prim>Array + Set<Prim>ArrayRegion, released after " +
      "the call; a span past the jsize bound refuses because no Java " +
      "array can hold it), and a result copies out (GetArrayLength + " +
      "Get<Prim>ArrayRegion) into owned storage whose release is free, " +
      "its length in the compiler-owned out slot beside the error slot. " +
      "Every length is an ELEMENT count because JNI has no other " +
      "denomination, which is what units:'elements' states. A null array " +
      "result is a named absence that refuses through the error channel; " +
      "an empty one is a real allocation with length zero",
  },
  callbacks: {
    kind: "translation",
    custom:
      "a callback registration point is a native method Java declared " +
      "unimplemented; RegisterNatives at bind installs a trampoline, and " +
      "connecting stores {instance global ref, fn, context} in a per-" +
      "callback list the trampoline searches by IsSameObject - JNI has no " +
      "user_data slot, so identity recovery is the translation, not a " +
      "decision. One live registration per instance per callback, because " +
      "JNI's single dispatch slot cannot accumulate the way g_signal does; " +
      "a second connect answers NULL through the nullable contract. Java " +
      "calling with no live registration gets IllegalStateException - the " +
      "absence is the JAVA caller's to catch, and it names the method. " +
      "An answered callback runs during the emitting call because its " +
      "boolean is that call's result; a queued one enqueues at the " +
      "trampoline and is delivered at the runtime's pump",
  },
  connectionSupport: {
    kind: "translation",
    custom:
      "a connection is one malloc'd record the compiler owns through the " +
      "handle contract: disconnect (the cancellation binding) unlinks it " +
      "and releases the instance reference, release (the destructor) " +
      "cancels first if still live and frees. Owner-confined like every " +
      "release: an unattached thread traps",
  },
  stringVectorSupport: {
    kind: "translation",
    custom:
      "a String[] result is a jobjectArray whose length JNI carries on the " +
      "object; the adapter normalizes it into the NUL terminator the " +
      "string-vector contract already speaks, copying each element out " +
      "through the UTF-16 bridge into an owned vector the named release " +
      "frees elements-and-all. A null String[] result and a null ELEMENT " +
      "are named absences that refuse through the error channel - a NULL " +
      "slot is the terminator, so an element's absence has no spelling " +
      "that does not end the vector early. An ARGUMENT runs the same " +
      "normalization inward: a frame-scoped jobjectArray built element by " +
      "element through the bridge, where NULL crosses as NULL because an " +
      "omitted list is not an empty one",
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

/** Per-element span vocabulary: the C spelling of the slot, the jni.h
 * types the body casts through, the Region-call family name, and the Java
 * spelling refusal messages use. */
const spanVocabulary: Readonly<
  Record<
    JvmSpanElement,
    {
      readonly jniScalar: string;
      readonly jniArray: string;
      readonly callName: string;
      readonly javaName: string;
    }
  >
> = Object.freeze({
  u8: Object.freeze({
    jniScalar: "jbyte",
    jniArray: "jbyteArray",
    callName: "Byte",
    javaName: "byte[]",
  }),
  i32: Object.freeze({
    jniScalar: "jint",
    jniArray: "jintArray",
    callName: "Int",
    javaName: "int[]",
  }),
  f32: Object.freeze({
    jniScalar: "jfloat",
    jniArray: "jfloatArray",
    callName: "Float",
    javaName: "float[]",
  }),
});

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

/** The span element each admitted primitive array carries. */
const spanElements: Readonly<Partial<Record<JvmPrimitive, JvmSpanElement>>> =
  Object.freeze({ byte: "u8", int: "i32", float: "f32" });

/** The typed-array carrier each refused primitive element WOULD use, so a
 * reader meeting double[] learns Float64Array is the missing piece rather
 * than thinking arrays are unsupported. Only Uint8Array, Uint32Array,
 * Int32Array, and Float32Array have a compiler runtime representation. */
const missingElementCarriers: Readonly<Partial<Record<JvmPrimitive, string>>> =
  Object.freeze({
    char: "Uint16Array",
    short: "Int16Array",
    double: "Float64Array",
    long: "BigInt64Array",
  });

/** One position, or null with a precise refusal. A selected class is an
 * ordinary handle; an unselected one is a boundary the caller can move by
 * selecting the class. Arrays admit by element family: byte[] and
 * String[] cross, int[]/float[] wait on the widened span boundary, and
 * every other element names exactly what it is missing, because each
 * family is its own slice with its own demand. */
function positionOf(
  type: JvmTypeReference,
  selectedNames: ReadonlySet<string>,
  path: string,
  what: string,
  diagnostics: JvmDiagnostic[],
  /** Whether this position is one the CALLER fills. A widening that is
   * sound on the way in is not sound on the way out. */
  accepts: boolean,
): JvmAdapterPosition | JvmAdapterResult | null {
  if (type.kind === "void") return { kind: "void" };
  if (type.kind === "primitive") {
    return { kind: "primitive", primitive: type.name };
  }
  if (type.kind === "object") {
    if (type.binaryName === "java/lang/String") {
      return { kind: "string" };
    }
    /* The platform writes its text surface in CharSequence — TextView's
     * only usable setText takes one — and every String IS a CharSequence,
     * so a string ARGUMENT crosses by the widening the call itself
     * performs rather than a conversion this boundary invents.
     *
     * A CharSequence RESULT refuses, and the asymmetry is the point: what
     * comes back may be a SpannableString, and handing it over as a
     * string would silently drop what makes it one. Reading it is a
     * decision a program should make, so it waits for a program.
     *
     * Only CharSequence. Generalising to "any interface String
     * implements" would sweep in Comparable and Serializable, where a
     * string argument says nothing about what the method wants. */
    if (type.binaryName === "java/lang/CharSequence") {
      if (accepts) return { kind: "string" };
      diagnostics.push(diagnostic(
        path,
        `${what} is java/lang/CharSequence, which crosses INTO the ` +
          "platform as a string because every String is one; coming back " +
          "it may be a SpannableString, and reading that as a string " +
          "would drop what makes it one — a CharSequence result waits on " +
          "a program that needs it",
      ));
      return null;
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
  if (type.dimensions === 1 && type.element.kind === "primitive") {
    const element = type.element.name;
    const spanElement = spanElements[element];
    if (spanElement !== undefined) {
      return { kind: "span", elem: spanElement };
    }
    const carrier = missingElementCarriers[element];
    diagnostics.push(diagnostic(
      path,
      carrier !== undefined
        ? `${what} is array type '${renderArrayType(type)}': element ` +
          `carrier ${carrier} has no runtime representation in the compiler` +
          (element === "long"
            ? ", and bigint is outside the compilable value set (SC2001)"
            : "")
        : `${what} is boolean[]: jboolean's u8 storage makes its carrier ` +
          "a decision rather than a translation",
    ));
    return null;
  }
  if (
    type.dimensions === 1 &&
    type.element.kind === "object" &&
    type.element.binaryName === "java/lang/String"
  ) {
    return { kind: "string-vector" };
  }
  diagnostics.push(
    diagnostic(
      path,
      `${what} is array type '${renderArrayType(type)}', whose element ` +
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
      diagnostics,
      true,
    );
    if (position === null || position.kind === "void") refused = true;
    else parameters.push(position);
  });
  const result = positionOf(
    method.result,
    selectedNames,
    `${path}/result`,
    "Result",
    diagnostics,
    false,
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
  if (position.kind === "span") {
    /* One source value, two C slots: the span marshalling contract pairs a
     * borrowed const pointer with a usize length parameter counting
     * ELEMENTS. The slot is a byte pointer for every element - the element
     * size is the managed side's business - and the cast at the Region
     * call is where the element reasserts itself. */
    return `const uint8_t *a${index}, size_t a${index}_length`;
  }
  if (position.kind === "string-vector") {
    return `const char *const *a${index}`;
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
    readonly nativeRegistrations: {
      readonly name: string;
      readonly descriptor: string;
      readonly trampolineSymbol: string;
    }[];
  }
  const plans: ClassPlan[] = [];
  const constructors: JvmConstructorAdapter[] = [];
  const staticMethods: JvmMethodAdapter[] = [];
  const instanceMethods: JvmMethodAdapter[] = [];
  const callbacks: JvmCallbackAdapter[] = [];
  /* Trampolines are defined with their callback's body, after bind in the
   * file, while bind installs them by address — hence forward declarations
   * beside the statics. */
  const callbackForwardDeclarations: string[] = [];
  const bodies: string[] = [];
  const headerDeclarations: string[] = [];
  const selectedNames: ReadonlySet<string> = new Set(
    snapshot.classes.map(({ binaryName }) => binaryName),
  );
  let usesStrings = false;
  let usesSpans = false;
  let usesStringVectors = false;
  let usesStringVectorArguments = false;
  let usesCallbacks = false;

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
        : prior.kind === "span"
          ? [`${indent}(*env)->DeleteLocalRef(env, ba${earlier});`]
          : prior.kind === "string-vector"
            ? [`${indent}if (jv${earlier} != NULL) (*env)->DeleteLocalRef(env, jv${earlier});`]
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
      if (parameter.kind === "string-vector") {
        usesStringVectorArguments = true;
        usesStrings = true;
        lines.push(
          /* A nullable Java String[] argument: NULL crosses as NULL (an
           * omitted list, not an empty one). Elements convert through the
           * UTF-16 bridge into a frame-scoped jobjectArray; the store's
           * bounds and type are valid by construction and cannot throw. */
          `  jobjectArray jv${index} = NULL;`,
          `  if (a${index} != NULL) {`,
          `    size_t count${index} = 0;`,
          `    while (a${index}[count${index}] != NULL) count${index}++;`,
          `    if (count${index} > (size_t)INT32_MAX) {`,
          `      *error = ${prefix}_message("string vector exceeds the JVM array bound");`,
          ...priorBridgeCleanup(parameters, index, "      "),
          `      ${zeroReturn}`,
          `    }`,
          `    jv${index} = (*env)->NewObjectArray(`,
          `        env, (jsize)count${index}, ${prefix}_cls_string, NULL);`,
          `    if ((*env)->ExceptionCheck(env)) {`,
          `      ${prefix}_capture(env, error);`,
          ...priorBridgeCleanup(parameters, index, "      "),
          `      ${zeroReturn}`,
          `    }`,
          `    if (jv${index} == NULL) {`,
          `      *error = ${prefix}_message("NewObjectArray failed");`,
          ...priorBridgeCleanup(parameters, index, "      "),
          `      ${zeroReturn}`,
          `    }`,
          `    for (size_t i${index} = 0; i${index} < count${index}; i${index}++) {`,
          `      jstring element${index} =`,
          `          ${prefix}_utf8_to_jstring(env, a${index}[i${index}], error);`,
          `      if (*error != NULL) {`,
          `        (*env)->DeleteLocalRef(env, jv${index});`,
          ...priorBridgeCleanup(parameters, index, "        "),
          `        ${zeroReturn}`,
          `      }`,
          `      (*env)->SetObjectArrayElement(`,
          `          env, jv${index}, (jsize)i${index}, element${index});`,
          `      (*env)->DeleteLocalRef(env, element${index});`,
          `    }`,
          `  }`,
        );
      }
      if (parameter.kind === "span") {
        usesSpans = true;
        const span = spanVocabulary[parameter.elem];
        lines.push(
          /* jsize is jint, so a span of more elements than INT32_MAX has
           * no Java array; the contract's span is non-null, so there is no
           * null arm. The Region copy's bounds are valid by construction
           * and cannot throw. The length counts ELEMENTS — JNI's only
           * denomination — which is what the units contract states. */
          `  if (a${index}_length > (size_t)INT32_MAX) {`,
          `    *error = ${prefix}_message("span exceeds the JVM array bound");`,
          ...priorBridgeCleanup(parameters, index, "    "),
          `    ${zeroReturn}`,
          `  }`,
          `  ${span.jniArray} ba${index} =`,
          `      (*env)->New${span.callName}Array(env, (jsize)a${index}_length);`,
          `  if ((*env)->ExceptionCheck(env)) {`,
          `    ${prefix}_capture(env, error);`,
          ...priorBridgeCleanup(parameters, index, "    "),
          `    ${zeroReturn}`,
          `  }`,
          `  if (ba${index} == NULL) {`,
          `    *error = ${prefix}_message("New${span.callName}Array failed");`,
          ...priorBridgeCleanup(parameters, index, "    "),
          `    ${zeroReturn}`,
          `  }`,
          `  if (a${index}_length > 0) {`,
          `    (*env)->Set${span.callName}ArrayRegion(env, ba${index}, 0,`,
          `                               (jsize)a${index}_length,`,
          `                               (const ${span.jniScalar} *)a${index});`,
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
        : parameter.kind === "span"
          ? [`  (*env)->DeleteLocalRef(env, ba${index});`]
          : parameter.kind === "string-vector"
            ? [`  if (jv${index} != NULL) (*env)->DeleteLocalRef(env, jv${index});`]
            : []
    );
  }

  function argumentOf(parameter: JvmAdapterPosition, index: number): string {
    if (parameter.kind === "handle") return `(jobject)a${index}`;
    if (parameter.kind === "string") return `js${index}`;
    if (parameter.kind === "span") return `ba${index}`;
    if (parameter.kind === "string-vector") return `jv${index}`;
    return `a${index}`;
  }

  for (const class_ of snapshot.classes) {
    const classToken = cSafe(class_.binaryName);
    const plan: ClassPlan = {
      class_,
      classVar: `${prefix}_cls_${classToken}`,
      members: [],
      nativeRegistrations: [],
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
      if (result.kind === "span") usesSpans = true;
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
            : result.kind === "span"
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
      /* A span result's length comes back beside the pointer, in a
       * compiler-owned out slot placed with the error slot. */
      const trailing = result.kind === "span" || result.kind === "string"
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
                   * NULL with an empty error slot is a successful null —
                   * the (NULL, 0) pair is written whole so the answer never
                   * depends on the caller's initialisation of the slot. The
                   * length slot is what lets U+0000 cross as data. */
                  `  jstring resultString = (jstring)${call};`,
                  ...bridgedEpilogue(signature.parameters),
                  `  if ((*env)->ExceptionCheck(env)) {`,
                  `    ${prefix}_capture(env, error);`,
                  `    return NULL;`,
                  `  }`,
                  `  if (resultString == NULL) {`,
                  `    *out_length = 0;`,
                  `    return NULL;`,
                  `  }`,
                  `  char *owned = ${prefix}_jstring_to_utf8(env, resultString, out_length, error);`,
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
                    `      vector[i] = ${prefix}_jstring_to_utf8(env, element, NULL, error);`,
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
              : result.kind === "span"
                ? ((span) => [
                    /* A span result is an owned copy out of JNI's own
                     * Region convention; the array never survives the call.
                     * The contract's span is non-null, so a null array is
                     * a named absence that refuses through the error
                     * channel. An empty array is a real allocation with
                     * length zero, never a null pointer, and the length
                     * slot counts ELEMENTS by construction. The Region
                     * copy's bounds are valid and cannot throw. */
                    `  ${span.jniArray} resultArray = (${span.jniArray})${call};`,
                    ...bridgedEpilogue(signature.parameters),
                    `  if ((*env)->ExceptionCheck(env)) {`,
                    `    ${prefix}_capture(env, error);`,
                    `    return NULL;`,
                    `  }`,
                    `  if (resultArray == NULL) {`,
                    `    *error = ${prefix}_message(`,
                    `        "Java method returned a null ${span.javaName}, which the span result contract rejects");`,
                    `    return NULL;`,
                    `  }`,
                    `  jsize resultLength = (*env)->GetArrayLength(env, resultArray);`,
                    `  uint8_t *owned = (uint8_t *)malloc(`,
                    `      resultLength > 0`,
                    `          ? (size_t)resultLength * sizeof(${span.jniScalar})`,
                    `          : 1);`,
                    `  if (owned == NULL) {`,
                    `    fprintf(stderr, "${prefix}: out of memory copying a ${span.javaName} result\\n");`,
                    `    abort();`,
                    `  }`,
                    `  if (resultLength > 0) {`,
                    `    (*env)->Get${span.callName}ArrayRegion(env, resultArray, 0, resultLength,`,
                    `                               (${span.jniScalar} *)owned);`,
                    `  }`,
                    `  (*env)->DeleteLocalRef(env, resultArray);`,
                    `  *out_length = (size_t)resultLength;`,
                    `  return owned;`,
                  ])(spanVocabulary[result.elem])
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
    const overloadedCallbackNames = new Set(
      class_.callbacks
        .map(({ name }) => name)
        .filter((name, _, all) => all.indexOf(name) !== all.lastIndexOf(name)),
    );
    for (const callback of class_.callbacks) {
      const path = `class/${class_.binaryName}/callback/${callback.name}`;
      if (callback.access.static) {
        diagnostics.push(diagnostic(
          path,
          "A callback registration anchors to its receiver; a static " +
            "native method has no receiver and waits on a class-anchored " +
            "owner spelling",
        ));
        continue;
      }
      const parameters: JvmAdapterPosition[] = [];
      let refused = false;
      callback.parameters.forEach((parameter, index) => {
        const scalar = parameter.kind === "primitive" ? parameter.name : null;
        if (
          scalar !== null && scalar !== "float" && scalar !== "boolean"
        ) {
          parameters.push({ kind: "primitive", primitive: scalar });
          return;
        }
        /* An object payload crosses as an OWNED handle: the jobject the
         * trampoline receives is a local reference that dies with the
         * native frame — JNI's only lending form — so the adapter
         * promotes it (NewGlobalRef) after the registration match and the
         * managed cell's destructor gives the promotion back through the
         * class-blind release. Same admission rule as every other object
         * position: the class must be selected to project. */
        if (
          parameter.kind === "object" &&
          parameter.binaryName !== "java/lang/String"
        ) {
          if (selectedNames.has(parameter.binaryName)) {
            parameters.push({
              kind: "handle",
              binaryName: parameter.binaryName,
            });
            return;
          }
          diagnostics.push(diagnostic(
            `${path}/parameters/${index}`,
            `Callback payload is object type '${parameter.binaryName}', ` +
              "which this selection does not project; select the class " +
              "to move the boundary",
          ));
          refused = true;
          return;
        }
        diagnostics.push(diagnostic(
          `${path}/parameters/${index}`,
          scalar === "float"
            ? "Callback payload float is f32, outside the retained " +
              "contract's exact-scalar set (integers and double)"
            : scalar === "boolean"
              ? "Callback payload boolean has no exact scalar position; " +
                "carry it as an integer"
              : parameter.kind === "object"
                ? "A String payload has no arm: a callback string would " +
                  "need a length-and-copy contract of its own, and the " +
                  "handle arm deliberately excludes the string bridge"
                : "An array payload is outside the retained contract; " +
                  "spans do not cross callbacks",
        ));
        refused = true;
      });
      const answers = callback.result.kind === "primitive" &&
        callback.result.name === "boolean";
      if (!answers && callback.result.kind !== "void") {
        diagnostics.push(diagnostic(
          `${path}/result`,
          "A callback answers with a boolean or answers nothing; any other " +
            "result would make the handler's value the emitting call's " +
            "without a contract for it",
        ));
        continue;
      }
      /* Delivery is not derivable: a void native method genuinely has two
       * contracts (during the caller's frame, or copied and pumped) and
       * the class file states neither, so the selection must. An answered
       * callback has exactly one — its boolean IS the emitting call's
       * result — so a stated delivery there is a second spelling of a
       * decided fact, refused for the same reason dual readers are. */
      if (answers && callback.delivery !== null) {
        diagnostics.push(diagnostic(
          `${path}/delivery`,
          "An answered callback runs during the emitting call because its " +
            "boolean is that call's result; the delivery field chooses " +
            "between the void arms and is refused here",
        ));
        continue;
      }
      if (!answers && callback.delivery === null) {
        diagnostics.push(diagnostic(
          `${path}/delivery`,
          "A void callback crosses on one of two arms — synchronous " +
            "during the caller's frame, or queued at the runtime's pump — " +
            "and the class file cannot say which; select it with " +
            "delivery: 'synchronous' or 'queued'",
        ));
        continue;
      }
      const delivery = answers
        ? ("answered" as const)
        : callback.delivery === "synchronous"
          ? ("told" as const)
          : ("queued" as const);
      /* A class-anchored registration exists because the FRAMEWORK owns
       * the instance, and a framework observes what it dispatched — so
       * the queued arm, whose whole premise is that delivery outlives the
       * emitting call, has no lifecycle method to serve. It waits for a
       * program rather than being emitted untested. */
      const classAnchored = callback.anchor === "class";
      if (classAnchored && delivery === "answered") {
        diagnostics.push(diagnostic(
          `${path}/anchor`,
          "A class-anchored registration is owned by the process, and a " +
            "process-owned contract carries no answer: nothing owns the " +
            "registration, so there is no call whose result the handler's " +
            "boolean could be; an answering override waits on its own arm",
        ));
        continue;
      }
      if (classAnchored && delivery === "queued") {
        diagnostics.push(diagnostic(
          `${path}/anchor`,
          "A class-anchored registration answers for instances a framework " +
            "constructs and observes, so its delivery is synchronous; the " +
            "queued arm waits on a program that needs it",
        ));
        continue;
      }
      if (refused) continue;
      usesCallbacks = true;
      const suffix = overloadedCallbackNames.has(callback.name)
        ? `_${descriptorSuffix(callback.descriptor)}`
        : "";
      const trampolineSymbol = `${prefix}_tramp_${classToken}_${callback.name}${suffix}`;
      const connectSymbol = `${prefix}_connect_${classToken}_${callback.name}${suffix}`;
      const headVariable = `${prefix}_reg_${classToken}_${callback.name}${suffix}`;
      const jniParameters = parameters.map((parameter, index) =>
        parameter.kind === "primitive"
          ? `${jniCTypes[parameter.primitive]} a${index}`
          : `jobject a${index}`
      );
      const handleIndices = parameters.flatMap((parameter, index) =>
        parameter.kind === "handle" ? [index] : []
      );
      /* The receiver is the handler's FIRST argument on a class-anchored
       * registration: one registration answers for every instance, so
       * which instance called is information only the payload carries. It
       * crosses exactly as any other object payload does — promoted from
       * the frame-scoped local reference into a managed cell. */
      const payloadPositions: JvmAdapterPosition[] = classAnchored
        ? [{ kind: "handle", binaryName: class_.binaryName }, ...parameters]
        : [...parameters];
      /* An answered trampoline returns the handler's boolean; a void one
       * returns nothing. Told and queued share this C shape deliberately:
       * whether the handler runs during this frame or the payload is
       * copied and pumped is the COMPILER's thunk's contract, spelled in
       * the SCABI manifest — the trampoline only reaches the registered
       * pointer. */
      const answerType = answers ? "jboolean" : "void";
      const ownerCheckSymbol = "nts_jvm_runtime_owner_thread_is_current";
      const callbackPointer = `${answerType} (*)(${[
        ...payloadPositions.map((parameter) =>
          parameter.kind === "primitive" ? jniCTypes[parameter.primitive] : "void *"
        ),
        "void *",
      ].join(", ")})`;
      plan.nativeRegistrations.push({
        name: callback.name,
        descriptor: callback.descriptor,
        trampolineSymbol,
      });
      callbackForwardDeclarations.push(
        `static ${answerType} JNICALL ${trampolineSymbol}(${[
          "JNIEnv *env",
          "jobject self",
          ...jniParameters,
        ].join(", ")});`,
      );
      /* A process-owned registration has no receiver to hand back, so
       * connect RETURNS NOTHING and a refusal travels the error channel
       * every other adapter already speaks — a NULL return cannot mean
       * "refused" when the success value is nothing at all. */
      const connectParameters = `${
        classAnchored ? "" : "void *self, "
      }${callbackPointer.replace("(*)", "(*callback)")}, void *context${
        classAnchored ? ", char **error" : ""
      }`;
      const connectReturn = classAnchored ? "void" : "void *";
      headerDeclarations.push(
        `${connectReturn} ${connectSymbol}(${connectParameters});`,
      );
      bodies.push(
        `/* ${class_.binaryName}.${callback.name}${callback.descriptor} - Java calls in */`,
        `static ${prefix}_connection *${headVariable};`,
        "",
        `static ${answerType} JNICALL ${trampolineSymbol}(${[
          "JNIEnv *env",
          "jobject self",
          ...jniParameters,
        ].join(", ")}) {`,
        /* Reaching a handler means reading a closure, and an instance is
         * never entered from two threads — an obligation the runtime does
         * not police, so a delivery on the wrong thread would corrupt
         * rather than fail. The target cannot make the rule unnecessary;
         * it can make it observable. Weak, because an adapter linked
         * without this target's runtime has no owner to ask about. */
        `  if (${ownerCheckSymbol} != NULL && !${ownerCheckSymbol}()) {`,
        `    (*env)->ThrowNew(env, ${prefix}_cls_illegal_state,`,
        `        "${class_.binaryName}.${callback.name} was dispatched on a ` +
          'thread that does not own the TypeScript instance; a handler runs ' +
          'on the owning thread or not at all");',
        ...(answers ? ["    return JNI_FALSE;"] : ["    return;"]),
        "  }",
        /* A QUEUED delivery's payload may not be withheld: its invocation
         * record's cleanup reads the same slot, so an absent payload
         * would release a pointer the library never gave. Java can still
         * pass NULL, so that arm refuses BY NAME before any promotion —
         * nothing to give back on this bail. A synchronous delivery has
         * the null arm and passes absence through. */
        /* A SYNCHRONOUS payload may be withheld, whoever owns the
         * registration; a queued one may not, because its invocation
         * record's cleanup reads the same slot and would release a
         * pointer that was never given. That arm refuses NULL by name
         * before any promotion — nothing to give back on the bail. */
        ...(delivery !== "queued"
          ? []
          : handleIndices.flatMap((index) => [
              `  if (a${index} == NULL) {`,
              `    (*env)->ThrowNew(env, ${prefix}_cls_illegal_state,`,
              `        "a NULL payload reached ${class_.binaryName}.${callback.name}; ` +
                'a queued delivery copies its payload into a record whose cleanup would release what was never given");',
              ...(answers ? ["    return JNI_FALSE;"] : ["    return;"]),
              "  }",
            ])),
        /* Instance-anchored: find the registration that named THIS
         * receiver. Class-anchored: there is at most one and it answers
         * for every instance, so identity is not the question. */
        ...(classAnchored
          ? [
              `  ${prefix}_connection *connection = ${headVariable};`,
              "  {",
              "    if (connection != NULL && connection->live) {",
            ]
          : [
              `  for (${prefix}_connection *connection = ${headVariable};`,
              "       connection != NULL; connection = connection->next) {",
              "    if (connection->live &&",
              "        (*env)->IsSameObject(env, connection->instance, self)) {",
            ]),
        /* Promotion happens AFTER the registration match: a jobject is a
         * local reference that dies with this frame, so the thunk must be
         * handed something it may intern — and a failed later promotion
         * releases the earlier ones, because a reference handed over on a
         * bail path is exactly where a leak hides. */
        ...handleIndices.flatMap((index, order) => [
          /* Absence is not a failure to promote: there is no object, so
           * there is no reference to take and none to give back. The cell
           * is built only when there IS one. */
          `      jobject payload${index} = a${index} == NULL`,
          "          ? NULL",
          `          : (*env)->NewGlobalRef(env, a${index});`,
          `      if (payload${index} == NULL && a${index} != NULL) {`,
          ...handleIndices.slice(0, order).map((prior) =>
            `        if (payload${prior} != NULL) {`
          ),
          ...handleIndices.slice(0, order).map((prior) =>
            `          (*env)->DeleteGlobalRef(env, payload${prior});`
          ),
          ...handleIndices.slice(0, order).map(() => "        }"),
          `        (*env)->ThrowNew(env, ${prefix}_cls_illegal_state,`,
          `            "promoting a payload for ${class_.binaryName}.${callback.name} failed");`,
          ...(answers ? ["        return JNI_FALSE;"] : ["        return;"]),
          "      }",
        ]),
        /* The receiver crosses as payload zero, promoted like any other
         * object: the local reference the trampoline holds dies with this
         * frame, and the handler is handed a cell that owns its object. */
        ...(classAnchored
          ? [
              "      jobject receiver = (*env)->NewGlobalRef(env, self);",
              "      if (receiver == NULL) {",
              ...handleIndices.map((prior) =>
                `        (*env)->DeleteGlobalRef(env, payload${prior});`
              ),
              `        (*env)->ThrowNew(env, ${prefix}_cls_illegal_state,`,
              `            "promoting the receiver for ${class_.binaryName}.${callback.name} failed");`,
              ...(answers ? ["        return JNI_FALSE;"] : ["        return;"]),
              "      }",
            ]
          : []),
        `      ${answers ? "return " : ""}((${callbackPointer})connection->callback)(${[
          ...(classAnchored ? ["receiver"] : []),
          ...parameters.map((parameter, index) =>
            parameter.kind === "handle" ? `payload${index}` : `a${index}`
          ),
          "connection->context",
        ].join(", ")});`,
        ...(answers ? [] : ["      return;"]),
        "    }",
        "  }",
        `  (*env)->ThrowNew(env, ${prefix}_cls_illegal_state,`,
        `      "no TypeScript handler is registered for ${class_.binaryName}.${callback.name}");`,
        ...(answers ? ["  return JNI_FALSE;"] : []),
        "}",
        "",
        `${connectReturn} ${connectSymbol}(${connectParameters}) {`,
        ...(classAnchored ? ["  *error = NULL;"] : []),
        ...(classAnchored ? [] : ["  char *error = NULL;"]),
        /* Class-anchored: `error` IS the caller's slot, so it is passed
         * on rather than addressed again. */
        `  JNIEnv *env = ${prefix}_env(${classAnchored ? "error" : "&error"});`,
        "  if (env == NULL) {",
        ...(classAnchored
          ? ["    return;"]
          : ["    free(error);", "    return NULL;"]),
        "  }",
        ...(classAnchored
          ? [
              "  if (callback == NULL) {",
              `    *error = ${prefix}_message("a registration needs a handler");`,
              "    return;",
              "  }",
            ]
          : ["  if (self == NULL || callback == NULL) return NULL;"]),
        /* One live registration per anchor: JNI's single dispatch slot
         * cannot accumulate, so a second connect is refused rather than
         * silently shadowing the first. A class-anchored one answers for
         * every instance, so ANY live registration is that second — and
         * it refuses through the error channel, because a registration
         * that hands nothing back cannot say "refused" with a value. */
        `  for (${prefix}_connection *existing = ${headVariable};`,
        "       existing != NULL; existing = existing->next) {",
        ...(classAnchored
          ? [
              "    if (existing->live) {",
              `      *error = ${prefix}_message(`,
              `          "${class_.binaryName}.${callback.name} already has a handler; ` +
                'a class-anchored registration answers for every instance, so there is one");',
              "      return;",
              "    }",
            ]
          : [
              "    if (existing->live &&",
              "        (*env)->IsSameObject(env, existing->instance, self)) {",
              "      return NULL;",
              "    }",
            ]),
        "  }",
        `  ${prefix}_connection *connection = calloc(1, sizeof *connection);`,
        ...(classAnchored
          ? [
              "  if (connection == NULL) {",
              `    *error = ${prefix}_message("out of memory registering a handler");`,
              "    return;",
              "  }",
              /* Nothing to hold: the registration outlives no instance
               * because it is not attached to one. */
              "  jobject stable = NULL;",
            ]
          : [
              "  if (connection == NULL) return NULL;",
              "  jobject stable = (*env)->NewGlobalRef(env, (jobject)self);",
              "  if (stable == NULL) {",
              "    free(connection);",
              "    return NULL;",
              "  }",
            ]),
        "  connection->instance = stable;",
        "  connection->callback = (void *)callback;",
        "  connection->context = context;",
        "  connection->live = 1;",
        `  connection->slot = &${headVariable};`,
        `  connection->next = ${headVariable};`,
        `  ${headVariable} = connection;`,
        ...(classAnchored ? ["  return;"] : ["  return connection;"]),
        "}",
        "",
      );
      callbacks.push(Object.freeze({
        className: class_.binaryName,
        name: callback.name,
        descriptor: callback.descriptor,
        connectSymbol,
        parameters: Object.freeze(payloadPositions),
        delivery,
        anchor: classAnchored ? ("class" as const) : ("instance" as const),
      }));
    }
    if (
      plan.members.length > 0 || class_.constructors.length > 0 ||
      plan.nativeRegistrations.length > 0
    ) {
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
  const disconnectSymbol = `${prefix}_disconnect`;
  const connectionFreeSymbol = `${prefix}_connection_free`;
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
    ...(usesStringVectorArguments
      ? [`static jclass ${prefix}_cls_string; /* String[] arguments build with it */`]
      : []),
    ...(usesCallbacks
      ? [
          `static jclass ${prefix}_cls_illegal_state; /* thrown at an unregistered callback */`,
          "",
          "/* One registration record. JNI has no user_data slot, so the",
          " * trampoline recovers the connection by instance identity; `slot`",
          " * points at the per-callback list head so disconnect can unlink",
          " * without knowing which callback it belongs to. Confined to the",
          " * runtime owner by the same-as-caller contract, so unlocked. */",
          `typedef struct ${prefix}_connection {`,
          "  jobject instance;",
          "  void *callback;",
          "  void *context;",
          "  int live;",
          `  struct ${prefix}_connection *next;`,
          `  struct ${prefix}_connection **slot;`,
          `} ${prefix}_connection;`,
          "",
          /* The target runtime answers whether this thread owns the
           * TypeScript instance. Weak: an adapter linked without that
           * runtime has no owner to ask about, and answers yes by
           * absence rather than refusing every delivery. */
          "extern int nts_jvm_runtime_owner_thread_is_current(void)",
          "    __attribute__((weak));",
          "",
          ...callbackForwardDeclarations,
        ]
      : []),
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
    "                              JNI_VERSION_1_6) != JNI_OK) {",
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
          " * that is not well-formed UTF-8, ill-formed UTF-16, or a Java",
          " * string carrying U+0000 crossing into a NUL-terminated",
          " * position - a length-carrying position takes it as data. */",
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
          "/* The length slot is the contract selector: a caller that",
          " * supplies one speaks the span contract, where U+0000 is data",
          " * like any other point; a caller that does not speaks",
          " * NUL-termination, where an embedded NUL has no representation",
          " * and must refuse. The unpaired-surrogate refusal is",
          " * unconditional - ill-formed UTF-16 has no UTF-8 spelling under",
          " * either contract. */",
          `static char *${prefix}_jstring_to_utf8(JNIEnv *env, jstring string,`,
          "                                       size_t *out_length,",
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
          "    if (point == 0 && out_length == NULL) {",
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
          "  if (out_length != NULL) *out_length = written;",
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
    ...(usesCallbacks
      ? [
          "/* Cancels a live registration: unlinks it and returns the",
          " * instance reference. The record survives for its destructor.",
          " * Owner-confined like every release: an unattached thread traps. */",
          `void ${disconnectSymbol}(void *opaque) {`,
          `  ${prefix}_connection *connection = opaque;`,
          "  if (connection == NULL || !connection->live) return;",
          "  JNIEnv *env = NULL;",
          `  if (${prefix}_vm == NULL ||`,
          `      (*${prefix}_vm)->GetEnv(${prefix}_vm, (void **)&env,`,
          "                              JNI_VERSION_1_6) != JNI_OK) {",
          `    fprintf(stderr, "${prefix}: disconnect on an unattached thread\\n");`,
          "    abort();",
          "  }",
          `  for (${prefix}_connection **cursor = connection->slot;`,
          "       *cursor != NULL; cursor = &(*cursor)->next) {",
          "    if (*cursor == connection) {",
          "      *cursor = connection->next;",
          "      break;",
          "    }",
          "  }",
          /* A class-anchored registration holds no instance, so there is
           * no reference to give back — the null is the anchor's shape
           * rather than a missing one. */
          "  if (connection->instance != NULL) {",
          "    (*env)->DeleteGlobalRef(env, connection->instance);",
          "  }",
          "  connection->live = 0;",
          "}",
          "",
          "/* The connection handle's destructor: cancels first if the",
          " * registration is still live, then frees the record. */",
          `void ${connectionFreeSymbol}(void *opaque) {`,
          "  if (opaque == NULL) return;",
          `  ${disconnectSymbol}(opaque);`,
          "  free(opaque);",
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
    "                              JNI_VERSION_1_6) != JNI_OK) {",
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
    ...(usesStringVectorArguments
      ? [
          `  ${prefix}_cls_string =`,
          `      ${prefix}_resolve_class(env, "java/lang/String", error);`,
          `  if (${prefix}_cls_string == NULL) return -1;`,
        ]
      : []),
    ...(usesCallbacks
      ? [
          `  ${prefix}_cls_illegal_state =`,
          `      ${prefix}_resolve_class(env, "java/lang/IllegalStateException", error);`,
          `  if (${prefix}_cls_illegal_state == NULL) return -1;`,
        ]
      : []),
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
      ...(plan.nativeRegistrations.length === 0
        ? []
        : [
            /* Registration identity for the inward direction: the
             * trampolines are installed once, beside the method IDs. */
            "  {",
            `    static const JNINativeMethod natives[] = {`,
            ...plan.nativeRegistrations.map(({ name, descriptor, trampolineSymbol }) =>
              `      { (char *)"${name}", (char *)"${descriptor}", (void *)${trampolineSymbol} },`
            ),
            "    };",
            `    if ((*env)->RegisterNatives(env, ${plan.classVar}, natives,`,
            `                                ${plan.nativeRegistrations.length}) != 0) {`,
            `      if ((*env)->ExceptionCheck(env)) ${prefix}_capture(env, error);`,
            `      else *error = ${prefix}_message("RegisterNatives failed");`,
            "      return -1;",
            "    }",
            "  }",
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
    "  if ((*vm)->GetEnv(vm, (void **)&env, JNI_VERSION_1_6) != JNI_OK) {",
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
    ...(usesCallbacks
      ? [
          `void ${disconnectSymbol}(void *connection);`,
          `void ${connectionFreeSymbol}(void *connection);`,
        ]
      : []),
    `const char *${errorMessageSymbol}(void *error);`,
    `void ${errorReleaseSymbol}(void *error);`,
    ...headerDeclarations,
    "",
    "#endif",
    "",
  ].join("\n");
  return Object.freeze({
    schema: "native-typescript.jvm-adapter-source",
    schemaVersion: 18,
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
    spanSupport: usesSpans
      ? Object.freeze({ region: "copy" as const })
      : null,
    stringVectorSupport: usesStringVectors
      ? Object.freeze({ releaseSymbol: strvFreeSymbol })
      : null,
    connectionSupport: usesCallbacks
      ? Object.freeze({
          disconnectSymbol,
          releaseSymbol: connectionFreeSymbol,
        })
      : null,
    constructors: Object.freeze(constructors),
    staticMethods: Object.freeze(staticMethods),
    instanceMethods: Object.freeze(instanceMethods),
    callbacks: Object.freeze(callbacks),
  });
}
