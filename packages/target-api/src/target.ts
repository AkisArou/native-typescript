import type { CapabilityId } from "./capability.ts";
import { defineProvider } from "./provider.ts";
import type {
  ArtifactProvider,
  BindingProvider,
  ModuleResolver,
  ForeignBoundaryProvider,
  Packager,
  RuntimeProvider,
} from "./provider.ts";

export type PointerWidth = 32 | 64;
export type Endianness = "little" | "big";
export type ObjectFormat = "elf" | "macho" | "coff" | "wasm";

export interface CompilerDescriptor {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly CapabilityId[];
}

export interface TargetDescriptor {
  readonly id: string;
  readonly version: string;
  readonly triple: string;
  readonly pointerWidth: PointerWidth;
  readonly endianness: Endianness;
  readonly objectFormat: ObjectFormat;
  readonly requiredCompilerCapabilities: readonly CapabilityId[];
  readonly supportedBindingFamilies: readonly string[];
}

export interface TargetDefinition {
  readonly descriptor: TargetDescriptor;
  readonly moduleResolvers: readonly ModuleResolver[];
  readonly bindingProviders: readonly BindingProvider[];
  readonly foreignBoundary: ForeignBoundaryProvider;
  readonly runtime: RuntimeProvider;
  readonly artifactProviders: readonly ArtifactProvider[];
  readonly packager: Packager;
}

export function defineCompiler<const Compiler extends CompilerDescriptor>(
  compiler: Compiler,
): Compiler {
  return Object.freeze({
    ...compiler,
    capabilities: Object.freeze([...compiler.capabilities]),
  }) as Compiler;
}

export function defineTarget<const Target extends TargetDefinition>(
  target: Target,
): Target {
  return Object.freeze({
    ...target,
    descriptor: Object.freeze({
      ...target.descriptor,
      requiredCompilerCapabilities: Object.freeze([
        ...target.descriptor.requiredCompilerCapabilities,
      ]),
      supportedBindingFamilies: Object.freeze([
        ...target.descriptor.supportedBindingFamilies,
      ]),
    }),
    moduleResolvers: Object.freeze(
      target.moduleResolvers.map((provider) => defineProvider(provider)),
    ),
    bindingProviders: Object.freeze(
      target.bindingProviders.map((provider) => defineProvider(provider)),
    ),
    foreignBoundary: defineProvider(target.foreignBoundary),
    runtime: defineProvider(target.runtime),
    artifactProviders: Object.freeze(
      target.artifactProviders.map((provider) => defineProvider(provider)),
    ),
    packager: defineProvider(target.packager),
  }) as Target;
}
