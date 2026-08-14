import {
  capabilities,
  defineCompiler,
  defineTarget,
  isCapabilityId,
} from "@native-typescript/target-api";
import type {
  CapabilityId,
  CompilerDescriptor,
  ProviderDefinition,
  ProviderKind,
  TargetDefinition,
} from "@native-typescript/target-api";

export type TargetPlanDiagnosticCode =
  | "NTS1001"
  | "NTS1002"
  | "NTS1003"
  | "NTS1004"
  | "NTS1005"
  | "NTS1006"
  | "NTS1007"
  | "NTS1008";

export interface TargetPlanDiagnostic {
  readonly code: TargetPlanDiagnosticCode;
  readonly severity: "error";
  readonly path: string;
  readonly message: string;
}

export interface CapabilitySource {
  readonly kind: "compiler" | "provider";
  readonly id: string;
}

export interface ResolvedCapability {
  readonly id: CapabilityId;
  readonly sources: readonly CapabilitySource[];
}

export interface TargetPlan {
  readonly compiler: CompilerDescriptor;
  readonly target: TargetDefinition;
  readonly providers: readonly ProviderDefinition[];
  readonly capabilities: readonly ResolvedCapability[];
}

export interface TargetPlanInput {
  readonly compiler: CompilerDescriptor;
  readonly target: TargetDefinition;
}

export class TargetPlanningError extends Error {
  override readonly name = "TargetPlanningError";
  readonly diagnostics: readonly TargetPlanDiagnostic[];

