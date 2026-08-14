import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const scriptcRoot = join(repositoryRoot, "third_party/scriptc");
const fixtureRoot = join(repositoryRoot, "fixtures/scabi-c-v1");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const result = spawnSync(
  pnpm,
  ["exec", "vitest", "run", "tests/harness/native-ir.test.ts"],
  {
    cwd: scriptcRoot,
    env: {
      ...process.env,
      SCRIPTC_NATIVE_IR_FIXTURE_SOURCE: join(
        fixtureRoot,
        "src/nts_scabi_fixture.c",
      ),
      SCRIPTC_NATIVE_IR_FIXTURE_INCLUDE: join(fixtureRoot, "include"),
    },
    stdio: "inherit",
  },
);

if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
