import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  JvmGenerationError,
  generateJvmAdapterSource,
  generateJvmSubclassSource,
  ingestJvmClasses,
} from "@native-typescript/bindgen-jvm";
import type { JvmSnapshot } from "@native-typescript/bindgen-jvm";

const repositoryRoot = resolve(import.meta.dirname, "..");

function hostSnapshot(
  methods: readonly (string | { name: string; descriptor: string })[] = [
    "onEvent",
    "run",
    "sealed",
    "onNotify",
    "onMeasure",
  ],
): JvmSnapshot {
  return ingestJvmClasses(
    [
      {
        logicalPath: "fixtures/jvm/classes/fixture/Host.class",
        bytes: readFileSync(
          resolve(repositoryRoot, "fixtures/jvm/classes/fixture/Host.class"),
        ),
      },
    ],
    {
      classes: [
        { binaryName: "fixture/Host", constructors: ["()V"], methods },
      ],
    },
  );
}

test("the generated subclass is deterministic and spells the override native", () => {
  const first = generateJvmSubclassSource(hostSnapshot(), {
    baseBinaryName: "fixture/Host",
    overrides: ["onEvent"],
  });
  assert.deepEqual(
    generateJvmSubclassSource(hostSnapshot(), {
      baseBinaryName: "fixture/Host",
      overrides: ["onEvent"],
    }),
    first,
  );
  assert.equal(first.subclassBinaryName, "fixture/HostBridge");
  assert.equal(first.logicalPath, "fixture/HostBridge.java");
  assert.match(first.source, /package fixture;/u);
  /* The base is named in full: the subclass may live in a package the
   * base does not, and a qualified extends clause is right either way. */
  assert.match(
    first.source,
    /public final class HostBridge extends fixture\.Host \{/u,
  );
  assert.match(
    first.source,
    /@Override\n {2}public native boolean onEvent\(int a0\);/u,
  );
  // The native super binding rides beside the override: the base
  // implementation reached non-virtually, as an ordinary method.
  assert.match(
    first.source,
    /public boolean ntsSuperOnEvent\(int a0\) \{\n {4}return super\.onEvent\(a0\);\n {2}\}/u,
  );
  assert.deepEqual(first.callbacks, ["onEvent"]);
  assert.deepEqual(first.methods, [
    { name: "ntsSuperOnEvent", descriptor: "(I)Z" },
  ]);
});

test("refusals name Java's own rules and the missing contract arms", () => {
  for (
    const [overrides, pattern] of [
      [["sealed"], /'sealed' is final; Java itself refuses the override/u],
      [["absent"], /does not exist on 'fixture\/Host'/u],
    ] as const
  ) {
    try {
      generateJvmSubclassSource(hostSnapshot(), {
        baseBinaryName: "fixture/Host",
        overrides,
      });
      assert.fail(`expected refusal for ${overrides[0]}`);
    } catch (error) {
      assert.ok(error instanceof JvmGenerationError);
      assert.match(error.diagnostics[0]!.message, pattern);
    }
  }
});

test("a void override tells: native void, delivery decided by the generator", () => {
  // Once the refusal fixture for the missing arm, onNotify is now the
  // golden void override. The generator, not the caller, states the
  // delivery: an override exists to be observed by the framework code
  // that dispatched it, so `synchronous` is a decision made where the
  // subclass is generated rather than a knob passed through.
  const generated = generateJvmSubclassSource(hostSnapshot(), {
    baseBinaryName: "fixture/Host",
    overrides: ["onNotify"],
  });
  assert.match(
    generated.source,
    /@Override\n {2}public native void onNotify\(int a0\);/u,
  );
  assert.match(
    generated.source,
    /public void ntsSuperOnNotify\(int a0\) \{\n {4}super\.onNotify\(a0\);\n {2}\}/u,
  );
  assert.deepEqual(generated.callbacks, [
    { name: "onNotify", descriptor: "(I)V", delivery: "synchronous" },
  ]);
  assert.deepEqual(generated.methods, [
    { name: "ntsSuperOnNotify", descriptor: "(I)V" },
  ]);
});

test("a platform-constructed subclass names its own package and loads its library", () => {
  // Both facts come from the same place: a class the PLATFORM constructs.
  // Nothing of ours runs before it, so its own initializer is the only
  // place the native half can be loaded — and Android refuses to load
  // application classes defined in the android.* namespace, so the
  // default of "the base's package" is exactly wrong for a platform base.
  const generated = generateJvmSubclassSource(hostSnapshot(), {
    baseBinaryName: "fixture/Host",
    overrides: ["onEvent"],
    subclassBinaryName: "com/example/app/MainScreen",
    loadLibrary: "ntsdemo",
  });
  assert.equal(generated.subclassBinaryName, "com/example/app/MainScreen");
  assert.equal(generated.logicalPath, "com/example/app/MainScreen.java");
  assert.match(generated.source, /^package com\.example\.app;$/mu);
  assert.match(
    generated.source,
    /public final class MainScreen extends fixture\.Host \{/u,
  );
  assert.match(
    generated.source,
    /\{\n {2}static \{\n {4}System\.loadLibrary\("ntsdemo"\);\n {2}\}/u,
  );
  // The library load precedes every native override, which is the only
  // ordering that makes a platform-dispatched override resolvable.
  assert.ok(
    generated.source.indexOf("System.loadLibrary") <
      generated.source.indexOf("public native"),
  );
});

test("an object payload crosses the generator as its Java source spelling", () => {
  // Generation admits any object javac can spell — whether the payload's
  // class projects is the adapter's refusal, made where the selection is
  // known. The spelling is the binary name with dots: fixture/Widget is
  // `fixture.Widget` in Java source.
  const generated = generateJvmSubclassSource(hostSnapshot(), {
    baseBinaryName: "fixture/Host",
    overrides: ["onMeasure"],
  });
  assert.match(
    generated.source,
    /@Override\n {2}public native boolean onMeasure\(int a0, fixture\.Widget a1\);/u,
  );
  assert.match(
    generated.source,
    /public boolean ntsSuperOnMeasure\(int a0, fixture\.Widget a1\) \{\n {4}return super\.onMeasure\(a0, a1\);\n {2}\}/u,
  );
  assert.deepEqual(generated.callbacks, ["onMeasure"]);
  assert.deepEqual(generated.methods, [
    { name: "ntsSuperOnMeasure", descriptor: "(ILfixture/Widget;)Z" },
  ]);
});

test("the void-synchronous arm's committed evidence now generates", () => {
  // Lifecycle.start() calls onCreate and then OBSERVES it, so queued
  // delivery is distinguishable from synchronous by construction: a
  // handler that ran late answers 0 where 1 is the truth. This test
  // pinned the refusal until fork 3c33818a admitted the arm — the
  // committed failing program was the admission's evidence, and the
  // fixture's three recorded questions are now answered: the void result
  // crosses (here), handle payloads still wait (the android-sdk pin), and
  // a synchronous void handler's throw stays pending exactly as the
  // asking form's does — a telling form simply has no answer to give, so
  // the two arms share the contract rather than each spelling its own.
  const lifecycle = ingestJvmClasses(
    [
      {
        logicalPath: "fixtures/jvm/classes/fixture/Lifecycle.class",
        bytes: readFileSync(
          resolve(
            repositoryRoot,
            "fixtures/jvm/classes/fixture/Lifecycle.class",
          ),
        ),
      },
    ],
    {
      classes: [
        {
          binaryName: "fixture/Lifecycle",
          constructors: ["()V"],
          methods: ["onCreate", "start"],
        },
      ],
    },
  );
  const generated = generateJvmSubclassSource(lifecycle, {
    baseBinaryName: "fixture/Lifecycle",
    overrides: ["onCreate"],
  });
  assert.match(
    generated.source,
    /@Override\n {2}public native void onCreate\(\);/u,
  );
  assert.match(
    generated.source,
    /public void ntsSuperOnCreate\(\) \{\n {4}super\.onCreate\(\);\n {2}\}/u,
  );
  assert.deepEqual(generated.callbacks, [
    { name: "onCreate", descriptor: "()V", delivery: "synchronous" },
  ]);
});

/**
 * The spanning proof, javac being the authority: the generated source
 * compiles against the base's real classes, the compiled subclass ingests,
 * and its native override is exactly the callback selection the generator
 * promised — so the ingress machinery takes over with nothing new.
 */
function discoverJavac(): string | null {
  try {
    execFileSync("javac", ["-version"], { stdio: "ignore" });
    return "javac";
  } catch {
    return null;
  }
}

const javac = discoverJavac();

test(
  "the generated source compiles and its override ingests as a callback",
  { skip: javac === null ? "no javac on this host" : false },
  () => {
    const generated = generateJvmSubclassSource(hostSnapshot(), {
      baseBinaryName: "fixture/Host",
      overrides: ["onEvent", "onMeasure", "onNotify"],
    });
    const workDir = mkdtempSync(join(tmpdir(), "nt-jvm-subclass-"));
    try {
      const sourcePath = join(workDir, generated.logicalPath);
      mkdirSync(dirname(sourcePath), { recursive: true });
      writeFileSync(sourcePath, generated.source);
      execFileSync(javac!, [
        "-cp",
        resolve(repositoryRoot, "fixtures/jvm/classes"),
        "-d",
        join(workDir, "classes"),
        sourcePath,
      ]);
      const compiled = join(workDir, "classes/fixture/HostBridge.class");
      assert.ok(existsSync(compiled));
      const sources = [
        {
          logicalPath: "fixtures/jvm/classes/fixture/Host.class",
          bytes: readFileSync(
            resolve(repositoryRoot, "fixtures/jvm/classes/fixture/Host.class"),
          ),
        },
        {
          logicalPath: "fixtures/jvm/classes/fixture/Widget.class",
          bytes: readFileSync(
            resolve(repositoryRoot, "fixtures/jvm/classes/fixture/Widget.class"),
          ),
        },
        { logicalPath: "generated/fixture/HostBridge.class", bytes: readFileSync(compiled) },
      ];
      const bridgeSelection = {
        binaryName: generated.subclassBinaryName,
        constructors: ["()V"],
        methods: generated.methods,
        callbacks: generated.callbacks,
      };
      const hostSelection = {
        binaryName: "fixture/Host",
        constructors: ["()V"] as const,
        methods: ["run"],
      };
      /* The payload's class must be selected to project — the refusal the
       * generator deliberately leaves to the stage that knows the
       * selection. */
      try {
        generateJvmAdapterSource(
          ingestJvmClasses(sources.slice(0, 1).concat(sources.slice(2)), {
            classes: [hostSelection, bridgeSelection],
          }),
          { packageSlug: "bridge" },
        );
        assert.fail("expected the unselected-payload refusal");
      } catch (error) {
        assert.ok(error instanceof JvmGenerationError);
        assert.ok(error.diagnostics.some(({ message }) =>
          message.includes(
            "which this selection does not project; select the class to move the boundary",
          )
        ));
      }
      const snapshot = ingestJvmClasses(sources, {
        classes: [
          hostSelection,
          { binaryName: "fixture/Widget", constructors: ["()V"] },
          bridgeSelection,
        ],
      });
      const adapter = generateJvmAdapterSource(snapshot, {
        packageSlug: "bridge",
      });
      /* All three arms of the override contract cross the same machinery:
       * the answered override, the answered one holding an object, and
       * the telling one, whose stated synchronous delivery survives the
       * compiled class file it cannot be read from. */
      assert.deepEqual(
        adapter.callbacks.map(({ name, delivery }) => ({ name, delivery })),
        [
          { name: "onEvent", delivery: "answered" },
          { name: "onMeasure", delivery: "answered" },
          { name: "onNotify", delivery: "told" },
        ],
      );
      assert.deepEqual(adapter.callbacks[0]!.parameters, [
        { kind: "primitive", primitive: "int" },
      ]);
      assert.deepEqual(adapter.callbacks[1]!.parameters, [
        { kind: "primitive", primitive: "int" },
        { kind: "handle", binaryName: "fixture/Widget", nullability: "unstated" },
      ]);
      assert.equal(adapter.callbacks[0]!.className, "fixture/HostBridge");
      /* The payload trampoline: promotion happens only AFTER the
       * registration match, so the no-match path never takes a reference
       * there is nothing to give back on — and only when there IS an
       * object, because a synchronous payload may be withheld and absence
       * is not a failure to promote. */
      assert.ok(adapter.source.includes("jobject payload1 = a1 == NULL"));
      assert.ok(adapter.source.includes(
        "          : (*env)->NewGlobalRef(env, a1);",
      ));
      /* A dispatch on a thread that does not own the instance throws by
       * name rather than reading a closure it must not: the obligation
       * the runtime does not police, made observable where it is broken. */
      assert.ok(adapter.source.includes(
        "was dispatched on a thread that does not own the TypeScript instance",
      ));
      /* The super bindings ingested as ordinary instance methods — the
       * dual-method-and-callback refusal does not fire because the super
       * spelling and the override are different members. */
      const superMethod = adapter.instanceMethods.find(
        ({ name }) => name === "ntsSuperOnEvent",
      );
      assert.ok(superMethod !== undefined);
      assert.deepEqual(superMethod!.result, {
        kind: "primitive",
        primitive: "boolean",
      });
      const superTell = adapter.instanceMethods.find(
        ({ name }) => name === "ntsSuperOnNotify",
      );
      assert.ok(superTell !== undefined);
      assert.deepEqual(superTell!.result, { kind: "void" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  },
);
