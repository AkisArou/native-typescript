import type { CapabilityId } from "./capability.ts";

export type ProviderKind =
  | "module-resolver"
  | "binding"
  | "foreign-boundary"
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
/**
 * The ABI family this target's foreign boundary uses, and what that boundary
 * requires of the runtime.
 *
 * It DECLARES a boundary; it does not lower one. The distinction is the whole
 * reason for the name. Its predecessor was called `NativeLoweringProvider`,
 * and a provider named for lowering invites an implementation that receives
 * Native IR and returns C or LLVM contributions — which is a per-platform
 * mini-backend, and the exact drift record 0004 measured five real defects
 * from when one decision lived in two emitters.
 *
 * Lowering belongs to the compiler, once, for both backends. Exact ABI
 * mechanics belong to generated artifacts whose interface, target, and
 * digest are verified. Neither is a provider callback, which is why every
 * provider here stays serializable data with no behavior.
 */
export type ForeignBoundaryProvider = ProviderDefinition<"foreign-boundary">;
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
