import {
  capabilities,
  defineProvider,
} from "@native-typescript/target-api";

export {
  glibRuntimeArtifactIds,
  glibRuntimeNative,
  planGlibRuntimeObject,
} from "./glib-runtime-object.ts";
export type { GlibRuntimeObjectPlan } from "./glib-runtime-object.ts";
export {
  gtkTargetObjectArtifactIds,
  planGtkTargetObjects,
} from "./gtk-target-objects.ts";
export type {
  GtkAdapterObject,
  GtkTargetObjectsPlan,
} from "./gtk-target-objects.ts";

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
