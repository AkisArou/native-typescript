import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadScriptCLibraryPlanners,
  scriptCCompilerDistribution,
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
