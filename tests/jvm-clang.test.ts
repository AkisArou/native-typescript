import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  parseClangAbiEvidence,
  planClangAbiProbe,
  renderCFunctionPointerType,
} from "@native-typescript/bindgen-c";
import {
  defineArtifactGraph,
  digestArtifactPath,
  executeArtifactGraph,
} from "@native-typescript/core";
import type {
  ArtifactActionDefinition,
  ArtifactDefinition,
} from "@native-typescript/core";
import {
  generateJvmAdapterSource,
  generateJvmClangAbiProbe,
  ingestJvmClasses,
} from "@native-typescript/bindgen-jvm";

const repositoryRoot = resolve(import.meta.dirname, "..");
const target = "x86_64-unknown-linux-gnu";
const executionPlatform = "x86_64-linux";

function executable(name: string): string | null {
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
  return null;
}

function discoverJavaHome(): string | null {
  const fromEnv = process.env["JAVA_HOME"];
  if (fromEnv !== undefined && existsSync(join(fromEnv, "include/jni.h"))) {
    return fromEnv;
  }
  try {
    const stderr = spawnSync(
      "sh",
      ["-c", "java -XshowSettings:properties -version 2>&1 >/dev/null"],
      { encoding: "utf8" },
    ).stdout;
    const match = stderr?.match(/java\.home = (.+)/u);
    if (match == null) return null;
    const home = match[1]!.trim();
    return existsSync(join(home, "include/jni.h")) ? home : null;
  } catch {
    return null;
  }
}

const jdk = discoverJavaHome();
const clangPath = executable("clang");
const sandboxPath = executable("bwrap");
const skip = jdk === null
  ? "no JDK with include/jni.h on this host"
  : clangPath === null
    ? "clang is unavailable"
    : sandboxPath === null
      ? "bwrap is unavailable"
      : false;

