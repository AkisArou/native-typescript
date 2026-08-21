import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineArtifactGraph,
  digestArtifactPath,
  executeArtifactGraph,
  nativeRuntimeServices,
  planScriptCExecutable,
  planScriptCLibraryEmission,
  planScriptCProgramEmission,
  planScriptCRuntimeObject,
  resolveSourceArtifact,
} from "@native-typescript/core";
import type {
  ArtifactActionDefinition,
  ArtifactDefinition,
} from "@native-typescript/core";
import {
  parseClangAbiEvidence,
  planClangAbiProbe,
} from "@native-typescript/bindgen-c";
import { parseScabiManifest } from "@native-typescript/scabi";
import {
  composeScriptCNativePrograms,
  loadScriptCExecutablePlanners,
  loadScriptCLibraryPlanners,
  locateScriptCCheckout,
  translateScabiNativeProgram,
} from "@native-typescript/scriptc";
import type { ScriptCNativeTranslationSuccess } from "@native-typescript/scriptc";
import {
  generateJvmAdapterSource,
  generateJvmClangAbiProbe,
  generateJvmScabiPackage,
  generateJvmSubclassSource,
  ingestJvmClasses,
} from "@native-typescript/bindgen-jvm";
import type {
  JvmClassSelection,
  JvmSubclassSelection,
} from "@native-typescript/bindgen-jvm";
import { jvmRuntimeProvider } from "./provider.ts";
import { resolveAndroidNativeSdk, resolveJdkSdk } from "./jdk-sdk.ts";
import { planJavacClasses } from "./javac-classes.ts";
import { planJvmTargetObjects } from "./jvm-target-objects.ts";
import { targetRuntimeArtifactIds } from "./target-runtime-objects.ts";

/**
 * Builds a JVM application from a project description: everything the build
 * needs to know about the JVM target lives here, so a test gate and a
 * future command line share one pipeline.
 *
 * Two phases, like the GTK build: the first executes the Clang ABI probe
 * against the real jni.h and generates the binding package; the second
 * compiles and links against it.
 */

const targetPackageRoot = fileURLToPath(new URL("../", import.meta.url));

export interface JvmApplicationProject {
  readonly name: string;
  /** Entry TypeScript file, relative to the project root. */
  readonly entry: string;
  readonly output: string;
  readonly packageSlug: string;
  /** Prebuilt class files to ingest, when the project ships them. */
  readonly classSources?: readonly {
    readonly logicalPath: string;
    readonly path: string;
  }[];
  /** Java sources the build compiles with the JDK's own javac, as a
   * planned action; the produced classes are what ingestion reads and what
   * the runner should put on NT_JVM_CLASSPATH. */
  readonly javaSources?: {
    readonly root: string;
    readonly logicalPath: string;
    readonly files: readonly string[];
  };
  readonly classes: readonly JvmClassSelection[];
  /** Generated Java subclasses: a base among the compiled classes plus the
   * overridable methods TypeScript implements. Each produces a generated
   * source, a second javac action compiled against the primary classes,
   * and a `callbacks:` selection on the compiled subclass. */
  readonly subclasses?: readonly JvmSubclassSelection[];
  readonly target: {
    readonly triple: string;
    readonly executionPlatform: string;
  };
  readonly sdk: {
    readonly vendor: string;
    readonly name: string;
    readonly version: string;
    readonly deploymentTarget: string;
  };
}

export interface JvmApplicationToolPaths {
  readonly clang: string;
  readonly node: string;
  readonly sandbox: string;
  /** The archiver, required for the hosted-library product. */
  readonly ar?: string;
}

export interface JvmApplicationBuildResult {
  readonly productPath: string;
  /** Where the planned javac action left the classes, when the project
   * built from Java sources; the runner's NT_JVM_CLASSPATH. */
  readonly builtClassesPath?: string;
  /** Where the subclass compilation left ITS classes; joins the runner's
   * NT_JVM_CLASSPATH beside the primary directory. */
  readonly builtSubclassesPath?: string;
  /** Directory holding the generated package: adapter C, header,
   * declarations, and manifest. */
  readonly generatedPackagePath: string;
  /** What the runner must put on LD_LIBRARY_PATH so the linked soname
   * resolves — a runtime input, like the classpath. Null on adoption-only
   * platforms: Android's loader takes the .so out of the APK. */
  readonly jvmLibraryPath: string | null;
}

