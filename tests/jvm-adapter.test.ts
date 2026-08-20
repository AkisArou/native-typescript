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
    "resized",
    "compareDepth",
    "label",
    "greet",
    "withNul",
    "sumBytes",
    "reverseBytes",
    "nullBytes",
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
    first.staticMethods.map(({ name }) => name).sort(),
    ["checkedAdd", "greet", "nullBytes", "reverseBytes", "sumBytes", "withNul"],
  );
  assert.deepEqual(
    first.instanceMethods.map(({ name }) => name).sort(),
    ["compareDepth", "depth", "label", "resize", "resize", "resized"],
  );
  assert.deepEqual(first.stringSupport, { bridge: "utf-16" });
  assert.deepEqual(first.byteSpanSupport, { region: "copy" });
  const sumBytes = first.staticMethods.find(({ name }) => name === "sumBytes")!;
  assert.deepEqual(sumBytes.parameters, [{ kind: "byte-span" }]);
  const resizeSymbols = first.instanceMethods
    .filter(({ name }) => name === "resize")
    .map(({ adapterSymbol }) => adapterSymbol);
  assert.equal(new Set(resizeSymbols).size, 2);

  assert.ok(first.source.includes(`jint ${first.bind.adapterSymbol}(`));
  // One release for every class: DeleteGlobalRef is class-blind.
  assert.ok(first.source.includes(`void ${first.release.adapterSymbol}(`));
  assert.equal(
    (first.source.match(/->DeleteGlobalRef/gu) ?? []).length,
    1,
  );
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
      "byteSpanSupport",
      "constructors",
      "envSupport",
      "errorSupport",
      "instanceMethods",
      "release",
      "staticMethods",
      "stringSupport",
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
    // The String parameter projects now; only the int[] result refuses,
    // named by its element family.
    assert.deepEqual(
      error.diagnostics.map(({ code }) => code),
      ["NTS7001"],
    );
    const messages = error.diagnostics.map(({ message }) => message).join("\n");
    assert.match(messages, /array type 'int\[\]', whose element family/u);
  }
});

