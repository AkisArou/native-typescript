import { capabilities, defineProvider } from "@native-typescript/target-api";

/**
 * What the GTK target's runtime provides, and what it needs from the compiler
 * to work at all.
 *
 * `requires.compiler` is read by the build: the owner runtime calls the
 * retained-callback service whether or not the application connects a signal,
 * so the service has to be linked on the target's say-so rather than on the
 * program's reachability.
 */
export const glibRuntimeProvider = defineProvider({
  descriptor: {
    kind: "runtime",
    id: "native-typescript.glib-runtime",
    version: "0.0.1",
    provides: [
      capabilities.runtimeOwnerExecutorV1,
      capabilities.foreignCallbackIngressV1,
      capabilities.retainedCallbackV1,
    ],
    requires: {
      compiler: [capabilities.retainedCallbackV1],
      providers: [],
    },
  },
});
