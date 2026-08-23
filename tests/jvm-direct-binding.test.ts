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
  generateJvmSubclassSource,
  ingestJvmClasses,
  JvmIngestionError,
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
            { name: "reverseBytes", descriptor: "([B)[B" },
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
        "fixture.fixture.widget.reversebytes",
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
          "export function nullableDepth(widget: Widget, present: boolean): number {\n" +
          "  const candidate: Widget | null = present ? widget : null;\n" +
          "  if (candidate === null) return -1;\n" +
          "  return candidate.depth();\n" +
          "}\n" +
          "export function utf16Length(value: string): number {\n" +
          "  return value.length;\n" +
          "}\n" +
          "export function reversedByteLength(value: Uint8Array): number {\n" +
          "  return Widget.reverseBytes(value).length;\n" +
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
          "nullableDepth",
          "utf16Length",
          "reversedByteLength",
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
          functionName: "nullableDepth",
          methodName: "nullableDepth",
        }, {
          functionName: "utf16Length",
          methodName: "utf16Length",
        }, {
          functionName: "reversedByteLength",
          methodName: "reversedByteLength",
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
          "    System.out.println(DirectBinding.nullableDepth(new fixture.Widget(11), true));\n" +
          "    System.out.println(DirectBinding.nullableDepth(new fixture.Widget(11), false));\n" +
          "    System.out.println(DirectBinding.utf16Length(\"👩‍💻\"));\n" +
          "    System.out.println(DirectBinding.reversedByteLength(new byte[] {1, 2, 3, 4}));\n" +
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
      assert.match(bytecode, /java\/lang\/String\.length:\(\)I/u);
      assert.match(bytecode, /fixture\/Widget\.reverseBytes:\(\[B\)\[B/u);
      assert.match(bytecode, /arraylength/u);
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
        "6.0\n7.0\n9.0\n11.0\n-1.0\n5.0\n4.0\n25000.0\n50000.0\n2.147483648E9\n1.5\n-Infinity\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a generated interface callback stays inside the JVM",
  { skip: javaHome === null ? "no JDK on this host" : false },
  async () => {
    execFileSync(pnpm, ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"]);
    const root = mkdtempSync(join(tmpdir(), "nts-jvm-direct-callback-"));
    try {
      const clickableClass = join(fixtureClasses, "fixture/Clickable.class");
      const buttonClass = join(fixtureClasses, "fixture/Button.class");
      const bridge = generateJvmSubclassSource(
        ingestJvmClasses(
          [{
            logicalPath: "fixtures/jvm/classes/fixture/Clickable.class",
            bytes: readFileSync(clickableClass),
          }],
          {
            classes: [{
              binaryName: "fixture/Clickable",
              methods: [{ name: "onClick", descriptor: "(Lfixture/Button;)V" }],
            }],
          },
        ),
        {
          baseBinaryName: "fixture/Clickable",
          overrides: [{ name: "onClick", descriptor: "(Lfixture/Button;)V" }],
          subclassBinaryName: "fixture/ClickBridge",
        },
      );
      assert.deepEqual(bridge.callbacks, [{
        name: "onClick",
        descriptor: "(Lfixture/Button;)V",
        delivery: "synchronous",
        directImplementation: {
          kind: "generated-interface",
          interfaceBinaryName: "fixture/Clickable",
        },
      }]);
      const generatedSources = join(root, "generated-sources");
      const bridgeSource = join(generatedSources, bridge.logicalPath);
      const hostSource = join(generatedSources, "fixture/CallbackHost.java");
      const supportClasses = join(root, "support-classes");
      mkdirSync(join(generatedSources, "fixture"), { recursive: true });
      mkdirSync(supportClasses);
      writeFileSync(bridgeSource, bridge.source);
      writeFileSync(
        hostSource,
        "package fixture;\n" +
          "public final class CallbackHost {\n" +
          "  public static void deliver(Clickable listener, Button source) {\n" +
          "    listener.onClick(source);\n" +
          "  }\n" +
          "}\n",
      );
      execFileSync(join(javaHome!, "bin/javac"), [
        "--release",
        "17",
        "-classpath",
        fixtureClasses,
        "-d",
        supportClasses,
        bridgeSource,
        hostSource,
      ]);

      /* A selection is not a complete class. Prove the stated role is
       * checked against the bytes by adding one UNSELECTED field: inference
       * from the projected snapshot would miss it and incorrectly admit the
       * direct replacement. */
      const falseSources = join(root, "false-shell-sources");
      const falseClasses = join(root, "false-shell-classes");
      const falseSource = join(falseSources, bridge.logicalPath);
      mkdirSync(join(falseSources, "fixture"), { recursive: true });
      mkdirSync(falseClasses);
      writeFileSync(
        falseSource,
        bridge.source.replace(/\n\}\n$/u, "\n  public int hiddenState;\n}\n"),
      );
      execFileSync(join(javaHome!, "bin/javac"), [
        "--release",
        "17",
        "-classpath",
        fixtureClasses,
        "-d",
        falseClasses,
        falseSource,
      ]);
      assert.throws(
        () => ingestJvmClasses(
          [{
            logicalPath: "fixtures/jvm/classes/fixture/Clickable.class",
            bytes: readFileSync(clickableClass),
          }, {
            logicalPath: "fixtures/jvm/classes/fixture/Button.class",
            bytes: readFileSync(buttonClass),
          }, {
            logicalPath: "generated/fixture/ClickBridge.class",
            bytes: readFileSync(
              join(falseClasses, "fixture/ClickBridge.class"),
            ),
          }],
          {
            classes: [{ binaryName: "fixture/Clickable" }, {
              binaryName: "fixture/Button",
            }, {
              binaryName: "fixture/ClickBridge",
              constructors: ["()V"],
              callbacks: bridge.callbacks,
            }],
          },
        ),
        (error: unknown) => {
          assert.ok(error instanceof JvmIngestionError);
          assert.match(
            error.diagnostics[0]!.message,
            /complete class file contains another constructor, method, field/u,
          );
          return true;
        },
      );

      const snapshot = ingestJvmClasses(
        [{
          logicalPath: "fixtures/jvm/classes/fixture/Widget.class",
          bytes: readFileSync(widgetClass),
        }, {
          logicalPath: "fixtures/jvm/classes/fixture/Clickable.class",
          bytes: readFileSync(clickableClass),
        }, {
          logicalPath: "fixtures/jvm/classes/fixture/Button.class",
          bytes: readFileSync(buttonClass),
        }, {
          logicalPath: "generated/fixture/ClickBridge.class",
          bytes: readFileSync(join(supportClasses, "fixture/ClickBridge.class")),
        }, {
          logicalPath: "generated/fixture/CallbackHost.class",
          bytes: readFileSync(join(supportClasses, "fixture/CallbackHost.class")),
        }],
        {
          classes: [{
            binaryName: "fixture/Widget",
            constructors: ["(I)V"],
            methods: [{ name: "depth", descriptor: "()I" }],
          }, {
            binaryName: "fixture/Clickable",
          }, {
            binaryName: "fixture/Button",
            constructors: ["(Ljava/lang/String;)V"],
          }, {
            binaryName: "fixture/ClickBridge",
            constructors: ["()V"],
            callbacks: bridge.callbacks,
          }, {
            binaryName: "fixture/CallbackHost",
            methods: [{
              name: "deliver",
              descriptor: "(Lfixture/Clickable;Lfixture/Button;)V",
            }],
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
          name: "@native-typescript/jvm-callback-fixture",
          version: "0.0.0",
          namespace: "native-typescript.jvm-callback-fixture",
          instance: "native-typescript.jvm-callback-fixture@0.0.0",
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
      const callbackDirect = generated.directBindings.bindings.find(
        ({ kind }) => kind === "instance-callback",
      );
      assert.deepEqual(callbackDirect, {
        id: "native-typescript.jvm-callback-fixture@0.0.0#fixture.fixture.clickbridge.onclick",
        kind: "instance-callback",
        ownerBinaryName: "fixture/ClickBridge",
        name: "onClick",
        descriptor: "(Lfixture/Button;)V",
        nativeEntrySymbol: "nts_jvm_fixture_connect_fixture_ClickBridge_onClick",
        interfaceBinaryName: "fixture/Clickable",
        cancellation: {
          bindingId: "native-typescript.jvm-callback-fixture@0.0.0#fixture.connection.disconnect",
          nativeEntrySymbol: "nts_jvm_fixture_disconnect",
        },
      });
      const localIds = [
        "fixture.object.release",
        "fixture.fixture.widget.constructor",
        "fixture.fixture.widget.depth",
        "fixture.fixture.button.constructor",
        "fixture.fixture.clickbridge.constructor",
        "fixture.fixture.clickbridge.onclick",
        "fixture.fixture.callbackhost.deliver",
      ];
      const translated = translateScabiNativeProgram(generated.manifest, {
        imports: localIds,
        exports: [],
      });
      assert.equal(translated.ok, true);
      if (!translated.ok) return;

      const source = join(root, "callback.ts");
      const declarations = join(root, "package.d.ts");
      writeFileSync(
        source,
        'import { Button, CallbackHost, ClickBridge, JvmConnection, Widget } from "@native-typescript/jvm-callback-fixture";\n' +
          "let retained: JvmConnection | null = null;\n" +
          "export function runCallback(): number {\n" +
          "  let delivered = 0;\n" +
          "  let target = new Widget(5);\n" +
          "  const stable = new Widget(3);\n" +
          '  const button = new Button("direct");\n' +
          "  const clicks = new ClickBridge();\n" +
          "  retained = clicks.onClick((source) => { if (source !== null) delivered += target.depth() + stable.depth() + source.depth() + 1; });\n" +
          "  target = new Widget(9);\n" +
          "  CallbackHost.deliver(clicks, button);\n" +
          "  CallbackHost.deliver(clicks, button);\n" +
          "  return delivered;\n" +
          "}\n" +
          "runCallback();\n",
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
        className: "DirectCallback",
        nativeBindings: generated.directBindings.bindings,
        functionExports: [{ functionName: "runCallback", methodName: "runCallback" }],
      });
      assert.match(javaSource, /private static final class NtsDoubleBox/u);
      assert.match(javaSource, /private static final class NtsReferenceBox/u);
      assert.match(
        javaSource,
        /\.ntsRegister0\(l_[0-9a-f]+, l_[0-9a-f]+, l_[0-9a-f]+\)/u,
      );
      assert.match(javaSource, /new NtsCallbackAdapter0\(\)/u);
      assert.doesNotMatch(javaSource, /private interface NtsCallback/u);
      const javaRoot = join(root, "java/dev/nts/generated");
      const classes = join(root, "classes");
      mkdirSync(javaRoot, { recursive: true });
      mkdirSync(classes);
      const javaPath = join(javaRoot, "DirectCallback.java");
      const harnessPath = join(javaRoot, "CallbackHarness.java");
      writeFileSync(javaPath, javaSource);
      writeFileSync(
        harnessPath,
        "package dev.nts.generated;\n" +
          "public final class CallbackHarness {\n" +
          "  public static void main(String[] args) {\n" +
          "    System.out.println(DirectCallback.runCallback());\n" +
          "  }\n" +
          "}\n",
      );
      execFileSync(join(javaHome!, "bin/javac"), [
        "--release",
        "17",
        "-classpath",
        `${supportClasses}:${fixtureClasses}`,
        "-d",
        classes,
        javaPath,
        harnessPath,
      ]);
      const bytecode = execFileSync(
        join(javaHome!, "bin/javap"),
        ["-classpath", `${classes}:${supportClasses}:${fixtureClasses}`, "-c", "-p", "dev.nts.generated.DirectCallback"],
        { encoding: "utf8" },
      );
      assert.match(bytecode, /fixture\/CallbackHost\.deliver:\(Lfixture\/Clickable;Lfixture\/Button;\)V/u);
      assert.match(bytecode, /fixture\/Button\.depth:\(\)I/u);
      assert.doesNotMatch(bytecode, /nts_jvm_fixture/u);
      assert.doesNotMatch(bytecode, / native /u);
      const callbackBytecode = execFileSync(
        join(javaHome!, "bin/javap"),
        [
          "-classpath",
          `${classes}:${supportClasses}:${fixtureClasses}`,
          "-c",
          "-p",
          "dev.nts.generated.DirectCallback$NtsCallbackAdapter0",
        ],
        { encoding: "utf8" },
      );
      assert.match(callbackBytecode, /implements fixture\.Clickable/u);
      assert.match(callbackBytecode, /public void onClick\(fixture\.Button\)/u);
      assert.match(callbackBytecode, /DirectCallback\.f_[0-9a-f]+:/u);
      assert.doesNotMatch(callbackBytecode, /invokeinterface/u);
      assert.doesNotMatch(callbackBytecode, /nts_jvm_fixture/u);
      assert.doesNotMatch(callbackBytecode, / native /u);
      const run = spawnSync(
        join(javaHome!, "bin/java"),
        ["-cp", `${classes}:${supportClasses}:${fixtureClasses}`, "dev.nts.generated.CallbackHarness"],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, "26.0\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
