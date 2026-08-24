#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
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
import { createChromiumBenchmarkNativeManifest } from "../src/benchmark-native.ts";
import { commandOutput, packageRoot, reportError, runCommand } from "./support.ts";

type Backend = "c" | "llvm";

interface Options {
  readonly backend: Backend | "all";
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
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument !== "--out" && argument !== "--backend") {
      throw new Error(`Unknown argument: ${argument}\n${usage()}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    if (argument === "--out") output = resolve(checkout, value);
    else if (value === "c" || value === "llvm" || value === "all") {
      backend = value;
    } else {
      throw new Error("--backend must be c, llvm, or all");
    }
    index += 1;
  }
  return Object.freeze({ backend, checkout, output });
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
  const benchmarkRoot = resolve(packageRoot, "benchmark/scriptc");
  const runtimeCompatibilityHeader = resolve(
    benchmarkRoot,
    "chromium-runtime-compat.h",
  );
  const { planLibraryCompilation, planLibraryExternalCBuild } =
    await loadScriptCLibraryPlanners();
  const planned = await planLibraryCompilation({
    profilePath: resolve(benchmarkRoot, `profile-${backend}.json`),
    externalTypes: {
      "@native-typescript/chromium-benchmark-native": resolve(
        benchmarkRoot,
        "native.d.ts",
      ),
    },
    native: native.input,
  });
  if (!planned.ok) {
    throw new Error(
      `Planning the ScriptC ${backend} benchmark library failed:\n` +
        planned.diagnostics.map(({ message }) => `  ${message}`).join("\n"),
    );
  }
  const keepSymbols = planned.plan.nativeBuild.localizeSymbols;
  if (keepSymbols === undefined || keepSymbols.length === 0) {
    throw new Error(`ScriptC ${backend} benchmark runtime is not localized`);
  }

  const backendRoot = resolve(options.output, backend);
  const objectRoot = resolve(backendRoot, "objects");
  mkdirSync(objectRoot, { recursive: true });
  const extension = backend === "llvm" ? "ll" : "c";
  const program = resolve(backendRoot, `program.${extension}`);
  writeFileSync(program, emitter.emitLibraryCompilationPlan(planned.plan));

  const programId = `benchmark/${backend}/program`;
  const runtimeId = "scriptc/runtime";
  const archiveId = `benchmark/${backend}/archive`;
  const external = await planLibraryExternalCBuild(
    unlocalizedPlan(planned.plan),
    {
      program: programId,
      runtime: runtimeId,
      output: archiveId,
      objectIdPrefix: `benchmark/${backend}/object/`,
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

  const [programObject, ...runtimeObjects] = external.objects;
  if (programObject === undefined || !programObject.fileName.startsWith("program.")) {
    throw new Error("ScriptC external plan did not put the program object first");
  }
  const staging = resolve(backendRoot, "runtime-staging.a");
  const combined = resolve(backendRoot, "program.localized.o");
  const keepFile = resolve(backendRoot, "keep-global-symbols.txt");
  const archive = resolve(backendRoot, `libscriptc-${backend}.a`);
  removeExactFile(resolve(backendRoot, `scriptc-${backend}.a`));
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
        `ScriptC ${backend} archive retained a physical source path`,
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
  const manifest = createChromiumBenchmarkNativeManifest({
    chromiumRevision: webIdlInput.chromiumRevision,
    clangVersion: "24.0.0git",
    metadataDigest: webIdlInput.webIdlDatabaseDigest,
    target,
  });
  const native = translateScabiNativeProgram(manifest, {
    imports: ["create_element_once"],
    exports: [],
  });
  if (!native.ok) {
    throw new Error(
      "Translating the Chromium benchmark native manifest failed:\n" +
        native.diagnostics.map(({ message }) => `  ${message}`).join("\n"),
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
  for (const backend of backends) {
    archives.push(await buildLibrary(
      backend,
      options,
      compilerModule as Required<LibraryEmitterModule>,
      clang,
      llvmAr,
      llvmLd,
      llvmNm,
      llvmObjcopy,
      native,
    ));
  }
  process.stdout.write(
    [
      "",
      "Built localized ScriptC benchmark libraries (no benchmark was run):",
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
