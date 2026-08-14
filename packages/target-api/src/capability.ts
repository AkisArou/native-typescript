export type CapabilityId = `${string}/v${number}`;

const CAPABILITY_ID_PATTERN =
  /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*(?:\/[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*)*\/v[1-9][0-9]*$/;

export function isCapabilityId(value: string): value is CapabilityId {
  return CAPABILITY_ID_PATTERN.test(value);
}

export function defineCapability<const Id extends CapabilityId>(id: Id): Id {
  if (!isCapabilityId(id)) {
    throw new TypeError(`Invalid capability ID: ${id}`);
  }

  return id;
}

export const capabilities = Object.freeze({
  nativeIrV1: defineCapability("native-ir/v1"),
  scabiV1: defineCapability("scabi/v1"),
  runtimeOwnerExecutorV1: defineCapability("runtime-owner-executor/v1"),
  retainedCallbackV1: defineCapability("retained-callback/v1"),
  foreignCallbackIngressV1: defineCapability("foreign-callback-ingress/v1"),
  artifactGraphV1: defineCapability("artifact-graph/v1"),
  partitionInterfaceV1: defineCapability("partition-interface/v1"),
});
