import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  JvmGenerationError,
  JvmIngestionError,
  generateJvmAdapterSource,
  generateJvmClangAbiProbe,
  generateJvmScabiPackage,
  generateJvmSubclassSource,
  ingestJvmClasses,
  readJarClassSources,
} from "@native-typescript/bindgen-jvm";
import type { JvmClassSource } from "@native-typescript/bindgen-jvm";
import {
  digestClangAbiEvidence,
  renderCFunctionPointerType,
} from "@native-typescript/bindgen-c";
import type {
  ClangAbiEvidenceSnapshot,
  ClangAbiProbe,
} from "@native-typescript/bindgen-c";
import { translateScabiNativeProgram } from "@native-typescript/scriptc";

/**
 * Ingestion against the real Android SDK, the artifact Phase 4 exists for.
 * Skips cleanly when no SDK is installed, like the GTK suites do for their
 * SDK. Assertions are limited to facts stable across API levels: the
 * Activity ancestry chain, the onCreate override contract, and constants
 * unchanged since API 1.
 */
function findAndroidJar(): { platform: string; physicalPath: string } | null {
  const roots = [
    process.env["ANDROID_SDK_ROOT"],
    process.env["ANDROID_HOME"],
    join(homedir(), "Android/Sdk"),
  ].filter((root): root is string => root !== undefined && root.length > 0);
  for (const root of roots) {
    const platformsDir = join(root, "platforms");
    if (!existsSync(platformsDir)) continue;
    const platforms = readdirSync(platformsDir)
      .filter((name) => /^android-\d+(\.\d+)?$/u.test(name))
      .sort((left, right) =>
        parseFloat(right.slice("android-".length)) -
        parseFloat(left.slice("android-".length))
      );
    for (const platform of platforms) {
      const physicalPath = join(platformsDir, platform, "android.jar");
      if (existsSync(physicalPath)) return { platform, physicalPath };
    }
  }
  return null;
}

const sdk = findAndroidJar();
const skip = sdk === null ? "no Android SDK platform with android.jar" : false;

function sdkSources(): JvmClassSource[] {
  // The logical path names the artifact, not its location on this machine.
  return readJarClassSources(
    readFileSync(sdk!.physicalPath),
    `android-sdk/${sdk!.platform}/android.jar`,
  );
}

const activityChain = [
  { binaryName: "java/lang/Object" },
  { binaryName: "android/content/Context" },
  { binaryName: "android/content/ContextWrapper" },
  { binaryName: "android/view/ContextThemeWrapper" },
];

test("the real Activity surface ingests with its contract intact", { skip }, () => {
  const snapshot = ingestJvmClasses(sdkSources(), {
    classes: [
      ...activityChain,
      {
        binaryName: "android/app/Activity",
        constructors: ["()V"],
        methods: [
          { name: "onCreate", descriptor: "(Landroid/os/Bundle;)V" },
          { name: "setContentView", descriptor: "(Landroid/view/View;)V" },
          "finish",
          "runOnUiThread",
        ],
        fields: ["RESULT_OK", "RESULT_CANCELED"],
      },
    ],
  });
  const activity = snapshot.classes.find(
    ({ binaryName }) => binaryName === "android/app/Activity",
  )!;

  // The override contract Phase 4's generated subclass must honor: onCreate
  // is protected, instance, void over one android/os/Bundle parameter.
  const onCreate = activity.methods.find(({ name }) => name === "onCreate")!;
  assert.equal(onCreate.access.visibility, "protected");
  assert.equal(onCreate.access.static, false);
  assert.equal(onCreate.result.kind, "void");
  assert.deepEqual(onCreate.parameters, [
    { kind: "object", binaryName: "android/os/Bundle" },
  ]);

  assert.deepEqual(
    activity.fields.find(({ name }) => name === "RESULT_OK")!.constantValue,
    { kind: "int", value: "-1" },
  );

  // The ancestry is internal the whole way down.
  const chain: string[] = [];
  let cursor = activity;
  while (cursor.superclass !== null) {
    assert.equal(cursor.superclass.kind, "internal");
    chain.push(cursor.superclass.binaryName);
    cursor = snapshot.classes.find(
      ({ binaryName }) => binaryName === cursor.superclass!.binaryName,
    )!;
  }
  assert.deepEqual(chain, [
    "android/view/ContextThemeWrapper",
    "android/content/ContextWrapper",
    "android/content/Context",
    "java/lang/Object",
  ]);
});

