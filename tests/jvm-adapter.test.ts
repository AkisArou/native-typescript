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
    "splitWords",
    "emptyWords",
    "nullElement",
    "countTags",
    "joinWords",
    "sumInts",
    "countInts",
    "reverseFloats",
    "measure",
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
    [
      "checkedAdd",
      "countInts",
      "countTags",
      "emptyWords",
      "greet",
      "joinWords",
      "nullBytes",
      "nullElement",
      "reverseBytes",
      "reverseFloats",
      "splitWords",
      "sumBytes",
      "sumInts",
      "withNul",
    ],
  );
  assert.deepEqual(
    first.instanceMethods.map(({ name }) => name).sort(),
    ["compareDepth", "depth", "label", "measure", "resize", "resize", "resized"],
  );
  assert.deepEqual(first.stringSupport, { bridge: "utf-16" });
  assert.deepEqual(first.spanSupport, { region: "copy" });
  // One release frees the vector and its elements; its symbol is what the
  // manifest's string-vector marshal names.
  assert.ok(first.stringVectorSupport !== null);
  assert.ok(
    first.source.includes(
      `void ${first.stringVectorSupport!.releaseSymbol}(char **vector)`,
    ),
  );
  const splitWords = first.staticMethods.find(
    ({ name }) => name === "splitWords",
  )!;
  assert.deepEqual(splitWords.result, { kind: "string-vector" });
  const sumBytes = first.staticMethods.find(({ name }) => name === "sumBytes")!;
  assert.deepEqual(sumBytes.parameters, [{ kind: "span", elem: "u8" }]);
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
      "constructors",
      "envSupport",
      "errorSupport",
      "instanceMethods",
      "release",
      "spanSupport",
      "staticMethods",
      "stringSupport",
      "stringVectorSupport",
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

test("the founding refusal resolves: measure returns a typed span", () => {
  // measure's int[] result opened this family's file as a refusal; the
  // widened span boundary is what finally admits it.
  const withMeasure = generateJvmAdapterSource(
    ingestSurface([{ binaryName: "fixture/Widget", methods: ["measure"] }]),
    { packageSlug: "fixture" },
  );
  const measure = withMeasure.instanceMethods.find(
    ({ name }) => name === "measure",
  )!;
  assert.deepEqual(measure.result, { kind: "span", elem: "i32" });
  assert.ok(
    withMeasure.header.includes(
      `uint8_t *${measure.adapterSymbol}(void *self, const char *a0, jboolean a1, size_t *out_length, char **error);`,
    ),
  );
});

test("a String[] argument crosses as a borrowed terminated vector", () => {
  const withCount = generateJvmAdapterSource(
    ingestSurface([
      { binaryName: "fixture/Widget", methods: ["countTags"] },
    ]),
    { packageSlug: "fixture" },
  );
  const countTags = withCount.staticMethods.find(
    ({ name }) => name === "countTags",
  )!;
  assert.deepEqual(countTags.parameters, [{ kind: "string-vector" }]);
  assert.ok(
    withCount.header.includes(
      `jint ${countTags.adapterSymbol}(const char *const *a0, char **error);`,
    ),
  );
});

