import type {
  ScriptCExecutableCompilationPlan,
  ScriptCExternalCcPlan,
} from "@native-typescript/scriptc";
import type {
  ArtifactActionArgument,
  ArtifactActionDefinition,
  ArtifactDefinition,
} from "./artifact-graph.ts";

export interface ScriptCExecutableArtifactPlan {
  readonly artifact: ArtifactDefinition;
  readonly action: ArtifactActionDefinition;
}

export interface ScriptCProgramEmissionArtifactPlan {
  readonly artifact: ArtifactDefinition;
  readonly action: ArtifactActionDefinition;
}

export function planScriptCProgramEmission(input: {
  readonly actionId: string;
  readonly plan: ScriptCExecutableCompilationPlan;
  readonly planArtifact: string;
  readonly compilerArtifact: string;
  readonly artifactId: string;
  readonly artifactFileName: string;
  readonly tool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly targetPlatform: string;
  readonly target: string;
}): ScriptCProgramEmissionArtifactPlan {
  if (
    input.plan.schema !== "scriptc.executable-compilation-plan" ||
    input.plan.schemaVersion !== 1
  ) {
    throw new Error("Unsupported ScriptC executable compilation plan schema");
  }
  if (input.tool.id !== "tool/node") {
    throw new Error(
      `ScriptC program emission requires tool/node, but received ${input.tool.id}`,
    );
  }
  if (input.plan.target.platform !== input.targetPlatform) {
    throw new Error(
      `ScriptC planned ${input.plan.target.platform}, but emission targets ${input.targetPlatform}`,
    );
  }
  const extension = input.plan.backend === "llvm" ? ".ll" : ".c";
  if (!input.artifactFileName.endsWith(extension)) {
    throw new Error(
      `ScriptC ${input.plan.backend} emission requires a ${extension} artifact`,
    );
  }
  return Object.freeze({
    artifact: Object.freeze({
      id: input.artifactId,
      kind: "generated-source",
      entryType: "file",
      mediaType: input.plan.backend === "llvm" ? "text/x-llvm" : "text/x-c",
      target: input.target,
      domain: "target",
      cache: "exportable",
      origin: Object.freeze({
        kind: "action",
        action: input.actionId,
        fileName: input.artifactFileName,
      }),
    }),
    action: Object.freeze({
      id: input.actionId,
      implementation: Object.freeze({
        id: "native-typescript/scriptc-program-emission",
        version: String(input.plan.schemaVersion),
      }),
      tool: Object.freeze({ ...input.tool }),
      arguments: Object.freeze([
        Object.freeze({
          kind: "input-path" as const,
          artifact: input.compilerArtifact,
          path: "executable-emitter-cli.js",
        }),
        Object.freeze({
          kind: "input-path" as const,
          artifact: input.planArtifact,
        }),
        Object.freeze({
          kind: "output-path" as const,
          artifact: input.artifactId,
        }),
      ]),
      environment: Object.freeze([]),
      inputs: Object.freeze([input.compilerArtifact, input.planArtifact]),
      outputs: Object.freeze([input.artifactId]),
      standardOutput: Object.freeze({ kind: "report" as const }),
      workingDirectory: "isolated",
      network: "denied",
      executionPlatform: input.executionPlatform,
      target: input.target,
      deterministic: true,
      cacheable: true,
    }),
  });
}

/**
 * One ScriptC runtime object, compiled on its own so it can be reused.
 *
 * The runtime is a function of the pinned checkout and the toolchain, not of
 * the application, so it survives an application edit. It reads system headers
 * nobody declared, which is why it records what it read: the entry is reused
 * only while every one of those files is unchanged.
 */
export function planScriptCRuntimeObject(input: {
  readonly actionId: string;
  readonly plan: ScriptCExternalCcPlan;
  readonly artifactFileName: string;
  readonly tool: ArtifactActionDefinition["tool"];
  readonly driverPlatform: string;
  readonly executionPlatform: string;
  readonly target: string;
}): ScriptCExecutableArtifactPlan {
  const executable = planScriptCExecutable(input);
  return Object.freeze({
    artifact: Object.freeze({
      ...executable.artifact,
      kind: "native-object",
      mediaType: "application/x-object",
      cache: "local",
    }),
    action: Object.freeze({
      ...executable.action,
      arguments: Object.freeze([
        Object.freeze({ kind: "literal", value: "-MD" } as const),
        Object.freeze({ kind: "literal", value: "-MF" } as const),
        Object.freeze({ kind: "dependency-path" } as const),
        ...executable.action.arguments,
      ]),
      deterministic: true,
      cacheable: true,
      recordsDependencies: true,
    }),
  });
}

export function planScriptCExecutable(input: {
  readonly actionId: string;
  readonly plan: ScriptCExternalCcPlan;
  readonly artifactFileName: string;
  readonly tool: ArtifactActionDefinition["tool"];
  readonly driverPlatform: string;
  readonly executionPlatform: string;
  readonly target: string;
}): ScriptCExecutableArtifactPlan {
  if (
    input.plan.schema !== "scriptc.external-cc-plan" ||
    input.plan.schemaVersion !== 1
  ) {
    throw new Error("Unsupported ScriptC external C plan schema");
  }
  if (input.tool.id !== `tool/${input.plan.driver.command}`) {
    throw new Error(
      `ScriptC requested ${input.plan.driver.command}, but received ${input.tool.id}`,
    );
  }
  if (input.plan.targetPlatform !== input.driverPlatform) {
    throw new Error(
      `ScriptC planned ${input.plan.targetPlatform}, but the product requires ${input.driverPlatform}`,
    );
  }
  const arguments_: ArtifactActionArgument[] = input.plan.arguments.map((argument) => {
    if (argument.kind === "literal") return { kind: "literal", value: argument.value };
    if (argument.kind === "output-path") {
      if (argument.output !== input.plan.output) {
        throw new Error(`ScriptC plan references unknown output ${argument.output}`);
      }
      return { kind: "output-path", artifact: argument.output };
    }
    return argument.path === undefined
      ? { kind: "input-path", artifact: argument.input }
      : { kind: "input-path", artifact: argument.input, path: argument.path };
  });
  return Object.freeze({
    artifact: Object.freeze({
      id: input.plan.output,
      kind: "executable",
      entryType: "file",
      mediaType: "application/x-executable",
      target: input.target,
      domain: "target",
      cache: "none",
      origin: Object.freeze({
        kind: "action",
        action: input.actionId,
        fileName: input.artifactFileName,
      }),
    }),
    action: Object.freeze({
      id: input.actionId,
      implementation: Object.freeze({
        id: "native-typescript/scriptc-external-cc",
        version: String(input.plan.schemaVersion),
      }),
      tool: Object.freeze({ ...input.tool }),
      arguments: Object.freeze(arguments_.map((argument) => Object.freeze(argument))),
      environment: Object.freeze([]),
      inputs: Object.freeze([...input.plan.inputs]),
      outputs: Object.freeze([input.plan.output]),
      standardOutput: Object.freeze({ kind: "report" }),
      workingDirectory: "isolated",
      network: "denied",
      executionPlatform: input.executionPlatform,
      target: input.target,
      deterministic: false,
      cacheable: false,
    }),
  });
}
