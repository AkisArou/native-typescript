import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePkgConfigSdk } from "@native-typescript/core";
import type {
  ArtifactActionDefinition,
  ResolvedPkgConfigSdk,
} from "@native-typescript/core";
import {
  girBindingToolFile,
  ingestGir,
  planGirNamespaceAnalysis,
} from "@native-typescript/bindgen-gir";
import type {
  GirNamespaceAnalysis,
  GirNamespaceSelection,
} from "@native-typescript/bindgen-gir";
import { executable, executionPlatform, nativeTarget } from "./artifacts.ts";

/**
 * Test-side conveniences over the library's namespace analysis. The planning
 * itself is `planGirNamespaceAnalysis` — a gate that reimplemented it would be
 * proving something about its own scaffolding rather than about generation.
 */

export const workspace = join(import.meta.dirname, "..", "..");
export const systemGioGir = "/usr/share/gir-1.0/Gio-2.0.gir";
export const systemGtkGir = "/usr/share/gir-1.0/Gtk-4.0.gir";
export const bindingToolPath = join(
  workspace,
  "packages/bindgen-gir/node_modules/.runtime",
  girBindingToolFile,
);

export async function toolIdentity(
  id: string,
  path: string,
): Promise<ArtifactActionDefinition["tool"]> {
  return {
    id,
    version: "test",
    digest: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
  };
}

export async function planNamespaceAnalysis(options: {
  readonly scratch: string;
  readonly suffix: string;
  readonly selections: readonly GirNamespaceSelection[];
  readonly clangTool: ArtifactActionDefinition["tool"];
  readonly nodeTool: ArtifactActionDefinition["tool"];
}): Promise<GirNamespaceAnalysis & { readonly sdk: ResolvedPkgConfigSdk }> {
  const sdk = await resolvePkgConfigSdk({
    id: "gtk4",
    executable: executable("pkg-config"),
    modules: ["gtk4"],
    target: nativeTarget,
  });
  const analysis = await planGirNamespaceAnalysis({
    selections: options.selections,
    sdk,
    scratch: options.scratch,
    suffix: options.suffix,
    generatorPath: bindingToolPath,
    clangTool: options.clangTool,
    nodeTool: options.nodeTool,
    executionPlatform,
    target: nativeTarget,
  });
  return { ...analysis, sdk };
}

/** The Gio lifecycle surface a GTK application drives. */
export function ingestGioApplication(
  methods: readonly string[],
): GirNamespaceSelection["snapshot"] {
  return ingestGir(readFileSync(systemGioGir, "utf8"), {
    logicalPath: "system-sdk/gir/Gio-2.0.gir",
    namespace: { name: "Gio", version: "2.0" },
    classes: [
      // register() takes a GCancellable, so its class is part of the selection.
      { name: "Cancellable", constructors: ["new"] },
      {
        name: "Application",
        constructors: ["new"],
        methods: [...methods],
        signals: ["activate"],
      },
    ],
    enumerations: [
      {
        name: "ApplicationFlags",
        /* non_unique keeps a test application off the session bus, so it never
         * defers to a running instance or waits on a name it cannot own. */
        members: ["default_flags", "is_service", "non_unique"],
      },
    ],
  });
}
