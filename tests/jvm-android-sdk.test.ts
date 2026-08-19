import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  JvmIngestionError,
  ingestJvmClasses,
  readJarClassSources,
} from "@native-typescript/bindgen-jvm";
import type { JvmClassSource } from "@native-typescript/bindgen-jvm";

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
