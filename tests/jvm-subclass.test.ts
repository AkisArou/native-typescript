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
  assert.deepEqual(first.callbacks, ["onEvent"]);
});

test("refusals name Java's own rules and the missing contract arms", () => {
  for (
    const [overrides, pattern] of [
      [["sealed"], /'sealed' is final; Java itself refuses the override/u],
      [
        ["onNotify"],
        /void-synchronous arm is its own admission, and a lifecycle method is its failing program/u,
      ],
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
      overrides: ["onEvent"],
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
              callbacks: generated.callbacks,
            },
          ],
        },
      );
      const adapter = generateJvmAdapterSource(snapshot, {
        packageSlug: "bridge",
      });
      assert.equal(adapter.callbacks.length, 1);
      assert.deepEqual(adapter.callbacks[0]!.parameters, [
        { kind: "primitive", primitive: "int" },
      ]);
      assert.equal(adapter.callbacks[0]!.answers, true);
      assert.equal(adapter.callbacks[0]!.className, "fixture/HostBridge");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  },
);
