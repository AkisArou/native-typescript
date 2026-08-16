import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scriptCCompilerDistribution } from "@native-typescript/scriptc";
import { bindingToolPath, systemGioGir, systemGtkGir } from "./support/gir-analysis.ts";
import { runApplication } from "./support/run-application.ts";

const workspace = join(import.meta.dirname, "..");
const scriptcRoot = join(workspace, "third_party/scriptc");
const cli = join(workspace, "packages/cli/src/main.ts");
const fixtureRoot = join(workspace, "fixtures/gtk-application");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const hasGtk = spawnSync("pkg-config", ["--exists", "gtk4"]).status === 0;
const hasXvfb = spawnSync("xvfb-run", ["--help"]).status === 0;
const hasClang = spawnSync("clang", ["--version"]).status === 0;
const hasBubblewrap = spawnSync("bwrap", ["--version"]).status === 0;

function invoke(
  args: readonly string[],
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", cli, ...args],
    { encoding: "utf8" },
  );
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

test("the CLI advertises build alongside its other commands", () => {
  const help = invoke(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /build {7}Build a project into a native executable/u);
  assert.match(help.stdout, /--backend <c\|llvm>/u);
});

test("the CLI reports a missing project rather than failing later", () => {
  const scratch = mkdtempSync(join(tmpdir(), "nts-cli-empty-"));
  try {
    const result = invoke(["build", scratch]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No native-typescript\.json in /u);
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
});

test("the CLI refuses an option it does not define", () => {
  const result = invoke(["build", "--backend", "wasm"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--backend takes 'c' or 'llvm'/u);
});

test(
  "the CLI builds a runnable native executable from a project description",
  {
    skip:
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      !existsSync(systemGioGir) ||
      !existsSync(systemGtkGir) ||
      !existsSync(bindingToolPath) ||
      !hasGtk ||
      !hasXvfb ||
      !hasClang ||
      !hasBubblewrap,
  },
  () => {
    /* One command, a project file, and a native binary. This is the path a
     * user actually takes, so it is the one that has to stay working — the
     * library gate proves the surface, and this proves the surface is
     * reachable without writing a build by hand. */
    execFileSync(pnpm, [
      "--dir",
      scriptcRoot,
      "--filter",
      "@scriptc/compiler",
      "build",
    ]);
    assert.equal(existsSync(scriptCCompilerDistribution()), true);

    const scratch = mkdtempSync(join(tmpdir(), "nts-cli-build-"));
    try {
      const output = join(scratch, "dist");
      const built = invoke([
        "build",
        fixtureRoot,
        "--out",
        output,
        "--cache",
        join(scratch, "cache"),
      ]);
      assert.equal(built.status, 0, built.stderr);
      const product = join(output, "gtk-application");
      assert.equal(built.stdout, `${product}\n`);
      assert.equal(existsSync(product), true);

      assert.deepEqual(runApplication(product), {
        status: 0,
        signal: null,
        stdout: "activated 1\n",
        stderr: "",
      });

      /* A second build runs against the cache the first one populated. What
       * is asserted is the part that matters: it must still produce a working
       * program, not merely exit zero. */
      const rebuilt = invoke([
        "build",
        fixtureRoot,
        "--out",
        output,
        "--cache",
        join(scratch, "cache"),
      ]);
      assert.equal(rebuilt.status, 0, rebuilt.stderr);
      assert.deepEqual(runApplication(product), {
        status: 0,
        signal: null,
        stdout: "activated 1\n",
        stderr: "",
      });
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  },
);
