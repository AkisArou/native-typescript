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
            "checkedAdd",
            "nativeHandle",
            "resized",
            "compareDepth",
            "nameLength",
            "label",
            "greet",
            "sumBytes",
            "reverseBytes",
            "splitWords",
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
  assert.match(generated.declarations, /static checkedAdd\(a0: jint, a1: jint\): jint;/u);
  assert.match(generated.declarations, /resized\(a0: jint\): Widget \| null;/u);
  assert.match(generated.declarations, /compareDepth\(a0: Widget \| null\): jint;/u);
  assert.match(generated.declarations, /static nameLength\(a0: string \| null\): jint;/u);
  assert.match(generated.declarations, /label\(a0: jint\): string \| null;/u);
  assert.match(generated.declarations, /static greet\(a0: string \| null\): string \| null;/u);
  const lengthBinding =
    generated.manifest.bindings["fixture.fixture.widget.namelength"];
  assert.ok(lengthBinding !== undefined && lengthBinding.kind !== "constant");
  const stringParameter = lengthBinding.signature.parameters.find(
    ({ name }) => name === "a0",
  );
  assert.ok(stringParameter?.marshal !== undefined);
  assert.equal(stringParameter.marshal.kind, "string");

  // A byte[] argument is one source value across the bytes contract's two
  // slots: the borrowed const span and the usize length it names.
  assert.match(
    generated.declarations,
    /static sumBytes\(a0: Uint8Array\): jint;/u,
  );
  const sumBinding = generated.manifest.bindings["fixture.fixture.widget.sumbytes"];
  assert.ok(sumBinding !== undefined && sumBinding.kind !== "constant");
  const [span, spanLength] = sumBinding.signature.parameters;
  assert.equal(span!.name, "a0");
  assert.equal(span!.type, "const_bytes");
  assert.equal(span!.nullable, false);
  assert.deepEqual(span!.marshal, {
    kind: "bytes",
    length: { kind: "parameter", parameter: "a0_length" },
    mutability: "const",
  });
  assert.equal(spanLength!.name, "a0_length");
  assert.equal(spanLength!.type, "usize");
  assert.deepEqual(generated.manifest.types["usize"], {
    kind: "integer",
    signed: false,
    bits: "pointer",
  });

  // A byte[] result: the marshal carries the element and the release and
  // deliberately NO length — the extent returns in a compiler-owned slot
  // the manifest never names. The visible signature is the argument pair
  // alone; the declaration promises a Uint8Array back.
  assert.match(
    generated.declarations,
    /static reverseBytes\(a0: Uint8Array\): Uint8Array;/u,
  );
  const reverseBinding =
    generated.manifest.bindings["fixture.fixture.widget.reversebytes"];
  assert.ok(reverseBinding !== undefined && reverseBinding.kind !== "constant");
  assert.equal(reverseBinding.signature.parameters.length, 2);
  assert.equal(reverseBinding.signature.result.type, "bytes_result");
  assert.equal(reverseBinding.signature.result.nullable, false);
  assert.deepEqual(reverseBinding.signature.result.ownership, { kind: "value" });
  assert.deepEqual(reverseBinding.signature.result.marshal, {
    kind: "bytes",
    mutability: "mutable",
    release: "free",
  });

  // A String[] result: an owned NUL-terminated vector whose one release —
  // the adapter's generated symbol — frees elements and vector both. The
  // element type is non-null by construction: a NULL slot is the
  // terminator, so element absence is unrepresentable.
  assert.match(
    generated.declarations,
    /static splitWords\(a0: string \| null\): string\[\];/u,
  );
  const splitBinding =
    generated.manifest.bindings["fixture.fixture.widget.splitwords"];
  assert.ok(splitBinding !== undefined && splitBinding.kind !== "constant");
  assert.equal(splitBinding.signature.result.type, "utf8_vector");
  assert.equal(splitBinding.signature.result.nullable, false);
  assert.deepEqual(splitBinding.signature.result.marshal, {
    kind: "string-vector",
    encoding: "utf-8",
    termination: "nul",
    embeddedNul: "reject",
    release: "nts_jvm_fixture_strv_free",
  });
  assert.deepEqual(generated.manifest.types["utf8_vector"], {
    kind: "pointer",
    pointee: "utf8_owned",
    mutability: "mutable",
    nullable: false,
    addressSpace: 0,
  });
  const widget = generated.manifest.types["jvm.fixture.widget"];
  assert.ok(widget !== undefined && widget.kind === "handle");
  if (widget.kind !== "handle") return;
  // One shared release, typed at the root every class identity-upcasts to.
  assert.equal(widget.destructor, "fixture.object.release");
  const release = generated.manifest.bindings["fixture.object.release"];
  assert.ok(release !== undefined && release.kind !== "constant");
  assert.equal(release.signature.parameters[0]!.type, "jvm.object");
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

  // A static method translates without a receiver, through the same
  // checked channel.
  const add = binding("fixture.fixture.widget.checkedadd");
  assert.equal(add.error.detect.kind, "outParameterIsNotNull");
  assert.equal(add.result.projection.kind, "number");

  // An object result is an owned NULLABLE handle - a Java method may
  // return null on success, and the translator keeps that distinct from
  // the constructor's non-null direct projection.
  const resized = binding("fixture.fixture.widget.resized");
  assert.equal(resized.result.projection.kind, "nullableHandle");
  const compare = binding("fixture.fixture.widget.comparedepth");
  assert.ok(compare !== undefined);

  // A string parameter crosses through the adapter's UTF-16 bridge; the
  // translated binding carries it as an ordinary marshalled slot.
  const nameLength = binding("fixture.fixture.widget.namelength");
  assert.ok(nameLength !== undefined);

  // A string RESULT coexists with the error-out contract because the
  // failure arrives in a slot and reads nothing from the result - the
  // rule 50e6f6b5 landed, carrying the release the contract named.
  const greet = binding("fixture.fixture.widget.greet");
  assert.equal(greet.error.detect.kind, "outParameterIsNotNull");
  assert.equal(greet.result.projection.kind, "utf8CString");

  // A byte[] argument needs NOTHING new from the compiler: the pair
  // lowers to the existing bytes projections, both slots fed by the one
  // Uint8Array source argument.
  const sum = binding("fixture.fixture.widget.sumbytes");
  assert.equal(sum.error.detect.kind, "outParameterIsNotNull");
  const spanProjections = sum.parameters
    .map(({ projection }) => projection)
    .filter(({ kind }) => kind === "bytesData" || kind === "bytesByteLength");
  assert.deepEqual(
    spanProjections.map(({ kind }) => kind).sort(),
    ["bytesByteLength", "bytesData"],
  );
  const spanArguments = new Set(
    spanProjections.map((projection) =>
      "argument" in projection ? projection.argument : -1
    ),
  );
  assert.equal(spanArguments.size, 1);

  // A byte[] RESULT: the projection copies the span into a fresh
  // Uint8Array and disposes through the named release; its length arrives
  // in the compiler-owned slot appended before the error slot.
  const reverse = binding("fixture.fixture.widget.reversebytes");
  assert.equal(reverse.error.detect.kind, "outParameterIsNotNull");
  assert.deepEqual(reverse.result.projection, {
    kind: "bytes",
    elem: "u8",
    release: { kind: "symbol", symbol: "free" },
  });
  const lengthOut = reverse.parameters.find(
    ({ projection }) => projection.kind === "bytesLengthOut",
  );
  assert.ok(lengthOut !== undefined);
  const errorSlotIndex = reverse.parameters.findIndex(
    ({ projection }) => projection.kind === "errorOut",
  );
  assert.equal(reverse.parameters.indexOf(lengthOut!), errorSlotIndex - 1);

  // A String[] RESULT: the projection copies the terminated vector into a
  // managed string array and disposes through the adapter's one release.
  const split = binding("fixture.fixture.widget.splitwords");
  assert.equal(split.error.detect.kind, "outParameterIsNotNull");
  assert.deepEqual(split.result.projection, {
    kind: "utf8CStringArray",
    nullable: false,
    release: { kind: "symbol", symbol: "nts_jvm_fixture_strv_free" },
  });
});
