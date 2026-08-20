import { planCObjectCompilation } from "@native-typescript/core";
import type {
  ArtifactActionDefinition,
  ArtifactActionInputArgument,
  ArtifactDefinition,
  ArtifactInputPath,
} from "@native-typescript/core";

/** The one native source the JVM target ships: the process bootstrap that
 * owns the JavaVM and invokes the binds registered at image load. */
export const targetRuntimeArtifactIds = Object.freeze({
  sourceTree: "source/target-jvm/runtime",
  runtimeObject: "object/target-jvm/jvm-runtime",
});

export interface TargetRuntimeObjectPlan {
  readonly object: ArtifactDefinition;
  readonly action: ArtifactActionDefinition;
}

export function targetRuntimeSourceTree(input: {
  readonly digest: string;
  readonly target: string;
}): ArtifactDefinition {
  return Object.freeze({
    id: targetRuntimeArtifactIds.sourceTree,
    kind: "source-tree",
    entryType: "directory",
    mediaType: "inode/directory",
    target: input.target,
    domain: "target",
    cache: "exportable",
    origin: Object.freeze({
      kind: "source",
      digest: input.digest,
      fileName: "target-jvm-runtime",
      logicalPath: "packages/target-jvm/runtime",
    }),
  });
}

export function planJvmRuntimeObject(input: {
  readonly scriptcRuntimeHeaders: ArtifactInputPath;
  readonly arguments: readonly ArtifactActionInputArgument[];
  readonly tool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
}): TargetRuntimeObjectPlan {
  const compilation = planCObjectCompilation({
    actionId: "compile/target-jvm/jvm-runtime",
    artifactId: targetRuntimeArtifactIds.runtimeObject,
    artifactFileName: "nts_jvm_runtime.o",
    source: {
      artifact: targetRuntimeArtifactIds.sourceTree,
      path: "nts_jvm_runtime.c",
    },
    arguments: [
      ...input.arguments,
      { kind: "literal", value: "-I" },
      { kind: "input-path", artifact: targetRuntimeArtifactIds.sourceTree },
      { kind: "literal", value: "-I" },
      { kind: "input-path", ...input.scriptcRuntimeHeaders },
    ],
    tool: input.tool,
    executionPlatform: input.executionPlatform,
    target: input.target,
    deterministic: true,
    cacheable: true,
  });
  return Object.freeze({
    object: compilation.artifact,
    action: compilation.action,
  });
}
