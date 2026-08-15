import { fileURLToPath } from "node:url";

export {
  translateScabiNativeProgram,
  type ScriptCNativeAbiType,
  type ScriptCNativeArgumentType,
  type ScriptCNativeBinding,
  type ScriptCNativeDeclaration,
  type ScriptCNativeErrorContract,
  type ScriptCNativeExport,
  type ScriptCNativeFrontendInput,
  type ScriptCNativeHandleDefinition,
  type ScriptCNativeIntegerScalar,
  type ScriptCNativeIrType,
  type ScriptCNativeParameterProjection,
  type ScriptCNativePointerType,
  type ScriptCNativeProgramSelection,
  type ScriptCNativeResultProjection,
  type ScriptCNativeResultAbiType,
  type ScriptCNativeScalar,
  type ScriptCNativeSourceType,
  type ScriptCNativeStructDefinition,
  type ScriptCNativeTypeDefinition,
  type ScriptCNativeTranslationDiagnostic,
  type ScriptCNativeTranslationResult,
  type ScriptCNativeValueType,
} from "./native.ts";
export type {
  ScriptCExternalCcArgument,
  ScriptCExternalCcPlan,
  ScriptCExternalCcPlanResolution,
} from "./external-build.ts";

export interface ScriptCCheckout {
  readonly branch: "native-typescript";
  readonly path: string;
  readonly repository: "https://github.com/AkisArou/scriptc.git";
}

export function locateScriptCCheckout(): ScriptCCheckout {
  return {
    branch: "native-typescript",
    path: fileURLToPath(new URL("../../../third_party/scriptc/", import.meta.url)),
    repository: "https://github.com/AkisArou/scriptc.git",
  };
}
