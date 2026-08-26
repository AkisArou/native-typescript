#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadScriptCLibraryPlanners,
  scriptCCompilerDistribution,
  translateScabiNativeProgram,
} from "@native-typescript/scriptc";
import type {
  ScriptCExternalCcArgument,
  ScriptCLibraryCompilationPlan,
} from "@native-typescript/scriptc";
import type { Sha256Digest } from "@native-typescript/scabi";
import { assertScabiManifest } from "@native-typescript/scabi";
import { commandOutput, packageRoot, reportError, runCommand } from "./support.ts";

type Backend = "c" | "llvm";
type WorkloadId = "benchmark" | "counter";

const benchmarkRoot = resolve(packageRoot, "../../benchmarks/chromium");

interface Options {
  readonly backend: Backend | "all";
  readonly workload: WorkloadId | "all";
  readonly checkout: string;
  readonly output: string;
}

interface WebIdlInput {
  readonly chromiumRevision: string;
  readonly webIdlDatabaseDigest: Sha256Digest;
}

interface LibraryEmitterModule {
  readonly emitLibraryCompilationPlan?: (
    plan: ScriptCLibraryCompilationPlan,
  ) => string;
}

interface Workload {
  readonly id: WorkloadId;
  readonly sourceRoot: string;
  readonly externalTypes: Readonly<Record<string, string>>;
  readonly outputRoot: string;
  readonly archiveStem: string;
}

const callbackOperations = Object.freeze([
  "configure",
  "dispatch",
  "stop_accepting",
  "discard",
  "destroy",
  "hosted_post",
] as const);

function callbackPrefix(workload: WorkloadId, backend: Backend): string {
  return workload === "counter"
    ? `nts_chromium_counter_scriptc_${backend}_callbacks`
    : `nts_chromium_scriptc_${backend}_callbacks`;
}

function callbackShim(prefix: string): string {
  return [
    '#include "scr_runtime.h"',
    "#include <stdlib.h>",
    "",
    "typedef void (*NtsHostedProbeCallback)(void *context);",
    "typedef struct {",
    "  NtsHostedProbeCallback callback;",
    "  void *context;",
    "} NtsHostedProbeFrame;",
    "",
    `static void ${prefix}_hosted_probe_release(void *opaque) {`,
    "  free(opaque);",
    "}",
    `static void ${prefix}_hosted_probe_resume(void *opaque, ScrPromise *settled) {`,
    "  (void)settled;",
    "  NtsHostedProbeFrame *frame = (NtsHostedProbeFrame *)opaque;",
    "  NtsHostedProbeCallback callback = frame->callback;",
    "  void *context = frame->context;",
    "  free(frame);",
    "  callback(context);",
    "}",
    "",
    `int ${prefix}_configure(ScrOwnerGatewayWakeFn wake, void *context) {`,
    "  return scr_retained_callbacks_configure(wake, context) ? 1 : 0;",
    "}",
    `int ${prefix}_dispatch(void) {`,
    "  return (int)scr_retained_callbacks_dispatch();",
    "}",
    `void ${prefix}_stop_accepting(void) {`,
    "  scr_retained_callbacks_stop_accepting();",
    "}",
    `size_t ${prefix}_discard(void) {`,
    "  return scr_retained_callbacks_discard();",
    "}",
    `int ${prefix}_destroy(void) {`,
    "  return scr_retained_callbacks_destroy() ? 1 : 0;",
    "}",
    `int ${prefix}_hosted_post(NtsHostedProbeCallback callback, void *context) {`,
    "  if (callback == NULL) return 0;",
    "  NtsHostedProbeFrame *frame =",
    "      (NtsHostedProbeFrame *)malloc(sizeof *frame);",
    "  if (frame == NULL) return 0;",
    "  frame->callback = callback;",
    "  frame->context = context;",
    "  return scr_hosted_scheduler_post(scr_hosted_scheduler_current(),",
    `                                   &${prefix}_hosted_probe_resume, frame,`,
    `                                   &${prefix}_hosted_probe_release)`,
    "      ? 1",
    "      : 0;",
    "}",
    "",
  ].join("\n");
}