test(
  "the real MainActivity's overrides generate; no arm remains",
  { skip },
  () => {
    /* Phase 4's acceptance app is a MainActivity whose onCreate calls
     * super and whose input methods receive platform objects. This pin
     * held BOTH missing arms as refusals, flipped to onStart alone when
     * fork 3c33818a admitted the void result, and completes with fork
     * 0309d850's handle payloads: onCreate(Bundle), onKeyDown(int,
     * KeyEvent), and onStart() all generate against the real artifact —
     * the exact surface the eventual Android acceptance app overrides.
     * What remains beyond generation (Bundle's real null at runtime, the
     * classes actually selected for projection) is the crossing's
     * business, not this pin's. */
    const snapshot = ingestJvmClasses(sdkSources(), {
      classes: [
        ...activityChain,
        {
          binaryName: "android/app/Activity",
          constructors: ["()V"],
          methods: [
            { name: "onCreate", descriptor: "(Landroid/os/Bundle;)V" },
            { name: "onKeyDown", descriptor: "(ILandroid/view/KeyEvent;)Z" },
            { name: "onStart", descriptor: "()V" },
          ],
        },
      ],
    });
    const admitted = generateJvmSubclassSource(snapshot, {
      baseBinaryName: "android/app/Activity",
      overrides: [
        { name: "onCreate", descriptor: "(Landroid/os/Bundle;)V" },
        { name: "onKeyDown", descriptor: "(ILandroid/view/KeyEvent;)Z" },
        { name: "onStart", descriptor: "()V" },
      ],
    });
    assert.match(
      admitted.source,
      /@Override\n {2}public native void onCreate\(android\.os\.Bundle a0\);/u,
    );
    assert.match(
      admitted.source,
      /public void ntsSuperOnCreate\(android\.os\.Bundle a0\) \{\n {4}super\.onCreate\(a0\);\n {2}\}/u,
    );
    assert.match(
      admitted.source,
      /@Override\n {2}public native boolean onKeyDown\(int a0, android\.view\.KeyEvent a1\);/u,
    );
    assert.match(
      admitted.source,
      /@Override\n {2}public native void onStart\(\);/u,
    );
    assert.match(
      admitted.source,
      /public void ntsSuperOnStart\(\) \{\n {4}super\.onStart\(\);\n {2}\}/u,
    );
    assert.deepEqual(admitted.callbacks, [
      {
        name: "onCreate",
        descriptor: "(Landroid/os/Bundle;)V",
        delivery: "synchronous",
      },
      { name: "onKeyDown", descriptor: "(ILandroid/view/KeyEvent;)Z" },
      { name: "onStart", descriptor: "()V", delivery: "synchronous" },
    ]);
  },
);

test(
  "a CharSequence crosses in as a string and refuses to come back as one",
  { skip },
  () => {
    /* The platform writes its text surface in CharSequence — TextView's
     * only usable setText takes one, since the int overload names a
     * resource an application without a resource table has not got. Every
     * String IS a CharSequence, so the way IN is a widening the call
     * performs. The way OUT is not: what comes back may be a
     * SpannableString, and handing it over as a string would decide the
     * program did not mean the spans. */
    const snapshot = ingestJvmClasses(sdkSources(), {
      classes: [
        ...activityChain,
        { binaryName: "android/util/AttributeSet" },
        { binaryName: "android/view/View" },
        {
          binaryName: "android/widget/TextView",
          methods: [
            { name: "setText", descriptor: "(Ljava/lang/CharSequence;)V" },
          ],
        },
      ],
    });
    const generated = generateJvmAdapterSource(snapshot, {
      packageSlug: "android",
    });
    const setText = generated.instanceMethods.find(
      ({ name }) => name === "setText",
    )!;
    assert.deepEqual(setText.parameters, [
      { kind: "string", nullability: "unstated" },
    ]);

    /* The same type in the other direction, refused by name. */
    try {
      generateJvmAdapterSource(
        ingestJvmClasses(sdkSources(), {
          classes: [
            ...activityChain,
            { binaryName: "android/view/View" },
            {
              binaryName: "android/widget/TextView",
              methods: [
                { name: "getText", descriptor: "()Ljava/lang/CharSequence;" },
              ],
            },
          ],
        }),
        { packageSlug: "android" },
      );
      assert.fail("expected the CharSequence result refusal");
    } catch (error) {
      assert.ok(error instanceof JvmGenerationError);
      assert.match(
        error.diagnostics[0]!.message,
        /may be a SpannableString.*waits on a program that needs it/su,
      );
    }
  },
);

