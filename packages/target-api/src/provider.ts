import type { CapabilityId } from "./capability.ts";

export type ProviderKind =
  | "module-resolver"
  | "binding"
  | "native-lowering"
  | "runtime"
  | "artifact"
  | "packager";

export interface ProviderRequirements {
  readonly compiler: readonly CapabilityId[];
  readonly providers: readonly CapabilityId[];
}

export interface ProviderDescriptor<
  Kind extends ProviderKind = ProviderKind,
> {
  readonly kind: Kind;
  readonly id: string;
  readonly version: string;
  readonly provides: readonly CapabilityId[];
  readonly requires: ProviderRequirements;
}

export interface ProviderDefinition<
  Kind extends ProviderKind = ProviderKind,
> {
  readonly descriptor: ProviderDescriptor<Kind>;
}

export type ModuleResolver = ProviderDefinition<"module-resolver">;
export type BindingProvider = ProviderDefinition<"binding">;
export type NativeLoweringProvider = ProviderDefinition<"native-lowering">;
export type RuntimeProvider = ProviderDefinition<"runtime">;
export type ArtifactProvider = ProviderDefinition<"artifact">;
export type Packager = ProviderDefinition<"packager">;

function freezeDescriptor<Kind extends ProviderKind>(
  descriptor: ProviderDescriptor<Kind>,
): ProviderDescriptor<Kind> {
  return Object.freeze({
    ...descriptor,
    provides: Object.freeze([...descriptor.provides]),
    requires: Object.freeze({
      compiler: Object.freeze([...descriptor.requires.compiler]),
      providers: Object.freeze([...descriptor.requires.providers]),
    }),
  });
}

export function defineProvider<
  Kind extends ProviderKind,
  const Provider extends ProviderDefinition<Kind>,
>(provider: Provider): Provider {
  return Object.freeze({
    ...provider,
    descriptor: freezeDescriptor(provider.descriptor),
  }) as Provider;
}