const target = Object.freeze({
  triple: "x86_64-unknown-linux-gnu",
  architecture: "x86_64",
  pointerWidth: 64 as const,
  endianness: "little" as const,
  objectFormat: "elf" as const,
  minimumPlatformVersion: "0",
  abi: "gnu",
  features: Object.freeze([]),
});

function usage(): string {
  return [
    "Usage: node scripts/build-chromium-benchmark-libraries.ts /path/to/chromium/src",
    "  [--out out/nts-counter/gen/native_typescript/benchmark]",
    "  [--backend c|llvm|all]",
    "  [--workload benchmark|counter|all]",
    "",
    "Builds artifacts only; it does not execute or time a benchmark.",
  ].join("\n");
}

function parseOptions(arguments_: readonly string[]): Options | null {
  if (arguments_.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const checkoutArgument = arguments_[0];
  if (checkoutArgument === undefined || checkoutArgument.startsWith("-")) {
    throw new Error(usage());
  }
  const checkout = resolve(checkoutArgument);
  let output = resolve(
    checkout,
    "out/nts-counter/gen/native_typescript/benchmark",
  );
  let backend: Backend | "all" = "all";
  let workload: WorkloadId | "all" = "benchmark";
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (
      argument !== "--out" && argument !== "--backend" &&
      argument !== "--workload"
    ) {
      throw new Error(`Unknown argument: ${argument}\n${usage()}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    if (argument === "--out") output = resolve(checkout, value);
    else if (argument === "--backend" &&
      (value === "c" || value === "llvm" || value === "all")) {
      backend = value;
    } else if (argument === "--workload" &&
      (value === "benchmark" || value === "counter" || value === "all")) {
      workload = value;
    } else {
      throw new Error(
        argument === "--backend"
          ? "--backend must be c, llvm, or all"
          : "--workload must be benchmark, counter, or all",
      );
    }
    index += 1;
  }
  return Object.freeze({ backend, checkout, output, workload });
}

function requireTool(checkout: string, name: string): string {
  const path = resolve(
    checkout,
    `third_party/llvm-build/Release+Asserts/bin/${name}`,
  );
  if (!existsSync(path)) throw new Error(`Pinned Chromium tool is absent: ${path}`);
  return path;
}

function removeExactFile(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function argumentPath(
  argument: ScriptCExternalCcArgument,
  inputs: ReadonlyMap<string, string>,
  outputs: ReadonlyMap<string, string>,
): string {
  if (argument.kind === "literal") return argument.value;
  const map = argument.kind === "input-path" ? inputs : outputs;
  const id = argument.kind === "input-path" ? argument.input : argument.output;
  const base = map.get(id);
  if (base === undefined) throw new Error(`No materialization path for ${id}`);
  if (argument.kind === "output-path" || argument.path === undefined) return base;
  if (isAbsolute(argument.path) || argument.path.split("/").includes("..")) {
    throw new Error(`Unsafe ScriptC plan-relative path: ${argument.path}`);
  }
  return join(base, argument.path);
}

function unlocalizedPlan(
  plan: ScriptCLibraryCompilationPlan,
): ScriptCLibraryCompilationPlan {
  const { localizeSymbols: _, ...nativeBuild } = plan.nativeBuild;
  return Object.freeze({
    ...plan,
    nativeBuild: Object.freeze(nativeBuild),
  });
}

async function buildLibrary(
  workload: Workload,
  backend: Backend,
  options: Options,
  emitter: Required<LibraryEmitterModule>,
  clang: string,
  llvmAr: string,
  llvmLd: string,
  llvmNm: string,
  llvmObjcopy: string,
  native: ReturnType<typeof translateScabiNativeProgram> & { readonly ok: true },
): Promise<string> {
  const runtimeCompatibilityHeader = resolve(
    packageRoot,
    "../../benchmarks/chromium/scriptc",
    "chromium-runtime-compat.h",
  );
  const { planLibraryCompilation, planLibraryExternalCBuild } =
    await loadScriptCLibraryPlanners();
  const planned = await planLibraryCompilation({
    profilePath: resolve(workload.sourceRoot, `profile-${backend}.json`),
    externalTypes: workload.externalTypes,
    native: native.input,
  });
  if (!planned.ok) {
    throw new Error(
      `Planning the ScriptC ${backend} ${workload.id} library failed:\n` +
        planned.diagnostics.map(({ message }) => `  ${message}`).join("\n"),
    );
  }
  const plannedKeepSymbols = planned.plan.nativeBuild.localizeSymbols;
  if (plannedKeepSymbols === undefined || plannedKeepSymbols.length === 0) {
    throw new Error(
      `ScriptC ${backend} ${workload.id} runtime is not localized`,
    );
  }

  const backendRoot = resolve(workload.outputRoot, backend);
  const objectRoot = resolve(backendRoot, "objects");
  mkdirSync(objectRoot, { recursive: true });
  const extension = backend === "llvm" ? "ll" : "c";
  const program = resolve(backendRoot, `program.${extension}`);
  writeFileSync(program, emitter.emitLibraryCompilationPlan(planned.plan));

  const programId = `${workload.id}/${backend}/program`;
  const runtimeId = "scriptc/runtime";
  const archiveId = `${workload.id}/${backend}/archive`;
  const external = await planLibraryExternalCBuild(
    unlocalizedPlan(planned.plan),
    {
      program: programId,
      runtime: runtimeId,
      output: archiveId,
      objectIdPrefix: `${workload.id}/${backend}/object/`,
    },
  );
  const inputs = new Map<string, string>([
    [programId, program],
    [runtimeId, external.bindings.runtimeDirectory],
  ]);
  const sysroot = resolve(
    options.checkout,
    "build/linux/debian_bullseye_amd64-sysroot",
  );
  if (!existsSync(sysroot)) {
    throw new Error(`Pinned Chromium Linux sysroot is absent: ${sysroot}`);
  }
  const repositoryRoot = resolve(packageRoot, "../..");
  const reproduciblePathArguments = [
    `-ffile-prefix-map=${repositoryRoot}=/native-typescript`,
    `-fmacro-prefix-map=${repositoryRoot}=/native-typescript`,
    `-ffile-prefix-map=${options.checkout}=/chromium`,
    `-fmacro-prefix-map=${options.checkout}=/chromium`,
  ];
  const outputs = new Map<string, string>();
  for (const object of external.objects) {
    const path = resolve(objectRoot, object.fileName);
    inputs.set(object.id, path);
    outputs.set(object.id, path);
  }
  for (const plan of external.plans.slice(0, -1)) {
    if (plan.driver.command !== "clang") {
      throw new Error(`Unexpected ScriptC compile driver: ${plan.driver.command}`);
    }
    const arguments_ = plan.arguments.map((argument) =>
      argumentPath(argument, inputs, outputs)
    );
    const compatibilityArguments = arguments_.some((argument) =>
      argument.endsWith(".c")
    )
      ? ["-include", runtimeCompatibilityHeader]
      : [];
    runCommand(
      clang,
      [
        `--target=${target.triple}`,
        `--sysroot=${sysroot}`,
        ...reproduciblePathArguments,
        ...compatibilityArguments,
        ...arguments_,
      ],
      backendRoot,
    );
  }

  const prefix = callbackPrefix(workload.id, backend);
  const callbackShimSource = resolve(backendRoot, "callback-host.c");
  const callbackShimObject = resolve(objectRoot, "callback-host.o");
  writeFileSync(callbackShimSource, callbackShim(prefix));
  runCommand(
    clang,
    [
      `--target=${target.triple}`,
      `--sysroot=${sysroot}`,
      ...reproduciblePathArguments,
      "-std=c11",
      "-D_GNU_SOURCE",
      "-DSCR_LIB",
      "-DSCR_THREAD_INSTANCES",
      "-O2",
      "-fPIC",
      "-include",
      runtimeCompatibilityHeader,
      "-I",
      resolve(external.bindings.runtimeDirectory, "src"),
      "-c",
      callbackShimSource,
      "-o",
      callbackShimObject,
    ],
    backendRoot,
  );
  const keepSymbols = [
    ...plannedKeepSymbols,
    ...callbackOperations.map((operation) => `${prefix}_${operation}`),
  ];

  const [programObject, ...runtimeObjects] = external.objects;
  if (programObject === undefined || !programObject.fileName.startsWith("program.")) {
    throw new Error("ScriptC external plan did not put the program object first");
  }
  const staging = resolve(backendRoot, "runtime-staging.a");
  const combined = resolve(backendRoot, "program.localized.o");
  const keepFile = resolve(backendRoot, "keep-global-symbols.txt");
  const archive = resolve(
    backendRoot,
    `lib${workload.archiveStem}-${backend}.a`,
  );
  removeExactFile(resolve(backendRoot, `${workload.archiveStem}-${backend}.a`));
  removeExactFile(staging);
  removeExactFile(combined);
  removeExactFile(archive);
  writeFileSync(keepFile, `${keepSymbols.join("\n")}\n`);
  runCommand(
    llvmAr,
    [
      "rcs",
      staging,
      ...runtimeObjects.map((object) => inputs.get(object.id)!),
    ],
    backendRoot,
  );
  runCommand(
    llvmLd,
    [
      "-r",
      "--force-group-allocation",
      inputs.get(programObject.id)!,
      callbackShimObject,
      staging,
      "-o",
      combined,
    ],
    backendRoot,
  );
  runCommand(
    llvmObjcopy,
    [`--keep-global-symbols=${keepFile}`, combined],
    backendRoot,
  );
  runCommand(llvmAr, ["rcs", archive, combined], backendRoot);

  const globals = commandOutput(
    llvmNm,
    ["--defined-only", "--extern-only", "--format=just-symbols", archive],
    backendRoot,
  ).split("\n").filter((symbol) => symbol.length > 0 && !symbol.endsWith(":"))
    .sort();
  const expected = [...keepSymbols].sort();
  if (JSON.stringify(globals) !== JSON.stringify(expected)) {
    throw new Error(
      `Localized ScriptC ${backend} globals differ from its declared surface:\n` +
        `  expected: ${expected.join(", ")}\n` +
        `  actual: ${globals.join(", ")}`,
    );
  }
  const archiveBytes = readFileSync(archive);
  for (const physicalRoot of [resolve(packageRoot, "../.."), options.checkout]) {
    if (archiveBytes.includes(Buffer.from(physicalRoot))) {
      throw new Error(
        `ScriptC ${backend} ${workload.id} archive retained a physical source path`,
      );
    }
  }
  return archive;
}

async function main(arguments_: readonly string[]): Promise<void> {
  const options = parseOptions(arguments_);
  if (options === null) return;
  const webIdlInput = JSON.parse(
    readFileSync(resolve(packageRoot, "chromium/webidl/input.json"), "utf8"),
  ) as WebIdlInput;
  if (commandOutput("git", ["rev-parse", "HEAD"], options.checkout) !==
      webIdlInput.chromiumRevision) {
    throw new Error("Benchmark libraries require the exact pinned Chromium revision");
  }
  const clang = requireTool(options.checkout, "clang");
  const llvmAr = requireTool(options.checkout, "llvm-ar");
  const llvmLd = requireTool(options.checkout, "ld.lld");
  const llvmNm = requireTool(options.checkout, "llvm-nm");
  const llvmObjcopy = requireTool(options.checkout, "llvm-objcopy");
  const clangVersion = commandOutput(clang, ["--version"], options.checkout)
    .split("\n")[0]!;
  if (!clangVersion.startsWith("clang version 24.0.0git ")) {
    throw new Error(`Unexpected pinned Chromium clang version: ${clangVersion}`);
  }
  const webManifest = assertScabiManifest(JSON.parse(readFileSync(
    resolve(packageRoot, "chromium/webidl/package.scabi.json"),
    "utf8",
  )));
  const counterNative = translateScabiNativeProgram(webManifest, {
    imports: [
      "web_current_document",
      "web_document_body",
      "web_document_create_element",
      "web_document_create_text_node",
      "web_node_append_child",
      "web_node_remove_child",
      "web_element_set_attribute",
      "web_element_query_selector",
      "web_html_element_click",
      "web_character_data_set_data",
      "web_event_target_listen",
      "web_subscription_release",
    ],
    exports: [],
  });
  if (!counterNative.ok) {
    throw new Error(
      "Translating the Chromium counter WebIDL manifest failed:\n" +
        counterNative.diagnostics.map(({ message }) => `  ${message}`).join("\n"),
    );
  }
  const compilerModule = await import(
    pathToFileURL(resolve(scriptCCompilerDistribution(), "index.js")).href
  ) as LibraryEmitterModule;
  if (typeof compilerModule.emitLibraryCompilationPlan !== "function") {
    throw new Error("Pinned ScriptC compiler has no library-plan emitter");
  }
  mkdirSync(options.output, { recursive: true });
  const backends: readonly Backend[] = options.backend === "all"
    ? ["c", "llvm"]
    : [options.backend];
  const archives: string[] = [];
  const workloadCandidates: readonly {
    readonly workload: Workload;
    readonly native: typeof counterNative;
  }[] = [
    {
      workload: {
        id: "benchmark",
        sourceRoot: resolve(benchmarkRoot, "scriptc"),
        externalTypes: {
          "@native-typescript/web-chromium": resolve(
            packageRoot,
            "chromium/webidl/reached.d.ts",
          ),
        },
        outputRoot: options.output,
        archiveStem: "scriptc",
      },
      native: counterNative,
    },
    {
      workload: {
        id: "counter",
        sourceRoot: resolve(packageRoot, "counter/scriptc"),
        externalTypes: {
          "@native-typescript/web-chromium": resolve(
            packageRoot,
            "chromium/webidl/reached.d.ts",
          ),
        },
        outputRoot: resolve(options.output, "../counter"),
        archiveStem: "scriptc-counter",
      },
      native: counterNative,
    },
  ];
  const workloads = workloadCandidates.filter(({ workload }) =>
    options.workload === "all" || options.workload === workload.id
  );
  for (const entry of workloads) {
    for (const backend of backends) {
      archives.push(await buildLibrary(
        entry.workload,
        backend,
        options,
        compilerModule as Required<LibraryEmitterModule>,
        clang,
        llvmAr,
        llvmLd,
        llvmNm,
        llvmObjcopy,
        entry.native,
      ));
    }
  }
  /* The archives live under root_out_dir but are intentionally materialized
   * by this repository rather than a GN action. GN permits their absolute
   * names in `libs`, yet does not add those external files to Ninja's input
   * graph; listing them in `inputs` is rejected because no GN target declares
   * the outputs. Mark the one source_set that owns the libraries dirty only
   * after every requested archive has passed compilation/localization. That
   * preserves every object cache while guaranteeing the next Ninja build
   * recompiles the host and relinks content_shell with these exact archives. */
  const relinkTrigger = resolve(
    options.checkout,
    "third_party/blink/renderer/native_typescript/nts_blink_benchmark_host.cc",
  );
  if (!existsSync(relinkTrigger)) {
    throw new Error(`Chromium ScriptC relink trigger is absent: ${relinkTrigger}`);
  }
  const now = new Date();
  utimesSync(relinkTrigger, now, now);
  process.stdout.write(
    [
      "",
      "Built localized ScriptC libraries (no benchmark was run):",
      ...archives.map((archive) => `  ${relative(options.checkout, archive)}`),
      "",
    ].join("\n"),
  );
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  reportError(error);
}
