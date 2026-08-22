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
    "ping",
    "tick",
    { name: "resize", descriptor: "(II)V" },
    { name: "resize", descriptor: "(D)V" },
  ]),
  callbacks: Object.freeze([
    "onPing",
    { name: "onTick", descriptor: "(I)V", delivery: "queued" as const },
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
  assert.notEqual(a!.frameBoundedSymbol, a!.adapterSymbol);
  assert.ok(first.source.includes(`void *${a!.frameBoundedSymbol}(`));

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
    [
      "compareDepth",
      "depth",
      "label",
      "measure",
      "ping",
      "resize",
      "resize",
      "resized",
      "tick",
    ],
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
  assert.deepEqual(splitWords.result, {
  kind: "string-vector",
  nullability: "unstated",
});
  const sumBytes = first.staticMethods.find(({ name }) => name === "sumBytes")!;
  assert.deepEqual(sumBytes.parameters, [
  { kind: "span", elem: "u8", nullability: "unstated" },
]);
  // The inward direction: registration points with their trampolines
  // installed at bind, the delivery split carried on the table.
  assert.equal(first.callbacks.length, 2);
  assert.deepEqual(
    first.callbacks.map(({ name, delivery }) => ({ name, delivery })),
    [
      { name: "onPing", delivery: "answered" },
      { name: "onTick", delivery: "queued" },
    ],
  );
  assert.ok(first.connectionSupport !== null);
  assert.ok(first.source.includes("RegisterNatives"));
  const resizeSymbols = first.instanceMethods
    .filter(({ name }) => name === "resize")
    .map(({ adapterSymbol }) => adapterSymbol);
  assert.equal(new Set(resizeSymbols).size, 2);

  assert.ok(first.source.includes(`jint ${first.bind.adapterSymbol}(`));
  // Exactly two DeleteGlobalRef call sites, each a distinct claim ending:
  // the class-blind handle release, and disconnect returning the reference
  // a registration held on its instance.
  assert.ok(first.source.includes(`void ${first.release.adapterSymbol}(`));
  assert.ok(
    first.source.includes(`void ${first.release.frameBoundedSymbol}(void *ref)`),
  );
  assert.ok(first.source.includes("->DeleteLocalRef(env, (jobject)ref)"));
  assert.equal(
    (first.source.match(/->DeleteGlobalRef/gu) ?? []).length,
    2,
  );
  assert.ok(
    first.source.includes(`const char *${first.errorSupport.messageSymbol}(`),
  );
  assert.ok(first.source.includes(`void ${first.errorSupport.releaseSymbol}(`));
  const resized = first.instanceMethods.find(({ name }) => name === "resized")!;
  assert.ok(resized.frameBoundedSymbol !== null);
  assert.ok(first.source.includes(`void *${resized.frameBoundedSymbol}(`));
  const depth = first.instanceMethods.find(({ name }) => name === "depth")!;
  assert.equal(depth.frameBoundedSymbol, null);
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
      "callbacks",
      "connectionSupport",
      "constructors",
      "envSupport",
      "errorSupport",
      "instanceMethods",
      "peerSlots",
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

test("a peer slot role cannot disappear outside the selected classes", () => {
  assert.throws(
    () => generateJvmAdapterSource(ingestSurface(), {
      packageSlug: "fixture",
      peerSlots: [{
        className: "fixture/MissingBridge",
        field: { name: "ntsPeer", descriptor: "J" },
      }],
    }),
    /Managed peer slot class 'fixture\/MissingBridge' is outside this selection/u,
  );
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
  assert.deepEqual(measure.result, {
  kind: "span",
  elem: "i32",
  nullability: "unstated",
});
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
  assert.deepEqual(countTags.parameters, [
  { kind: "string-vector", nullability: "unstated" },
]);
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

test("delivery is stated exactly once: required on void, refused on answered", () => {
  // A void native method genuinely has two contracts — during the caller's
  // frame, or copied and pumped — and the class file states neither, so a
  // bare selection underdetermines the crossing. An answered callback has
  // one delivery already, so stating one would be a second spelling of a
  // decided fact.
  for (
    const [callbacks, pattern] of [
      [
        ["onPing", "onTick"],
        /A void callback crosses on one of two arms.*delivery: 'synchronous' or 'queued'/u,
      ],
      [
        [{ name: "onPing", descriptor: "(I)Z", delivery: "queued" as const }],
        /An answered callback runs during the emitting call because its boolean is that call's result/u,
      ],
    ] as const
  ) {
    try {
      generateJvmAdapterSource(
        ingestSurface([{ binaryName: "fixture/Widget", callbacks }]),
        { packageSlug: "fixture" },
      );
      assert.fail("expected JvmGenerationError");
    } catch (error) {
      assert.ok(error instanceof JvmGenerationError);
      assert.match(error.diagnostics[0]!.message, pattern);
    }
  }
});

test("a class-anchored registration answers for instances it never named", () => {
  // The registration a FRAMEWORK forces: the platform constructs the
  // object, calls it, and never hands it over first, so there is no
  // instant at which a program could name the instance. One registration
  // answers for every instance of the class, and the receiver is the
  // handler's first argument because nothing else could say which one
  // called.
  const generated = generateJvmAdapterSource(
    ingestSurface([
      {
        binaryName: "fixture/Widget",
        constructors: ["(I)V"],
        methods: ["tick"],
        callbacks: [
          {
            name: "onTick",
            descriptor: "(I)V",
            delivery: "synchronous" as const,
            anchor: "class" as const,
          },
        ],
      },
    ]),
    { packageSlug: "fixture" },
  );
  const callback = generated.callbacks[0]!;
  assert.equal(callback.anchor, "class");
  // The receiver leads the payloads, typed as the class it answers for.
  assert.deepEqual(callback.parameters, [
    /* The receiver a class-anchored registration hands the handler is
     * non-null by the JVM's dispatch rule: an instance method is reached
     * THROUGH an object, so there is no call that omits it. */
    { kind: "handle", binaryName: "fixture/Widget", nullability: "non-null" },
    { kind: "primitive", primitive: "int" },
  ]);
  // Connect takes no receiver because there is none to take, and hands
  // nothing back because nothing owns the registration — so a refusal
  // travels the error channel instead of a return value.
  assert.ok(
    generated.header.includes(
      `void ${callback.connectSymbol}(void (*callback)(void *, jint, void *), ` +
        "void *context, char **error);",
    ),
    generated.header,
  );
  // The receiver is promoted like any other object payload: the local
  // reference dies with the trampoline's frame.
  assert.ok(
    generated.source.includes(
      "jobject receiver = (*env)->NewGlobalRef(env, self);",
    ),
  );
  // Any live registration is the second one — a class-anchored
  // registration cannot accumulate any more than a per-instance one can.
  assert.ok(generated.source.includes("already has a handler"));
  // Nothing is anchored, so nothing is held.
  assert.ok(generated.source.includes("jobject stable = NULL;"));
});

test("class anchoring refuses the delivery it has no program for", () => {
  try {
    generateJvmAdapterSource(
      ingestSurface([
        {
          binaryName: "fixture/Widget",
          constructors: ["(I)V"],
          callbacks: [
            {
              name: "onTick",
              descriptor: "(I)V",
              delivery: "queued" as const,
              anchor: "class" as const,
            },
          ],
        },
      ]),
      { packageSlug: "fixture" },
    );
    assert.fail("expected JvmGenerationError");
  } catch (error) {
    assert.ok(error instanceof JvmGenerationError);
    assert.match(
      error.diagnostics[0]!.message,
      /class-anchored registration answers for instances a framework constructs and observes/u,
    );
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
  assert.deepEqual(reverse.result, {
  kind: "span",
  elem: "u8",
  nullability: "unstated",
});
  assert.deepEqual(withReverse.spanSupport, { region: "copy" });
  // The length rides a compiler-owned out slot beside the error slot.
  assert.ok(
    withReverse.header.includes(
      `uint8_t *${reverse.adapterSymbol}(const uint8_t *a0, size_t a0_length, size_t *out_length, char **error);`,
    ),
  );
});

test(
  "a delivery on a thread that does not own the instance is refused",
  { skip },
  () => {
    /* An instance is never entered from two threads, and the runtime does
     * not police that: reaching a handler means reading a closure, and a
     * closure read from a foreign thread corrupts rather than fails. The
     * generated trampoline's job is to ASK before it delivers, and this
     * proves it does — the owner predicate is stubbed here so the test
     * controls the answer, which is exactly the adapter's side of the
     * contract. The runtime's own implementation of "which thread owns
     * the instance" is proven where it lives.
     *
     * Both answers are taken. A refusal that also refused the ordinary
     * case would pass a one-sided test while breaking every delivery. */
    const adapter = generateJvmAdapterSource(
      ingestSurface([
        {
          binaryName: "fixture/Widget",
          constructors: ["(I)V"],
          methods: ["ping"],
          callbacks: ["onPing"],
        },
      ]),
      { packageSlug: "fixture" },
    );
    const home = jdk!;
    const workDir = mkdtempSync(join(tmpdir(), "nt-jvm-owner-thread-"));
    try {
      const construct = adapter.constructors[0]!.adapterSymbol;
      const ping = adapter.instanceMethods.find(
        ({ name }) => name === "ping",
      )!.adapterSymbol;
      const connect = adapter.callbacks[0]!.connectSymbol;
      const message = adapter.errorSupport.messageSymbol;
      const classpath = resolve(repositoryRoot, "fixtures/jvm/classes");
      const main = [
        "#include <jni.h>",
        "#include <stdio.h>",
        "#include <string.h>",
        `#include "adapter.h"`,
        "/* The predicate the generated trampoline asks. Weak in the",
        " * adapter, defined here so the test decides the answer. */",
        "static int nts_owner_answer = 1;",
        "int nts_jvm_runtime_owner_thread_is_current(void) {",
        "  return nts_owner_answer;",
        "}",
        "static int nts_delivered;",
        "static jboolean nts_handler(jint value, void *context) {",
        "  (void)value; (void)context;",
        "  nts_delivered += 1;",
        "  return JNI_TRUE;",
        "}",
        "",
        "int main(void) {",
        `  char cp[] = "-Djava.class.path=${classpath}";`,
        "  JavaVMOption options[1] = { { .optionString = cp } };",
        "  JavaVMInitArgs args = { .version = JNI_VERSION_1_6, .nOptions = 1,",
        "                          .options = options, .ignoreUnrecognized = JNI_FALSE };",
        "  JavaVM *vm; JNIEnv *env;",
        "  if (JNI_CreateJavaVM(&vm, (void **)&env, &args) != JNI_OK) return 10;",
        "  char *error = NULL;",
        `  if (${adapter.bind.adapterSymbol}(env, &error) != 0) return 11;`,
        `  void *w = ${construct}(7, &error);`,
        "  if (w == NULL || error != NULL) return 12;",
        `  if (${connect}(w, nts_handler, NULL) == NULL) return 13;`,
        "  /* The owning thread: delivery happens. */",
        `  if (${ping}(w, 2, &error) != 2 || error != NULL) return 14;`,
        "  if (nts_delivered != 2) return 15;",
        "  /* A thread that does not own the instance: the trampoline",
        "   * refuses before reading the closure, and Java sees the",
        "   * exception through the checked channel. */",
        "  nts_owner_answer = 0;",
        `  (void)${ping}(w, 2, &error);`,
        "  if (error == NULL) return 16;",
        `  if (strstr(${message}(error), "does not own the TypeScript instance") == NULL) {`,
        "    return 17;",
        "  }",
        "  if (nts_delivered != 2) return 18;",
        '  printf("OK\\n");',
        "  return 0;",
        "}",
        "",
      ].join("\n");
      writeFileSync(join(workDir, "adapter.c"), adapter.source);
      writeFileSync(join(workDir, "adapter.h"), adapter.header);
      writeFileSync(join(workDir, "main.c"), main);
      const executable = join(workDir, "probe");
      execFileSync("clang", [
        "-O1",
        "-Wall",
        "-Werror",
        `-I${join(home, "include")}`,
        `-I${join(home, "include/linux")}`,
        join(workDir, "adapter.c"),
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
  },
);

test(
  "one class-anchored registration serves instances it never named",
  { skip },
  () => {
    /* The property class anchoring exists FOR, and the one a per-instance
     * registration cannot have: a single handler answers for two objects
     * the registration never mentioned, and tells them apart only by the
     * receiver it is handed. Two instances is the smallest number that
     * can distinguish "answers for the class" from "answers for the one
     * you registered", so the test uses exactly two.
     *
     * The handler also calls BACK into the receiver it was given, which
     * is what proves the promotion produced a usable reference rather
     * than a pointer that merely survived the frame — and it releases
     * that reference, which is the ownership half of the same story. */
    const adapter = generateJvmAdapterSource(
      ingestSurface([
        {
          binaryName: "fixture/Widget",
          constructors: ["(I)V"],
          methods: ["depth", "tick"],
          callbacks: [
            {
              name: "onTick",
              descriptor: "(I)V",
              delivery: "synchronous" as const,
              anchor: "class" as const,
            },
          ],
        },
      ]),
      { packageSlug: "fixture" },
    );
    const home = jdk!;
    const workDir = mkdtempSync(join(tmpdir(), "nt-jvm-class-anchor-"));
    try {
      const construct = adapter.constructors[0]!.adapterSymbol;
      const depth = adapter.instanceMethods.find(
        ({ name }) => name === "depth",
      )!.adapterSymbol;
      const tick = adapter.instanceMethods.find(
        ({ name }) => name === "tick",
      )!.adapterSymbol;
      const connect = adapter.callbacks[0]!.connectSymbol;
      const release = adapter.release.adapterSymbol;
      const message = adapter.errorSupport.messageSymbol;
      const releaseError = adapter.errorSupport.releaseSymbol;
      const classpath = resolve(repositoryRoot, "fixtures/jvm/classes");
      const main = [
        "#include <jni.h>",
        "#include <stdio.h>",
        "#include <stdlib.h>",
        "#include <string.h>",
        `#include "adapter.h"`,
        "static int nts_seen_depth;",
        "static int nts_seen_calls;",
        "/* The receiver arrives promoted and owned: usable for a call",
        " * back into Java, and released by whoever was handed it. */",
        "static void nts_on_tick(void *receiver, jint value, void *context) {",
        "  char *error = NULL;",
        `  nts_seen_depth += ${depth}(receiver, &error);`,
        "  if (error != NULL) { nts_seen_depth = -1000; }",
        "  nts_seen_calls += 1;",
        "  (void)value;",
        "  (void)context;",
        `  ${release}(receiver);`,
        "}",
        "",
        "int main(void) {",
        `  char cp[] = "-Djava.class.path=${classpath}";`,
        "  JavaVMOption options[1] = { { .optionString = cp } };",
        "  JavaVMInitArgs args = { .version = JNI_VERSION_1_6, .nOptions = 1,",
        "                          .options = options, .ignoreUnrecognized = JNI_FALSE };",
        "  JavaVM *vm; JNIEnv *env;",
        "  if (JNI_CreateJavaVM(&vm, (void **)&env, &args) != JNI_OK) return 10;",
        "  char *error = NULL;",
        `  if (${adapter.bind.adapterSymbol}(env, &error) != 0) return 11;`,
        "  /* One registration, made before either object exists — which is",
        "   * the whole point: on a platform, the instances are not ours.",
        "   * It hands nothing back, because nothing owns it. */",
        `  ${connect}(nts_on_tick, NULL, &error);`,
        "  if (error != NULL) return 12;",
        "  /* A second registration is refused, and says so through the",
        "   * error channel: a call that returns nothing cannot refuse",
        "   * with a value. */",
        `  ${connect}(nts_on_tick, NULL, &error);`,
        "  if (error == NULL) return 13;",
        `  if (strstr(${message}(error), "already has a handler") == NULL) return 20;`,
        `  ${releaseError}(error); error = NULL;`,
        `  void *first = ${construct}(7, &error);`,
        "  if (first == NULL || error != NULL) return 14;",
        `  void *second = ${construct}(9, &error);`,
        "  if (second == NULL || error != NULL) return 15;",
        `  ${tick}(first, 2, &error);`,
        "  if (error != NULL) return 16;",
        `  ${tick}(second, 1, &error);`,
        "  if (error != NULL) return 17;",
        "  /* Two calls on the first (depth 7) and one on the second",
        "   * (depth 9): 7 + 7 + 9. A registration that answered for only",
        "   * one instance could not reach 23, and one that lost the",
        "   * receiver could not tell 7 from 9 at all. */",
        "  if (nts_seen_calls != 3) return 18;",
        "  if (nts_seen_depth != 23) return 19;",
        '  printf("OK\\n");',
        "  return 0;",
        "}",
        "",
      ].join("\n");
      writeFileSync(join(workDir, "adapter.c"), adapter.source);
      writeFileSync(join(workDir, "adapter.h"), adapter.header);
      writeFileSync(join(workDir, "main.c"), main);
      const executable = join(workDir, "probe");
      execFileSync("clang", [
        "-O1",
        "-Wall",
        "-Werror",
        `-I${join(home, "include")}`,
        `-I${join(home, "include/linux")}`,
        join(workDir, "adapter.c"),
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
  },
);

test("the generated adapter compiles and calls a live JVM", { skip }, () => {
  const adapter = generate();
  const home = jdk!;
  const workDir = mkdtempSync(join(tmpdir(), "nt-jvm-adapter-"));
  try {
    const constructorSymbol = adapter.constructors.find(
      ({ descriptor }) => descriptor === "(I)V",
    )!.adapterSymbol;
    const frameConstructorSymbol = adapter.constructors.find(
      ({ descriptor }) => descriptor === "(I)V",
    )!.frameBoundedSymbol;
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
    const frameResizedSymbol = adapter.instanceMethods.find(
      ({ name }) => name === "resized",
    )!.frameBoundedSymbol!;
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
    const pingSymbol = adapter.instanceMethods.find(
      ({ name }) => name === "ping",
    )!.adapterSymbol;
    const connectOnPing = adapter.callbacks.find(
      ({ name }) => name === "onPing",
    )!.connectSymbol;
    const connectOnTick = adapter.callbacks.find(
      ({ name }) => name === "onTick",
    )!.connectSymbol;
    const tickSymbol = adapter.instanceMethods.find(
      ({ name }) => name === "tick",
    )!.adapterSymbol;
    const disconnectSymbol = adapter.connectionSupport!.disconnectSymbol;
    const connectionFreeSymbol = adapter.connectionSupport!.releaseSymbol;
    const releaseWidget = adapter.release.adapterSymbol;
    const releaseFrame = adapter.release.frameBoundedSymbol;
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
      "static jboolean nts_test_on_ping(jint value, void *context) {",
      "  *(int *)context += value;",
      "  return value % 2 == 0 ? JNI_TRUE : JNI_FALSE;",
      "}",
      "",
      "static void nts_test_on_tick(jint value, void *context) {",
      "  *(int *)context += value + 1;",
      "}",
      "",
      "int main(void) {",
      `  char cp[] = "-Djava.class.path=${classpath}";`,
      "  JavaVMOption options[1] = { { .optionString = cp } };",
      "  JavaVMInitArgs args = { .version = JNI_VERSION_10, .nOptions = 1,",
      "                          .options = options, .ignoreUnrecognized = JNI_FALSE };",
      "  JavaVM *vm; JNIEnv *env;",
      "  if (JNI_CreateJavaVM(&vm, (void **)&env, &args) != JNI_OK) return 10;",
      "  char *error = NULL;",
      `  if (${adapter.bind.adapterSymbol}(env, &error) != 0) return 11;`,
      `  void *local = ${frameConstructorSymbol}(9, &error);`,
      "  if (local == NULL || error != NULL) return 56;",
      `  if (${depthSymbol}(local, &error) != 9 || error != NULL) return 57;`,
      `  ${releaseFrame}(local);`,
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
      `  void *local2 = ${frameResizedSymbol}(w, 4, &error);`,
      "  if (local2 == NULL || error != NULL) return 58;",
      `  if (${depthSymbol}(local2, &error) != 4 || error != NULL) return 59;`,
      `  ${releaseFrame}(local2);`,
      /* String results ride the span shape: the byte count arrives in the
       * compiler's slot, which the strcmp checks cross-examine against the
       * terminator the bridge still writes. */
      "  size_t textLength = 0;",
      `  char *text = ${labelSymbol}(w, 5, &textLength, &error);`,
      "  if (text == NULL || error != NULL || textLength != 8) return 21;",
      '  if (strcmp(text, "widget-5") != 0) return 22;',
      "  free(text);",
      /* Non-BMP round trip: the party popper is 4 UTF-8 bytes and one
       * UTF-16 surrogate pair; both bridges must agree exactly. The C hex
       * escapes must survive to the C compiler (double backslash here):
       * a JS-interpreted spelling re-encodes into 8 Latin-1-shaped bytes
       * and tests a different, BMP-only string - which the length slot is
       * what finally caught. */
      `  text = ${greetSymbol}("\\xf0\\x9f\\x8e\\x89", &textLength, &error);`,
      "  if (text == NULL || error != NULL || textLength != 8) return 23;",
      '  if (strcmp(text, "hi \\xf0\\x9f\\x8e\\x89!") != 0) return 24;',
      "  free(text);",
      /* A successful null writes the (NULL, 0) pair whole: the poison
       * proves the adapter wrote the zero rather than inheriting it. */
      "  textLength = 99;",
      `  text = ${greetSymbol}(NULL, &textLength, &error);`,
      "  if (text != NULL || error != NULL || textLength != 0) return 25;",
      /* The founding refusal, live: U+0000 crosses as one byte of data,
       * and only the length can say so - strcmp would stop at it. */
      `  text = ${withNulSymbol}(&textLength, &error);`,
      "  if (text == NULL || error != NULL || textLength != 3) return 26;",
      '  if (memcmp(text, "a\\0b", 3) != 0) return 55;',
      "  free(text);",
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
      `  text = ${joinWordsSymbol}(tags, &textLength, &error);`,
      "  if (text == NULL || error != NULL || textLength != 10) return 38;",
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
      /* The inward direction, end to end in C: connect a handler, let Java
       * call it (ping dispatches onPing per iteration), check the answers
       * steered Java's own control flow AND the context crossed; a second
       * connect on the same instance refuses; after disconnect, Java's call
       * throws IllegalStateException, which the ping ADAPTER captures into
       * the checked channel; release after disconnect is idempotent. */
      "  int pingContext = 0;",
      `  void *connection = ${connectOnPing}(w, nts_test_on_ping, &pingContext);`,
      "  if (connection == NULL) return 47;",
      `  if (${connectOnPing}(w, nts_test_on_ping, &pingContext) != NULL) return 48;`,
      `  if (${pingSymbol}(w, 4, &error) != 2 || error != NULL) return 49;`,
      "  if (pingContext != 6) return 50;",
      `  ${disconnectSymbol}(connection);`,
      `  (void)${pingSymbol}(w, 1, &error);`,
      "  if (error == NULL ||",
      `      strstr(${messageSymbol}(error), "no TypeScript handler") == NULL) return 51;`,
      `  ${releaseSymbol}(error); error = NULL;`,
      `  ${connectionFreeSymbol}(connection);`,
      /* The queued trampoline at the C level is an inline call - the queue
       * exists only in the compiler's thunk - so the void round-trip
       * proves the plumbing: three ticks accumulate (1+2+3), and release
       * without a prior disconnect cancels on the way out. */
      "  int tickContext = 0;",
      `  void *tickConnection = ${connectOnTick}(w, nts_test_on_tick, &tickContext);`,
      "  if (tickConnection == NULL) return 52;",
      `  ${tickSymbol}(w, 3, &error);`,
      "  if (error != NULL || tickContext != 6) return 53;",
      `  ${connectionFreeSymbol}(tickConnection);`,
      `  (void)${tickSymbol}(w, 1, &error);`,
      "  if (error == NULL) return 54;",
      `  ${releaseSymbol}(error); error = NULL;`,
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
