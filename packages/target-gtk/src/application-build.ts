import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineArtifactGraph,
  digestArtifactPath,
  executeArtifactGraph,
  planScriptCExecutable,
  planScriptCProgramEmission,
  resolvePkgConfigSdk,
  resolveSourceArtifact,
} from "@native-typescript/core";
import type {
  ArtifactActionDefinition,
  ArtifactDefinition,
} from "@native-typescript/core";
import { parseScabiManifest } from "@native-typescript/scabi";
import type { ScabiManifest } from "@native-typescript/scabi";
import {
  composeScriptCNativePrograms,
  loadScriptCExecutablePlanners,
  locateScriptCCheckout,
  translateScabiNativeProgram,
} from "@native-typescript/scriptc";
import type { ScriptCNativeTranslationSuccess } from "@native-typescript/scriptc";
import {
  girBindingToolFile,
  ingestGir,
  planGirNamespaceAnalysis,
} from "@native-typescript/bindgen-gir";
import type {
  GObjectAdapterSource,
  GirNamespaceSelection,
} from "@native-typescript/bindgen-gir";
import { planGtkTargetObjects } from "./gtk-target-objects.ts";
import { targetRuntimeArtifactIds } from "./target-runtime-objects.ts";
import { parseGtkApplicationProject } from "./application-project.ts";
import type { GtkApplicationProject } from "./application-project.ts";

/**
 * Builds a GTK application from a project description.
 *
 * Everything an application build needs to know about GTK lives here rather
 * than in whoever is driving the build, so a command line, a test gate, and an
 * editor integration all get the same pipeline instead of three
 * reconstructions of it that can disagree.
 *
 * The build runs in two phases because generation is itself a build: the first
 * graph probes the C ABI with Clang and emits the binding packages, and only
 * once those exist can the second graph compile and link against them.
 */

const targetPackageRoot = fileURLToPath(new URL("../", import.meta.url));

export interface GtkApplicationBuildResult {
  /** Absolute path of the linked executable inside the build root. */
  readonly productPath: string;
  readonly generatedPackages: readonly {
    readonly slug: string;
    readonly path: string;
  }[];
}

export interface GtkApplicationToolPaths {
  readonly clang: string;
  readonly node: string;
  readonly pkgConfig: string;
  readonly sandbox: string;
}

async function toolIdentity(
  id: string,
  path: string,
): Promise<ArtifactActionDefinition["tool"]> {
  const content = await digestArtifactPath(path, "file");
  return Object.freeze({ id, version: content.digest.slice(7, 19), digest: content.digest });
}

async function treeArtifact(options: {
  readonly id: string;
  readonly path: string;
  readonly fileName: string;
  readonly logicalPath: string;
  readonly target: string;
  readonly domain: ArtifactDefinition["domain"];
}): Promise<ArtifactDefinition> {
  const resolved = await resolveSourceArtifact({
    id: options.id,
    path: options.path,
    kind: "source-tree",
    entryType: "directory",
    mediaType: "inode/directory",
    target: options.target,
    domain: options.domain,
    cache: "exportable",
    fileName: options.fileName,
    logicalPath: options.logicalPath,
  });
  return resolved.artifact;
}

interface GeneratedPackageContent {
  readonly slug: string;
  readonly path: string;
  readonly declarationsPath: string;
  readonly adapterPath: string;
  readonly adapter: GObjectAdapterSource;
  readonly manifest: ScabiManifest;
}

