import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  generateJvmAdapterSource,
  generateJvmClangAbiProbe,
  generateJvmScabiPackage,
  ingestJvmClasses,
} from "@native-typescript/bindgen-jvm";
import {
  digestClangAbiEvidence,
  renderCFunctionPointerType,
} from "@native-typescript/bindgen-c";
import type {
  ClangAbiEvidenceSnapshot,
  ClangAbiProbe,
} from "@native-typescript/bindgen-c";
import {
  loadScriptCExecutablePlanners,
  loadScriptCJvmEmitter,
  translateScabiNativeProgram,
} from "@native-typescript/scriptc";
import { discoverJavaHome } from "@native-typescript/target-jvm";

const workspace = join(import.meta.dirname, "..");
const scriptcRoot = join(workspace, "third_party/scriptc");
const fixtureClasses = join(workspace, "fixtures/jvm/classes");
const widgetClass = join(fixtureClasses, "fixture/Widget.class");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const javaHome = discoverJavaHome();

function evidence(probe: ClangAbiProbe): ClangAbiEvidenceSnapshot {
  const clang = Object.freeze({
    toolId: "tool/clang",
    version: "test",
    digest: `sha256:${"a".repeat(64)}`,
    target: "x86_64-unknown-linux-gnu",
  });
  const functions = Object.freeze(probe.functions.map((function_) => {
    const type = renderCFunctionPointerType(function_, "");
    return Object.freeze({
      id: function_.id,
      symbol: function_.symbol,
      expectedType: type,
      clangType: type,
    });
  }));
  return Object.freeze({
    schema: "native-typescript.clang-abi-evidence",
    schemaVersion: 3,
    probeDigest: probe.sourceDigest,
    semanticDigest: digestClangAbiEvidence({
      probeDigest: probe.sourceDigest,
      clang,
      functions,
      records: [],
      enums: [],
    }),
    clang,
    functions,
    records: Object.freeze([]),
    enums: Object.freeze([]),
  });
}

test(
  "a checked native call uses authoritative JVM coordinates without JNI",
  { skip: javaHome === null ? "no JDK on this host" : false },
  async () => {
    execFileSync(pnpm, ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"]);
    const snapshot = ingestJvmClasses(
      [{
        logicalPath: "fixtures/jvm/classes/fixture/Widget.class",
        bytes: readFileSync(widgetClass),
      }],
      {
        classes: [{
          binaryName: "fixture/Widget",
          methods: [{ name: "nameLength", descriptor: "(Ljava/lang/String;)I" }],
        }],
      },
    );
    const adapter = generateJvmAdapterSource(snapshot, { packageSlug: "fixture" });
    const generated = generateJvmScabiPackage({
      snapshot,
      adapter,
      packageSlug: "fixture",
      evidence: evidence(generateJvmClangAbiProbe(adapter)),
      package: {
        name: "@native-typescript/jvm-fixture",
        version: "0.0.0",
        namespace: "native-typescript.jvm-fixture",
        instance: "native-typescript.jvm-fixture@0.0.0",
      },
      target: {
        triple: "x86_64-unknown-linux-gnu",
        architecture: "x86_64",
        pointerWidth: 64,
        endianness: "little",
        objectFormat: "elf",
        minimumPlatformVersion: "glibc-2.17",
        abi: "sysv-amd64",
        features: ["jvm"],
      },
      sdk: {
        vendor: "openjdk",
        name: "jdk",
        version: "21",
        deploymentTarget: "21",
        modules: ["fixture"],
      },
      linkInputs: [
        { id: "link.jvm", kind: "shared-library", name: "jvm", order: 0 },
      ],
      adapterInput: { id: "fixture.jvm-adapters", output: "jvm-adapters.o" },
    });
    const selectedBinding = "fixture.fixture.widget.namelength";
    const translated = translateScabiNativeProgram(generated.manifest, {
      imports: [selectedBinding],
      exports: [],
    });
    assert.equal(translated.ok, true);
    if (!translated.ok) return;

    const root = mkdtempSync(join(tmpdir(), "nts-jvm-direct-binding-"));
    try {
      const source = join(root, "app.ts");
      const declarations = join(root, "package.d.ts");
      writeFileSync(
        source,
        'import { Widget } from "@native-typescript/jvm-fixture";\n' +
          "export function stringLength(): number {\n" +
          '  return Widget.nameLength("direct");\n' +
          "}\n" +
          "stringLength();\n",
      );
      writeFileSync(declarations, generated.declarations);
      const planners = await loadScriptCExecutablePlanners();
      const planned = planners.planExecutableCompilation(source, {
        backend: "c",
        sourceRoot: root,
        externalTypes: {
          [generated.manifest.package.name]: declarations,
        },
        native: translated.input,
      });
      assert.equal(
        planned.ok,
        true,
        planned.ok ? undefined : planned.diagnostics.map(({ message }) => message).join("\n"),
      );
      if (!planned.ok) return;

      const emitter = await loadScriptCJvmEmitter();
      const javaSource = emitter.emitJvmSerializedModule(planned.plan.ir, {
        packageName: "dev.nts.generated",
        className: "DirectBinding",
        nativeBindings: generated.directBindings.bindings,
        functionExports: [{
          functionName: "stringLength",
          methodName: "stringLength",
        }],
      });
      const javaRoot = join(root, "java/dev/nts/generated");
      const classes = join(root, "classes");
      mkdirSync(javaRoot, { recursive: true });
      mkdirSync(classes);
      const javaPath = join(javaRoot, "DirectBinding.java");
      const harnessPath = join(javaRoot, "Harness.java");
      writeFileSync(javaPath, javaSource);
      writeFileSync(
        harnessPath,
        "package dev.nts.generated;\n" +
          "public final class Harness {\n" +
          "  public static void main(String[] args) {\n" +
          "    System.out.println(DirectBinding.stringLength());\n" +
          "  }\n" +
          "}\n",
      );
      execFileSync(join(javaHome!, "bin/javac"), [
        "--release",
        "17",
        "-classpath",
        fixtureClasses,
        "-d",
        classes,
        javaPath,
        harnessPath,
      ]);
      const bytecode = execFileSync(
        join(javaHome!, "bin/javap"),
        ["-classpath", `${classes}:${fixtureClasses}`, "-c", "-p", "dev.nts.generated.DirectBinding"],
        { encoding: "utf8" },
      );
      assert.match(
        bytecode,
        /fixture\/Widget\.nameLength:\(Ljava\/lang\/String;\)I/u,
      );
      assert.doesNotMatch(bytecode, /nts_jvm_fixture/u);
      assert.doesNotMatch(bytecode, / native /u);
      const run = spawnSync(
        join(javaHome!, "bin/java"),
        ["-cp", `${classes}:${fixtureClasses}`, "dev.nts.generated.Harness"],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0);
      assert.equal(run.stdout, "6.0\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
