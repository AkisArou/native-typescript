import type {
  ArtifactActionDefinition,
  ArtifactActionInputArgument,
  ArtifactDefinition,
  ArtifactInputPath,
} from "@native-typescript/core";
import { planGObjectAdapterObject } from "@native-typescript/bindgen-gir";
import type {
  GObjectAdapterObjectPlan,
  GObjectAdapterSource,
} from "@native-typescript/bindgen-gir";
import {
  glibRuntimeArtifactIds,
  planGlibRuntimeObject,
} from "./glib-runtime-object.ts";
import type { GlibRuntimeObjectPlan } from "./glib-runtime-object.ts";

export const gtkTargetObjectArtifactIds = Object.freeze({
  glibRuntimeSourceTree: glibRuntimeArtifactIds.sourceTree,
  glibRuntimeObject: glibRuntimeArtifactIds.object,
});

/**
 * Adapter artifact identities for one binding package, derived from its
 * package slug so several namespaces can contribute objects to one link
 * without colliding. Callers read the resulting identities off the returned
 * plan rather than recomputing them, so this stays internal.
 */
function gtkAdapterObjectArtifactIds(slug: string): {
  readonly source: string;
  readonly object: string;
} {
  return Object.freeze({
    source: `source/${slug}/gobject-adapters`,
    object: `object/${slug}/gobject-adapters`,
  });
}

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

export interface GtkAdapterObject {
  readonly slug: string;
  readonly plan: GObjectAdapterObjectPlan;
}

export interface GtkTargetObjectsPlan {
  readonly runtime: GlibRuntimeObjectPlan;
  readonly adapters: readonly GtkAdapterObject[];
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
  /**
   * One entry per generated binding package, keyed by its package slug. An
   * application can reach several namespaces, and each contributes its own
   * adapter object to the link.
   */
  readonly adapters: readonly {
    readonly slug: string;
    readonly adapter: GObjectAdapterSource;
  }[];
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

  const slugs = new Set<string>();
  const adapters = input.adapters.map(({ slug, adapter }): GtkAdapterObject => {
    if (slugs.has(slug)) {
      throw new Error(`GTK target objects declare package slug '${slug}' twice`);
    }
    slugs.add(slug);
    const ids = gtkAdapterObjectArtifactIds(slug);
    return Object.freeze({
      slug,
      plan: planGObjectAdapterObject({
        adapter,
        sourceArtifactId: ids.source,
        objectArtifactId: ids.object,
        actionId: `compile/${slug}/gobject-adapters`,
        logicalPath: `generated/${slug}/gobject-adapters.c`,
        artifactFileName: "gobject-adapters.o",
        arguments: input.sdkArguments,
        tool: input.tool,
        executionPlatform: input.executionPlatform,
        target: input.target,
      }),
    });
  });

  return Object.freeze({
    runtime,
    adapters: Object.freeze(adapters),
    artifacts: Object.freeze([
      runtime.sourceTree,
      runtime.object,
      ...adapters.flatMap(({ plan }) => [plan.source, plan.object]),
    ]),
    actions: Object.freeze([
      runtime.action,
      ...adapters.map(({ plan }) => plan.action),
    ]),
  });
}