export async function buildGtkApplication(input: {
  readonly projectRoot: string;
  readonly project: GtkApplicationProject;
  /** Where intermediate descriptions and both build roots are written. */
  readonly scratch: string;
  readonly backend: "c" | "llvm";
  readonly tools: GtkApplicationToolPaths;
  /** Optional content-addressed action cache shared across builds. */
  readonly cachePath?: string;
  readonly maxConcurrency?: number;
}): Promise<GtkApplicationBuildResult> {
  const { project } = input;
  // The build writes descriptions and probes here before any graph runs.
  mkdirSync(input.scratch, { recursive: true });
  const target = project.target.triple;
  const executionPlatform = project.target.executionPlatform;
  const clangTool = await toolIdentity("tool/clang", input.tools.clang);
  const nodeTool = await toolIdentity("tool/node", input.tools.node);
  const tools = {
    [clangTool.id]: { path: input.tools.clang },
    [nodeTool.id]: { path: input.tools.node },
  };
  const sandbox = { kind: "bubblewrap" as const, path: input.tools.sandbox };
  const cache =
    input.cachePath === undefined
      ? undefined
      : { kind: "local" as const, path: input.cachePath };

  const sdk = await resolvePkgConfigSdk({
    id: "gtk4",
    executable: input.tools.pkgConfig,
    modules: [...project.sdkModules],
    target,
  });

  // Phase one: probe the C ABI and generate one binding package per namespace.
  const ingested = new Map<string, GirNamespaceSelection["snapshot"]>();
  const selections: GirNamespaceSelection[] = [];
  for (const namespace of project.namespaces) {
    const girPath = join(
      project.girDirectory,
      `${namespace.name}-${namespace.version}.gir`,
    );
    const snapshot = ingestGir(readFileSync(girPath, "utf8"), {
      logicalPath: `system-sdk/gir/${namespace.name}-${namespace.version}.gir`,
      namespace: { name: namespace.name, version: namespace.version },
      classes: namespace.classes,
      records: namespace.records,
      enumerations: namespace.enumerations,
    });
    const key = `${namespace.name}-${namespace.version}`;
    ingested.set(key, snapshot);
    selections.push({
      snapshot,
      imports: namespace.imports.map((imported) => {
        const resolved = ingested.get(
          `${imported.name}-${imported.version}`,
        );
        if (resolved === undefined) {
          throw new Error(
            `Namespace ${key} imports ${imported.name}-${imported.version}, ` +
              "which is not selected before it",
          );
        }
        return resolved;
      }),
      sdkModules: namespace.sdkModules,
    });
  }

  const analysis = await planGirNamespaceAnalysis({
    selections,
    sdk,
    scratch: input.scratch,
    generatorPath: join(
      targetPackageRoot,
      "../bindgen-gir/node_modules/.runtime",
      girBindingToolFile,
    ),
    clangTool,
    nodeTool,
    executionPlatform,
    target,
  });
  const analysisReport = await executeArtifactGraph(analysis.graph, {
    buildRoot: join(input.scratch, "generate"),
    sourcePaths: analysis.sourcePaths,
    tools,
    sandbox,
    ...(cache === undefined ? {} : { cache }),
  });

  const generated: GeneratedPackageContent[] = analysis.packages.map(
    ({ slug, bindingsArtifactId }) => {
      const artifact = analysisReport.artifacts.find(
        ({ id }) => id === bindingsArtifactId,
      );
      if (artifact === undefined) {
        throw new Error(`Generation produced no package for namespace ${slug}`);
      }
      return {
        slug,
        path: artifact.path,
        declarationsPath: join(artifact.path, "package.d.ts"),
        adapterPath: join(artifact.path, "gobject-adapters.c"),
        adapter: JSON.parse(
          readFileSync(join(artifact.path, "gobject-adapter.json"), "utf8"),
        ) as GObjectAdapterSource,
        manifest: parseScabiManifest(
          readFileSync(join(artifact.path, "package.scabi.json"), "utf8"),
        ),
      };
    },
  );

  /* The target's own bootstrap is a binding package like any other: an
   * application reaches gtk_init and the owner runtime through SCABI rather
   * than through anything privileged. */
  const bootstrapRoot = join(targetPackageRoot, "application");
  const bootstrapManifest = parseScabiManifest(
    readFileSync(join(bootstrapRoot, "package.scabi.json"), "utf8"),
  );

  const translations: ScriptCNativeTranslationSuccess[] = [];
  for (const manifest of [bootstrapManifest, ...generated.map((entry) => entry.manifest)]) {
    const translated = translateScabiNativeProgram(manifest, {
      imports: Object.keys(manifest.bindings),
      exports: [],
    });
    if (!translated.ok) {
      throw new Error(
        `Native translation of ${manifest.package.name} failed:\n` +
          translated.diagnostics
            .map(({ code, path, message }) => `  ${code} ${path}: ${message}`)
            .join("\n"),
      );
    }
    translations.push(translated);
  }
  const [firstTranslation, ...restTranslations] = translations;
  if (firstTranslation === undefined) {
    throw new Error("A GTK application must compose at least one package");
  }
  const composed = composeScriptCNativePrograms([
    firstTranslation,
    ...restTranslations,
  ]);
  if (!composed.ok) {
    throw new Error(
      "Native package composition failed:\n" +
        composed.diagnostics
          .map(({ code, path, message }) => `  ${code} ${path}: ${message}`)
          .join("\n"),
    );
  }

  // Phase two: compile the target's objects and the program, then link.
  const runtimePath = join(targetPackageRoot, "runtime");
  const runtimeContent = await digestArtifactPath(runtimePath, "directory");
  const targetObjects = planGtkTargetObjects({
    adapters: generated.map(({ slug, adapter }) => ({ slug, adapter })),
    targetRuntimeSourceTreeDigest: runtimeContent.digest,
    scriptcRuntimeHeaders: { artifact: "headers/scriptc/runtime" },
    sdkArguments: sdk.compileArguments,
    tool: clangTool,
    executionPlatform,
    target,
  });

  const checkout = locateScriptCCheckout();
  const scriptcRuntimeRoot = join(checkout.path, "packages/runtime");
  const scriptcRuntimeInclude = join(scriptcRuntimeRoot, "src");
  const compilerDistribution = join(checkout.path, "packages/compiler/dist");
  const runtimeArtifacts = await Promise.all([
    treeArtifact({
      id: "runtime/scriptc",
      path: scriptcRuntimeRoot,
      fileName: "scriptc-runtime",
      logicalPath: "third_party/scriptc/packages/runtime",
      target,
      domain: "target",
    }),
    treeArtifact({
      id: "headers/scriptc/runtime",
      path: scriptcRuntimeInclude,
      fileName: "scriptc-runtime-headers",
      logicalPath: "third_party/scriptc/packages/runtime/src",
      target,
      domain: "target",
    }),
    treeArtifact({
      id: "tool-input/scriptc/emitter",
      path: compilerDistribution,
      fileName: "scriptc-emitter",
      logicalPath: "third_party/scriptc/packages/compiler/dist",
      target: executionPlatform,
      domain: "host",
    }),
  ]);
  const [scriptcRuntime, scriptcHeaders, compilerEmitter] = runtimeArtifacts;
  if (
    scriptcRuntime === undefined ||
    scriptcHeaders === undefined ||
    compilerEmitter === undefined
  ) {
    throw new Error("The ScriptC runtime could not be resolved as artifacts");
  }

  const { planExecutableCompilation, planExecutableExternalCBuild } =
    await loadScriptCExecutablePlanners();
  const externalTypes: Record<string, string> = {
    [bootstrapManifest.package.name]: join(bootstrapRoot, "package.d.ts"),
  };
  for (const entry of generated) {
    externalTypes[entry.manifest.package.name] = entry.declarationsPath;
  }
  const linkInputs = [
    targetObjects.runtime.object.id,
    targetObjects.application.object.id,
    ...targetObjects.adapters.map(({ plan }) => plan.object.id),
  ];
  const planned = planExecutableCompilation(
    join(input.projectRoot, project.entry),
    {
      backend: input.backend,
      sourceRoot: input.projectRoot,
      externalTypes,
      native: composed.input,
      nativeLinkInputs: linkInputs,
      nativeSystemLibraries: composed.build.linkInputs
        .filter(({ kind }) => kind === "system-library")
        .toSorted((left, right) => left.order - right.order)
        .map(({ name }) => name),
    },
  );
  if (!planned.ok) {
    throw new Error(
      `Compiling ${project.entry} failed:\n` +
        planned.diagnostics.map(({ message }) => `  ${message}`).join("\n"),
    );
  }

  const programId = `generated/scriptc/${input.backend}/program`;
  const outputId = `product/${project.name}/${input.backend}`;
  const planId = `metadata/scriptc/${input.backend}/compilation-plan`;
  const planPath = join(input.scratch, `${input.backend}-compilation-plan.json`);
  writeFileSync(planPath, JSON.stringify(planned.plan));
  const planResolution = await resolveSourceArtifact({
    id: planId,
    path: planPath,
    kind: "metadata",
    entryType: "file",
    mediaType: "application/vnd.scriptc.executable-compilation-plan+json",
    target: executionPlatform,
    domain: "host",
    cache: "exportable",
    fileName: "compilation-plan.json",
    logicalPath: `generated/scriptc/${input.backend}/compilation-plan.json`,
  });
  const emissionPlan = planScriptCProgramEmission({
    actionId: `emit/scriptc-program/${input.backend}`,
    plan: planned.plan,
    planArtifact: planId,
    compilerArtifact: compilerEmitter.id,
    artifactId: programId,
    artifactFileName: input.backend === "llvm" ? "program.ll" : "program.c",
    tool: nodeTool,
    executionPlatform,
    targetPlatform: "linux",
    target,
  });
  const externalResult = await planExecutableExternalCBuild(planned.plan, {
    program: programId,
    runtime: scriptcRuntime.id,
    linkInputs,
    output: outputId,
  });
  const executablePlan = planScriptCExecutable({
    actionId: `link/scriptc-executable/${input.backend}`,
    plan: externalResult.plan,
    artifactFileName: project.output,
    tool: clangTool,
    driverPlatform: "linux",
    executionPlatform,
    target,
  });

  const graph = defineArtifactGraph({
    artifacts: [
      ...sdk.artifacts,
      ...runtimeArtifacts,
      planResolution.artifact,
      ...targetObjects.artifacts,
      emissionPlan.artifact,
      executablePlan.artifact,
    ],
    actions: [
      emissionPlan.action,
      ...targetObjects.actions,
      executablePlan.action,
    ],
  });
  const report = await executeArtifactGraph(graph, {
    buildRoot: join(input.scratch, `link-${input.backend}`),
    sourcePaths: {
      ...sdk.sourcePaths,
      [targetRuntimeArtifactIds.sourceTree]: runtimePath,
      [scriptcRuntime.id]: scriptcRuntimeRoot,
      [scriptcHeaders.id]: scriptcRuntimeInclude,
      [compilerEmitter.id]: compilerDistribution,
      [planId]: planPath,
      ...Object.fromEntries(
        targetObjects.adapters.map(({ slug, plan }) => {
          const entry = generated.find((candidate) => candidate.slug === slug);
          if (entry === undefined) {
            throw new Error(`No generated adapter source for ${slug}`);
          }
          return [plan.source.id, entry.adapterPath];
        }),
      ),
    },
    tools,
    sandbox,
    ...(cache === undefined ? {} : { cache }),
    maxConcurrency: input.maxConcurrency ?? 2,
  });
  const product = report.artifacts.find(({ id }) => id === outputId);
  if (product === undefined) {
    throw new Error(`The build produced no executable for ${project.name}`);
  }
  return Object.freeze({
    productPath: product.path,
    generatedPackages: Object.freeze(
      generated.map(({ slug, path }) => Object.freeze({ slug, path })),
    ),
  });
}

export { parseGtkApplicationProject };
export type { GtkApplicationProject };
