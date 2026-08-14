import {
  capabilities,
  defineProvider,
} from "@native-typescript/target-api";

export const glibRuntimeNative = Object.freeze({
  header: "runtime/nts_glib_runtime.h",
  source: "runtime/nts_glib_runtime.c",
  pkgConfigModules: Object.freeze(["glib-2.0"]),
});

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
