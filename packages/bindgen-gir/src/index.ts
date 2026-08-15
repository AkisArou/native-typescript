export { ingestGir } from "./gir.ts";
export { generateGirClangAbiProbe } from "./gir-clang.ts";
export {
  girBindingAnalysisArtifactIds,
  planGirBindingAnalysis,
} from "./gir-binding-analysis.ts";
export type {
  GirBindingAnalysisArtifactIds,
  GirBindingAnalysisPlan,
} from "./gir-binding-analysis.ts";
export { generateGObjectScabiPackage } from "./gobject-scabi.ts";
export type {
  GObjectScabiGenerationOptions,
  GObjectScabiPackage,
} from "./gobject-scabi.ts";
export {
  defineGirBindingPackageRequest,
  girBindingToolFile,
  girPackageSlug,
  planGirBindingPackage,
  planGirClangEvidenceNormalization,
  validateGirBindingPackageRequest,
} from "./gir-binding-package.ts";
export type {
  GirBindingPackageArtifactPlan,
  GirBindingPackageDescriptor,
  GirBindingPackageRequest,
  GirClangEvidenceArtifactPlan,
} from "./gir-binding-package.ts";
export {
  generateGObjectAdapterSource,
  planGObjectAdapterObject,
} from "./gobject-adapter.ts";
export type {
  GObjectAdapterObjectPlan,
  GObjectAdapterSource,
  GObjectConstructorAdapter,
  GObjectSignalAdapter,
  GObjectSignalConnectionAdapter,
  GObjectValueMethodAdapter,
  GObjectValueMethodOutputAdapter,
} from "./gobject-adapter.ts";
export { GirIngestionError } from "./gir-model.ts";
export type {
  GirAnnotation,
  GirCallbackScope,
  GirCallable,
  GirClass,
  GirClassSelection,
  GirDeclarationReference,
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
