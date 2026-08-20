import { capabilities } from "@native-typescript/target-api";
import type { CapabilityId, ProviderDefinition } from "@native-typescript/target-api";

/**
 * Turns a provider's declared compiler requirements into the runtime services
 * ScriptC has to include.
 *
 * ScriptC includes a runtime service when the compiled program reaches it,
 * which is the right rule for the program and the wrong one for a target. A
 * target's runtime objects are linked whether or not the application happens
 * to use what they call — the GLib owner runtime calls the retained-callback
 * service even in an application that connects no signal — so their needs have
 * to be stated rather than inferred.
 *
 * `requires.compiler` was that statement all along and nothing read it. This is
 * what reads it, which is why an unmapped capability is an error: a provider
 * that requires something the compiler cannot supply must not link and then
 * fail on undefined symbols.
 */

/** ScriptC's own vocabulary for services an embedder can require. */
export type NativeRuntimeService =
  | "retained-callbacks"
  | "native-handle"
  | "attached-loop";

const serviceByCapability = new Map<CapabilityId, NativeRuntimeService>([
  [capabilities.retainedCallbackV1, "retained-callbacks"],
  /* Foreign-thread ingress is delivered through the retained-callback
   * service's owner gateway, so requiring it requires that service. */
  [capabilities.foreignCallbackIngressV1, "retained-callbacks"],
  /* A runtime that owns an executor drives it through ScriptC's
   * attached-source API, which is a demand on the compiled runtime in one
   * product and free in the other: an executable's runtime carries the loop
   * unconditionally, because there the loop IS main, while a library's base
   * drops it. A target that both PROVIDES this capability and REQUIRES it is
   * making the honest statement in both — trivially satisfied where the loop
   * is already there, and load-bearing where it is not. */
  [capabilities.runtimeOwnerExecutorV1, "attached-loop"],
]);

/**
 * Capabilities a provider may require that place no demand on the compiled
 * runtime. They describe how a target plans or schedules rather than what has
 * to be linked, so they map to nothing rather than to an error.
 */
const withoutRuntimeService: readonly CapabilityId[] = Object.freeze([
  capabilities.nativeIrV1,
  capabilities.scabiV1,
  capabilities.artifactGraphV1,
  capabilities.partitionInterfaceV1,
]);

export function nativeRuntimeServices(
  providers: readonly ProviderDefinition[],
): readonly NativeRuntimeService[] {
  const services = new Set<NativeRuntimeService>();
  for (const { descriptor } of providers) {
    for (const capability of descriptor.requires.compiler) {
      const service = serviceByCapability.get(capability);
      if (service !== undefined) {
        services.add(service);
        continue;
      }
      if (withoutRuntimeService.includes(capability)) continue;
      throw new Error(
        `Provider ${descriptor.id} requires compiler capability ` +
          `'${capability}', which maps to no runtime service. Either the ` +
          "capability is unimplemented or the mapping is missing; linking " +
          "without it would fail on undefined symbols instead.",
      );
    }
  }
  return Object.freeze([...services].sort());
}
