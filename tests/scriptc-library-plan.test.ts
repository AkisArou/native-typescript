import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadScriptCLibraryPlanners,
  scriptCCompilerDistribution,
  verifyScriptCEmbedderProtocol,
} from "@native-typescript/scriptc";

const workspace = join(import.meta.dirname, "..");
const scriptcRoot = join(workspace, "third_party/scriptc");
const fixtureRoot = join(workspace, "fixtures/scriptc-library");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

test(
  "the workspace can plan a ScriptC library without building one",
  { skip: !existsSync(join(scriptcRoot, "package.json")) },
  async () => {
    /* A library is the product an embedding target needs: the JVM target
     * links one into a shared object that a Java host loads, and Android
     * will do the same. What the target must own is the LINK — how a library
     * is packaged for a host platform is where the platform knowledge lives
     * — so the compiler's product is a static archive and the plan is how a
     * build graph gets one without the compiler writing it anywhere. */
    execFileSync(
      pnpm,
      ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"],
    );
    assert.equal(existsSync(scriptCCompilerDistribution()), true);

    /* Through the loader rather than a path: importing the built compiler
     * directly makes the workspace fail to typecheck until the submodule has
     * been built, which a clean checkout has not. */
    const { planLibraryCompilation, planLibraryExternalCBuild } =
      await loadScriptCLibraryPlanners();

    /* The profile names its own entry, so it is staged with an absolute one
     * rather than the planner being told where the sources are. */
    const scratch = mkdtempSync(join(tmpdir(), "nts-library-plan-"));
    try {
      const profile = JSON.parse(
        readFileSync(join(fixtureRoot, "profile.json"), "utf8"),
      ) as { entry: string };
      profile.entry = join(fixtureRoot, profile.entry);
      const profilePath = join(scratch, "profile.json");
      writeFileSync(profilePath, JSON.stringify(profile, null, 2));

      const planned = await planLibraryCompilation({ profilePath });
      assert.equal(planned.ok, true, JSON.stringify(planned));
      if (!planned.ok) return;

      assert.equal(planned.plan.schema, "scriptc.library-compilation-plan");
      assert.equal(planned.plan.emission, "c");
      /* No output location anywhere in it. A plan that named one would make
       * two builds of the same program differ by where they ran, which is
       * what content-addressing a plan is meant to rule out. */
      const serialized = JSON.stringify(planned.plan);
      assert.ok(!serialized.includes(scratch));
      assert.equal(
        (planned.plan.nativeBuild as Record<string, unknown>)["outPath"],
        undefined,
      );

      const build = await planLibraryExternalCBuild(planned.plan, {
        program: "program.c",
        runtime: "scriptc-runtime",
        output: "library.a",
        objectIdPrefix: "obj/",
      });

      /* One compile per object and one archive collecting exactly those,
       * so a graph that runs the compiles can also run the archive rather
       * than letting the compiler produce an artifact it never declared. */
      assert.ok(build.objects.length > 0);
      assert.equal(build.plans.length, build.objects.length + 1);
      const archive = build.plans.at(-1);
      assert.ok(archive);
      assert.equal(archive.output, "library.a");
      for (const object of build.objects) {
        assert.ok(archive.inputs.includes(object.id), object.id);
      }
      /* Every command is path-free at the boundary: the driver's own
       * arguments carry logical inputs and outputs, never workspace paths. */
      for (const plan of build.plans) {
        assert.equal(plan.schema, "scriptc.external-cc-plan");
        assert.ok(!JSON.stringify(plan.arguments).includes(scratch));
      }
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  },
);

test("a compiler that implements a different contract is refused", () => {
  /* The loaders used to check only that the expected FUNCTIONS existed, so a
   * distribution built from an incompatible revision passed and failed later
   * with a structurally wrong plan — at a distance from the mismatch that
   * caused it. A stale `dist` after a submodule repin is the ordinary way to
   * reach that state, and easy to reach by accident. */
  const stale = {
    protocol: "scriptc.embedder",
    protocolVersion: 1,
    /* One version behind and otherwise identical: the shape a stale build
     * actually has, not a wholly foreign object. */
    irVersion: 43,
    executablePlanVersion: 1,
    libraryPlanVersion: 1,
    externalCcPlanVersion: 1,
  };

  assert.throws(
    () => verifyScriptCEmbedderProtocol(stale, "/somewhere/dist"),
    (error: Error) => {
      /* Both sides named, and the remedy, because the likely cause is a
       * build older than the checkout rather than a foreign fork. */
      assert.match(error.message, /irVersion: expected 46, found 43/u);
      assert.match(error.message, /its build is stale/u);
      assert.match(error.message, /pnpm scriptc:build/u);
      /* And only the version that moved is reported. */
      assert.doesNotMatch(error.message, /libraryPlanVersion/u);
      return true;
    },
  );

  assert.throws(
    () => verifyScriptCEmbedderProtocol(null, "/somewhere/dist"),
    /malformed embedder protocol/u,
  );

  /* The other half of the claim: the real compiler agrees, so the check is
   * not vacuously refusing everything. */
  verifyScriptCEmbedderProtocol(
    {
      protocol: "scriptc.embedder",
      protocolVersion: 1,
      irVersion: 46,
      executablePlanVersion: 1,
      libraryPlanVersion: 1,
      externalCcPlanVersion: 1,
    },
    "/somewhere/dist",
  );
});
