import type {
  ArtifactActionDefinition,
  ArtifactActionInputArgument,
  ArtifactDefinition,
  ArtifactInputPath,
} from "@native-typescript/core";
import {
  glibRuntimeArtifactIds,
  planGlibRuntimeObject,
} from "./glib-runtime-object.ts";
import type { GlibRuntimeObjectPlan } from "./glib-runtime-object.ts";
import { planGObjectAdapterObject } from "./gobject-adapter.ts";
import type {
  GObjectAdapterObjectPlan,
  GObjectAdapterSource,
} from "./gobject-adapter.ts";

export const gtkTargetObjectArtifactIds = Object.freeze({
  glibRuntimeSourceTree: glibRuntimeArtifactIds.sourceTree,
  glibRuntimeObject: glibRuntimeArtifactIds.object,
  adapterSource: "source/gtk4/gobject-adapters",
  adapterObject: "object/gtk4/gobject-adapters",
});

/* The GLib runtime adapter is ordinary portable C and is held to the strictest
 * dialect the target package compiles. The generated GObject adapters instead
 * require GNU extensions reached through the GTK headers, so their prologue is
 * owned by planGObjectAdapterObject rather than shared here. */
const glibRuntimeCompilePrologue: readonly ArtifactActionInputArgument[] =
  Object.freeze(
    (["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-pedantic"] as const).map(
      (value): ArtifactActionInputArgument =>
        Object.freeze({ kind: "literal", value }),
    ),
  );

export interface GtkTargetObjectsPlan {
  readonly runtime: GlibRuntimeObjectPlan;
  readonly adapters: GObjectAdapterObjectPlan;
  readonly artifacts: readonly ArtifactDefinition[];
  readonly actions: readonly ArtifactActionDefinition[];
}

/**
 * Plans every native object the GTK target contributes to an application link:
 * the target-owned GLib owner-runtime adapter and the generated GObject
 * adapters for the selected binding surface.
 *
 * Callers supply the SDK compile arguments, tool identity, and execution
 * facts. Artifact identities, per-object dialect policy, and dependency edges
 * belong to the target package so an application build cannot reconstruct them
 * inconsistently.
 */
export function planGtkTargetObjects(input: {
  readonly adapter: GObjectAdapterSource;
  readonly glibRuntimeSourceTreeDigest: string;
  readonly scriptcRuntimeHeaders: ArtifactInputPath;
  readonly sdkArguments: readonly ArtifactActionInputArgument[];
  readonly tool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
}): GtkTargetObjectsPlan {
  const runtime = planGlibRuntimeObject({
    sourceTreeDigest: input.glibRuntimeSourceTreeDigest,
    scriptcRuntimeHeaders: input.scriptcRuntimeHeaders,
    arguments: [...glibRuntimeCompilePrologue, ...input.sdkArguments],
    tool: input.tool,
    executionPlatform: input.executionPlatform,
    target: input.target,
  });

  const adapters = planGObjectAdapterObject({
    adapter: input.adapter,
    sourceArtifactId: gtkTargetObjectArtifactIds.adapterSource,
    objectArtifactId: gtkTargetObjectArtifactIds.adapterObject,
    actionId: "compile/gtk4/gobject-adapters",
    logicalPath: "generated/gtk4/gobject-adapters.c",
    artifactFileName: "gobject-adapters.o",
    arguments: input.sdkArguments,
    tool: input.tool,
    executionPlatform: input.executionPlatform,
    target: input.target,
  });

  return Object.freeze({
    runtime,
    adapters,
    artifacts: Object.freeze([
      runtime.sourceTree,
      runtime.object,
      adapters.source,
      adapters.object,
    ]),
    actions: Object.freeze([runtime.action, adapters.action]),
  });
}
