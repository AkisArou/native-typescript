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
 * exact UTF-16 bridge, constructors, and the checked failure channel
 * (pending exception captured to an error-out slot). Arrays are the named
 * next slice, waiting on the counted-vector contract SCABI reserved for
 * this platform.
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

/** One adapter position: a JNI primitive scalar, or a stable reference to
 * a class this selection projects. */
export type JvmAdapterPosition =
  | { readonly kind: "primitive"; readonly primitive: JvmPrimitive }
  | { readonly kind: "handle"; readonly binaryName: string }
  | { readonly kind: "string" };

export type JvmAdapterResult = { readonly kind: "void" } | JvmAdapterPosition;

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
}

/**
 * The generated env acquisition every other family calls through: the
 * JavaVM cached at bind time answers GetEnv for the current thread. This is
 * the package's one declared GAP — see its classification.
 */
export interface JvmEnvSupportAdapter {
  readonly helperSymbol: string;
}

export interface JvmClassReleaseAdapter {
  /** Releases one stable reference; the destructor-as-data symbol. */
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
  readonly schemaVersion: 5;
  readonly source: string;
  readonly sourceDigest: string;
  /** Declarations for every public adapter symbol. The ABI probe compiles
   * against this beside jni.h, and an embedding host includes it. */
  readonly header: string;
  readonly headerFileName: string;
  readonly bind: JvmBindAdapter;
  readonly envSupport: JvmEnvSupportAdapter;
  readonly classRelease: JvmClassReleaseAdapter;
  readonly errorSupport: JvmErrorSupportAdapter;
  /** Present when any position is a java/lang/String: the generated UTF-16
   * bridge both directions cross through. Null when no string crosses. */
  readonly stringSupport: { readonly bridge: "utf-16" } | null;
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
      "and the JavaVM is cached here because it is process identity",
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
  classRelease: {
    kind: "translation",
    custom:
      "JNI spells releasing one stable reference DeleteGlobalRef(env, ref); " +
      "the current thread's env is looked up through the declared gap so " +
      "the release is unary, which is what destructor-as-data needs. " +
      "Owner-confined destruction already guarantees an attached thread; " +
      "an unattached one is a runtime bug and traps.",
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

/** One position, or null with a precise refusal. A selected class is an
 * ordinary handle; an unselected one is a boundary the caller can move by
 * selecting the class. */
function positionOf(
  type: JvmTypeReference,
  selectedNames: ReadonlySet<string>,
  path: string,
  what: string,
  diagnostics: JvmDiagnostic[],
): JvmAdapterResult | null {
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
  diagnostics.push(
    diagnostic(
      path,
      `${what} is an array, which waits on the counted-vector contract`,
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

  /* String arguments cross through local jstrings converted before the call
   * and released after it, with every earlier conversion released on a
   * failed later one. */
  function stringPrologue(
    parameters: readonly JvmAdapterPosition[],
    zeroReturn: string,
  ): string[] {
    const lines: string[] = [];
    parameters.forEach((parameter, index) => {
      if (parameter.kind !== "string") return;
      usesStrings = true;
      const priorCleanup = parameters
        .slice(0, index)
        .flatMap((prior, earlier) =>
          prior.kind === "string"
            ? [`      if (js${earlier} != NULL) (*env)->DeleteLocalRef(env, js${earlier});`]
            : []
        );
      lines.push(
        `  jstring js${index} = NULL;`,
        `  if (a${index} != NULL) {`,
        `    js${index} = ${prefix}_utf8_to_jstring(env, a${index}, error);`,
        `    if (*error != NULL) {`,
        ...priorCleanup,
        `      ${zeroReturn}`,
        `    }`,
        `  }`,
      );
    });
    return lines;
  }

  function stringEpilogue(parameters: readonly JvmAdapterPosition[]): string[] {
    return parameters.flatMap((parameter, index) =>
      parameter.kind === "string"
        ? [`  if (js${index} != NULL) (*env)->DeleteLocalRef(env, js${index});`]
        : []
    );
  }

  function argumentOf(parameter: JvmAdapterPosition, index: number): string {
    if (parameter.kind === "handle") return `(jobject)a${index}`;
    if (parameter.kind === "string") return `js${index}`;
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
        ...stringPrologue(signature.parameters, "return NULL;"),
        `  jobject local = (*env)->NewObject(${[
          "env",
          plan.classVar,
          midVar,
          ...argumentList,
        ].join(", ")});`,
        ...stringEpilogue(signature.parameters),
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
      const returnType = result.kind === "void"
        ? "void"
        : result.kind === "primitive"
          ? jniCTypes[result.primitive]
          : result.kind === "string"
            ? "char *"
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
          "char **error",
        ].join(", ")});`,
      );
      bodies.push(
        `/* ${class_.binaryName}.${method.name}${method.descriptor} */`,
        `${returnType}${returnType.endsWith("*") ? "" : " "}${adapterSymbol}(${[
          ...receiver,
          ...parameterDeclarations,
          "char **error",
        ].join(", ")}) {`,
        `  JNIEnv *env = ${prefix}_env(error);`,
        `  if (env == NULL) ${zeroReturn}`,
        ...stringPrologue(signature.parameters, zeroReturn),
        ...(result.kind === "void"
          ? [
              `  ${call};`,
              ...stringEpilogue(signature.parameters),
              `  if ((*env)->ExceptionCheck(env)) ${prefix}_capture(env, error);`,
            ]
          : result.kind === "handle"
            ? [
                /* An object result is a frame-scoped local reference; its
                 * acquisition is normalized exactly as a constructor's. A
                 * NULL local with no exception is a successful null. */
                `  jobject local = ${call};`,
                ...stringEpilogue(signature.parameters),
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
                  ...stringEpilogue(signature.parameters),
                  `  if ((*env)->ExceptionCheck(env)) {`,
                  `    ${prefix}_capture(env, error);`,
                  `    return NULL;`,
                  `  }`,
                  `  if (resultString == NULL) return NULL;`,
                  `  char *owned = ${prefix}_jstring_to_utf8(env, resultString, error);`,
                  `  (*env)->DeleteLocalRef(env, resultString);`,
                  `  return owned;`,
                ]
              : [
                  `  ${returnType} result = ${call};`,
                  ...stringEpilogue(signature.parameters),
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
  const releaseSymbol = `${prefix}_release`;
  const errorMessageSymbol = `${prefix}_error_message`;
  const errorReleaseSymbol = `${prefix}_error_release`;
  const envHelperSymbol = `${prefix}_env`;
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
    ...bodies,
  ];
  const source = lines.join("\n");
  const headerGuard = `NTS_JVM_${slug.toUpperCase()}_ADAPTER_H`;
  const header = [
    "/* Generated by @native-typescript/bindgen-jvm. */",
    `#ifndef ${headerGuard}`,
    `#define ${headerGuard}`,
    "#include <jni.h>",
    "",
    `jint ${bindSymbol}(JNIEnv *env, char **error);`,
    `void ${releaseSymbol}(void *ref);`,
    `const char *${errorMessageSymbol}(void *error);`,
    `void ${errorReleaseSymbol}(void *error);`,
    ...headerDeclarations,
    "",
    "#endif",
    "",
  ].join("\n");
  return Object.freeze({
    schema: "native-typescript.jvm-adapter-source",
    schemaVersion: 5,
    header,
    headerFileName: `nts_jvm_${slug}_adapter.h`,
    source,
    sourceDigest: `sha256:${createHash("sha256").update(source).digest("hex")}`,
    bind: Object.freeze({ adapterSymbol: bindSymbol }),
    envSupport: Object.freeze({ helperSymbol: envHelperSymbol }),
    classRelease: Object.freeze({ adapterSymbol: releaseSymbol }),
    errorSupport: Object.freeze({
      messageSymbol: errorMessageSymbol,
      releaseSymbol: errorReleaseSymbol,
    }),
    stringSupport: usesStrings
      ? Object.freeze({ bridge: "utf-16" as const })
      : null,
    constructors: Object.freeze(constructors),
    staticMethods: Object.freeze(staticMethods),
    instanceMethods: Object.freeze(instanceMethods),
  });
}
