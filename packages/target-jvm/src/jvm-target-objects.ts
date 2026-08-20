import type {
  ArtifactActionDefinition,
  ArtifactActionInputArgument,
  ArtifactDefinition,
  ArtifactInputPath,
} from "@native-typescript/core";
import { planJvmAdapterObject } from "@native-typescript/bindgen-jvm";
import type {
  JvmAdapterObjectPlan,
  JvmAdapterSource,
} from "@native-typescript/bindgen-jvm";
import {
  planJvmRuntimeObject,
  targetRuntimeSourceTree,
} from "./target-runtime-objects.ts";
import type { TargetRuntimeObjectPlan } from "./target-runtime-objects.ts";

/* The bootstrap includes jni.h and the scriptc runtime header; jni.h is
 * clean C but the adapters' weak-registration attribute is GNU, so both
 * compile as gnu11 under the same warnings-as-errors wall. */
function compilePrologue(
  ...values: readonly string[]
): readonly ArtifactActionInputArgument[] {
  return Object.freeze(
    values.map((value): ArtifactActionInputArgument =>
      Object.freeze({ kind: "literal", value })
    ),
  );
}

/* -fPIC unconditionally, by the library profile's own argument: the
 * objects exist to be linked into either product, an executable accepts
 * PIC objects at negligible cost, and a non-PIC object discovered by a
 * shared-object link is a broken build diagnosed three layers from its
 * cause. */
const jvmCompilePrologue = compilePrologue(
  "-std=gnu11",
  "-O2",
  "-fPIC",
  "-Wall",
  "-Wextra",
  "-Werror",
);

export interface JvmAdapterObject {
  readonly slug: string;
  readonly plan: JvmAdapterObjectPlan;
}

export interface JvmTargetObjectsPlan {
  readonly sourceTree: ArtifactDefinition;
  readonly runtime: TargetRuntimeObjectPlan;
  readonly adapters: readonly JvmAdapterObject[];
  readonly artifacts: readonly ArtifactDefinition[];
  readonly actions: readonly ArtifactActionDefinition[];
}

/**
 * Plans every native object the JVM target contributes to an application
 * link: the runtime bootstrap and one generated adapter object per binding
 * package. Identities, dialect policy, and dependency edges belong here so
 * an application build cannot reconstruct them inconsistently.
 */
export function planJvmTargetObjects(input: {
  readonly adapters: readonly {
    readonly slug: string;
    readonly adapter: JvmAdapterSource;
  }[];
  readonly targetRuntimeSourceTreeDigest: string;
  readonly scriptcRuntimeHeaders: ArtifactInputPath;
  /** Compile arguments that reach jni.h, from the resolved JDK. */
  readonly sdkArguments: readonly ArtifactActionInputArgument[];
  readonly tool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
}): JvmTargetObjectsPlan {
  const sourceTree = targetRuntimeSourceTree({
    digest: input.targetRuntimeSourceTreeDigest,
    target: input.target,
  });
  const runtime = planJvmRuntimeObject({
    scriptcRuntimeHeaders: input.scriptcRuntimeHeaders,
    arguments: [...jvmCompilePrologue, ...input.sdkArguments],
    tool: input.tool,
    executionPlatform: input.executionPlatform,
    target: input.target,
  });

  const slugs = new Set<string>();
  const adapters = input.adapters.map(({ slug, adapter }): JvmAdapterObject => {
    if (slugs.has(slug)) {
      throw new Error(`JVM target objects declare package slug '${slug}' twice`);
    }
    slugs.add(slug);
    return Object.freeze({
      slug,
      plan: planJvmAdapterObject({
        adapter,
        sourceArtifactId: `source/${slug}/jvm-adapters`,
        objectArtifactId: `object/${slug}/jvm-adapters`,
        actionId: `compile/${slug}/jvm-adapters`,
        logicalPath: `generated/${slug}/jvm-adapters.c`,
        artifactFileName: "jvm-adapters.o",
        arguments: input.sdkArguments,
        tool: input.tool,
        executionPlatform: input.executionPlatform,
        target: input.target,
      }),
    });
  });

  return Object.freeze({
    sourceTree,
    runtime,
    adapters: Object.freeze(adapters),
    artifacts: Object.freeze([
      sourceTree,
      runtime.object,
      ...adapters.flatMap(({ plan }) => [plan.source, plan.object]),
    ]),
    actions: Object.freeze([
      runtime.action,
      ...adapters.map(({ plan }) => plan.action),
    ]),
  });
}
