import { capabilities, defineProvider } from "@native-typescript/target-api";

/**
 * What the JVM target's runtime provides. The single attached main thread is
 * the owner executor — the same shape as GTK's, minus the loop.
 *
 * `requires.compiler` is deliberately empty: this target has no
 * Java-to-native callbacks yet, so linking the retained-callback service on
 * its say-so would link a service nothing uses and hide that nothing does.
 */
export const jvmRuntimeProvider = defineProvider({
  descriptor: {
    kind: "runtime",
    id: "native-typescript.jvm-runtime",
    version: "0.0.1",
    provides: [capabilities.runtimeOwnerExecutorV1],
    requires: {
      compiler: [],
      providers: [],
    },
  },
});
