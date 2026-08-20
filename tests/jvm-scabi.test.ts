import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  digestClangAbiEvidence,
  renderCFunctionPointerType,
} from "@native-typescript/bindgen-c";
import type {
  ClangAbiEvidenceSnapshot,
  ClangAbiProbe,
} from "@native-typescript/bindgen-c";
import {
  generateJvmAdapterSource,
  generateJvmClangAbiProbe,
  generateJvmScabiPackage,
  ingestJvmClasses,
} from "@native-typescript/bindgen-jvm";
import type {
  JvmScabiGenerationOptions,
  JvmScabiPackage,
} from "@native-typescript/bindgen-jvm";
import { translateScabiNativeProgram } from "@native-typescript/scriptc";

const repositoryRoot = resolve(import.meta.dirname, "..");

function snapshot() {
  return ingestJvmClasses(
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
            "nativeHandle",
            { name: "resize", descriptor: "(II)V" },
            { name: "resize", descriptor: "(D)V" },
          ],
        },
      ],
    },
  );
}

/* Synthesized evidence, exactly as tests/gtk-scabi.test.ts synthesizes it:
 * the unit under test is manifest generation, and the real Clang probe runs
 * in the build-pipeline suites. */
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
  const semanticInput = {
    probeDigest: probe.sourceDigest,
    clang,
    functions,
    records: [],
    enums: [],
  };
  return Object.freeze({
    schema: "native-typescript.clang-abi-evidence",
    schemaVersion: 3,
    probeDigest: probe.sourceDigest,
    semanticDigest: digestClangAbiEvidence(semanticInput),
    clang,
    functions,
    records: Object.freeze([]),
    enums: Object.freeze([]),
  });
}

function options(): JvmScabiGenerationOptions {
  const selected = snapshot();
  const adapter = generateJvmAdapterSource(selected, { packageSlug: "fixture" });
  return {
    snapshot: selected,
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
  };
}

function generate(): JvmScabiPackage {
  return generateJvmScabiPackage(options());
}

test("the JVM manifest validates, is deterministic, and declares its surface", () => {
  const generated = generate();
  assert.deepEqual(generate(), generated);
  assert.match(generated.manifestDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(generated.declarations, /export declare class Widget \{/u);
  assert.match(generated.declarations, /constructor\(\);/u);
  assert.match(generated.declarations, /export type jint = number;/u);
  assert.match(generated.declarations, /export type jlong = bigint & \{/u);
  assert.match(generated.declarations, /nativeHandle\(\): jlong;/u);
  assert.match(generated.declarations, /depth\(\): jint;/u);
  const widget = generated.manifest.types["jvm.fixture.widget"];
  assert.ok(widget !== undefined && widget.kind === "handle");
  if (widget.kind !== "handle") return;
  assert.equal(widget.destructor, "fixture.object.release");
  assert.deepEqual(widget.upcasts, [{ kind: "identity", target: "jvm.object" }]);
});

test("each ownership shape translates through the neutral compiler input", () => {
  const generated = generate();
  const program = translateScabiNativeProgram(generated.manifest, {
    imports: Object.keys(generated.manifest.bindings),
    exports: [],
  });
  assert.equal(program.ok, true, JSON.stringify(program, null, 2).slice(0, 4000));
  if (!program.ok) return;
  const input = program.input;

  // Translated ids are qualified by the package instance.
  const instance = "native-typescript.jvm-fixture@0.0.0";
  function binding(id: string) {
    const found = input.bindings.find((entry) => entry.id === `${instance}#${id}`);
    assert.ok(found !== undefined, `binding ${id} translated`);
    return found!;
  }

  // A scalar call with the checked failure channel.
  const depth = binding("fixture.fixture.widget.depth");
  assert.equal(depth.error.detect.kind, "outParameterIsNotNull");
  assert.equal(depth.result.projection.kind, "number");

  // A 64-bit result keeps its exact carrier.
  const nativeHandle = binding("fixture.fixture.widget.nativehandle");
  assert.notEqual(nativeHandle.result.projection.kind, "number");

  // Construction is a direct call: the callee already transferred the
  // reference, and what releases it is what the handle type names.
  const constructor = binding("fixture.fixture.widget.constructor");
  assert.equal(constructor.result.projection.kind, "direct");

  // A void instance method carries its receiver.
  const resize = input.bindings.find((entry) =>
    entry.id.startsWith(`${instance}#fixture.fixture.widget.resize`)
  );
  assert.ok(resize !== undefined);
});
