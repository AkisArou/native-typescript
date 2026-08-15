import { planCObjectCompilation } from "@native-typescript/core";
import type {
  ArtifactActionArgument,
  ArtifactActionDefinition,
  ArtifactDefinition,
  ArtifactInputPath,
  CObjectCompilationPlan,
} from "@native-typescript/core";
import {
  capabilities,
  defineProvider,
} from "@native-typescript/target-api";

export { ingestGir } from "./gir.ts";
export { generateGirClangFunctionProbe } from "./gir-clang.ts";
export { GirIngestionError } from "./gir-model.ts";
export type {
  GirAnnotation,
  GirCallbackScope,
  GirCallable,
  GirClass,
  GirClassSelection,
  GirDiagnostic,
  GirDiagnosticCode,
  GirInclude,
  GirIngestionOptions,
  GirParameter,
  GirParameterDirection,
  GirReturnValue,
  GirSignalWhen,
  GirSnapshot,
  GirTransferOwnership,
  GirTypeReference,
} from "./gir-model.ts";

export const glibRuntimeNative = Object.freeze({
  header: "runtime/nts_glib_runtime.h",
  source: "runtime/nts_glib_runtime.c",
  pkgConfigModules: Object.freeze(["glib-2.0"]),
});

export const glibRuntimeArtifactIds = Object.freeze({
  sourceTree: "source/target-gtk/glib-runtime",
  object: "object/target-gtk/glib-runtime",
});

export interface GlibRuntimeObjectPlan {
  readonly sourceTree: ArtifactDefinition;
  readonly object: ArtifactDefinition;
  readonly action: ArtifactActionDefinition;
}

export function planGlibRuntimeObject(input: {
  readonly sourceTreeDigest: string;
  readonly scriptcRuntimeHeaders: ArtifactInputPath;
  readonly arguments: readonly ArtifactActionArgument[];
  readonly tool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
}): GlibRuntimeObjectPlan {
  const sourceTree: ArtifactDefinition = Object.freeze({
    id: glibRuntimeArtifactIds.sourceTree,
    kind: "source-tree",
    entryType: "directory",
    mediaType: "inode/directory",
    target: input.target,
    domain: "target",
    cache: "exportable",
    origin: Object.freeze({
      kind: "source",
      digest: input.sourceTreeDigest,
      fileName: "target-gtk-runtime",
      logicalPath: "packages/target-gtk/runtime",
    }),
  });
  const compilation: CObjectCompilationPlan = planCObjectCompilation({
    actionId: "compile/target-gtk/glib-runtime",
    artifactId: glibRuntimeArtifactIds.object,
    artifactFileName: "nts_glib_runtime.o",
    source: {
      artifact: glibRuntimeArtifactIds.sourceTree,
      path: "nts_glib_runtime.c",
    },
    arguments: [
      ...input.arguments,
      { kind: "literal", value: "-I" },
      { kind: "input-path", artifact: glibRuntimeArtifactIds.sourceTree },
      { kind: "literal", value: "-I" },
      { kind: "input-path", ...input.scriptcRuntimeHeaders },
    ],
    tool: input.tool,
    executionPlatform: input.executionPlatform,
    target: input.target,
    deterministic: false,
    cacheable: false,
  });
  return Object.freeze({
    sourceTree,
    object: compilation.artifact,
    action: compilation.action,
  });
}

export const glibRuntimeProvider = defineProvider({
  descriptor: {
    kind: "runtime",
    id: "native-typescript.glib-runtime",
    version: "0.0.1",
    provides: [
      capabilities.runtimeOwnerExecutorV1,
      capabilities.foreignCallbackIngressV1,
      capabilities.retainedCallbackV1,
    ],
    requires: {
      compiler: [capabilities.retainedCallbackV1],
      providers: [],
    },
  },
});
