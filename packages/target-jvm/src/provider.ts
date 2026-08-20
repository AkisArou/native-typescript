import { capabilities, defineProvider } from "@native-typescript/target-api";

/**
 * What the JVM target's runtime provides. The single attached main thread is
 * the owner executor — the same shape as GTK's, minus the loop.
 *
 * Retained callbacks arrived with the answered ingress slice: Java calls a
 * registered native method and the handler's boolean is the emitting call's
 * result. `requires.compiler` mirrors GTK's reasoning — the service links on
 * the target's say-so, not on the program's reachability.
 */
export const jvmRuntimeProvider = defineProvider({
  descriptor: {
    kind: "runtime",
    id: "native-typescript.jvm-runtime",
    version: "0.0.1",
    provides: [
      capabilities.runtimeOwnerExecutorV1,
      capabilities.retainedCallbackV1,
    ],
    requires: {
      /* runtimeOwnerExecutorV1 is REQUIRED as well as provided: this
       * runtime's pump calls the owner loop's attached-source API and
       * checkpoint in both products. For an executable the loop is main
       * and the statement is satisfied trivially; for a library it is
       * what puts the loop unit into the archive - once the capability
       * mapping learns the difference. */
      compiler: [
        capabilities.retainedCallbackV1,
        capabilities.runtimeOwnerExecutorV1,
      ],
      providers: [],
    },
  },
});
