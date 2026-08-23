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
            "joinWords",
            "sumInts",
            "measure",
            "ping",
            "tick",
            { name: "resize", descriptor: "(II)V" },
            { name: "resize", descriptor: "(D)V" },
          ],
          callbacks: [
            "onPing",
            { name: "onTick", descriptor: "(I)V", delivery: "queued" },
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

function options(selected = snapshot()): JvmScabiGenerationOptions {
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
  assert.deepEqual(
    generated.directBindings.bindings.find(({ id }) =>
      id.endsWith("#fixture.fixture.widget.namelength")
    ),
    {
      id: "native-typescript.jvm-fixture@0.0.0#fixture.fixture.widget.namelength",
      kind: "static-method",
      ownerBinaryName: "fixture/Widget",
      name: "nameLength",
      descriptor: "(Ljava/lang/String;)I",
      nativeEntrySymbol: "nts_jvm_fixture_call_fixture_Widget_nameLength",
    },
  );
  assert.equal(
    JSON.parse(generated.directBindingsSource).schema,
    "native-typescript.jvm-direct-bindings",
  );
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
    length: { kind: "parameter", parameter: "a0_length", units: "elements" },
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

  // Typed spans: elem is stated when it is not the u8 the contract reads
  // an absence as, the argument length says units:"elements" (JNI's only
  // denomination), and the carriers are the runtime's typed arrays.
  assert.match(
    generated.declarations,
    /static sumInts\(a0: Int32Array\): jint;/u,
  );
  assert.match(
    generated.declarations,
    /measure\(a0: string \| null, a1: boolean\): Int32Array;/u,
  );
  const sumIntsBinding =
    generated.manifest.bindings["fixture.fixture.widget.sumints"];
  assert.ok(sumIntsBinding !== undefined && sumIntsBinding.kind !== "constant");
  assert.deepEqual(sumIntsBinding.signature.parameters[0]!.marshal, {
    kind: "bytes",
    elem: "i32",
    length: { kind: "parameter", parameter: "a0_length", units: "elements" },
    mutability: "const",
  });
  const measureBinding =
    generated.manifest.bindings["fixture.fixture.widget.measure"];
  assert.ok(measureBinding !== undefined && measureBinding.kind !== "constant");
  assert.equal(measureBinding.signature.result.type, "bytes_result");
  assert.deepEqual(measureBinding.signature.result.marshal, {
    kind: "bytes",
    elem: "i32",
    mutability: "mutable",
    release: "free",
  });
  // The physical slot is a byte pointer for every element; the element
  // lives in the marshal and the carrier, never in the type table.
  assert.equal(generated.manifest.types["i32_span_result"], undefined);

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

  // The inward direction: a connect binding whose callback is anchored to
  // its receiver, cancelled by disconnect, answered synchronously — the
  // GObject signal contract with JNI identities behind it.
  assert.match(
    generated.declarations,
    /onPing\(callback: \(a0: jint\) => boolean\): JvmConnection;/u,
  );
  assert.match(generated.declarations, /export interface JvmConnection \{/u);
  const connectBinding =
    generated.manifest.bindings["fixture.fixture.widget.onping"];
  assert.ok(connectBinding !== undefined && connectBinding.kind !== "constant");
  assert.deepEqual(connectBinding.error, { kind: "nullable" });
  const callbackParameter = connectBinding.signature.parameters.find(
    ({ name }) => name === "callback",
  );
  assert.ok(callbackParameter?.callback !== undefined);
  assert.equal(callbackParameter.callback.registrationOwner, "self");
  assert.equal(
    callbackParameter.callback.cancellationBinding,
    "fixture.connection.disconnect",
  );
  assert.equal(callbackParameter.callback.synchronousReturn, true);
  // The queued variant: void answer, copied transport, the sender
  // injected as the handler's first argument.
  assert.match(
    generated.declarations,
    /onTick\(callback: \(sender: Widget, a0: jint\) => void\): JvmConnection;/u,
  );
  const tickBinding =
    generated.manifest.bindings["fixture.fixture.widget.ontick"];
  assert.ok(tickBinding !== undefined && tickBinding.kind !== "constant");
  const tickCallback = tickBinding.signature.parameters.find(
    ({ name }) => name === "callback",
  );
  assert.ok(tickCallback?.callback !== undefined);
  assert.equal(tickCallback.callback.synchronousReturn, false);
  assert.deepEqual(tickCallback.callback.arguments, [
    { parameter: "a0", transport: "copy" },
  ]);
  assert.ok(tickCallback.callback.sourceArguments !== undefined);
  assert.deepEqual(tickCallback.callback.sourceArguments[0], {
    kind: "registration-owner",
  });
  const connectionType = generated.manifest.types["jvm.connection"];
  assert.ok(connectionType !== undefined && connectionType.kind === "handle");
  if (connectionType.kind === "handle") {
    assert.equal(connectionType.destructor, "fixture.connection.release");
  }

  // A String[] ARGUMENT: borrowed for the call, nullable (NULL is an
  // omitted list, not an empty one), no release, and the source arm gains
  // null only on this side — a null result refuses at the adapter.
  assert.match(
    generated.declarations,
    /static joinWords\(a0: string\[\] \| null\): string \| null;/u,
  );
  const joinBinding =
    generated.manifest.bindings["fixture.fixture.widget.joinwords"];
  assert.ok(joinBinding !== undefined && joinBinding.kind !== "constant");
  const vectorParameter = joinBinding.signature.parameters[0];
  assert.equal(vectorParameter!.type, "nullable_const_utf8_vector");
  assert.equal(vectorParameter!.nullable, true);
  assert.deepEqual(vectorParameter!.ownership, {
    kind: "borrowed",
    scope: "call",
  });
  assert.deepEqual(vectorParameter!.marshal, {
    kind: "string-vector",
    encoding: "utf-8",
    termination: "nul",
    embeddedNul: "reject",
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

test("the telling arm: synchronous void, borrowed payloads, no sender", () => {
  // The arm fork 3c33818a admitted: synchronousReturn with a void ret.
  // Same native method as the queued pins above, opposite delivery — the
  // selection is what decides, because the class file cannot. The handler
  // borrows (nothing outlives the frame) and receives no sender, for the
  // same managed-handle reasoning as the answered arm: neither weakens
  // when nothing comes back.
  const selected = ingestJvmClasses(
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
          constructors: ["()V"],
          callbacks: [
            { name: "onTick", descriptor: "(I)V", delivery: "synchronous" },
          ],
        },
      ],
    },
  );
  const generation = options(selected);
  const generated = generateJvmScabiPackage(generation);
  assert.match(
    generated.declarations,
    /onTick\(callback: \(a0: jint\) => void\): JvmConnection;/u,
  );
  const telling =
    generated.manifest.bindings["fixture.fixture.widget.ontick"];
  assert.ok(telling !== undefined && telling.kind !== "constant");
  const tellingCallback = telling.signature.parameters.find(
    ({ name }) => name === "callback",
  );
  assert.ok(tellingCallback?.callback !== undefined);
  assert.equal(tellingCallback.callback.synchronousReturn, true);
  assert.deepEqual(tellingCallback.callback.arguments, [
    { parameter: "a0", transport: "borrow" },
  ]);
  assert.deepEqual(tellingCallback.callback.sourceArguments, [
    { kind: "callback-parameter", parameter: "a0" },
  ]);
  const callbackType =
    generated.manifest.types["jvm.fixture.widget.ontick.callback"];
  assert.ok(callbackType !== undefined && callbackType.kind === "callback");
  if (callbackType.kind === "callback") {
    assert.equal(callbackType.signature.result.type, "void");
  }
});

test("a compile-time constant crosses as its value, and the rest refuse", () => {
  /* A static final with a ConstantValue attribute IS its value: the class
   * file states it, so nothing is called and no adapter is generated for
   * it. The Widget fixture carries every ConstantValue kind, which is why
   * it can show both what crosses and what does not.
   *
   * A class file records a boolean, a byte and a char all as ints, so the
   * DESCRIPTOR decides the type — the value alone could not say what was
   * written. */
  const withConstants = ingestJvmClasses(
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
          constructors: ["()V"],
          fields: ["MAX_DEPTH", "RATIO"],
        },
      ],
    },
  );
  const generated = generateJvmScabiPackage(options(withConstants));
  /* Ambient values merged into a namespace beside the class: the
   * compiler resolves a constant only through a value declaration, and
   * `Widget.MAX_DEPTH` still reads as the class file writes it.
   *
   * Matched to the last const rather than to the closing brace: the three
   * constants this selection did not name still come with the class, and
   * the ones that cannot be projected leave their reason in the same
   * namespace. What this pins is that the values lead, in canonical
   * order. */
  assert.match(
    generated.declarations,
    /export declare namespace Widget \{\n {2}const MAX_DEPTH: jint;\n {2}const RATIO: jdouble;\n/u,
  );

  const depth = generated.manifest.bindings["fixture.fixture.widget.max_depth"];
  assert.ok(depth !== undefined && depth.kind === "constant");
  assert.equal(depth.value, 32);
  /* The double is read back out of the BITS the class file records,
   * which is the only lossless way a floating value is written down. */
  const ratio = generated.manifest.bindings["fixture.fixture.widget.ratio"];
  assert.ok(ratio !== undefined && ratio.kind === "constant");
  assert.equal(ratio.value, 0.25);

  /* The claim is not the manifest, it is reaching the compiler. */
  const program = translateScabiNativeProgram(generated.manifest, {
    imports: Object.keys(generated.manifest.bindings),
    exports: [],
  });
  assert.equal(
    program.ok,
    true,
    program.ok ? "" : JSON.stringify(program.diagnostics).slice(0, 1500),
  );

  /* What refuses, each naming its own reason rather than sharing one. */
  for (
    const [field, pattern] of [
      ["SEED", /carrier is a branded bigint/u],
      ["SCALE", /its type is f32 and ScriptC's value set has only f64/u],
      ["NAME", /String constant: its value is bytes/u],
      ["depth", /not a compile-time constant/u],
    ] as const
  ) {
    assert.throws(
      () =>
        generateJvmScabiPackage(options(ingestJvmClasses(
          [
            {
              logicalPath: "fixtures/jvm/classes/fixture/Widget.class",
              bytes: readFileSync(
                resolve(
                  repositoryRoot,
                  "fixtures/jvm/classes/fixture/Widget.class",
                ),
              ),
            },
          ],
          {
            classes: [
              {
                binaryName: "fixture/Widget",
                constructors: ["()V"],
                fields: [field],
              },
            ],
          },
        ))),
      pattern,
      `field ${field}`,
    );
  }
});

test("a class-anchored registration is owned by the process", () => {
  // The Android crux, in manifest form: ART constructs the Activity, so
  // there is no receiver whose lifetime bounds the registration — which
  // is the same fact as having no handle to hand back and no disposal to
  // cancel through. The honest owner is the process, because the
  // registration outlives every instance the way the class does.
  const selected = ingestJvmClasses(
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
          constructors: ["()V"],
          methods: ["depth", "tick"],
          callbacks: [
            {
              name: "onTick",
              descriptor: "(I)V",
              delivery: "synchronous",
              anchor: "class",
            },
          ],
        },
      ],
    },
  );
  const generation = options(selected);
  const generated = generateJvmScabiPackage(generation);
  // The receiver is the handler's first argument, because one
  // registration answers for every instance and nothing else could say
  // which one called.
  assert.match(
    generated.declarations,
    /static onTick\(callback: \(a0: Widget, a1: jint\) => void\): void;/u,
  );
  const binding = generated.manifest.bindings["fixture.fixture.widget.ontick"];
  assert.ok(binding !== undefined && binding.kind !== "constant");
  // Nothing to hold: no connection comes back, and the refusal of a
  // second registration travels the error channel instead of a value.
  assert.equal(binding.signature.result.type, "void");
  assert.deepEqual(binding.error?.kind, "error-out");
  assert.equal(
    binding.signature.parameters.some(({ name }) => name === "self"),
    false,
  );
  const contract = binding.signature.parameters.find(
    ({ name }) => name === "callback",
  )?.callback;
  assert.ok(contract !== undefined);
  assert.equal(contract.registrationOwner, "process");
  assert.equal(contract.cancellationBinding, undefined);
  assert.equal(contract.synchronousReturn, true);
  assert.deepEqual(
    contract.allowedInvocationExecutors.map(({ kind }) => kind),
    ["same-as-caller"],
  );
  // No registration-owner injection: there is no owner to inject.
  assert.ok(
    (contract.sourceArguments ?? []).every(
      ({ kind }) => kind === "callback-parameter",
    ),
  );
  assert.deepEqual(contract.sourceArguments?.[0], {
    kind: "callback-parameter",
    parameter: "a0",
    frameBounded: {
      promote: generation.adapter.release.framePromoteSymbol,
      release: generation.adapter.release.frameBoundedSymbol,
    },
  });
  /* The manifest is not the claim — reaching the arm is. This shape was
   * unreachable in two directions at once: SCABI had no word for a
   * registration nothing owns, and once it had one, the owner gate ahead
   * of the process branch demanded exactly what that branch forbids. Both
   * are closed, so a JVM manifest now translates into the process-owned
   * arm end to end. */
  const program = translateScabiNativeProgram(generated.manifest, {
    imports: Object.keys(generated.manifest.bindings),
    exports: [],
  });
  assert.equal(
    program.ok,
    true,
    program.ok ? "" : JSON.stringify(program.diagnostics).slice(0, 2000),
  );
  if (program.ok) {
    const instance = "native-typescript.jvm-fixture@0.0.0";
    const lowered = program.input.bindings.find(({ id }) =>
      id === `${instance}#fixture.fixture.widget.ontick`
    );
    assert.ok(lowered !== undefined);
    const source = lowered?.arguments.find(({ callback }) => callback !== undefined)
      ?.callback?.sourceArguments[0];
    assert.deepEqual(source, {
      kind: "callback-parameter",
      parameter: 0,
      destructor: `${instance}#fixture.object.release`,
      frameBounded: {
        promote: { symbol: generation.adapter.release.framePromoteSymbol },
        release: { symbol: generation.adapter.release.frameBoundedSymbol },
      },
    });
  }

  // The receiver crosses as the payload arm's owned handle.
  const callbackType =
    generated.manifest.types["jvm.fixture.widget.ontick.callback"];
  assert.ok(callbackType !== undefined && callbackType.kind === "callback");
  if (callbackType.kind === "callback") {
    assert.equal(callbackType.signature.result.type, "void");
    const receiver = callbackType.signature.parameters[0]!;
    assert.equal(receiver.nullable, false);
    assert.deepEqual(receiver.ownership, {
      kind: "owned",
      transfer: "to-runtime",
    });
  }
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
  const constructorManifest =
    generated.manifest.bindings["fixture.fixture.widget.constructor"];
  assert.ok(constructorManifest !== undefined && constructorManifest.kind !== "constant");
  assert.ok(constructorManifest.signature.result.frameBounded !== undefined);
  assert.deepEqual(constructor.result.frameBounded, {
    entry: { symbol: constructorManifest.signature.result.frameBounded!.entry },
    release: { symbol: constructorManifest.signature.result.frameBounded!.release },
  });

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
  const resizedManifest =
    generated.manifest.bindings["fixture.fixture.widget.resized"];
  assert.ok(resizedManifest !== undefined && resizedManifest.kind !== "constant");
  assert.ok(resizedManifest.signature.result.frameBounded !== undefined);
  assert.deepEqual(resized.result.frameBounded, {
    entry: { symbol: resizedManifest.signature.result.frameBounded!.entry },
    release: { symbol: resizedManifest.signature.result.frameBounded!.release },
  });
  const compare = binding("fixture.fixture.widget.comparedepth");
  assert.ok(compare !== undefined);

  // A string parameter crosses through the adapter's UTF-16 bridge; the
  // translated binding carries it as an ordinary marshalled slot.
  const nameLength = binding("fixture.fixture.widget.namelength");
  assert.ok(nameLength !== undefined);

  // A string RESULT coexists with the error-out contract because the
  // failure arrives in a slot and reads nothing from the result. It rides
  // the span arm - length in the compiler's slot, embedded NUL as data -
  // and keeps the null arm a Java String may always take.
  const greet = binding("fixture.fixture.widget.greet");
  assert.equal(greet.error.detect.kind, "outParameterIsNotNull");
  assert.deepEqual(greet.result.projection, {
    kind: "utf8Span",
    nullable: true,
    release: { kind: "symbol", symbol: "free" },
  });

  // A byte[] argument needs NOTHING new from the compiler: the pair
  // lowers to the existing bytes projections, both slots fed by the one
  // Uint8Array source argument.
  const sum = binding("fixture.fixture.widget.sumbytes");
  assert.equal(sum.error.detect.kind, "outParameterIsNotNull");
  const spanProjections = sum.parameters
    .map(({ projection }) => projection)
    .filter(({ kind }) => kind === "bytesData" || kind === "bytesLength");
  assert.deepEqual(
    spanProjections.map(({ kind }) => kind).sort(),
    ["bytesData", "bytesLength"],
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

  // The inward direction lowers through the existing retained-callback
  // machinery: the connect binding carries the function and context slots.
  const onPing = binding("fixture.fixture.widget.onping");
  assert.deepEqual(
    onPing.parameters.map(({ projection }) => projection.kind),
    ["argument", "callbackFunction", "callbackContext"],
  );

  // A String[] RESULT: the projection copies the terminated vector into a
  // managed string array and disposes through the adapter's one release.
  const split = binding("fixture.fixture.widget.splitwords");
  assert.equal(split.error.detect.kind, "outParameterIsNotNull");
  assert.deepEqual(split.result.projection, {
    kind: "utf8CStringArray",
    nullable: false,
    release: { kind: "symbol", symbol: "nts_jvm_fixture_strv_free" },
  });

  // A String[] ARGUMENT lowers through the existing borrowed vector arm:
  // one nullable string-array source value behind one physical slot.
  const join = binding("fixture.fixture.widget.joinwords");
  const vectorSlot = join.parameters.find(
    ({ projection }) => projection.kind === "utf8CStringArray",
  );
  assert.ok(vectorSlot !== undefined);
});
