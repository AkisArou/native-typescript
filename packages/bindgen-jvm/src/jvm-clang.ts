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

function positionCTypes(position: JvmAdapterPosition): readonly string[] {
  if (position.kind === "primitive") return [jniCTypes[position.primitive]];
  if (position.kind === "string") return ["const char*"];
  /* A span is one position across two physical slots; the probe proves
   * both, in the order the adapter declares them. */
  /* A byte pointer for every element: the element lives in the marshal
   * and the managed side, never in the slot. */
  if (position.kind === "span") return ["const uint8_t*", "size_t"];
  if (position.kind === "string-vector") return ["const char* const*"];
  return ["void*"];
}

function resultCType(result: JvmAdapterResult): string {
  if (result.kind === "void") return "void";
  if (result.kind === "string") return "char*";
  if (result.kind === "span") return "uint8_t*";
  if (result.kind === "string-vector") return "char**";
  if (result.kind === "primitive") return jniCTypes[result.primitive];
  return "void*";
}

/** A span result's length rides a compiler-owned out slot placed beside
 * the error slot; the probe proves both trailing slots. */
function trailingCTypes(result: JvmAdapterResult): readonly string[] {
  return result.kind === "span" ? ["size_t*", "char**"] : ["char**"];
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
    candidate(
      `jvm.release.${adapter.release.adapterSymbol}`,
      adapter.release.adapterSymbol,
      "void",
      ["void*"],
    ),
    ...(adapter.stringVectorSupport === null
      ? []
      : [
          candidate(
            `jvm.strv.${adapter.stringVectorSupport.releaseSymbol}`,
            adapter.stringVectorSupport.releaseSymbol,
            "void",
            ["char**"],
          ),
        ]),
    /* Connect symbols are NOT probed, and the reason is a LIMITATION, not
     * a decision: parseCTypeCandidate refuses function types by design
     * (`parseCTypeCandidate("char (*)(int)")` throws), so a
     * function-pointer parameter has no candidate spelling. Until the
     * grammar grows one, the registration machinery's ABI is proven by the
     * adapter compiling against its own header and by the live suite; if
     * it ever does, these symbols become probeable and should be. The
     * unary connection operations are ordinary and are probed. */
    ...(adapter.connectionSupport === null
      ? []
      : [
          candidate(
            `jvm.connection.disconnect.${adapter.connectionSupport.disconnectSymbol}`,
            adapter.connectionSupport.disconnectSymbol,
            "void",
            ["void*"],
          ),
          candidate(
            `jvm.connection.release.${adapter.connectionSupport.releaseSymbol}`,
            adapter.connectionSupport.releaseSymbol,
            "void",
            ["void*"],
          ),
        ]),
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
          ...constructor.parameters.flatMap(positionCTypes),
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
          ...method.parameters.flatMap(positionCTypes),
          ...trailingCTypes(method.result),
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
