import {
  capabilities,
  defineProvider,
} from "@native-typescript/target-api";

export { ingestGir } from "./gir.ts";
export { generateGirClangAbiProbe } from "./gir-clang.ts";
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
export type { GtkTargetObjectsPlan } from "./gtk-target-objects.ts";
export {
  gtkBindingAnalysisArtifactIds,
  planGtkBindingAnalysis,
} from "./gtk-binding-analysis.ts";
export { generateGtkScabiPackage } from "./gtk-scabi.ts";
export {
  defineGtkBindingPackageRequest,
  girPackageSlug,
  gtkBindingToolFile,
  planGtkBindingPackage,
  planGtkClangEvidenceNormalization,
  validateGtkBindingPackageRequest,
} from "./gtk-binding-package.ts";
export {
  generateGObjectAdapterSource,
  planGObjectAdapterObject,
} from "./gobject-adapter.ts";
export { GirIngestionError } from "./gir-model.ts";
export type {
  GirAnnotation,
  GirCallbackScope,
  GirCallable,
  GirClass,
  GirClassSelection,
  GirDiagnostic,
  GirDiagnosticCode,
  GirEnumeration,
  GirEnumerationMember,
  GirEnumerationSelection,
  GirInclude,
  GirIngestionOptions,
  GirParameter,
  GirParameterDirection,
  GirRecord,
  GirRecordField,
  GirRecordSelection,
  GirReturnValue,
  GirSignalWhen,
  GirSnapshot,
  GirTransferOwnership,
  GirTypeReference,
} from "./gir-model.ts";
export type {
  GObjectAdapterSource,
  GObjectAdapterObjectPlan,
  GObjectConstructorAdapter,
  GObjectSignalAdapter,
  GObjectSignalConnectionAdapter,
  GObjectValueMethodAdapter,
  GObjectValueMethodOutputAdapter,
} from "./gobject-adapter.ts";
export type {
  GtkScabiGenerationOptions,
  GtkScabiPackage,
} from "./gtk-scabi.ts";
export type {
  GtkBindingAnalysisPlan,
} from "./gtk-binding-analysis.ts";
export type {
  GtkBindingPackageArtifactPlan,
  GtkBindingPackageDescriptor,
  GtkBindingPackageRequest,
  GtkClangEvidenceArtifactPlan,
} from "./gtk-binding-package.ts";

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
