import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  glibRuntimeArtifactIds,
  glibRuntimeNative,
  glibRuntimeProvider,
  planGlibRuntimeObject,
} from "@native-typescript/target-gtk";
import { capabilities } from "@native-typescript/target-api";

const workspace = join(import.meta.dirname, "..");
const targetPackage = join(workspace, "packages/target-gtk");
const runtimeDir = join(targetPackage, "runtime");
const scriptcRuntime = join(
  workspace,
  "third_party/scriptc/packages/runtime/src",
);
const fixture = join(workspace, "tests/fixtures/glib-runtime.c");

const glibProbe = spawnSync("pkg-config", ["--exists", "glib-2.0"]);
const hasGlib = glibProbe.status === 0;

function pkgConfig(...args: string[]): string[] {
  return execFileSync("pkg-config", [...args, "glib-2.0"], {
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function glibCompileFlags(): string[] {
  return pkgConfig("--cflags").flatMap((flag) =>
    flag.startsWith("-I") ? ["-isystem", flag.slice(2)] : [flag],
  );
}

test("GTK target declares the GLib owner runtime contract", () => {
  assert.equal(glibRuntimeProvider.descriptor.kind, "runtime");
  assert.deepEqual(glibRuntimeProvider.descriptor.provides, [
    capabilities.runtimeOwnerExecutorV1,
    capabilities.foreignCallbackIngressV1,
    capabilities.retainedCallbackV1,
  ]);
  assert.deepEqual(glibRuntimeProvider.descriptor.requires.compiler, [
    capabilities.retainedCallbackV1,
  ]);
  assert.deepEqual(glibRuntimeNative, {
    header: "runtime/nts_glib_runtime.h",
    source: "runtime/nts_glib_runtime.c",
    pkgConfigModules: ["glib-2.0"],
  });
});

test("GTK target contributes its GLib runtime as an artifact-graph fragment", () => {
  const plan = planGlibRuntimeObject({
    sourceTreeDigest: `sha256:${"1".repeat(64)}`,
    scriptcRuntimeHeaders: { artifact: "headers/scriptc/runtime" },
    arguments: [
      { kind: "literal", value: "-std=c11" },
      { kind: "input-path", artifact: "sdk/glib/include" },
    ],
    tool: {
      id: "tool/clang",
      version: "1",
      digest: `sha256:${"2".repeat(64)}`,
    },
    executionPlatform: "x86_64-linux",
    target: "x86_64-unknown-linux-gnu",
  });

  assert.equal(plan.sourceTree.id, glibRuntimeArtifactIds.sourceTree);
  assert.equal(plan.object.id, glibRuntimeArtifactIds.object);
  assert.deepEqual(plan.action.inputs, [
    glibRuntimeArtifactIds.sourceTree,
    "sdk/glib/include",
    "headers/scriptc/runtime",
  ]);
  assert.deepEqual(plan.action.arguments.slice(-5), [
    { kind: "input-path", artifact: "headers/scriptc/runtime" },
    { kind: "literal", value: "-c" },
    {
      kind: "input-path",
      artifact: glibRuntimeArtifactIds.sourceTree,
      path: "nts_glib_runtime.c",
    },
    { kind: "literal", value: "-o" },
    { kind: "output-path", artifact: glibRuntimeArtifactIds.object },
  ]);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.action.arguments), true);
});

for (const sanitizer of ["none", "address", "thread"] as const) {
  test(
    `GLib owner runtime schedules exact callback turns (${sanitizer})`,
    {
      skip:
        !hasGlib ||
        (sanitizer === "thread" && process.platform !== "linux"),
    },
    () => {
      const scratch = mkdtempSync(join(tmpdir(), "nts-glib-runtime-"));
      const binary = join(scratch, `glib-runtime-${sanitizer}`);
      try {
        execFileSync("clang", [
          "-std=c11",
          "-O1",
          "-g",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-pedantic",
          "-pthread",
          ...(sanitizer === "address"
            ? ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"]
            : sanitizer === "thread"
              ? ["-fsanitize=thread", "-fno-omit-frame-pointer"]
              : []),
          ...glibCompileFlags(),
          "-I",
          runtimeDir,
          "-I",
          scriptcRuntime,
          join(targetPackage, glibRuntimeNative.source),
          fixture,
          ...pkgConfig("--libs"),
          "-o",
          binary,
        ]);
        assert.equal(
          execFileSync(binary, { encoding: "utf8" }),
          "glib runtime: ok\n",
        );
        if (sanitizer === "none") {
          const wrongOwner = spawnSync(binary, ["wrong-owner"], {
            encoding: "utf8",
          });
          assert.notEqual(wrongOwner.status, 0);
          assert.match(
            wrongOwner.stderr,
            /GLib runtime dispatched outside its owner thread/u,
          );
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
}
