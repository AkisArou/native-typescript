import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseScabiManifest } from "@native-typescript/scabi";
import { translateScabiNativeProgram } from "@native-typescript/scriptc";

const workspace = join(import.meta.dirname, "..");
const scriptcRoot = join(workspace, "third_party/scriptc");
const fixtureRoot = join(workspace, "fixtures/gtk-counter");
const targetRoot = join(workspace, "packages/target-gtk");
const runtimeInclude = join(scriptcRoot, "packages/runtime/src");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const hasGtk = spawnSync("pkg-config", ["--exists", "gtk4"]).status === 0;
const hasXvfb = spawnSync("xvfb-run", ["--help"]).status === 0;

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function pkgConfig(...args: string[]): string[] {
  return execFileSync("pkg-config", [...args, "gtk4"], { encoding: "utf8" })
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

test(
  "compiled TypeScript drives a real GTK window through the attached loop",
  {
    skip:
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      !hasGtk ||
      !hasXvfb,
  },
  async () => {
    const manifest = parseScabiManifest(
      readFileSync(join(fixtureRoot, "package.scabi.json"), "utf8"),
    );
    assert.equal(
      manifest.declarations.digest,
      sha256(join(fixtureRoot, "package.d.ts")),
    );
    assert.equal(
      manifest.sdk.metadataDigest,
      sha256(join(fixtureRoot, "include/nts_gtk_counter.h")),
    );

    const translated = translateScabiNativeProgram(manifest, {
      imports: [
        "runtime_start",
        "counter_create",
        "counter_schedule_click",
        "counter_destroy",
        "quit",
        "complete",
      ],
      exports: [],
    });
    assert.equal(
      translated.ok,
      true,
      translated.ok
        ? undefined
        : translated.diagnostics
            .map(({ code, path, message }) => `${code} ${path}: ${message}`)
            .join("\n"),
    );
    if (!translated.ok) return;

    assert.deepEqual(
      translated.linkInputIds,
      manifest.linkInputs.map(({ id }) => id).sort(),
    );

    const scratch = mkdtempSync(join(tmpdir(), "nts-gtk-app-"));
    try {
      const cflags = pkgConfig("--cflags").flatMap((flag) =>
        flag.startsWith("-I") ? ["-isystem", flag.slice(2)] : [flag],
      );
      const objects = [
        [
          join(targetRoot, "runtime/nts_glib_runtime.c"),
          join(scratch, "nts_glib_runtime.o"),
        ],
        [
          join(fixtureRoot, "src/nts_gtk_counter.c"),
          join(scratch, "nts_gtk_counter.o"),
        ],
      ] as const;
      for (const [source, object] of objects) {
        execFileSync("clang", [
          "-std=c11",
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-pedantic",
          ...cflags,
          "-I",
          join(fixtureRoot, "include"),
          "-I",
          join(targetRoot, "runtime"),
          "-I",
          runtimeInclude,
          "-c",
          source,
          "-o",
          object,
        ]);
      }

      const systemLibraries = manifest.linkInputs
        .filter(({ kind }) => kind === "system-library")
        .sort((left, right) => left.order - right.order)
        .map(({ name }) => name);
      execFileSync(
        pnpm,
        ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"],
      );
      const { compile } = await import(
        "../third_party/scriptc/packages/compiler/dist/index.js"
      );
      for (const backend of ["c", "llvm"] as const) {
        const outDir = join(scratch, backend);
        const result = await compile(join(fixtureRoot, "app.ts"), {
          outDir,
          outPath: join(outDir, "gtk-counter"),
          backend,
          emitIr: true,
          externalTypes: {
            [manifest.package.name]: join(fixtureRoot, "package.d.ts"),
          },
          native: translated.input,
          nativeLinkInputs: objects.map(([, object]) => object),
          nativeSystemLibraries: systemLibraries,
        });
        assert.equal(
          result.ok,
          true,
          result.ok
            ? undefined
            : result.diagnostics
                .map((diagnostic) => diagnostic.message)
                .join("\n"),
        );
        if (!result.ok) continue;

        const run = spawnSync(
          "xvfb-run",
          [
            "-a",
            "--server-args=-screen 0 1024x768x24",
            result.binaryPath,
          ],
          {
            env: {
              ...process.env,
              GDK_BACKEND: "x11",
              GDK_DISABLE: "gl,vulkan",
              GSETTINGS_BACKEND: "memory",
              GSK_RENDERER: "cairo",
              NO_AT_BRIDGE: "1",
            },
            encoding: "utf8",
          },
        );
        assert.deepEqual(
          {
            status: run.status,
            signal: run.signal,
            stdout: run.stdout,
            stderr: run.stderr,
          },
          { status: 0, signal: null, stdout: "", stderr: "" },
          backend,
        );
      }
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  },
);
