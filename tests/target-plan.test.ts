import assert from "node:assert/strict";
import test from "node:test";
import { TargetPlanningError, planTarget } from "@native-typescript/core";
import type {
  CapabilityId,
  CompilerDescriptor,
  ProviderDefinition,
  ProviderKind,
  RuntimeProvider,
  TargetDefinition,
} from "@native-typescript/target-api";
import {
  capabilities,
  defineCompiler,
  defineProvider,
  defineTarget,
} from "@native-typescript/target-api";

function provider<Kind extends ProviderKind>(
  kind: Kind,
  id: string,
  options: {
    readonly provides?: ProviderDefinition<Kind>["descriptor"]["provides"];
    readonly requiresCompiler?: ProviderDefinition<Kind>["descriptor"]["requires"]["compiler"];
    readonly requiresProviders?: ProviderDefinition<Kind>["descriptor"]["requires"]["providers"];
  } = {},
): ProviderDefinition<Kind> {
  return defineProvider({
    descriptor: {
      kind,
      id,
      version: "1.0.0",
      provides: options.provides ?? [],
      requires: {
        compiler: options.requiresCompiler ?? [],
        providers: options.requiresProviders ?? [],
      },
    },
  });
}

function compiler(
  available: CompilerDescriptor["capabilities"] = [
    capabilities.nativeIrV1,
    capabilities.scabiV1,
  ],
): CompilerDescriptor {
  return defineCompiler({
    id: "scriptc",
    version: "0.0.30-native-typescript.1",
    capabilities: available,
  });
}

function target(
  overrides: Partial<TargetDefinition> = {},
): TargetDefinition {
  return defineTarget({
    descriptor: {
      id: "native-typescript.host-c",
      version: "0.0.1",
      triple: "x86_64-unknown-linux-gnu",
      pointerWidth: 64,
      endianness: "little",
      objectFormat: "elf",
      requiredCompilerCapabilities: [
        capabilities.nativeIrV1,
        capabilities.scabiV1,
      ],
      supportedBindingFamilies: ["c"],
    },
    moduleResolvers: [provider("module-resolver", "native-c-modules")],
    bindingProviders: [
      provider("binding", "clang-c-bindings", {
        requiresCompiler: [capabilities.scabiV1],
      }),
    ],
    nativeLowering: provider("native-lowering", "c-native-lowering", {
      requiresCompiler: [capabilities.nativeIrV1],
    }),
    runtime: provider("runtime", "host-runtime", {
      provides: [
        capabilities.runtimeOwnerExecutorV1,
        capabilities.foreignCallbackIngressV1,
      ],
    }),
    artifactProviders: [
      provider("artifact", "host-c-artifacts", {
        provides: [capabilities.artifactGraphV1],
      }),
    ],
    packager: provider("packager", "host-linker", {
      requiresProviders: [capabilities.artifactGraphV1],
    }),
    ...overrides,
  });
}

function planningError(run: () => unknown): TargetPlanningError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof TargetPlanningError);
    return error;
  }

  assert.fail("Expected target planning to fail");
}

test("target planning produces an immutable capability snapshot", () => {
  const mutableCapabilities: CapabilityId[] = [
    capabilities.nativeIrV1,
    capabilities.scabiV1,
  ];
  const plan = planTarget({
    compiler: {
      id: "scriptc",
      version: "0.0.30-native-typescript.1",
      capabilities: mutableCapabilities,
    },
    target: target(),
  });
  mutableCapabilities.length = 0;

  assert.equal(plan.compiler.capabilities.length, 2);
  assert.equal(plan.providers.length, 6);
  assert.deepEqual(
    plan.providers.map(({ descriptor }) => descriptor.kind),
    [
      "module-resolver",
      "binding",
      "native-lowering",
      "runtime",
      "artifact",
      "packager",
    ],
  );
  assert.deepEqual(
    plan.capabilities.map(({ id }) => id),
    [
      capabilities.artifactGraphV1,
      capabilities.foreignCallbackIngressV1,
      capabilities.nativeIrV1,
      capabilities.runtimeOwnerExecutorV1,
      capabilities.scabiV1,
    ],
  );
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.target), true);
  assert.equal(Object.isFrozen(plan.target.runtime.descriptor.provides), true);
  assert.equal(Object.isFrozen(plan.capabilities), true);
});

test("target planning rejects missing compiler capabilities", () => {
  const error = planningError(() =>
    planTarget({
      compiler: compiler([capabilities.nativeIrV1]),
      target: target(),
    }),
  );

  assert.deepEqual(
    error.diagnostics.map(({ code }) => code),
    ["NTS1004", "NTS1004"],
  );
  assert.match(error.message, /Compiler scriptc does not provide scabi\/v1/);
});

test("target planning rejects unresolved provider requirements", () => {
  const definition = target({
    packager: provider("packager", "host-linker", {
      requiresProviders: [capabilities.partitionInterfaceV1],
    }),
  });
  const error = planningError(() =>
    planTarget({ compiler: compiler(), target: definition }),
  );

  assert.deepEqual(error.diagnostics.map(({ code }) => code), ["NTS1005"]);
  assert.match(error.message, /No selected provider supplies partition-interface\/v1/);
});

test("every runtime provider declares owner execution and callback ingress", () => {
  const definition = target({
    runtime: provider("runtime", "host-runtime"),
  });
  const error = planningError(() =>
    planTarget({ compiler: compiler(), target: definition }),
  );

  assert.deepEqual(
    error.diagnostics.map(({ code }) => code),
    ["NTS1007", "NTS1007"],
  );
  assert.match(error.message, /runtime-owner-executor\/v1/);
  assert.match(error.message, /foreign-callback-ingress\/v1/);
});

test("provider identities are unique across provider roles", () => {
  const definition = target({
    packager: provider("packager", "host-runtime"),
  });
  const error = planningError(() =>
    planTarget({ compiler: compiler(), target: definition }),
  );

  assert.deepEqual(error.diagnostics.map(({ code }) => code), ["NTS1003"]);
  assert.match(error.message, /Provider ID is already used by target\.runtime/);
});

test("provider roles are checked at runtime", () => {
  const misplacedRuntime = provider("artifact", "host-runtime", {
    provides: [
      capabilities.runtimeOwnerExecutorV1,
      capabilities.foreignCallbackIngressV1,
    ],
  }) as unknown as RuntimeProvider;
  const definition = target({ runtime: misplacedRuntime });
  const error = planningError(() =>
    planTarget({ compiler: compiler(), target: definition }),
  );

  assert.deepEqual(error.diagnostics.map(({ code }) => code), ["NTS1006"]);
  assert.match(error.message, /Expected runtime provider, received artifact/);
});

test("capability syntax and duplicate declarations fail without cascades", () => {
  const invalidCapability = "Native IR v1" as never;
  const definition = target({
    descriptor: {
      ...target().descriptor,
      requiredCompilerCapabilities: [
        invalidCapability,
        capabilities.nativeIrV1,
        capabilities.nativeIrV1,
      ],
    },
  });
  const error = planningError(() =>
    planTarget({ compiler: compiler(), target: definition }),
  );

  assert.deepEqual(
    error.diagnostics.map(({ code }) => code),
    ["NTS1001", "NTS1002"],
  );
});
