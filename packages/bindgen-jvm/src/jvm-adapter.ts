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
 * The first slice's algebra is deliberately narrow and refuses precisely:
 * methods over JNI primitive scalars and void, constructors, and the
 * checked failure channel (pending exception captured to a message beside
 * the result, release = free). Object-typed positions, strings, and arrays
 * are named next slices, not silent truncations — arrays in particular wait
 * on the counted-vector contract SCABI reserved for this platform.
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

export interface JvmConstructorAdapter {
  readonly className: string;
  /** The JNI identity the adapter resolves: ("<init>", descriptor). */
  readonly descriptor: string;
  readonly adapterSymbol: string;
  readonly parameters: readonly JvmPrimitive[];
}

export interface JvmMethodAdapter {
  readonly kind: "static" | "instance";
  readonly className: string;
  readonly name: string;
  readonly descriptor: string;
  readonly adapterSymbol: string;
  readonly result: "void" | JvmPrimitive;
  readonly parameters: readonly JvmPrimitive[];
}

export interface JvmBindAdapter {
  /** Resolves every class and method ID once; must run before any call. */
  readonly adapterSymbol: string;
}

export interface JvmClassReleaseAdapter {
  /** Releases one stable reference; the destructor-as-data symbol. */
  readonly adapterSymbol: string;
}

export interface JvmFailureSupportAdapter {
  readonly failureType: string;
  /** The release action for a captured message, named by the contract. */
  readonly messageRelease: "free";
}

export interface JvmAdapterSource {
  readonly schema: "native-typescript.jvm-adapter-source";
  readonly schemaVersion: 1;
  readonly source: string;
  readonly sourceDigest: string;
  readonly bind: JvmBindAdapter;
  readonly classRelease: JvmClassReleaseAdapter;
  readonly failureSupport: JvmFailureSupportAdapter;
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

type JvmAdapterMetadata = "schema" | "schemaVersion" | "source" | "sourceDigest";

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
      "resolution is registration identity performed once, not a call",
  },
  classRelease: {
    kind: "translation",
    custom:
      "JNI spells releasing one stable reference DeleteGlobalRef(env, ref); " +
      "env is a thread capability, so the release is wrapped to the " +
      "runtime's unary destructor shape",
  },
  failureSupport: {
    kind: "translation",
    custom:
      "failure is a pending exception, and only a restricted set of JNI " +
      "operations is legal until it is captured or cleared; capture " +
      "materializes the throwable's message and clears, off the hot path",
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
      "cached class reference and method ID",
  },
  instanceMethods: {
    kind: "translation",
    custom:
      "the call is Call<Type>Method through the env table on a stable " +
      "receiver reference with a cached method ID",
  },
});

