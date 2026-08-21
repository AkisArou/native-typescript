import assert from "node:assert/strict";
import test from "node:test";
import {
  generateAndroidManifest,
  planAndroidApk,
} from "@native-typescript/target-jvm";

/**
 * The packaging machinery's own observers. The APK chain's stages are
 * pure plans over authoritative tools, so what is checkable here is
 * exactly what the plan DECIDES: which tool runs, what it is handed, and
 * the properties an Android package must have to load at all.
 *
 * The command sequence itself was established by running it — aapt2
 * link --output-to-dir, jar --create with named entries, zipalign -P 16,
 * apksigner with v2 only — including the observation that two signings of
 * one APK are byte-identical, which is what lets the signing action claim
 * determinism.
 */

const tool = (id: string) =>
  Object.freeze({ id, version: "test", digest: `sha256:${"a".repeat(64)}` });

function plan() {
  return planAndroidApk({
    target: "x86_64-linux-android35",
    executionPlatform: "x86_64-linux",
    libraryEntry: "lib/x86_64/libntsdemo.so",
    classes: [
      { artifact: "source/android/classes-primary", path: "com/example/A.class" },
      { artifact: "source/android/classes-subclass", path: "com/example/M.class" },
    ],
    androidJarArtifact: "sdk/android-platform-jar",
    minSdk: 35,
    tools: {
      aapt2: tool("tool/aapt2"),
      d8: tool("tool/d8"),
      jar: tool("tool/jar"),
      zipalign: tool("tool/zipalign"),
      apksigner: tool("tool/apksigner"),
    },
    keyAlias: "nts",
    keyPassword: "android",
  });
}

function literals(actionId: string): string[] {
  const action = plan().actions.find(({ id }) => id === actionId)!;
  return action.arguments.flatMap((argument) =>
    argument.kind === "literal" ? [argument.value] : []
  );
}

test("the manifest declares what ART reads to decide what the package is", () => {
  const manifest = generateAndroidManifest({
    applicationId: "com.example.ntsdemo",
    activityBinaryName: "com/example/ntsdemo/MainActivity",
    label: "NTS Demo",
    minSdk: 35,
    targetSdk: 36,
  });
  assert.match(manifest, /package="com\.example\.ntsdemo"/u);
  assert.match(
    manifest,
    /android:name="com\.example\.ntsdemo\.MainActivity"/u,
  );
  assert.match(manifest, /android:minSdkVersion="35"/u);
  assert.match(manifest, /android:targetSdkVersion="36"/u);
  // Launcher-visible, and exported — an unexported launcher activity is
  // a package the system will not start.
  assert.match(manifest, /android\.intent\.action\.MAIN/u);
  assert.match(manifest, /android\.intent\.category\.LAUNCHER/u);
  assert.match(manifest, /android:exported="true"/u);
  // The other half of the alignment decision: the loader maps the
  // library out of the APK rather than extracting it.
  assert.match(manifest, /android:extractNativeLibs="false"/u);
  // No resource references: an application with no resources needs none,
  // and a manifest that named one would need a resource table to exist.
  assert.ok(!manifest.includes("@string/"));
});

test("a manifest refuses what the platform would refuse later", () => {
  const base = {
    applicationId: "com.example.ntsdemo",
    activityBinaryName: "com/example/ntsdemo/MainActivity",
    label: "NTS Demo",
    minSdk: 35,
    targetSdk: 36,
  };
  // An Activity generated into the platform's own package is the mistake
  // this refusal exists for: Android will not load application classes
  // from android.*, and the failure at install time names nothing.
  assert.throws(
    () =>
      generateAndroidManifest({
        ...base,
        activityBinaryName: "android/app/ActivityBridge",
      }),
    /outside application id/u,
  );
  assert.throws(
    () => generateAndroidManifest({ ...base, applicationId: "ntsdemo" }),
    /two or more dot-separated Java identifiers/u,
  );
  assert.throws(
    () => generateAndroidManifest({ ...base, targetSdk: 30 }),
    /Invalid SDK range/u,
  );
});

test("the APK chain is five pure stages, each a function of its inputs", () => {
  const { actions, productId } = plan();
  assert.deepEqual(actions.map(({ id }) => id), [
    "link/android/resources",
    "compile/android/dex",
    "package/android/apk-assemble",
    "package/android/apk-align",
    "package/android/apk-sign",
  ]);
  assert.equal(productId, "product/android/apk");
  for (const action of actions) {
    // No stage may edit a file in place: the obvious spelling of "add the
    // dex to the APK" is jar --update, and it is precisely what an
    // artifact action cannot be.
    assert.ok(!action.inputs.some((input) => action.outputs.includes(input)));
    assert.equal(action.deterministic, true);
    assert.equal(action.network, "denied");
  }
});

test("the package's load-bearing properties are argued, not defaulted", () => {
  // --output-to-dir is what makes the chain pure: the binary manifest
  // lands as a file, so the APK is created from named entries rather
  // than edited.
  assert.ok(literals("link/android/resources").includes("--output-to-dir"));

  const assemble = literals("package/android/apk-assemble");
  // STORED entries, because a mapped library cannot be decompressed on
  // the fly and only a stored entry can be page-aligned at all.
  assert.ok(assemble.includes("--no-compress"));
  // A fixed timestamp: a zip records modification times, so a build that
  // stamped "now" would produce a different artifact every run.
  assert.ok(assemble.includes("2000-01-01T00:00:00Z"));
  assert.ok(assemble.includes("--no-manifest"));
  // Entries are named individually; jar walks a directory in readdir
  // order, and an APK whose entry order depends on the filesystem would
  // differ between machines.
  for (const entry of ["AndroidManifest.xml", "resources.arsc", "classes.dex"]) {
    assert.ok(assemble.includes(entry), `assembly does not name ${entry}`);
  }
  assert.ok(assemble.includes("lib/x86_64/libntsdemo.so"));

  // 16KB pages: this is the alignment the manifest's extractNativeLibs
  // declaration requires, and the page size current devices ship.
  const align = literals("package/android/apk-align");
  assert.ok(align.includes("-P") && align.includes("16"));

  // v2 only: v1 signature files land INSIDE the zip and would undo the
  // alignment the previous stage just established.
  const sign = literals("package/android/apk-sign");
  const v1 = sign.indexOf("--v1-signing-enabled");
  const v2 = sign.indexOf("--v2-signing-enabled");
  assert.equal(sign[v1 + 1], "false");
  assert.equal(sign[v2 + 1], "true");
});

test("the dex stage names every class and desugars against the platform", () => {
  const dex = plan().actions.find(({ id }) => id === "compile/android/dex")!;
  const classPaths = dex.arguments.flatMap((argument) =>
    argument.kind === "input-path" && argument.path !== undefined
      ? [argument.path]
      : []
  );
  assert.deepEqual(classPaths, ["com/example/A.class", "com/example/M.class"]);
  // --lib is the platform's own classes: d8 needs them to desugar
  // against, and it is the same jar the manifest linked against.
  assert.ok(literals("compile/android/dex").includes("--lib"));
  assert.ok(dex.inputs.includes("sdk/android-platform-jar"));
});
