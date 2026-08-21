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
  assert.match(
    first.source,
    /public final class HostBridge extends Host \{/u,
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
      overrides: ["onEvent", "onNotify"],
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
      const snapshot = ingestJvmClasses(
        [
          {
            logicalPath: "fixtures/jvm/classes/fixture/Host.class",
            bytes: readFileSync(
              resolve(repositoryRoot, "fixtures/jvm/classes/fixture/Host.class"),
            ),
          },
          { logicalPath: "generated/fixture/HostBridge.class", bytes: readFileSync(compiled) },
        ],
        {
          classes: [
            {
              binaryName: "fixture/Host",
              constructors: ["()V"],
              methods: ["run"],
            },
            {
              binaryName: generated.subclassBinaryName,
              constructors: ["()V"],
              methods: generated.methods,
              callbacks: generated.callbacks,
            },
          ],
        },
      );
      const adapter = generateJvmAdapterSource(snapshot, {
        packageSlug: "bridge",
      });
      /* Both arms of the override contract cross the same machinery: the
       * answered override and the telling one, whose stated synchronous
       * delivery survives the compiled class file it cannot be read from. */
      assert.deepEqual(
        adapter.callbacks.map(({ name, delivery }) => ({ name, delivery })),
        [
          { name: "onEvent", delivery: "answered" },
          { name: "onNotify", delivery: "told" },
        ],
      );
      assert.deepEqual(adapter.callbacks[0]!.parameters, [
        { kind: "primitive", primitive: "int" },
      ]);
      assert.equal(adapter.callbacks[0]!.className, "fixture/HostBridge");
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
