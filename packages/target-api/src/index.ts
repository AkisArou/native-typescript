export {
  capabilities,
  defineCapability,
  isCapabilityId,
} from "./capability.ts";
export type { CapabilityId } from "./capability.ts";

export { defineProvider } from "./provider.ts";
export type {
  ArtifactProvider,
  BindingProvider,
  ModuleResolver,
  ForeignBoundaryProvider,
  Packager,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderKind,
  ProviderRequirements,
  RuntimeProvider,
} from "./provider.ts";

export { defineCompiler, defineTarget } from "./target.ts";
export type {
  CompilerDescriptor,
  Endianness,
  ObjectFormat,
  PointerWidth,
  TargetDefinition,
  TargetDescriptor,
} from "./target.ts";
