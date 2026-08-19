import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  JVM_ADAPTER_FAMILIES,
  JvmGenerationError,
  generateJvmAdapterSource,
  ingestJvmClasses,
} from "@native-typescript/bindgen-jvm";
import type {
  JvmAdapterSource,
  JvmClassSelection,
  JvmSnapshot,
} from "@native-typescript/bindgen-jvm";

const repositoryRoot = resolve(import.meta.dirname, "..");

function fixtureBytes(name: string): Uint8Array {
  return readFileSync(
    resolve(repositoryRoot, `fixtures/jvm/classes/fixture/${name}.class`),
  );
}

const adapterSurface: JvmClassSelection = Object.freeze({
  binaryName: "fixture/Widget",
  constructors: Object.freeze(["()V", "(I)V"]),
  methods: Object.freeze([
    "depth",
    "checkedAdd",
    { name: "resize", descriptor: "(II)V" },
    { name: "resize", descriptor: "(D)V" },
  ]),
});

function ingestSurface(
  classes: readonly JvmClassSelection[] = [adapterSurface],
): JvmSnapshot {
  return ingestJvmClasses(
    [
      {
        logicalPath: "fixtures/jvm/classes/fixture/Widget.class",
        bytes: fixtureBytes("Widget"),
      },
    ],
    { classes },
  );
}

function generate(): JvmAdapterSource {
  return generateJvmAdapterSource(ingestSurface(), { packageSlug: "fixture" });
}

/**
 * The JDK this host offers, found by asking `java` itself (settings print on
 * stderr) so version-manager shims resolve to the real home. Null skips the
 * compile-and-run test cleanly, like the Android SDK suite does for its SDK.
 */
function discoverJavaHome(): string | null {
  const fromEnv = process.env["JAVA_HOME"];
  if (fromEnv !== undefined && existsSync(join(fromEnv, "include/jni.h"))) {
    return fromEnv;
  }
  try {
    const stderr = execFileSync(
      "sh",
      ["-c", "java -XshowSettings:properties -version 2>&1 >/dev/null"],
      { encoding: "utf8" },
    );
    const match = stderr.match(/java\.home = (.+)/u);
    if (match === null) return null;
    const home = match[1]!.trim();
    return existsSync(join(home, "include/jni.h")) ? home : null;
  } catch {
    return null;
  }
}

const jdk = discoverJavaHome();
const skip = jdk === null ? "no JDK with include/jni.h on this host" : false;

test("the adapter source is deterministic and carries its member table", () => {
  const first = generate();
  assert.deepEqual(generate(), first);
  assert.match(first.sourceDigest, /^sha256:[0-9a-f]{64}$/u);

  assert.deepEqual(
    first.constructors.map(({ descriptor }) => descriptor).sort(),
    ["()V", "(I)V"],
  );
  const [a, b] = first.constructors;
  assert.notEqual(a!.adapterSymbol, b!.adapterSymbol);

  assert.deepEqual(
    first.staticMethods.map(({ name }) => name),
    ["checkedAdd"],
  );
  assert.deepEqual(
    first.instanceMethods.map(({ name }) => name).sort(),
    ["depth", "resize", "resize"],
  );
  const resizeSymbols = first.instanceMethods
    .filter(({ name }) => name === "resize")
    .map(({ adapterSymbol }) => adapterSymbol);
  assert.equal(new Set(resizeSymbols).size, 2);

  assert.ok(first.source.includes(`jint ${first.bind.adapterSymbol}(`));
  assert.ok(first.source.includes(`void ${first.classRelease.adapterSymbol}(`));
  assert.ok(
    first.source.includes(`const char *${first.errorSupport.messageSymbol}(`),
  );
  assert.ok(first.source.includes(`void ${first.errorSupport.releaseSymbol}(`));
});

test("every generated-C family carries a classification", () => {
  for (const [family, classification] of Object.entries(JVM_ADAPTER_FAMILIES)) {
    assert.ok(
      classification.kind === "translation" || classification.kind === "gap",
      family,
    );
  }
  assert.deepEqual(
    Object.keys(JVM_ADAPTER_FAMILIES).sort(),
    [
      "bind",
      "classRelease",
      "constructors",
      "envSupport",
      "errorSupport",
      "instanceMethods",
      "staticMethods",
    ],
  );
  // The env lookup is the package's one declared gap; everything else is a
  // translation. A new gap appearing here is a review event by design.
  assert.equal(JVM_ADAPTER_FAMILIES.envSupport.kind, "gap");
  const gapCount = Object.values(JVM_ADAPTER_FAMILIES).filter(
    ({ kind }) => kind === "gap",
  ).length;
  assert.equal(gapCount, 1);
});

