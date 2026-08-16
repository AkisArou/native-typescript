import { planCObjectCompilation } from "@native-typescript/core";
import type {
  ArtifactActionDefinition,
  ArtifactActionInputArgument,
  ArtifactDefinition,
  ArtifactInputPath,
  CObjectCompilationPlan,
} from "@native-typescript/core";

/**
 * The native sources the GTK target ships. Both live in one directory and are
 * compiled from one source tree, but they are not interchangeable: the GLib
 * owner runtime is portable C that knows nothing about GTK, while the
 * application bootstrap is the GTK-specific half that initialises the toolkit.
 * Keeping them apart is what lets the runtime stay under the strict dialect.
 */
export const targetRuntimeNative = Object.freeze({
  glibRuntime: Object.freeze({
    header: "runtime/nts_glib_runtime.h",
    source: "runtime/nts_glib_runtime.c",
    pkgConfigModules: Object.freeze(["glib-2.0"]),
  }),
  application: Object.freeze({
    header: "runtime/nts_gtk_application.h",
    source: "runtime/nts_gtk_application.c",
    pkgConfigModules: Object.freeze(["gtk4"]),
  }),
});

export const targetRuntimeArtifactIds = Object.freeze({
  sourceTree: "source/target-gtk/runtime",
  glibRuntimeObject: "object/target-gtk/glib-runtime",
  applicationObject: "object/target-gtk/application",
});

export interface TargetRuntimeObjectPlan {
  readonly object: ArtifactDefinition;
  readonly action: ArtifactActionDefinition;
}

/**
 * The one source tree both target-runtime objects compile from. It is declared
 * separately because two objects share it: whichever object were to own it
 * would have to be built for the other to exist.
 */
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
      fileName: "target-gtk-runtime",
      logicalPath: "packages/target-gtk/runtime",
    }),
  });
}

interface TargetRuntimeObjectInput {
  readonly scriptcRuntimeHeaders: ArtifactInputPath;
  readonly arguments: readonly ArtifactActionInputArgument[];
  readonly tool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
}

function planTargetRuntimeObject(
  input: TargetRuntimeObjectInput & {
    readonly actionId: string;
    readonly artifactId: string;
    readonly artifactFileName: string;
    readonly sourcePath: string;
  },
): TargetRuntimeObjectPlan {
  const compilation: CObjectCompilationPlan = planCObjectCompilation({
    actionId: input.actionId,
    artifactId: input.artifactId,
    artifactFileName: input.artifactFileName,
    source: {
      artifact: targetRuntimeArtifactIds.sourceTree,
      path: input.sourcePath,
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
    /* Clang given the same sources and arguments produces the same object,
     * and what it read beyond the declared inputs is recorded for the cache to
     * check. */
    deterministic: true,
    cacheable: true,
  });
  return Object.freeze({
    object: compilation.artifact,
    action: compilation.action,
  });
}

export function planGlibRuntimeObject(
  input: TargetRuntimeObjectInput,
): TargetRuntimeObjectPlan {
  return planTargetRuntimeObject({
    ...input,
    actionId: "compile/target-gtk/glib-runtime",
    artifactId: targetRuntimeArtifactIds.glibRuntimeObject,
    artifactFileName: "nts_glib_runtime.o",
    sourcePath: "nts_glib_runtime.c",
  });
}

export function planGtkApplicationObject(
  input: TargetRuntimeObjectInput,
): TargetRuntimeObjectPlan {
  return planTargetRuntimeObject({
    ...input,
    actionId: "compile/target-gtk/application",
    artifactId: targetRuntimeArtifactIds.applicationObject,
    artifactFileName: "nts_gtk_application.o",
    sourcePath: "nts_gtk_application.c",
  });
}
