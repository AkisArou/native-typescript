import {
  capabilities,
  defineProvider,
} from "@native-typescript/target-api";

export {
  planGlibRuntimeObject,
  planGtkApplicationObject,
  targetRuntimeArtifactIds,
  targetRuntimeNative,
  targetRuntimeSourceTree,
} from "./target-runtime-objects.ts";
export type { TargetRuntimeObjectPlan } from "./target-runtime-objects.ts";
export { planGtkTargetObjects } from "./gtk-target-objects.ts";
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

export { buildGtkApplication } from "./application-build.ts";
export type {
  GtkApplicationBuildResult,
  GtkApplicationToolPaths,
} from "./application-build.ts";
export {
  GtkApplicationProjectError,
  parseGtkApplicationProject,
} from "./application-project.ts";
export type {
  GtkApplicationProject,
  GtkProjectNamespace,
} from "./application-project.ts";