  constructor(diagnostics: readonly TargetPlanDiagnostic[]) {
    const summary = diagnostics
      .map(
        (diagnostic) =>
          `${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
      )
      .join("\n");
    super(
      `Target planning failed with ${diagnostics.length} error(s)\n${summary}`,
    );
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

interface ProviderAtPath {
  readonly path: string;
  readonly provider: ProviderDefinition;
  readonly expectedKind: ProviderKind;
}

const runtimeCapabilities = Object.freeze([
  capabilities.runtimeOwnerExecutorV1,
  capabilities.foreignCallbackIngressV1,
]);

function diagnostic(
  code: TargetPlanDiagnosticCode,
  path: string,
  message: string,
): TargetPlanDiagnostic {
  return Object.freeze({ code, severity: "error", path, message });
}

function providerEntries(target: TargetDefinition): readonly ProviderAtPath[] {
  return Object.freeze([
    ...target.moduleResolvers.map((provider, index) => ({
      path: `target.moduleResolvers[${index}]`,
      provider,
      expectedKind: "module-resolver" as const,
    })),
    ...target.bindingProviders.map((provider, index) => ({
      path: `target.bindingProviders[${index}]`,
      provider,
      expectedKind: "binding" as const,
    })),
    {
      path: "target.nativeLowering",
      provider: target.nativeLowering,
      expectedKind: "native-lowering" as const,
    },
    {
      path: "target.runtime",
      provider: target.runtime,
      expectedKind: "runtime" as const,
    },
    ...target.artifactProviders.map((provider, index) => ({
      path: `target.artifactProviders[${index}]`,
      provider,
      expectedKind: "artifact" as const,
    })),
    {
      path: "target.packager",
      provider: target.packager,
      expectedKind: "packager" as const,
    },
  ]);
}

function validateIdentity(
  value: string,
  path: string,
  diagnostics: TargetPlanDiagnostic[],
): void {
  if (value.length === 0 || value.trim() !== value || /\s/.test(value)) {
    diagnostics.push(
      diagnostic(
        "NTS1008",
        path,
        "Identity must be non-empty and contain no whitespace",
      ),
    );
  }
}

function validateCapabilities(
  values: readonly CapabilityId[],
  path: string,
  diagnostics: TargetPlanDiagnostic[],
): void {
  const seen = new Set<string>();

  for (const [index, value] of values.entries()) {
    if (!isCapabilityId(value)) {
      diagnostics.push(
        diagnostic(
          "NTS1001",
          `${path}[${index}]`,
          `Invalid capability ID: ${value}`,
        ),
      );
      continue;
    }

    if (seen.has(value)) {
      diagnostics.push(
        diagnostic(
          "NTS1002",
          `${path}[${index}]`,
          `Duplicate capability: ${value}`,
        ),
      );
      continue;
    }

    seen.add(value);
  }
}

function validateProvider(
  entry: ProviderAtPath,
  diagnostics: TargetPlanDiagnostic[],
): void {
  const { descriptor } = entry.provider;
  validateIdentity(descriptor.id, `${entry.path}.descriptor.id`, diagnostics);
  validateIdentity(
    descriptor.version,
    `${entry.path}.descriptor.version`,
    diagnostics,
  );

  if (descriptor.kind !== entry.expectedKind) {
    diagnostics.push(
      diagnostic(
        "NTS1006",
        `${entry.path}.descriptor.kind`,
        `Expected ${entry.expectedKind} provider, received ${descriptor.kind}`,
      ),
    );
  }

  validateCapabilities(
    descriptor.provides,
    `${entry.path}.descriptor.provides`,
    diagnostics,
  );
  validateCapabilities(
    descriptor.requires.compiler,
    `${entry.path}.descriptor.requires.compiler`,
    diagnostics,
  );
  validateCapabilities(
    descriptor.requires.providers,
    `${entry.path}.descriptor.requires.providers`,
    diagnostics,
  );
}

function validateRequirements(
  compiler: CompilerDescriptor,
  target: TargetDefinition,
  providers: readonly ProviderAtPath[],
  diagnostics: TargetPlanDiagnostic[],
): void {
  const compilerCapabilities = new Set(
    compiler.capabilities.filter(isCapabilityId),
  );
  const providerCapabilities = new Set(
    providers
      .flatMap(({ provider }) => provider.descriptor.provides)
      .filter(isCapabilityId),
  );

  for (const capability of new Set(
    target.descriptor.requiredCompilerCapabilities.filter(isCapabilityId),
  )) {
    if (!compilerCapabilities.has(capability)) {
      diagnostics.push(
        diagnostic(
          "NTS1004",
          "target.descriptor.requiredCompilerCapabilities",
          `Compiler ${compiler.id} does not provide ${capability}`,
        ),
      );
    }
  }

  for (const entry of providers) {
    for (const capability of new Set(
      entry.provider.descriptor.requires.compiler.filter(isCapabilityId),
    )) {
      if (!compilerCapabilities.has(capability)) {
        diagnostics.push(
          diagnostic(
            "NTS1004",
            `${entry.path}.descriptor.requires.compiler`,
            `Compiler ${compiler.id} does not provide ${capability}`,
          ),
        );
      }
    }

    for (const capability of new Set(
      entry.provider.descriptor.requires.providers.filter(isCapabilityId),
    )) {
      if (!providerCapabilities.has(capability)) {
        diagnostics.push(
          diagnostic(
            "NTS1005",
            `${entry.path}.descriptor.requires.providers`,
            `No selected provider supplies ${capability}`,
          ),
        );
      }
    }
  }

  const runtimeProvides = new Set(
    target.runtime.descriptor.provides.filter(isCapabilityId),
  );
  for (const capability of runtimeCapabilities) {
    if (!runtimeProvides.has(capability)) {
      diagnostics.push(
        diagnostic(
          "NTS1007",
          "target.runtime.descriptor.provides",
          `Runtime provider must supply ${capability}`,
        ),
      );
    }
  }
}

function resolveCapabilities(
  compiler: CompilerDescriptor,
  providers: readonly ProviderAtPath[],
): readonly ResolvedCapability[] {
  const sources = new Map<CapabilityId, CapabilitySource[]>();

  const add = (id: CapabilityId, source: CapabilitySource): void => {
    const existing = sources.get(id);
    if (existing === undefined) {
      sources.set(id, [source]);
    } else {
      existing.push(source);
    }
  };

  for (const capability of compiler.capabilities) {
    add(capability, { kind: "compiler", id: compiler.id });
  }

  for (const { provider } of providers) {
    for (const capability of provider.descriptor.provides) {
      add(capability, { kind: "provider", id: provider.descriptor.id });
    }
  }

  return Object.freeze(
    [...sources.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([id, capabilitySources]) =>
        Object.freeze({
          id,
          sources: Object.freeze(
            capabilitySources.map((source) => Object.freeze(source)),
          ),
        }),
      ),
  );
}

export function planTarget(input: TargetPlanInput): TargetPlan {
  const compiler = defineCompiler(input.compiler);
  const target = defineTarget(input.target);
  const entries = providerEntries(target);
  const diagnostics: TargetPlanDiagnostic[] = [];

  validateIdentity(compiler.id, "compiler.id", diagnostics);
  validateIdentity(compiler.version, "compiler.version", diagnostics);
  validateIdentity(target.descriptor.id, "target.descriptor.id", diagnostics);
  validateIdentity(
    target.descriptor.version,
    "target.descriptor.version",
    diagnostics,
  );
  validateCapabilities(compiler.capabilities, "compiler.capabilities", diagnostics);
  validateCapabilities(
    target.descriptor.requiredCompilerCapabilities,
    "target.descriptor.requiredCompilerCapabilities",
    diagnostics,
  );

  const providerIds = new Map<string, string>();
  for (const entry of entries) {
    validateProvider(entry, diagnostics);
    const previousPath = providerIds.get(entry.provider.descriptor.id);
    if (previousPath !== undefined) {
      diagnostics.push(
        diagnostic(
          "NTS1003",
          `${entry.path}.descriptor.id`,
          `Provider ID is already used by ${previousPath}`,
        ),
      );
    } else {
      providerIds.set(entry.provider.descriptor.id, entry.path);
    }
  }

  validateRequirements(compiler, target, entries, diagnostics);

  if (diagnostics.length > 0) {
    throw new TargetPlanningError(diagnostics);
  }

  const providers = Object.freeze(entries.map(({ provider }) => provider));
  return Object.freeze({
    compiler,
    target,
    providers,
    capabilities: resolveCapabilities(compiler, entries),
  });
}