test("refused array elements name the carrier each is missing", () => {
  // A reader meeting double[] learns Float64Array is the missing piece
  // rather than concluding arrays are unsupported.
  for (
    const [method, pattern] of [
      ["samples", /'double\[\]': element carrier Float64Array has no runtime representation in the compiler/u],
      [
        "ids",
        /'long\[\]': element carrier BigInt64Array has no runtime representation in the compiler, and bigint is outside the compilable value set \(SC2001\)/u,
      ],
    ] as const
  ) {
    try {
      generateJvmAdapterSource(
        ingestSurface([{ binaryName: "fixture/Widget", methods: [method] }]),
        { packageSlug: "fixture" },
      );
      assert.fail("expected JvmGenerationError");
    } catch (error) {
      assert.ok(error instanceof JvmGenerationError);
      assert.match(error.diagnostics[0]!.message, pattern);
    }
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
  assert.deepEqual(reverse.result, { kind: "span", elem: "u8" });
  assert.deepEqual(withReverse.spanSupport, { region: "copy" });
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
    const splitWordsSymbol = adapter.staticMethods.find(
      ({ name }) => name === "splitWords",
    )!.adapterSymbol;
    const emptyWordsSymbol = adapter.staticMethods.find(
      ({ name }) => name === "emptyWords",
    )!.adapterSymbol;
    const nullElementSymbol = adapter.staticMethods.find(
      ({ name }) => name === "nullElement",
    )!.adapterSymbol;
    const countTagsSymbol = adapter.staticMethods.find(
      ({ name }) => name === "countTags",
    )!.adapterSymbol;
    const joinWordsSymbol = adapter.staticMethods.find(
      ({ name }) => name === "joinWords",
    )!.adapterSymbol;
    const strvFreeSymbol = adapter.stringVectorSupport!.releaseSymbol;
    const sumIntsSymbol = adapter.staticMethods.find(
      ({ name }) => name === "sumInts",
    )!.adapterSymbol;
    const countIntsSymbol = adapter.staticMethods.find(
      ({ name }) => name === "countInts",
    )!.adapterSymbol;
    const reverseFloatsSymbol = adapter.staticMethods.find(
      ({ name }) => name === "reverseFloats",
    )!.adapterSymbol;
    const measureSymbol = adapter.instanceMethods.find(
      ({ name }) => name === "measure",
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
      /* String[] result: a real vector with a NUL terminator the adapter
       * synthesized, the empty vector as one terminator slot, and a null
       * element refusing rather than truncating the vector early. */
      `  char **words = ${splitWordsSymbol}("alpha beta", &error);`,
      "  if (words == NULL || error != NULL) return 33;",
      '  if (words[0] == NULL || strcmp(words[0], "alpha") != 0 ||',
      '      words[1] == NULL || strcmp(words[1], "beta") != 0 ||',
      "      words[2] != NULL) return 34;",
      `  ${strvFreeSymbol}(words);`,
      `  words = ${emptyWordsSymbol}(&error);`,
      "  if (words == NULL || error != NULL || words[0] != NULL) return 35;",
      `  ${strvFreeSymbol}(words);`,
      `  words = ${nullElementSymbol}(&error);`,
      "  if (words != NULL || error == NULL ||",
      `      strstr(${messageSymbol}(error), "null element") == NULL) return 36;`,
      `  ${releaseSymbol}(error); error = NULL;`,
      /* String[] argument: content crosses (join proves elements arrive in
       * order and intact, emoji included), NULL crosses as NULL and Java's
       * own NullPointerException reports through the checked channel. */
      "  const char *const tags[] = {\"alpha\", \"\\xf0\\x9f\\x8e\\x89\", NULL};",
      `  if (${countTagsSymbol}(tags, &error) != 2 || error != NULL) return 37;`,
      `  text = ${joinWordsSymbol}(tags, &error);`,
      "  if (text == NULL || error != NULL) return 38;",
      '  if (strcmp(text, "alpha,\\xf0\\x9f\\x8e\\x89") != 0) return 39;',
      "  free(text);",
      `  (void)${countTagsSymbol}(NULL, &error);`,
      "  if (error == NULL) return 40;",
      `  ${releaseSymbol}(error); error = NULL;`,
      /* Typed spans: signed content survives (sumInts), the length echo is
       * the units mirror (four elements must count four; a bytes-crossed
       * count would build sixteen), floats come back REVERSED with exact
       * f32-representable values, and measure - the founding refusal -
       * answers as a live int[] result with an element-counted length. */
      "  int32_t ints[3] = {1, -2, 4};",
      `  if (${sumIntsSymbol}((const uint8_t *)ints, 3, &error) != 3 ||\n      error != NULL) return 41;`,
      `  if (${countIntsSymbol}((const uint8_t *)ints, 3, &error) != 3 ||\n      error != NULL) return 42;`,
      "  float floats[2] = {1.5f, -2.25f};",
      "  size_t floatCount = 0;",
      `  float *rev = (float *)${reverseFloatsSymbol}(\n      (const uint8_t *)floats, 2, &floatCount, &error);`,
      "  if (rev == NULL || error != NULL || floatCount != 2) return 43;",
      "  if (rev[0] != -2.25f || rev[1] != 1.5f) return 44;",
      "  free(rev);",
      "  size_t measureCount = 0;",
      `  int32_t *measured = (int32_t *)${measureSymbol}(\n      w, "label", JNI_TRUE, &measureCount, &error);`,
      "  if (measured == NULL || error != NULL || measureCount != 2) return 45;",
      "  if (measured[0] != 5 || measured[1] != 1) return 46;",
      "  free(measured);",
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