async function toolIdentity(
  id: string,
  path: string,
): Promise<ArtifactActionDefinition["tool"]> {
  const content = await digestArtifactPath(path, "file");
  return Object.freeze({
    id,
    version: content.digest.slice(7, 19),
    digest: content.digest,
  });
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

export async function buildJvmApplication(input: {
  readonly projectRoot: string;
  readonly project: JvmApplicationProject;
  readonly scratch: string;
  readonly backend: "c" | "llvm";
  /** What to produce: a standalone executable that CREATES a JVM, or a
   * hosted shared library a JVM loads and this runtime ADOPTS. */
  readonly product?: "executable" | "hosted-library";
  readonly javaHome: string;
  readonly tools: JvmApplicationToolPaths;
  readonly cachePath?: string;
  readonly maxConcurrency?: number;
}): Promise<JvmApplicationBuildResult> {
  const { project } = input;
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
  /* The triple is the platform fact: an Android target's jni.h lives in
   * the NDK toolchain's own sysroot (the clang tool the caller passes IS
   * the NDK wrapper), and no libjvm exists there to create — so the only
   * product is the adopted library, refused here by name rather than at
   * a link three stages later. javaHome stays the HOST JDK: javac is
   * execution-platform tooling either way. */
  const androidTarget = /-linux-android\d+$/u.test(target);
  if (androidTarget && input.product !== "hosted-library") {
    throw new Error(
      `Target '${target}' has no executable product: Android has no libjvm ` +
        "to create, and a library there is adopted by the process that " +
        "loads it — build with product: 'hosted-library'",
    );
  }
  const sdk = androidTarget
    ? resolveAndroidNativeSdk()
    : await resolveJdkSdk({ javaHome: input.javaHome, target });

  /* Phase zero, when the project ships Java sources rather than classes:
   * javac runs as a planned action, and everything downstream reads what
   * it produced. Generation is itself a build. */
  let classSources = project.classSources ?? [];
  let builtClassesPath: string | undefined;
  if (project.javaSources !== undefined) {
    const javacTool = await toolIdentity(
      "tool/javac",
      join(input.javaHome, "bin/javac"),
    );
    const sourcesDigest = await digestArtifactPath(
      project.javaSources.root,
      "directory",
    );
    const javac = planJavacClasses({
      sourcesDigest: sourcesDigest.digest,
      files: project.javaSources.files,
      logicalPath: project.javaSources.logicalPath,
      tool: javacTool,
      executionPlatform,
      target,
    });
    const javacReport = await executeArtifactGraph(
      defineArtifactGraph({
        artifacts: [javac.sources, javac.classes],
        actions: [javac.action],
      }),
      {
        buildRoot: join(input.scratch, "javac"),
        sourcePaths: { [javac.sources.id]: project.javaSources.root },
        tools: { ...tools, [javacTool.id]: { path: join(input.javaHome, "bin/javac") } },
        sandbox,
        ...(cache === undefined ? {} : { cache }),
      },
    );
    const produced = javacReport.artifacts.find(
      ({ id }) => id === javac.classes.id,
    );
    if (produced === undefined) {
      throw new Error("javac produced no class directory");
    }
    builtClassesPath = produced.path;
    function walkClasses(root: string, prefix: string): {
      readonly logicalPath: string;
      readonly path: string;
    }[] {
      return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(
        (entry) => {
          const relative = prefix.length === 0
            ? entry.name
            : `${prefix}/${entry.name}`;
          if (entry.isDirectory()) return walkClasses(root, relative);
          if (!entry.name.endsWith(".class")) return [];
          return [{
            logicalPath: `generated/jvm-java-classes/${relative}`,
            path: join(root, relative),
          }];
        },
      );
    }
    classSources = walkClasses(produced.path, "");
  }

  /* Phase 0b: generated subclasses. Generation reads the BASE from the
   * classes phase 0 produced, emits Java source, and a second javac action
   * compiles it against those same classes — generation is itself a build,
   * twice over. The compiled subclass joins ingestion and the runner's
   * classpath beside the primary directory. */
  let builtSubclassesPath: string | undefined;
  const subclassSelections: JvmClassSelection[] = [];
  if (project.subclasses !== undefined && project.subclasses.length > 0) {
    if (builtClassesPath === undefined) {
      throw new Error(
        "Generated subclasses need javaSources: the base compiles first " +
          "and the subclass compiles against it",
      );
    }
    const javacTool = await toolIdentity(
      "tool/javac",
      join(input.javaHome, "bin/javac"),
    );
    const generatedSourcesRoot = join(input.scratch, "subclass-sources");
    const generatedFiles: string[] = [];
    for (const specification of project.subclasses) {
      const baseSource = classSources.find(({ logicalPath }) =>
        logicalPath.endsWith(`/${specification.baseBinaryName}.class`)
      );
      if (baseSource === undefined) {
        throw new Error(
          `Subclass base '${specification.baseBinaryName}' is not among ` +
            "the compiled classes",
        );
      }
      const baseSnapshot = ingestJvmClasses(
        [{
          logicalPath: baseSource.logicalPath,
          bytes: readFileSync(baseSource.path),
        }],
        {
          classes: [{
            binaryName: specification.baseBinaryName,
            constructors: ["()V"],
            methods: specification.overrides,
          }],
        },
      );
      const generated = generateJvmSubclassSource(baseSnapshot, specification);
      const sourcePath = join(generatedSourcesRoot, generated.logicalPath);
      mkdirSync(dirname(sourcePath), { recursive: true });
      writeFileSync(sourcePath, generated.source);
      generatedFiles.push(generated.logicalPath);
      subclassSelections.push({
        binaryName: generated.subclassBinaryName,
        constructors: ["()V"],
        methods: generated.methods,
        callbacks: generated.callbacks,
      });
    }
    const classpathDigest = await digestArtifactPath(
      builtClassesPath,
      "directory",
    );
    const classpathArtifact: ArtifactDefinition = Object.freeze({
      id: "generated/jvm-java-classes",
      kind: "source-tree",
      entryType: "directory",
      mediaType: "inode/directory",
      target,
      domain: "target",
      cache: "exportable",
      origin: Object.freeze({
        kind: "source",
        digest: classpathDigest.digest,
        fileName: "jvm-java-classes",
        logicalPath: "generated/jvm-java-classes",
      }),
    });
    const generatedDigest = await digestArtifactPath(
      generatedSourcesRoot,
      "directory",
    );
    const subclassJavac = planJavacClasses({
      sourcesDigest: generatedDigest.digest,
      files: generatedFiles,
      logicalPath: "generated/jvm-subclass-sources",
      tool: javacTool,
      executionPlatform,
      target,
      variant: "-subclasses",
      classpath: { artifact: classpathArtifact.id },
    });
    const subclassReport = await executeArtifactGraph(
      defineArtifactGraph({
        artifacts: [
          subclassJavac.sources,
          classpathArtifact,
          subclassJavac.classes,
        ],
        actions: [subclassJavac.action],
      }),
      {
        buildRoot: join(input.scratch, "javac-subclasses"),
        sourcePaths: {
          [subclassJavac.sources.id]: generatedSourcesRoot,
          [classpathArtifact.id]: builtClassesPath,
        },
        tools: {
          ...tools,
          [javacTool.id]: { path: join(input.javaHome, "bin/javac") },
        },
        sandbox,
        ...(cache === undefined ? {} : { cache }),
      },
    );
    const producedSubclasses = subclassReport.artifacts.find(
      ({ id }) => id === subclassJavac.classes.id,
    );
    if (producedSubclasses === undefined) {
      throw new Error("subclass javac produced no class directory");
    }
    builtSubclassesPath = producedSubclasses.path;
    classSources = [
      ...classSources,
      ...readdirSync(producedSubclasses.path, {
        recursive: true,
        withFileTypes: true,
      })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".class"))
        .map((entry) => {
          const relative = join(entry.parentPath, entry.name)
            .slice(producedSubclasses.path.length + 1);
          return {
            logicalPath: `generated/jvm-subclass-classes/${relative}`,
            path: join(producedSubclasses.path, relative),
          };
        }),
    ];
  }

  // Phase one: ingest, generate, and prove the adapter ABI against jni.h.
  const snapshot = ingestJvmClasses(
    classSources.map(({ logicalPath, path }) => ({
      logicalPath,
      bytes: readFileSync(path),
    })),
    { classes: [...project.classes, ...subclassSelections] },
  );
  const slug = project.packageSlug;
  const adapter = generateJvmAdapterSource(snapshot, { packageSlug: slug });
  const probe = generateJvmClangAbiProbe(adapter);

  const generatedRoot = join(input.scratch, "generated", slug);
  mkdirSync(generatedRoot, { recursive: true });
  const adapterPath = join(generatedRoot, "jvm-adapters.c");
  writeFileSync(adapterPath, adapter.source);
  writeFileSync(join(generatedRoot, adapter.headerFileName), adapter.header);
  const probePath = join(input.scratch, "probe.c");
  writeFileSync(probePath, probe.source);

  const adapterIncludeDigest = await digestArtifactPath(generatedRoot, "directory");
  const adapterInclude: ArtifactDefinition = Object.freeze({
    id: "sdk/jvm-adapter-include",
    kind: "sdk",
    entryType: "directory",
    mediaType: "inode/directory",
    target,
    domain: "target",
    cache: "none",
    origin: Object.freeze({
      kind: "source",
      digest: adapterIncludeDigest.digest,
      fileName: "jvm-adapter-include",
      logicalPath: `generated/${slug}`,
    }),
  });
  const probePlan = planClangAbiProbe({
    probe,
    sourceArtifactId: "source/jvm-clang/probe",
    rawAstArtifactId: "metadata/jvm-clang/raw-ast",
    rawLlvmArtifactId: "metadata/jvm-clang/raw-llvm",
    astActionId: "inspect/jvm-clang/ast",
    llvmActionId: "inspect/jvm-clang/calling-convention",
    logicalPath: `generated/${slug}/abi-probe.c`,
    arguments: [...sdk.compileArguments, {
      kind: "literal",
      value: "-I",
    }, { kind: "input-path", artifact: adapterInclude.id }],
    tool: clangTool,
    executionPlatform,
    target,
  });
  const probeReport = await executeArtifactGraph(
    defineArtifactGraph({
      artifacts: [
        probePlan.source,
        ...sdk.artifacts,
        adapterInclude,
        probePlan.rawAst,
        probePlan.rawLlvm,
      ],
      actions: [probePlan.astAction, probePlan.llvmAction],
    }),
    {
      buildRoot: join(input.scratch, "probe"),
      sourcePaths: {
        [probePlan.source.id]: probePath,
        ...sdk.sourcePaths,
        [adapterInclude.id]: generatedRoot,
      },
      tools,
      sandbox,
      ...(cache === undefined ? {} : { cache }),
    },
  );
  const rawAst = probeReport.artifacts.find(({ id }) => id === probePlan.rawAst.id);
  const rawLlvm = probeReport.artifacts.find(({ id }) => id === probePlan.rawLlvm.id);
  if (rawAst === undefined || rawLlvm === undefined) {
    throw new Error("The JVM ABI probe produced no evidence");
  }
  const evidence = parseClangAbiEvidence(
    readFileSync(rawAst.path, "utf8"),
    readFileSync(rawLlvm.path, "utf8"),
    {
      probe,
      clang: {
        toolId: clangTool.id,
        version: clangTool.version,
        digest: clangTool.digest,
        target,
      },
    },
  );

  const generated = generateJvmScabiPackage({
    snapshot,
    adapter,
    packageSlug: slug,
    evidence,
    package: {
      name: `@native-typescript/jvm-${slug}`,
      version: "0.0.0",
      namespace: `native-typescript.jvm.${slug}`,
      instance: `native-typescript.jvm.${slug}@0.0.0`,
    },
    target: {
      triple: target,
      architecture: "x86_64",
      pointerWidth: 64,
      endianness: "little",
      objectFormat: "elf",
      minimumPlatformVersion: "glibc-2.17",
      abi: "sysv-amd64",
      features: ["jvm"],
    },
    sdk: { ...project.sdk, modules: [slug] },
    /* The runtime component row matches the bootstrap's exactly so the two
     * packages merge on it. libjvm itself enters the link as an artifact
     * the build supplies, never as a manifest input. */
    linkInputs: [
      {
        id: "jvm-application-runtime",
        kind: "runtime-component",
        name: "jvm-application-runtime",
        order: 0,
      },
    ],
    adapterInput: { id: `${slug}.jvm-adapters`, output: "jvm-adapters.o" },
  });
  writeFileSync(join(generatedRoot, "package.scabi.json"), generated.manifestSource);
  writeFileSync(join(generatedRoot, "package.d.ts"), generated.declarations);

  /* The target's own bootstrap is a binding package like any other. */
  const bootstrapRoot = join(targetPackageRoot, "application");
  const bootstrapManifest = parseScabiManifest(
    readFileSync(join(bootstrapRoot, "package.scabi.json"), "utf8"),
  );

  const translations: ScriptCNativeTranslationSuccess[] = [];
  for (const manifest of [bootstrapManifest, generated.manifest]) {
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
  const [bootstrapTranslation, generatedTranslation] = translations;
  const composed = composeScriptCNativePrograms([
    bootstrapTranslation!,
    generatedTranslation!,
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
  const targetObjects = planJvmTargetObjects({
    adapters: [{ slug, adapter }],
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
    [generated.manifest.package.name]: join(generatedRoot, "package.d.ts"),
  };
  /* libjvm is a positional link input: the linker takes the resolved .so
   * path directly, and the runner supplies the soname's directory. Absent
   * on adoption-only platforms, whose only product never links it. */
  const linkInputs = [
    targetObjects.runtime.object.id,
    ...targetObjects.adapters.map(({ plan }) => plan.object.id),
    ...(sdk.libjvmArtifactId === null ? [] : [sdk.libjvmArtifactId]),
  ];

  if (input.product === "hosted-library") {
    /* ── the hosted product ──────────────────────────────────────────────
     * The compiler's product is a PIC static archive (a stated property of
     * the plan, not a flag checked here); packaging it for a host platform
     * is target business. The profile is written by the target because the
     * target names the boot contract: init_symbol is the weak entry the
     * runtime's owner thread calls, per the library rule that the calling
     * thread IS the instance selector. */
    const profilePath = join(input.scratch, "hosted-profile.json");
    writeFileSync(
      profilePath,
      JSON.stringify(
        {
          profile_format: 1,
          name: project.name,
          entry: join(input.projectRoot, project.entry),
          emission: input.backend,
          abi: {
            prefix: "nts_jvm_hosted_",
            init_symbol: "nts_jvm_hosted_init",
            sink_register_symbol: "nts_jvm_hosted_set_panic_sink",
            collect_symbol: null,
            result_reset_symbol: null,
          },
          exports: [],
        },
        null,
        2,
      ),
    );
    const { planLibraryCompilation, planLibraryExternalCBuild } =
      await loadScriptCLibraryPlanners();
    const libraryPlanned = await planLibraryCompilation({
      profilePath,
      externalTypes,
      native: composed.input,
      /* The owner runtime calls services the program never mentions, so
       * the archive carries them on the target's say-so: the provider
       * requires what it also provides, and the capability mapping turns
       * that into ["attached-loop", "retained-callbacks"] here — free
       * where the loop is already main, load-bearing where the embedder
       * pumps. */
      nativeRuntimeRequires: nativeRuntimeServices([jvmRuntimeProvider]),
    });
    if (!libraryPlanned.ok) {
      throw new Error(
        `Compiling ${project.entry} as a library failed:\n` +
          libraryPlanned.diagnostics
            .map(({ message }) => `  ${message}`)
            .join("\n"),
      );
    }

    /* Emission is a graph action, exactly as the executable path does it:
     * the plan enters as a metadata artifact and library-emitter-cli
     * materializes the program inside the sandbox. */
    const programFileName = input.backend === "llvm"
      ? "program.ll"
      : "program.c";
    const programId = `generated/scriptc/${input.backend}/library-program`;
    const libraryPlanId =
      `metadata/scriptc/${input.backend}/library-compilation-plan`;
    const libraryPlanPath = join(
      input.scratch,
      `${input.backend}-library-compilation-plan.json`,
    );
    writeFileSync(libraryPlanPath, JSON.stringify(libraryPlanned.plan));
    const libraryPlanResolution = await resolveSourceArtifact({
      id: libraryPlanId,
      path: libraryPlanPath,
      kind: "metadata",
      entryType: "file",
      mediaType: "application/vnd.scriptc.library-compilation-plan+json",
      target: executionPlatform,
      domain: "host",
      cache: "exportable",
      fileName: "library-compilation-plan.json",
      logicalPath:
        `generated/scriptc/${input.backend}/library-compilation-plan.json`,
    });
    const libraryEmission = planScriptCLibraryEmission({
      actionId: `emit/scriptc-library/${input.backend}`,
      plan: libraryPlanned.plan,
      planArtifact: libraryPlanId,
      compilerArtifact: compilerEmitter.id,
      artifactId: programId,
      artifactFileName: programFileName,
      tool: nodeTool,
      executionPlatform,
      targetPlatform: "linux",
      target,
    });

    const archiveId = `generated/scriptc/${input.backend}/library-archive`;
    const external = await planLibraryExternalCBuild(libraryPlanned.plan, {
      program: programId,
      runtime: scriptcRuntime.id,
      output: archiveId,
      objectIdPrefix: "object/scriptc-library/",
    });
    const archivePlan = external.plans.at(-1);
    if (archivePlan === undefined) {
      throw new Error("ScriptC produced no archive command for the library");
    }
    const objectPlans = external.plans.slice(0, -1).map((plan, index) =>
      planScriptCRuntimeObject({
        actionId: `compile/scriptc-library/${external.objects[index]!.fileName}`,
        plan,
        artifactFileName: external.objects[index]!.fileName,
        tool: clangTool,
        driverPlatform: "linux",
        executionPlatform,
        target,
      })
    );
    const arTool = await toolIdentity(
      "tool/ar",
      input.tools.ar ?? "/usr/bin/ar",
    );
    if (arTool.id !== `tool/${archivePlan.driver.command}`) {
      throw new Error(
        `ScriptC archives with ${archivePlan.driver.command}, not ar`,
      );
    }
    const archiveArguments = archivePlan.arguments.map((argument) => {
      if (argument.kind === "literal") {
        return { kind: "literal" as const, value: argument.value };
      }
      if (argument.kind === "output-path") {
        return { kind: "output-path" as const, artifact: argument.output };
      }
      return argument.path === undefined
        ? { kind: "input-path" as const, artifact: argument.input }
        : {
            kind: "input-path" as const,
            artifact: argument.input,
            path: argument.path,
          };
    });
    const archiveArtifact: ArtifactDefinition = Object.freeze({
      id: archiveId,
      kind: "native-object",
      entryType: "file",
      mediaType: "application/x-archive",
      target,
      domain: "target",
      cache: "exportable",
      origin: Object.freeze({
        kind: "action",
        action: `archive/scriptc-library/${input.backend}`,
        fileName: "program.lib.a",
      }),
    });
    const archiveAction: ArtifactActionDefinition = Object.freeze({
      id: `archive/scriptc-library/${input.backend}`,
      implementation: Object.freeze({
        id: "native-typescript/scriptc-library-archive",
        version: "1",
      }),
      tool: Object.freeze({ ...arTool }),
      arguments: Object.freeze(archiveArguments),
      environment: Object.freeze([]),
      inputs: Object.freeze([
        ...new Set(
          archivePlan.arguments.flatMap((argument) =>
            argument.kind === "input-path" ? [argument.input] : []
          ),
        ),
      ]),
      outputs: Object.freeze([archiveId]),
      standardOutput: Object.freeze({ kind: "report" as const }),
      workingDirectory: "isolated" as const,
      network: "denied" as const,
      executionPlatform,
      target,
      deterministic: true,
      cacheable: true,
    });

    /* The .so link is the target's, and the adapter and runtime objects
     * stay DIRECT positional inputs rather than archive members: archive
     * semantics drop unreferenced members, and the adapters' whole
     * registration story rides constructors nothing references. libjvm is
     * deliberately absent — the host process already holds it, and the
     * loader resolves the undefined JNI symbols from it. */
    const soId = `product/${project.name}-hosted/${input.backend}`;
    const soFileName = `lib${project.output}.so`;
    const soArtifact: ArtifactDefinition = Object.freeze({
      id: soId,
      kind: "native-object",
      entryType: "file",
      mediaType: "application/x-sharedlib",
      target,
      domain: "target",
      cache: "none",
      origin: Object.freeze({
        kind: "action",
        action: `link/jvm-hosted-library/${input.backend}`,
        fileName: soFileName,
      }),
    });
    const soAction: ArtifactActionDefinition = Object.freeze({
      id: `link/jvm-hosted-library/${input.backend}`,
      implementation: Object.freeze({
        id: "native-typescript/jvm-hosted-library-link",
        version: "1",
      }),
      tool: Object.freeze({ ...clangTool }),
      arguments: Object.freeze([
        Object.freeze({ kind: "literal" as const, value: "-shared" }),
        /* 16KB max-page-size UNCONDITIONALLY: Android 15+ devices ship
         * 16K pages and their loader refuses a 4K-aligned .so; on 4K
         * platforms the wider alignment costs bytes, not correctness —
         * one link spelling, the same reasoning that made PIC
         * unconditional. */
        Object.freeze({
          kind: "literal" as const,
          value: "-Wl,-z,max-page-size=16384",
        }),
        Object.freeze({ kind: "literal" as const, value: "-o" }),
        Object.freeze({ kind: "output-path" as const, artifact: soId }),
        Object.freeze({
          kind: "input-path" as const,
          artifact: targetObjects.runtime.object.id,
        }),
        ...targetObjects.adapters.map(({ plan }) =>
          Object.freeze({
            kind: "input-path" as const,
            artifact: plan.object.id,
          })
        ),
        Object.freeze({ kind: "input-path" as const, artifact: archiveId }),
      ]),
      environment: Object.freeze([]),
      inputs: Object.freeze([
        targetObjects.runtime.object.id,
        ...targetObjects.adapters.map(({ plan }) => plan.object.id),
        archiveId,
      ]),
      outputs: Object.freeze([soId]),
      standardOutput: Object.freeze({ kind: "report" as const }),
      workingDirectory: "isolated" as const,
      network: "denied" as const,
      executionPlatform,
      target,
      deterministic: true,
      /* A product is not cached, so its link may not claim to be — the
       * same pairing the executable link states. */
      cacheable: false,
    });

    const hostedGraph = defineArtifactGraph({
      artifacts: [
        ...sdk.artifacts,
        /* Only what this graph uses: the emitter tool-input belongs to the
         * executable path's emission action, which the stopgap replaces. */
        scriptcRuntime,
        scriptcHeaders,
        compilerEmitter,
        libraryPlanResolution.artifact,
        libraryEmission.artifact,
        ...targetObjects.artifacts,
        ...objectPlans.map(({ artifact }) => artifact),
        archiveArtifact,
        soArtifact,
      ],
      actions: [
        libraryEmission.action,
        ...targetObjects.actions,
        ...objectPlans.map(({ action }) => action),
        archiveAction,
        soAction,
      ],
    });
    const hostedReport = await executeArtifactGraph(hostedGraph, {
      buildRoot: join(input.scratch, `link-hosted-${input.backend}`),
      sourcePaths: {
        ...sdk.sourcePaths,
        [targetRuntimeArtifactIds.sourceTree]: runtimePath,
        [scriptcRuntime.id]: scriptcRuntimeRoot,
        [scriptcHeaders.id]: scriptcRuntimeInclude,
        [compilerEmitter.id]: compilerDistribution,
        [libraryPlanId]: libraryPlanPath,
        ...Object.fromEntries(
          targetObjects.adapters.map(({ plan }) => [plan.source.id, adapterPath]),
        ),
      },
      tools: { ...tools, [arTool.id]: { path: input.tools.ar ?? "/usr/bin/ar" } },
      sandbox,
      ...(cache === undefined ? {} : { cache }),
    });
    const hostedProduct = hostedReport.artifacts.find(({ id }) => id === soId);
    if (hostedProduct === undefined) {
      throw new Error("the hosted library graph produced no shared object");
    }
    return Object.freeze({
      productPath: hostedProduct.path,
      generatedPackagePath: generatedRoot,
      jvmLibraryPath: sdk.libraryPath,
      ...(builtClassesPath === undefined ? {} : { builtClassesPath }),
      ...(builtSubclassesPath === undefined ? {} : { builtSubclassesPath }),
    });
  }

  const planned = planExecutableCompilation(
    join(input.projectRoot, project.entry),
    {
      backend: input.backend,
      sourceRoot: input.projectRoot,
      externalTypes,
      native: composed.input,
      nativeLinkInputs: linkInputs,
      nativeRuntimeRequires: nativeRuntimeServices([jvmRuntimeProvider]),
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
    runtimeObjectIdPrefix: "object/scriptc-runtime/",
  });
  const linkPlan = externalResult.plans.at(-1);
  if (linkPlan === undefined) {
    throw new Error("ScriptC produced no link command for the application");
  }
  const runtimeObjectPlans = externalResult.plans
    .slice(0, -1)
    .map((plan, index) =>
      planScriptCRuntimeObject({
        actionId: `compile/scriptc-runtime/${
          externalResult.runtimeObjects[index]!.fileName
        }`,
        plan,
        artifactFileName: externalResult.runtimeObjects[index]!.fileName,
        tool: clangTool,
        driverPlatform: "linux",
        executionPlatform,
        target,
      })
    );
  const executablePlan = planScriptCExecutable({
    actionId: `link/scriptc-executable/${input.backend}`,
    plan: linkPlan,
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
      ...runtimeObjectPlans.map(({ artifact }) => artifact),
      executablePlan.artifact,
    ],
    actions: [
      emissionPlan.action,
      ...targetObjects.actions,
      ...runtimeObjectPlans.map(({ action }) => action),
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
        targetObjects.adapters.map(({ plan }) => [plan.source.id, adapterPath]),
      ),
    },
    tools,
    sandbox,
    ...(cache === undefined ? {} : { cache }),
    maxConcurrency:
      input.maxConcurrency ?? Math.max(1, availableParallelism() - 1),
  });
  const product = report.artifacts.find(({ id }) => id === outputId);
  if (product === undefined) {
    throw new Error(`The build produced no executable for ${project.name}`);
  }
  return Object.freeze({
    productPath: product.path,
    generatedPackagePath: generatedRoot,
    jvmLibraryPath: sdk.libraryPath,
    ...(builtClassesPath === undefined ? {} : { builtClassesPath }),
    ...(builtSubclassesPath === undefined ? {} : { builtSubclassesPath }),
  });
}