test("a byte[] result crosses as an owned copy with a length out slot", () => {
  const withReverse = generateJvmAdapterSource(
    ingestSurface([
      { binaryName: "fixture/Widget", methods: ["reverseBytes"] },
    ]),
    { packageSlug: "fixture" },
  );
  const reverse = withReverse.staticMethods.find(
    ({ name }) => name === "reverseBytes",
  )!;
  assert.deepEqual(reverse.result, { kind: "byte-span" });
  assert.deepEqual(withReverse.byteSpanSupport, { region: "copy" });
  // The length rides a compiler-owned out slot beside the error slot.
  assert.ok(
    withReverse.header.includes(
      `uint8_t *${reverse.adapterSymbol}(const uint8_t *a0, size_t a0_length, size_t *out_length, char **error);`,
    ),
  );
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
    const resizedSymbol = adapter.instanceMethods.find(
      ({ name }) => name === "resized",
    )!.adapterSymbol;
    const compareSymbol = adapter.instanceMethods.find(
      ({ name }) => name === "compareDepth",
    )!.adapterSymbol;
    const labelSymbol = adapter.instanceMethods.find(
      ({ name }) => name === "label",
    )!.adapterSymbol;
    const greetSymbol = adapter.staticMethods.find(
      ({ name }) => name === "greet",
    )!.adapterSymbol;
    const withNulSymbol = adapter.staticMethods.find(
      ({ name }) => name === "withNul",
    )!.adapterSymbol;
    const sumBytesSymbol = adapter.staticMethods.find(
      ({ name }) => name === "sumBytes",
    )!.adapterSymbol;
    const reverseBytesSymbol = adapter.staticMethods.find(
      ({ name }) => name === "reverseBytes",
    )!.adapterSymbol;
    const nullBytesSymbol = adapter.staticMethods.find(
      ({ name }) => name === "nullBytes",
    )!.adapterSymbol;
    const releaseWidget = adapter.release.adapterSymbol;
    const classpath = resolve(repositoryRoot, "fixtures/jvm/classes");
    const messageSymbol = adapter.errorSupport.messageSymbol;
    const releaseSymbol = adapter.errorSupport.releaseSymbol;
    const main = [
      "#include <jni.h>",
      "#include <limits.h>",
      "#include <stdio.h>",
      "#include <stdlib.h>",
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
      `  void *w2 = ${resizedSymbol}(w, 3, &error);`,
      "  if (w2 == NULL || error != NULL) return 17;",
      `  if (${depthSymbol}(w2, &error) != 3 || error != NULL) return 18;`,
      `  if (${compareSymbol}(w, w2, &error) <= 0 || error != NULL) return 19;`,
      `  if (${compareSymbol}(w, NULL, &error) != -1 || error != NULL) return 20;`,
      `  ${releaseWidget}(w2);`,
      `  char *text = ${labelSymbol}(w, 5, &error);`,
      "  if (text == NULL || error != NULL) return 21;",
      '  if (strcmp(text, "widget-5") != 0) return 22;',
      "  free(text);",
      /* Non-BMP round trip: the party popper is 4 UTF-8 bytes and one
       * UTF-16 surrogate pair; both bridges must agree exactly. */
      `  text = ${greetSymbol}("\xf0\x9f\x8e\x89", &error);`,
      "  if (text == NULL || error != NULL) return 23;",
      '  if (strcmp(text, "hi \xf0\x9f\x8e\x89!") != 0) return 24;',
      "  free(text);",
      `  text = ${greetSymbol}(NULL, &error);`,
      "  if (text != NULL || error != NULL) return 25;",
      `  text = ${withNulSymbol}(&error);`,
      "  if (text != NULL || error == NULL ||",
      `      strstr(${messageSymbol}(error), "embedded NUL") == NULL) return 26;`,
      `  ${releaseSymbol}(error); error = NULL;`,
      /* Byte span: 1+2+3+250 = 256 proves unsigned reassembly on the Java
       * side; the zero-length span proves the empty array is still built. */
      "  uint8_t bytes[4] = {1, 2, 3, 250};",
      `  if (${sumBytesSymbol}(bytes, sizeof bytes, &error) != 256 ||`,
      "      error != NULL) return 27;",
      `  if (${sumBytesSymbol}(bytes, 0, &error) != 0 || error != NULL) return 28;`,
      /* Byte-span result: REVERSED, not echoed, so a copy that reads the
       * right bytes into the wrong place fails differently from one that
       * reads the wrong bytes. The empty result is a real allocation with
       * length zero, and a null byte[] refuses through the error channel. */
      "  size_t outLength = 0;",
      `  uint8_t *reversed = ${reverseBytesSymbol}(bytes, sizeof bytes, &outLength, &error);`,
      "  if (reversed == NULL || error != NULL || outLength != 4) return 29;",
      "  if (reversed[0] != 250 || reversed[1] != 3 ||",
      "      reversed[2] != 2 || reversed[3] != 1) return 30;",
      "  free(reversed);",
      `  reversed = ${reverseBytesSymbol}(bytes, 0, &outLength, &error);`,
      "  if (reversed == NULL || error != NULL || outLength != 0) return 31;",
      "  free(reversed);",
      `  reversed = ${nullBytesSymbol}(&outLength, &error);`,
      "  if (reversed != NULL || error == NULL ||",
      `      strstr(${messageSymbol}(error), "null byte[]") == NULL) return 32;`,
      `  ${releaseSymbol}(error); error = NULL;`,
      `  ${releaseWidget}(w);`,
      "  (*vm)->DestroyJavaVM(vm);",
      "  printf(\"OK\\n\");",
      "  return 0;",
      "}",
      "",
    ].join("\n");
    const adapterPath = join(workDir, "adapter.c");
    writeFileSync(adapterPath, adapter.source);
    /* The generator's own header declares everything main.c calls. */
    writeFileSync(join(workDir, "adapter.h"), adapter.header);
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
