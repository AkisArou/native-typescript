/**
 * Builds the Clang ABI probe for a generated JVM adapter: every adapter
 * symbol, spelled with the exact jni.h types its C source uses, verified
 * against the real header at generation time. Evidence, not inference —
 * jint's width and JNIEnv's shape are facts about the platform's header,
 * and this is where they get proven rather than assumed.
 *
 * The probe covers the ADAPTER surface, not JNI itself: the env-table calls
 * inside the adapter are compiled against jni.h by the same Clang that
 * compiles the adapter, so their checking needs no probe. What the manifest
 * states — and therefore what must be proven — is the signatures the
 * compiler will call.
 */

import {
  generateClangAbiProbe,
  parseCTypeCandidate,
} from "@native-typescript/bindgen-c";
import type {
  CFunctionCandidate,
  ClangAbiProbe,
} from "@native-typescript/bindgen-c";
import { jniCTypes } from "./jvm-adapter.ts";
import type {
  JvmAdapterPosition,
  JvmAdapterResult,
  JvmAdapterSource,
} from "./jvm-adapter.ts";

function positionCType(position: JvmAdapterPosition): string {
  if (position.kind === "primitive") return jniCTypes[position.primitive];
  if (position.kind === "string") return "const char*";
  return "void*";
}

function resultCType(result: JvmAdapterResult): string {
  if (result.kind === "void") return "void";
  if (result.kind === "string") return "char*";
  return positionCType(result);
}

function candidate(
  id: string,
  symbol: string,
  result: string,
  parameters: readonly string[],
): CFunctionCandidate {
  return {
    id,
    symbol,
    result: parseCTypeCandidate(result, `${id}/result`),
    parameters: parameters.map((parameter, index) =>
      parseCTypeCandidate(parameter, `${id}/parameters/${index}`)
    ),
  };
}

export function generateJvmClangAbiProbe(
  adapter: JvmAdapterSource,
): ClangAbiProbe {
  const functions: CFunctionCandidate[] = [
    candidate(
      `jvm.bind.${adapter.bind.adapterSymbol}`,
      adapter.bind.adapterSymbol,
      "jint",
      ["JNIEnv*", "char**"],
    ),
    ...adapter.classReleases.map((release) =>
      candidate(
        `jvm.release.${release.adapterSymbol}`,
        release.adapterSymbol,
        "void",
        ["void*"],
      )
    ),
    candidate(
      `jvm.error.message.${adapter.errorSupport.messageSymbol}`,
      adapter.errorSupport.messageSymbol,
      "const char*",
      ["void*"],
    ),
    candidate(
      `jvm.error.release.${adapter.errorSupport.releaseSymbol}`,
      adapter.errorSupport.releaseSymbol,
      "void",
      ["void*"],
    ),
    ...adapter.constructors.map((constructor) =>
      candidate(
        `jvm.constructor.${constructor.adapterSymbol}`,
        constructor.adapterSymbol,
        "void*",
        [
          ...constructor.parameters.map(positionCType),
          "char**",
        ],
      )
    ),
    ...[...adapter.staticMethods, ...adapter.instanceMethods].map((method) =>
      candidate(
        `jvm.${method.kind}.${method.adapterSymbol}`,
        method.adapterSymbol,
        resultCType(method.result),
        [
          ...(method.kind === "instance" ? ["void*"] : []),
          ...method.parameters.map(positionCType),
          "char**",
        ],
      )
    ),
  ].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  /* jni.h declares the platform's types; the adapter's own header declares
   * the probed symbols, because no SDK header knows generated C. Both are
   * real compiled surfaces, which is what makes the probe evidence. */
  return generateClangAbiProbe({
    includes: ["jni.h", adapter.headerFileName],
    functions,
    records: [],
    enums: [],
  });
}