const jniCTypes: Readonly<Record<JvmPrimitive, string>> = Object.freeze({
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

/** A primitive-or-void position, or null with a precise refusal. */
function scalarOf(
  type: JvmTypeReference,
  path: string,
  what: string,
  diagnostics: JvmDiagnostic[],
): "void" | JvmPrimitive | null {
  if (type.kind === "void") return "void";
  if (type.kind === "primitive") return type.name;
  const shape = type.kind === "array"
    ? "an array, which waits on the counted-vector contract"
    : `object type '${type.binaryName}'`;
  diagnostics.push(
    diagnostic(
      path,
      `${what} is ${shape}; the generated-adapter algebra covers JNI ` +
        "primitive scalars and void in this slice",
    ),
  );
  return null;
}

interface ResolvedSignature {
  readonly parameters: readonly JvmPrimitive[];
  readonly result: "void" | JvmPrimitive;
}

function resolveSignature(
  method: JvmMethod,
  path: string,
  diagnostics: JvmDiagnostic[],
): ResolvedSignature | null {
  const parameters: JvmPrimitive[] = [];
  let refused = false;
  method.parameters.forEach((parameter, index) => {
    const scalar = scalarOf(
      parameter,
      `${path}/parameters/${index}`,
      `Parameter ${index}`,
      diagnostics,
    );
    if (scalar === null || scalar === "void") refused = true;
    else parameters.push(scalar);
  });
  const result = scalarOf(method.result, `${path}/result`, "Result", diagnostics);
  if (result === null || refused) return null;
  return { parameters, result };
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
  const failureType = `${prefix}_failure`;

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
      const signature = resolveSignature(constructor, path, diagnostics);
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
      const parameterDeclarations = signature.parameters.map(
        (parameter, index) => `${jniCTypes[parameter]} a${index}`,
      );
      const argumentList = signature.parameters.map((_, index) => `a${index}`);
      bodies.push(
        `/* ${class_.binaryName}.<init>${constructor.descriptor} */`,
        `void *${adapterSymbol}(${[
          "JNIEnv *env",
          ...parameterDeclarations,
          `${failureType} *fail`,
        ].join(", ")}) {`,
        `  jobject local = (*env)->NewObject(${[
          "env",
          plan.classVar,
          midVar,
          ...argumentList,
        ].join(", ")});`,
        `  if ((*env)->ExceptionCheck(env)) {`,
        `    ${prefix}_capture(env, fail);`,
        `    return NULL;`,
        `  }`,
        `  jobject stable = (*env)->NewGlobalRef(env, local);`,
        `  (*env)->DeleteLocalRef(env, local);`,
        `  if (stable == NULL) { fail->failed = 1; fail->message = NULL; }`,
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
      const signature = resolveSignature(method, path, diagnostics);
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
      const returnType = signature.result === "void"
        ? "void"
        : jniCTypes[signature.result];
      const callName = signature.result === "void"
        ? "Void"
        : jniCallNames[signature.result];
      const receiver = method.access.static
        ? []
        : ["void *self"];
      const callTarget = method.access.static
        ? plan.classVar
        : "(jobject)self";
      const callFamily = method.access.static ? "CallStatic" : "Call";
      const parameterDeclarations = signature.parameters.map(
        (parameter, index) => `${jniCTypes[parameter]} a${index}`,
      );
      const argumentList = signature.parameters.map((_, index) => `a${index}`);
      const call = `(*env)->${callFamily}${callName}Method(${[
        "env",
        callTarget,
        midVar,
        ...argumentList,
      ].join(", ")})`;
      bodies.push(
        `/* ${class_.binaryName}.${method.name}${method.descriptor} */`,
        `${returnType} ${adapterSymbol}(${[
          "JNIEnv *env",
          ...receiver,
          ...parameterDeclarations,
          `${failureType} *fail`,
        ].join(", ")}) {`,
        ...(signature.result === "void"
          ? [
              `  ${call};`,
              `  if ((*env)->ExceptionCheck(env)) ${prefix}_capture(env, fail);`,
            ]
          : [
              `  ${returnType} result = ${call};`,
              `  if ((*env)->ExceptionCheck(env)) {`,
              `    ${prefix}_capture(env, fail);`,
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
  const lines = [
    "/* Generated by @native-typescript/bindgen-jvm. */",
    "#include <jni.h>",
    "#include <stdlib.h>",
    "#include <string.h>",
    "",
    "/* The landed outcome arm: a failure indicator beside the result, the",
    " * message owned by the caller, its release action free(). */",
    `typedef struct ${failureType} {`,
    "  int failed;",
    "  char *message;",
    `} ${failureType};`,
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
    "/* Pending-exception capture: JNI permits only a restricted set of",
    " * operations while an exception is pending, so it is taken and cleared",
    " * before the message is read. Cold by construction. */",
    `static void ${prefix}_capture(JNIEnv *env, ${failureType} *fail) {`,
    "  fail->failed = 1;",
    "  fail->message = NULL;",
    "  if ((*env)->PushLocalFrame(env, 8) < 0) {",
    "    (*env)->ExceptionClear(env);",
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
    "        fail->message = strdup(utf);",
    "        (*env)->ReleaseStringUTFChars(env, msg, utf);",
    "      }",
    "    }",
    "  }",
    "  (*env)->PopLocalFrame(env, NULL);",
    "}",
    "",
    `void ${releaseSymbol}(JNIEnv *env, void *ref) {`,
    "  (*env)->DeleteGlobalRef(env, (jobject)ref);",
    "}",
    "",
    `static jclass ${prefix}_resolve_class(JNIEnv *env, const char *name,`,
    `                                      ${failureType} *fail) {`,
    "  jclass local = (*env)->FindClass(env, name);",
    "  if ((*env)->ExceptionCheck(env)) {",
    `    ${prefix}_capture(env, fail);`,
    "    return NULL;",
    "  }",
    "  jclass stable = (jclass)(*env)->NewGlobalRef(env, local);",
    "  (*env)->DeleteLocalRef(env, local);",
    "  if (stable == NULL) { fail->failed = 1; fail->message = NULL; }",
    "  return stable;",
    "}",
    "",
    "/* Registration identity, resolved exactly once before any call. */",
    `jint ${bindSymbol}(JNIEnv *env, ${failureType} *fail) {`,
    "  fail->failed = 0;",
    "  fail->message = NULL;",
    `  ${prefix}_cls_throwable =`,
    `      ${prefix}_resolve_class(env, "java/lang/Throwable", fail);`,
    `  if (${prefix}_cls_throwable == NULL) return -1;`,
    `  ${prefix}_mid_get_message = (*env)->GetMethodID(`,
    `      env, ${prefix}_cls_throwable, "getMessage",`,
    `      "()Ljava/lang/String;");`,
    `  if ((*env)->ExceptionCheck(env)) { ${prefix}_capture(env, fail); return -1; }`,
    ...plans.flatMap((plan) => [
      `  ${plan.classVar} =`,
      `      ${prefix}_resolve_class(env, "${plan.class_.binaryName}", fail);`,
      `  if (${plan.classVar} == NULL) return -1;`,
      ...plan.members.flatMap((member) => [
        `  ${member.midVar} = (*env)->${
          member.static ? "GetStaticMethodID" : "GetMethodID"
        }(`,
        `      env, ${plan.classVar}, "${member.name}", "${member.descriptor}");`,
        `  if ((*env)->ExceptionCheck(env)) { ${prefix}_capture(env, fail); return -1; }`,
      ]),
    ]),
    "  return 0;",
    "}",
    "",
    ...bodies,
  ];
  const source = lines.join("\n");
  return Object.freeze({
    schema: "native-typescript.jvm-adapter-source",
    schemaVersion: 1,
    source,
    sourceDigest: `sha256:${createHash("sha256").update(source).digest("hex")}`,
    bind: Object.freeze({ adapterSymbol: bindSymbol }),
    classRelease: Object.freeze({ adapterSymbol: releaseSymbol }),
    failureSupport: Object.freeze({
      failureType,
      messageRelease: "free",
    }),
    constructors: Object.freeze(constructors),
    staticMethods: Object.freeze(staticMethods),
    instanceMethods: Object.freeze(instanceMethods),
  });
}
