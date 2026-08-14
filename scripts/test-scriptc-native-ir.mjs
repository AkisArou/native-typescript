import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseScabiManifest } from "../packages/scabi/src/index.ts";
import { translateScabiNativeProgram } from "../packages/scriptc/src/index.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const scriptcRoot = join(repositoryRoot, "third_party/scriptc");
const fixtureRoot = join(repositoryRoot, "fixtures/scabi-c-v1");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const manifest = parseScabiManifest(
  readFileSync(join(fixtureRoot, "package.scabi.json"), "utf8"),
);
const translated = translateScabiNativeProgram(manifest, [
  "i8_identity",
  "u8_identity",
  "i16_identity",
  "u16_identity",
  "i32_identity",
  "u32_identity",
  "i64_identity",
  "u64_identity",
  "usize_identity",
]);
if (!translated.ok) {
  throw new Error(
    translated.diagnostics
      .map((diagnostic) => `${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`)
      .join("\n"),
  );
}

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
      SCRIPTC_NATIVE_IR_DECLARATIONS: join(fixtureRoot, "package.d.ts"),
      SCRIPTC_NATIVE_FRONTEND_INPUT: JSON.stringify(translated.input),
    },
    stdio: "inherit",
  },
);

if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