test("selecting Activity without its ancestry is refused", { skip }, () => {
  assert.throws(
    () =>
      ingestJvmClasses(sdkSources(), {
        classes: [{ binaryName: "android/app/Activity" }],
      }),
    (error: unknown) => {
      assert.ok(error instanceof JvmIngestionError);
      assert.equal(error.diagnostics[0]!.code, "NTS6006");
      return true;
    },
  );
});

test("every class in the SDK either ingests or is refused by design", { skip }, () => {
  // Full-member ingestion class by class: the algebra must never mis-parse
  // real metadata; the only admissible refusal on this corpus is NTS6004
  // (non-static inner, local/anonymous, module descriptor).
  const sources = sdkSources();
  let ingested = 0;
  let refusedByDesign = 0;
  for (const source of sources) {
    try {
      const snapshot = ingestJvmClasses([source], {
        classes: [
          {
            binaryName: source.logicalPath
              .slice(source.logicalPath.indexOf("!/") + 2)
              .replace(/\.class$/u, ""),
          },
        ],
      });
      assert.equal(snapshot.classes.length, 1);
      ingested++;
    } catch (error) {
      assert.ok(error instanceof JvmIngestionError);
      assert.deepEqual(
        [...new Set(error.diagnostics.map(({ code }) => code))],
        ["NTS6004"],
        `${source.logicalPath}: ${error.message}`,
      );
      refusedByDesign++;
    }
  }
  assert.ok(ingested > 5000, `ingested ${ingested} of ${sources.length}`);
  assert.ok(refusedByDesign < sources.length / 20);
});

