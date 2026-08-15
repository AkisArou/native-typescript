import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  parseClangFunctionEvidence,
  planClangFunctionProbe,
} from "@native-typescript/bindgen-c";
import {
  defineArtifactGraph,
  executeArtifactGraph,
  resolvePkgConfigCompileSdk,
} from "@native-typescript/core";
import type { ArtifactActionDefinition } from "@native-typescript/core";
import {
  generateGirClangFunctionProbe,
  ingestGir,
} from "@native-typescript/target-gtk";

const systemGtkGir = "/usr/share/gir-1.0/Gtk-4.0.gir";
const target = "x86_64-unknown-linux-gnu";
const executionPlatform = "x86_64-linux";
const hasGtk = spawnSync("pkg-config", ["--exists", "gtk4"]).status === 0;
const hasClang = spawnSync("clang", ["--version"]).status === 0;
const hasBubblewrap = spawnSync("bwrap", ["--version"]).status === 0;

function executable(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching explicit PATH entries.
    }
  }
  throw new Error(`Required executable is unavailable: ${name}`);
}

function toolIdentity(path: string): ArtifactActionDefinition["tool"] {
  const result = spawnSync(path, ["--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const version = /clang version ([^\s]+)/u.exec(result.stdout)?.[1];
  assert.ok(version);
  return {
    id: "tool/clang",
    version,
    digest: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
  };
}

test(
  "selected Gtk GIR callables agree with authoritative Clang headers",
  {
    skip:
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      !existsSync(systemGtkGir) ||
      !hasGtk ||
      !hasClang ||
      !hasBubblewrap,
  },
  async () => {
    const snapshot = ingestGir(readFileSync(systemGtkGir, "utf8"), {
      logicalPath: "system-sdk/gir/Gtk-4.0.gir",
      namespace: { name: "Gtk", version: "4.0" },
      classes: [
        {
          name: "Button",
          constructors: ["new_with_label"],
          methods: ["get_label", "set_label"],
          signals: ["clicked"],
        },
      ],
    });
    const probe = generateGirClangFunctionProbe(snapshot);
    assert.deepEqual(probe.functions.map(({ symbol }) => symbol), [
      "gtk_button_new_with_label",
      "gtk_button_get_label",
      "gtk_button_set_label",
    ]);
    assert.equal(probe.source.includes("clicked"), false);

    const clangPath = executable("clang");
    const pkgConfigPath = executable("pkg-config");
    const bubblewrapPath = executable("bwrap");
    const clang = toolIdentity(clangPath);
    const sdk = await resolvePkgConfigCompileSdk({
      id: "gtk4-clang-evidence",
      executable: pkgConfigPath,
      modules: ["gtk4"],
      target,
    });
    const plan = planClangFunctionProbe({
      probe,
      sourceArtifactId: "source/gtk4/clang-function-probe",
      evidenceArtifactId: "metadata/gtk4/clang-function-evidence",
      actionId: "inspect/gtk4/clang-functions",
      logicalPath: "generated/gtk4/clang-function-probe.c",
      arguments: sdk.arguments,
      tool: clang,
      executionPlatform,
      target,
    });
    const graph = defineArtifactGraph({
      artifacts: [plan.source, ...sdk.artifacts, plan.evidence],
      actions: [plan.action],
    });
    assert.equal(JSON.stringify(graph).includes("/usr/include"), false);

    const temporaryRoot = mkdtempSync(join(tmpdir(), "native-typescript-gtk-clang-"));
    try {
      const sourcePath = join(temporaryRoot, "clang-function-probe.c");
      writeFileSync(sourcePath, probe.source);
      const report = await executeArtifactGraph(graph, {
        buildRoot: join(temporaryRoot, "build"),
        sourcePaths: {
          ...sdk.sourcePaths,
          [plan.source.id]: sourcePath,
        },
        tools: { [clang.id]: { path: clangPath } },
        sandbox: { kind: "bubblewrap", path: bubblewrapPath },
      });
      const ast = report.artifacts.find(({ id }) => id === plan.evidence.id);
      assert.ok(ast);
      const evidence = parseClangFunctionEvidence(readFileSync(ast.path, "utf8"), {
        probe,
        clang: {
          toolId: clang.id,
          version: clang.version,
          digest: clang.digest,
          target,
        },
      });
      assert.deepEqual(evidence.functions.map(({ symbol }) => symbol), [
        "gtk_button_new_with_label",
        "gtk_button_get_label",
        "gtk_button_set_label",
      ]);
      assert.match(evidence.semanticDigest, /^sha256:[0-9a-f]{64}$/u);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);
