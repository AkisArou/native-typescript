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
  "checked static, constructor, and instance calls use JVM coordinates without JNI",
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
          constructors: ["(I)V"],
          methods: [
            { name: "depth", descriptor: "()I" },
            { name: "nameLength", descriptor: "(Ljava/lang/String;)I" },
          ],
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
    const translated = translateScabiNativeProgram(generated.manifest, {
      imports: [
        "fixture.object.release",
        "fixture.fixture.widget.constructor",
        "fixture.fixture.widget.depth",
        "fixture.fixture.widget.namelength",
      ],
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
          "export function objectDepth(): number {\n" +
          "  const widget = new Widget(7);\n" +
          "  return widget.depth();\n" +
          "}\n" +
          "export function suppliedDepth(widget: Widget): number {\n" +
          "  return widget.depth();\n" +
          "}\n" +
          "const LOOP_LIMIT = 50000;\n" +
          "export function integerLoop(): number {\n" +
          "  let index = 0;\n" +
          "  let checksum = 0;\n" +
          "  while (index < LOOP_LIMIT) {\n" +
          "    checksum = checksum + (index & 1);\n" +
          "    index = index + 1;\n" +
          "  }\n" +
          "  return checksum;\n" +
          "}\n" +
          "export function integerLoopAcrossNative(widget: Widget): number {\n" +
          "  let index = 0;\n" +
          "  let checksum = 0;\n" +
          "  while (index < LOOP_LIMIT) {\n" +
          "    checksum = checksum + (widget.depth() & 1);\n" +
          "    index = index + 1;\n" +
          "  }\n" +
          "  return checksum;\n" +
          "}\n" +
          "export function overflowingNumber(): number {\n" +
          "  let value = 2147483647;\n" +
          "  value = value + 1;\n" +
          "  return value;\n" +
          "}\n" +
          "export function fractionalNumber(): number {\n" +
          "  let value = 0.5;\n" +
          "  value = value + 1;\n" +
          "  return value;\n" +
          "}\n" +
          "export function negativeZeroNumber(): number {\n" +
          "  let value = -0;\n" +
          "  return 1 / value;\n" +
          "}\n" +
          "stringLength();\n" +
          "objectDepth();\n",
      );
      writeFileSync(declarations, generated.declarations);
      const planners = await loadScriptCExecutablePlanners();
      const planned = planners.planExecutableCompilation(source, {
        backend: "c",
        externalFunctionRoots: [
          "suppliedDepth",
          "integerLoop",
          "integerLoopAcrossNative",
          "overflowingNumber",
          "fractionalNumber",
          "negativeZeroNumber",
        ],
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
        }, {
          functionName: "objectDepth",
          methodName: "objectDepth",
        }, {
          functionName: "suppliedDepth",
          methodName: "suppliedDepth",
        }, {
          functionName: "integerLoop",
          methodName: "integerLoop",
        }, {
          functionName: "integerLoopAcrossNative",
          methodName: "integerLoopAcrossNative",
        }, {
          functionName: "overflowingNumber",
          methodName: "overflowingNumber",
        }, {
          functionName: "fractionalNumber",
          methodName: "fractionalNumber",
        }, {
          functionName: "negativeZeroNumber",
          methodName: "negativeZeroNumber",
        }],
      });
      assert.equal(javaSource.match(/\bint l_[0-9a-f]+ = 0;/gu)?.length, 2);
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
          "    System.out.println(DirectBinding.objectDepth());\n" +
          "    System.out.println(DirectBinding.suppliedDepth(new fixture.Widget(9)));\n" +
          "    System.out.println(DirectBinding.integerLoop());\n" +
          "    System.out.println(DirectBinding.integerLoopAcrossNative(new fixture.Widget(9)));\n" +
          "    System.out.println(DirectBinding.overflowingNumber());\n" +
          "    System.out.println(DirectBinding.fractionalNumber());\n" +
          "    System.out.println(DirectBinding.negativeZeroNumber());\n" +
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
      assert.match(bytecode, /fixture\/Widget\."<init>":\(I\)V/u);
      assert.match(bytecode, /fixture\/Widget\.depth:\(\)I/u);
      assert.doesNotMatch(bytecode, /nts_jvm_fixture/u);
      assert.doesNotMatch(bytecode, / native /u);
      const run = spawnSync(
        join(javaHome!, "bin/java"),
        ["-cp", `${classes}:${fixtureClasses}`, "dev.nts.generated.Harness"],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0);
      assert.equal(
        run.stdout,
        "6.0\n7.0\n9.0\n25000.0\n50000.0\n2.147483648E9\n1.5\n-Infinity\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