/* Synthesized evidence, as in tests/jvm-scabi.test.ts: this test is about
 * the real SDK surface flowing through generation and translation; the
 * probe's execution against a real header has its own gate. */
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
  "the real Activity surface generates and translates end to end",
  { skip },
  () => {
    // The acceptance application's binding, minus the runtime: construct an
    // activity, receive onCreate's bundle, set a real view, find one by id,
    // read the intent, retarget it by name, and move payload arrays both
    // ways. Every shape is one the algebra landed: scalars, handles,
    // statics, strings both directions, spans, string vectors, and the
    // checked failure channel. Note getByteArrayExtra returns null at
    // runtime when the extra is absent — that refuses through the error
    // channel today, and it is the real-world demand evidence for a
    // nullable-span-result arm whenever one is proposed.
    const snapshot = ingestJvmClasses(sdkSources(), {
      classes: [
        { binaryName: "java/lang/Object" },
        { binaryName: "android/content/Context" },
        { binaryName: "android/content/ContextWrapper" },
        { binaryName: "android/view/ContextThemeWrapper" },
        { binaryName: "android/os/BaseBundle" },
        { binaryName: "android/os/Bundle", constructors: ["()V"] },
        { binaryName: "android/view/View" },
        {
          binaryName: "android/content/Intent",
          constructors: ["()V"],
          methods: [
            { name: "setAction", descriptor: "(Ljava/lang/String;)Landroid/content/Intent;" },
            "getAction",
            { name: "putExtra", descriptor: "(Ljava/lang/String;[B)Landroid/content/Intent;" },
            "getByteArrayExtra",
            "getStringArrayExtra",
            "getIntArrayExtra",
          ],
        },
        {
          binaryName: "android/app/Activity",
          constructors: ["()V"],
          methods: [
            { name: "onCreate", descriptor: "(Landroid/os/Bundle;)V" },
            { name: "setContentView", descriptor: "(Landroid/view/View;)V" },
            "findViewById",
            "getIntent",
            "finish",
          ],
          fields: [],
        },
      ],
    });
    const adapter = generateJvmAdapterSource(snapshot, { packageSlug: "android" });
    const generated = generateJvmScabiPackage({
      snapshot,
      adapter,
      packageSlug: "android",
      evidence: evidence(generateJvmClangAbiProbe(adapter)),
      package: {
        name: "@native-typescript/android-activity",
        version: "0.0.0",
        namespace: "native-typescript.android-activity",
        instance: "native-typescript.android-activity@0.0.0",
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
        vendor: "google",
        name: "android",
        version: sdk!.platform,
        deploymentTarget: sdk!.platform,
        modules: ["android"],
      },
      linkInputs: [
        { id: "link.jvm", kind: "shared-library", name: "jvm", order: 0 },
      ],
      adapterInput: { id: "android.jvm-adapters", output: "jvm-adapters.o" },
    });
    assert.match(
      generated.declarations,
      /export declare class Activity extends ContextThemeWrapper \{/u,
    );
    assert.match(
      generated.declarations,
      /onCreate\(a0: Bundle \| null\): void;/u,
    );
    /* Narrowed by what android.jar itself states: Intent.setAction is
     * annotated non-null, so the chain reads the way it reads in Java —
     * `intent.setAction(x).putExtra(y)` with no null test between them.
     * The ARGUMENT stays open because nothing states otherwise. */
    assert.match(
      generated.declarations,
      /setAction\(a0: string \| null\): Intent;/u,
    );
    // The arrays family against the real artifact: a byte[] payload in
    // (span + units:"elements"), a byte[] result out, a String[] vector,
    // and an int[] span, all on Intent as shipped.
    assert.match(
      generated.declarations,
      /putExtra\(a0: string \| null, a1: Uint8Array\): Intent;/u,
    );
    assert.match(
      generated.declarations,
      /getByteArrayExtra\(a0: string \| null\): Uint8Array;/u,
    );
    assert.match(
      generated.declarations,
      /getStringArrayExtra\(a0: string \| null\): string\[\];/u,
    );
    assert.match(
      generated.declarations,
      /getIntArrayExtra\(a0: string \| null\): Int32Array;/u,
    );
    assert.match(
      generated.declarations,
      /getAction\(\): string \| null;/u,
    );
    const program = translateScabiNativeProgram(generated.manifest, {
      imports: Object.keys(generated.manifest.bindings),
      exports: [],
    });
    assert.equal(program.ok, true, JSON.stringify(program, null, 2).slice(0, 3000));
    if (!program.ok) return;
    const instance = "native-typescript.android-activity@0.0.0";
    const onCreate = program.input.bindings.find(
      ({ id }) => id === `${instance}#android.android.app.activity.oncreate`,
    );
    assert.ok(onCreate !== undefined, "onCreate translated");
    assert.equal(onCreate!.error.detect.kind, "outParameterIsNotNull");
    const findViewById = program.input.bindings.find(
      ({ id }) => id === `${instance}#android.android.app.activity.findviewbyid`,
    );
    assert.ok(findViewById !== undefined, "findViewById translated");
    assert.equal(findViewById!.result.projection.kind, "nullableHandle");
    const getAction = program.input.bindings.find(
      ({ id }) => id === `${instance}#android.android.content.intent.getaction`,
    );
    assert.ok(getAction !== undefined, "getAction translated");
    /* The span arm, nullable: getAction's null-on-success is the recorded
     * evidence that forced the arm to admit absence. */
    assert.deepEqual(getAction!.result.projection, {
      kind: "utf8Span",
      nullable: true,
      release: { kind: "symbol", symbol: "free" },
    });
  },
);
