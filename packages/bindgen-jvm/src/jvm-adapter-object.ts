/**
 * Plans the compilation of one generated JVM adapter into a native object,
 * mirroring bindgen-gir's planGObjectAdapterObject: the source artifact is
 * the adapter's own text pinned by its digest, and the object compiles under
 * the strict dialect with whatever SDK arguments reach jni.h.
 */

import { planCObjectCompilation } from "@native-typescript/core";
import type {
  ArtifactActionDefinition,
  ArtifactActionInputArgument,
  ArtifactDefinition,
} from "@native-typescript/core";
import type { JvmAdapterSource } from "./jvm-adapter.ts";

export interface JvmAdapterObjectPlan {
  readonly source: ArtifactDefinition;
  readonly object: ArtifactDefinition;
  readonly action: ArtifactActionDefinition;
}

export function planJvmAdapterObject(input: {
  readonly adapter: JvmAdapterSource;
  readonly sourceArtifactId: string;
  readonly objectArtifactId: string;
  readonly actionId: string;
  readonly logicalPath: string;
  readonly artifactFileName: string;
  readonly arguments: readonly ArtifactActionInputArgument[];
  readonly tool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
}): JvmAdapterObjectPlan {
  const source: ArtifactDefinition = Object.freeze({
    id: input.sourceArtifactId,
    kind: "generated-source",
    entryType: "file",
    mediaType: "text/x-c",
    target: input.target,
    domain: "target",
    cache: "exportable",
    origin: Object.freeze({
      kind: "source",
      digest: input.adapter.sourceDigest,
      fileName: "jvm-adapters.c",
      logicalPath: input.logicalPath,
    }),
  });
  const compilation = planCObjectCompilation({
    actionId: input.actionId,
    artifactId: input.objectArtifactId,
    artifactFileName: input.artifactFileName,
    source: { artifact: input.sourceArtifactId },
    arguments: [
      /* jni.h is clean C11; the adapter holds the strict dialect. The weak
       * registration reference is a GNU attribute, hence gnu11. */
      { kind: "literal", value: "-std=gnu11" },
      { kind: "literal", value: "-O2" },
      { kind: "literal", value: "-Wall" },
      { kind: "literal", value: "-Wextra" },
      { kind: "literal", value: "-Werror" },
      ...input.arguments,
    ],
    tool: input.tool,
    executionPlatform: input.executionPlatform,
    target: input.target,
    deterministic: true,
    cacheable: true,
  });
  return Object.freeze({
    source,
    object: compilation.artifact,
    action: compilation.action,
  });
}