function digest(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function clangIdentity(path: string): ArtifactActionDefinition["tool"] {
  const probe = spawnSync(path, ["--version"], { encoding: "utf8" });
  const version = /clang version ([^\s]+)/u.exec(probe.stdout)?.[1];
  assert.ok(version !== undefined);
  return { id: "tool/clang", version, digest: digest(path) };
}

test(
  "the adapter probe compiles against the real jni.h and the evidence agrees",
  { skip },
  async () => {
    const snapshot = ingestJvmClasses(
      [
        {
          logicalPath: "fixtures/jvm/classes/fixture/Widget.class",
          bytes: readFileSync(
            resolve(repositoryRoot, "fixtures/jvm/classes/fixture/Widget.class"),
          ),
        },
      ],
      {
        classes: [
          {
            binaryName: "fixture/Widget",
            constructors: ["()V", "(I)V"],
            methods: [
              "depth",
              "checkedAdd",
              "nativeHandle",
              "sumBytes",
              "reverseBytes",
              "splitWords",
              "joinWords",
              { name: "resize", descriptor: "(II)V" },
              { name: "resize", descriptor: "(D)V" },
            ],
          },
        ],
      },
    );
    const adapter = generateJvmAdapterSource(snapshot, { packageSlug: "fixture" });
    const probe = generateJvmClangAbiProbe(adapter);
    const temporaryRoot = mkdtempSync(join(tmpdir(), "native-typescript-jvm-clang-"));
    try {
      const sourcePath = join(temporaryRoot, "probe.c");
      writeFileSync(sourcePath, probe.source);
      /* The adapter's declarations are part of the probed surface: no SDK
       * header declares generated symbols. */
      const adapterIncludeRoot = join(temporaryRoot, "adapter-include");
      mkdirSync(adapterIncludeRoot);
      writeFileSync(join(adapterIncludeRoot, adapter.headerFileName), adapter.header);
      const includeRoot = join(jdk!, "include");
      const includeLinux = join(jdk!, "include/linux");
      const includeArtifact: ArtifactDefinition = {
        id: "sdk/jdk-include",
        kind: "sdk",
        entryType: "directory",
        mediaType: "inode/directory",
        target,
        domain: "target",
        cache: "none",
        origin: {
          kind: "source",
          digest: (await digestArtifactPath(includeRoot, "directory")).digest,
          fileName: "jdk-include",
          logicalPath: "jdk/include",
        },
      };
      const includeLinuxArtifact: ArtifactDefinition = {
        id: "sdk/jdk-include-linux",
        kind: "sdk",
        entryType: "directory",
        mediaType: "inode/directory",
        target,
        domain: "target",
        cache: "none",
        origin: {
          kind: "source",
          digest: (await digestArtifactPath(includeLinux, "directory")).digest,
          fileName: "jdk-include-linux",
          logicalPath: "jdk/include/linux",
        },
      };
      const adapterIncludeArtifact: ArtifactDefinition = {
        id: "sdk/adapter-include",
        kind: "sdk",
        entryType: "directory",
        mediaType: "inode/directory",
        target,
        domain: "target",
        cache: "none",
        origin: {
          kind: "source",
          digest: (await digestArtifactPath(adapterIncludeRoot, "directory")).digest,
          fileName: "adapter-include",
          logicalPath: "generated/jvm-clang/adapter-include",
        },
      };
      const tool = clangIdentity(clangPath!);
      const plan = planClangAbiProbe({
        probe,
        sourceArtifactId: "source/jvm-clang/probe",
        rawAstArtifactId: "metadata/jvm-clang/raw-ast",
        rawLlvmArtifactId: "metadata/jvm-clang/raw-llvm",
        astActionId: "inspect/jvm-clang/ast",
        llvmActionId: "inspect/jvm-clang/calling-convention",
        logicalPath: "generated/jvm-clang/fixture-probe.c",
        arguments: [
          { kind: "literal", value: "-I" },
          { kind: "input-path", artifact: includeArtifact.id },
          { kind: "literal", value: "-I" },
          { kind: "input-path", artifact: includeLinuxArtifact.id },
          { kind: "literal", value: "-I" },
          { kind: "input-path", artifact: adapterIncludeArtifact.id },
        ],
        tool,
        executionPlatform,
        target,
      });
      const graph = defineArtifactGraph({
        artifacts: [
          plan.source,
          includeArtifact,
          includeLinuxArtifact,
          adapterIncludeArtifact,
          plan.rawAst,
          plan.rawLlvm,
        ],
        actions: [plan.astAction, plan.llvmAction],
      });
      const report = await executeArtifactGraph(graph, {
        buildRoot: join(temporaryRoot, "build"),
        sourcePaths: {
          [plan.source.id]: sourcePath,
          [includeArtifact.id]: includeRoot,
          [includeLinuxArtifact.id]: includeLinux,
          [adapterIncludeArtifact.id]: adapterIncludeRoot,
        },
        tools: { [tool.id]: { path: clangPath! } },
        sandbox: { kind: "bubblewrap", path: sandboxPath! },
      });
      const ast = report.artifacts.find(({ id }) => id === plan.rawAst.id);
      const llvm = report.artifacts.find(({ id }) => id === plan.rawLlvm.id);
      assert.ok(ast !== undefined && llvm !== undefined);
      const evidence = parseClangAbiEvidence(
        readFileSync(ast!.path, "utf8"),
        readFileSync(llvm!.path, "utf8"),
        {
          probe,
          clang: {
            toolId: tool.id,
            version: tool.version,
            digest: tool.digest,
            target,
          },
        },
      );
      /* The claim the manifest will make, proven against the platform's own
       * header: every adapter symbol's real signature is exactly the one
       * the probe expected — jint's width included, which is the fact
       * nothing else in the pipeline is allowed to assume. The renderer
       * spells pointers the way Clang does (079fa0b6, e0cd470d), so the
       * comparison is exact. */
      assert.equal(evidence.functions.length, probe.functions.length);
      probe.functions.forEach((function_, index) => {
        const entry = evidence.functions[index]!;
        assert.equal(entry.symbol, function_.symbol);
        assert.equal(entry.expectedType, renderCFunctionPointerType(function_, ""));
        assert.equal(entry.clangType, entry.expectedType, function_.symbol);
      });
      const bind = evidence.functions.find(
        ({ symbol }) => symbol === adapter.bind.adapterSymbol,
      );
      assert.equal(bind?.clangType, "jint (*)(JNIEnv *, char **)");
      /* The byte-span pair, byte-exact: one adapter position, two probed
       * slots, spelled the way Clang spells them. */
      const sumBytes = evidence.functions.find(({ symbol }) =>
        symbol.endsWith("_sumBytes")
      );
      assert.equal(
        sumBytes?.clangType,
        "jint (*)(const uint8_t *, size_t, char **)",
      );
      /* A byte-span result: owned pointer out, its length in a
       * compiler-owned out slot beside the error slot. */
      const reverseBytes = evidence.functions.find(({ symbol }) =>
        symbol.endsWith("_reverseBytes")
      );
      assert.equal(
        reverseBytes?.clangType,
        "uint8_t *(*)(const uint8_t *, size_t, size_t *, char **)",
      );
      /* A string-vector result and its two-level release, byte-exact. */
      const splitWords = evidence.functions.find(({ symbol }) =>
        symbol.endsWith("_splitWords")
      );
      assert.equal(
        splitWords?.clangType,
        "char **(*)(const char *, char **)",
      );
      const strvFree = evidence.functions.find(({ symbol }) =>
        symbol.endsWith("_strv_free")
      );
      assert.equal(strvFree?.clangType, "void (*)(char **)");
      /* A borrowed vector argument's double-const spelling, byte-exact. */
      const joinWords = evidence.functions.find(({ symbol }) =>
        symbol.endsWith("_joinWords")
      );
      assert.equal(
        joinWords?.clangType,
        "char *(*)(const char *const *, char **)",
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);
