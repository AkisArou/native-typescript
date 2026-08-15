import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { resolvePkgConfigSdk } from "@native-typescript/core";

const fixtureRoot = join(import.meta.dirname, "fixtures", "pkg-config");
const executable = join(fixtureRoot, "fake-pkg-config.sh");

test("pkg-config SDK resolution preserves compile inputs and exact system libraries", async () => {
  const resolved = await resolvePkgConfigSdk({
    id: "fake-sdk",
    executable,
    modules: ["fake-sdk"],
    target: "x86_64-unknown-linux-gnu",
  });

  assert.deepEqual(resolved.modules, [{ name: "fake-sdk", version: "4.5.6" }]);
  assert.equal(resolved.resolver.version, "1.2.3");
  assert.equal(resolved.artifacts.length, 2);
  assert.deepEqual(resolved.compileArguments, [
    { kind: "literal", value: "-isystem" },
    { kind: "input-path", artifact: "sdk/pkg-config/fake-sdk/include/0" },
    { kind: "literal", value: "-DFAKE_VALUE=a b" },
    { kind: "literal", value: "-isystem" },
    { kind: "input-path", artifact: "sdk/pkg-config/fake-sdk/include/1" },
  ]);
  assert.deepEqual(resolved.systemLibraries, ["fake-one", "fake_two"]);
  const serializedArtifacts = JSON.stringify(resolved.artifacts);
  for (const path of Object.values(resolved.sourcePaths)) {
    assert.equal(serializedArtifacts.includes(path), false);
  }
});

test("pkg-config SDK resolution rejects unmodeled linker fragments", async () => {
  await assert.rejects(
    resolvePkgConfigSdk({
      id: "fake-bad-link",
      executable,
      modules: ["fake-bad-link"],
      target: "x86_64-unknown-linux-gnu",
    }),
    /unsupported system-library fragment: -pthread/u,
  );
});