test("positions outside the slice algebra are refused precisely", () => {
  const withMeasure = ingestSurface([
    { binaryName: "fixture/Widget", methods: ["measure"] },
  ]);
  try {
    generateJvmAdapterSource(withMeasure, { packageSlug: "fixture" });
    assert.fail("expected JvmGenerationError");
  } catch (error) {
    assert.ok(error instanceof JvmGenerationError);
    assert.deepEqual(
      error.diagnostics.map(({ code }) => code),
      ["NTS7001", "NTS7001"],
    );
    const messages = error.diagnostics.map(({ message }) => message).join("\n");
    assert.match(messages, /java\/lang\/String/u);
    assert.match(messages, /counted-vector contract/u);
  }
});

test("the generated adapter compiles and calls a live JVM", { skip }, () => {
  const adapter = generate();
  const home = jdk!;
  const workDir = mkdtempSync(join(tmpdir(), "nt-jvm-adapter-"));
  try {
    const constructorSymbol = adapter.constructors.find(
      ({ descriptor }) => descriptor === "(I)V",
    )!.adapterSymbol;
    const depthSymbol = adapter.instanceMethods.find(
      ({ name }) => name === "depth",
    )!.adapterSymbol;
    const addSymbol = adapter.staticMethods.find(
      ({ name }) => name === "checkedAdd",
    )!.adapterSymbol;
    const resizeIISymbol = adapter.instanceMethods.find(
      ({ name, descriptor }) => name === "resize" && descriptor === "(II)V",
    )!.adapterSymbol;
    const classpath = resolve(repositoryRoot, "fixtures/jvm/classes");
    const messageSymbol = adapter.errorSupport.messageSymbol;
    const releaseSymbol = adapter.errorSupport.releaseSymbol;
    const main = [
      "#include <jni.h>",
      "#include <limits.h>",
      "#include <stdio.h>",
      "#include <string.h>",
      `#include "adapter.h"`,
      "int main(void) {",
      `  char cp[] = "-Djava.class.path=${classpath}";`,
      "  JavaVMOption options[1] = { { .optionString = cp } };",
      "  JavaVMInitArgs args = { .version = JNI_VERSION_10, .nOptions = 1,",
      "                          .options = options, .ignoreUnrecognized = JNI_FALSE };",
      "  JavaVM *vm; JNIEnv *env;",
      "  if (JNI_CreateJavaVM(&vm, (void **)&env, &args) != JNI_OK) return 10;",
      "  char *error = NULL;",
      `  if (${adapter.bind.adapterSymbol}(env, &error) != 0) return 11;`,
      `  void *w = ${constructorSymbol}(7, &error);`,
      "  if (w == NULL || error != NULL) return 12;",
      `  if (${depthSymbol}(w, &error) != 7 || error != NULL) return 13;`,
      `  if (${addSymbol}(2, 3, &error) != 5 || error != NULL) return 14;`,
      `  (void)${addSymbol}(INT_MAX, 1, &error);`,
      "  if (error == NULL ||",
      `      strstr(${messageSymbol}(error), "overflow") == NULL) return 15;`,
      `  ${releaseSymbol}(error); error = NULL;`,
      `  ${resizeIISymbol}(w, 2, 3, &error);`,
      "  if (error != NULL) return 16;",
      `  ${adapter.classRelease.adapterSymbol}(w);`,
      "  (*vm)->DestroyJavaVM(vm);",
      "  printf(\"OK\\n\");",
      "  return 0;",
      "}",
      "",
    ].join("\n");
    /* Declarations for what main uses; the generator does not emit a header
     * yet, which is fine for a first slice - the manifest will carry the
     * signatures for the compiler, and this test writes them from the same
     * adapter table the manifest would be built from. */
    const header = [
      `jint ${adapter.bind.adapterSymbol}(JNIEnv *, char **);`,
      `void ${adapter.classRelease.adapterSymbol}(void *);`,
      `const char *${messageSymbol}(void *);`,
      `void ${releaseSymbol}(void *);`,
      `void *${constructorSymbol}(jint, char **);`,
      `jint ${depthSymbol}(void *, char **);`,
      `jint ${addSymbol}(jint, jint, char **);`,
      `void ${resizeIISymbol}(void *, jint, jint, char **);`,
      "",
    ].join("\n");
    const adapterPath = join(workDir, "adapter.c");
    /* The generated source defines the failure struct itself; the header is
     * only for main.c, so the adapter translation unit does not include it. */
    writeFileSync(adapterPath, adapter.source);
    writeFileSync(join(workDir, "adapter.h"), header);
    writeFileSync(join(workDir, "main.c"), main);
    const executable = join(workDir, "probe");
    execFileSync("clang", [
      "-O1",
      "-Wall",
      "-Werror",
      `-I${join(home, "include")}`,
      `-I${join(home, "include/linux")}`,
      adapterPath,
      join(workDir, "main.c"),
      "-o",
      executable,
      `-L${join(home, "lib/server")}`,
      "-ljvm",
      `-Wl,-rpath,${join(home, "lib/server")}`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const output = execFileSync(executable, [], {
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(output.trim(), "OK");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
