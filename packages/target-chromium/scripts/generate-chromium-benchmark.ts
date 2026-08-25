#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  defineChromiumBenchmarkContract,
  type ChromiumBenchmarkContract,
} from "../src/benchmark-contract.ts";
import { packageRoot, reportError } from "./support.ts";

interface GeneratedFile {
  readonly path: string;
  readonly contents: string;
}

const benchmarkRoot = resolve(packageRoot, "../../benchmarks/chromium");

function contract(): ChromiumBenchmarkContract {
  const path = resolve(benchmarkRoot, "workloads.json");
  return defineChromiumBenchmarkContract(
    JSON.parse(readFileSync(path, "utf8")),
  );
}

function profile(
  contract_: ChromiumBenchmarkContract,
  backend: "c" | "llvm",
): string {
  const prefix = `nts_chromium_scriptc_${backend}_`;
  return `${JSON.stringify({
    profile_format: 1,
    name: `native-typescript-chromium-benchmark-${backend}`,
    entry: "app.ts",
    emission: backend,
    optimization: "release",
    abi: {
      prefix,
      init_symbol: `${prefix}init`,
      sink_register_symbol: `${prefix}set_panic_sink`,
      collect_symbol: null,
      result_reset_symbol: null,
      localize_runtime: true,
      instance_per_thread: true,
    },
    exports: contract_.workloads.map((workload) => ({
      export: workload.typescriptExport,
      symbol: `${prefix}${workload.symbolStem}`,
      params: ["f64"],
      returns: "f64",
    })),
  }, null, 2)}\n`;
}

function cppInclude(contract_: ChromiumBenchmarkContract): string {
  return [
    "// Generated from benchmarks/chromium/workloads.json; do not edit.",
    ...contract_.workloads.map((workload) => {
      const budgets = [
        workload.budgets.cpp,
        workload.budgets["scriptc-c"],
        workload.budgets["scriptc-llvm"],
      ].flatMap((budget) => [
        budget.perCallIterations,
        budget.perCallWarmupIterations,
        budget.compiledLoopIterations,
        budget.compiledLoopWarmupIterations,
      ]);
      return `NTS_CHROMIUM_BENCHMARK_WORKLOAD(${JSON.stringify(workload.id)}, ` +
        `${workload.cppFunction}, ${workload.symbolStem}, ${budgets.join(", ")})`;
    }),
    "",
  ].join("\n");
}

function browserContract(contract_: ChromiumBenchmarkContract): string {
  return [
    "// Generated from benchmarks/chromium/workloads.json; do not edit.",
    "\"use strict\";",
    `globalThis.ntsBenchmarkContract = Object.freeze(${JSON.stringify({
      sampleCount: contract_.sampleCount,
      workloads: contract_.workloads.map((workload) => {
        const budget = workload.budgets.v8;
        return {
          id: workload.id,
          function: workload.typescriptExport,
          ...budget,
        };
      }),
    })});`,
    "",
  ].join("\n");
}

function generatedFiles(): readonly GeneratedFile[] {
  const value = contract();
  return [
    {
      path: resolve(benchmarkRoot, "scriptc/profile-c.json"),
      contents: profile(value, "c"),
    },
    {
      path: resolve(benchmarkRoot, "scriptc/profile-llvm.json"),
      contents: profile(value, "llvm"),
    },
    {
      path: resolve(
        packageRoot,
        "chromium/overlay/generated/nts_benchmark_workloads.inc",
      ),
      contents: cppInclude(value),
    },
    {
      path: resolve(benchmarkRoot, "pages/workloads.js"),
      contents: browserContract(value),
    },
  ];
}

function usage(): string {
  return "Usage: node scripts/generate-chromium-benchmark.ts [--check]";
}

function main(arguments_: readonly string[]): void {
  if (arguments_.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (arguments_.some((argument) => argument !== "--check")) {
    throw new Error(usage());
  }
  const check = arguments_.includes("--check");
  for (const file of generatedFiles()) {
    if (check) {
      if (!existsSync(file.path) || readFileSync(file.path, "utf8") !== file.contents) {
        throw new Error(`Generated Chromium benchmark artifact is stale: ${file.path}`);
      }
    } else {
      writeFileSync(file.path, file.contents, "utf8");
      process.stdout.write(`Wrote ${file.path}\n`);
    }
  }
  if (check) process.stdout.write("Chromium benchmark artifacts are current\n");
}

try {
  main(process.argv.slice(2));
} catch (error) {
  reportError(error);
}
