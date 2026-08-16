import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  glibRuntimeProvider,
  planGlibRuntimeObject,
  planGtkTargetObjects,
  targetRuntimeArtifactIds,
  targetRuntimeNative,
  targetRuntimeSourceTree,
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
  assert.deepEqual(targetRuntimeNative, {
    glibRuntime: {
      header: "runtime/nts_glib_runtime.h",
      source: "runtime/nts_glib_runtime.c",
      pkgConfigModules: ["glib-2.0"],
    },
    application: {
      header: "runtime/nts_gtk_application.h",
      source: "runtime/nts_gtk_application.c",
      pkgConfigModules: ["gtk4"],
    },
  });
});

test("GTK target contributes its GLib runtime as an artifact-graph fragment", () => {
  const sourceTree = targetRuntimeSourceTree({
    digest: `sha256:${"1".repeat(64)}`,
    target: "x86_64-unknown-linux-gnu",
  });
  const plan = planGlibRuntimeObject({
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

  assert.equal(sourceTree.id, targetRuntimeArtifactIds.sourceTree);
  assert.equal(plan.object.id, targetRuntimeArtifactIds.glibRuntimeObject);
  assert.deepEqual(plan.action.inputs, [
    targetRuntimeArtifactIds.sourceTree,
    "sdk/glib/include",
    "headers/scriptc/runtime",
  ]);
  /* A cacheable compile also asks Clang for the list of files it read, which
   * is what lets the entry be revalidated. */
  assert.deepEqual(plan.action.arguments.slice(-7), [
    { kind: "literal", value: "-MD" },
    { kind: "literal", value: "-MF" },
    { kind: "dependency-path" },
    { kind: "literal", value: "-c" },
    {
      kind: "input-path",
      artifact: targetRuntimeArtifactIds.sourceTree,
      path: "nts_glib_runtime.c",
    },
    { kind: "literal", value: "-o" },
    { kind: "output-path", artifact: targetRuntimeArtifactIds.glibRuntimeObject },
  ]);
  assert.equal(plan.action.recordsDependencies, true);
  assert.equal(plan.action.cacheable, true);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.action.arguments), true);
});

test("GTK target objects compose one fragment with per-object dialect policy", () => {
  const sdkArguments = [
    { kind: "input-path", artifact: "sdk/gtk4/include" },
  ] as const;
  const plan = planGtkTargetObjects({
    adapters: [{ slug: "gtk4", adapter: {
      schema: "native-typescript.gobject-adapter-source",
      schemaVersion: 8,
      source: "/* generated */\n",
      sourceDigest: `sha256:${"3".repeat(64)}`,
      constructors: [],
      signalConnection: null,
      signals: [],
      valueMethods: [],
      classReleases: [],
      errorSupport: null,
      retainedResultMethods: [],
      throwingMethods: [],
    } }],
    targetRuntimeSourceTreeDigest: `sha256:${"1".repeat(64)}`,
    scriptcRuntimeHeaders: { artifact: "headers/scriptc/runtime" },
    sdkArguments,
    tool: {
      id: "tool/clang",
      version: "1",
      digest: `sha256:${"2".repeat(64)}`,
    },
    executionPlatform: "x86_64-linux",
    target: "x86_64-unknown-linux-gnu",
  });

  assert.equal(plan.runtime.object.id, targetRuntimeArtifactIds.glibRuntimeObject);
  assert.equal(
    plan.application.object.id,
    targetRuntimeArtifactIds.applicationObject,
  );
  assert.equal(plan.adapters[0]?.plan.source.id, "source/gtk4/gobject-adapters");
  assert.equal(plan.adapters[0]?.plan.object.id, "object/gtk4/gobject-adapters");

  // The GLib runtime is portable C held to the strict dialect; the application
  // bootstrap and the generated GObject adapters reach GNU extensions through
  // the GTK headers.
  const literals = (action: (typeof plan)["runtime"]["action"]): string[] =>
    action.arguments.flatMap((argument) =>
      argument.kind === "literal" ? [argument.value] : [],
    );
  assert.deepEqual(literals(plan.runtime.action).slice(0, 6), [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-pedantic",
  ]);
  assert.deepEqual(literals(plan.application.action).slice(0, 5), [
    "-std=gnu11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
  ]);
  assert.deepEqual(literals(plan.adapters[0]!.plan.action).slice(0, 4), [
    "-std=gnu11",
    "-Wall",
    "-Wextra",
    "-Werror",
  ]);

  // Every object sees the SDK include tree, and the fragment declares it.
  for (const action of [
    plan.runtime.action,
    plan.application.action,
    plan.adapters[0]!.plan.action,
  ]) {
    assert.equal(action.inputs.includes("sdk/gtk4/include"), true);
  }

  assert.deepEqual(
    plan.artifacts.map(({ id }) => id),
    [
      targetRuntimeArtifactIds.sourceTree,
      targetRuntimeArtifactIds.glibRuntimeObject,
      targetRuntimeArtifactIds.applicationObject,
      "source/gtk4/gobject-adapters",
      "object/gtk4/gobject-adapters",
    ],
  );
  assert.deepEqual(plan.actions, [
    plan.runtime.action,
    plan.application.action,
    plan.adapters[0]!.plan.action,
  ]);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.artifacts), true);
  assert.equal(Object.isFrozen(plan.actions), true);
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
          join(targetPackage, targetRuntimeNative.glibRuntime.source),
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
