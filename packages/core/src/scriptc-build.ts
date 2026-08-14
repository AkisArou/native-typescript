import type { ScriptCExternalCcPlan } from "@native-typescript/scriptc";
import type {
  ArtifactActionArgument,
  ArtifactActionDefinition,
  ArtifactDefinition,
} from "./artifact-graph.ts";

export interface ScriptCExecutableArtifactPlan {
  readonly artifact: ArtifactDefinition;
  readonly action: ArtifactActionDefinition;
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
      workingDirectory: "isolated",
      network: "denied",
      executionPlatform: input.executionPlatform,
      target: input.target,
      deterministic: false,
      cacheable: false,
    }),
  });
}
