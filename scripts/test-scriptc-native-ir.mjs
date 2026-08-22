import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseScabiManifest } from "../packages/scabi/src/index.ts";
import { translateScabiNativeProgram } from "../packages/scriptc/src/index.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const scriptcRoot = join(repositoryRoot, "third_party/scriptc");
const fixtureRoot = join(repositoryRoot, "fixtures/scabi-c-v1");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const manifest = structuredClone(parseScabiManifest(
  readFileSync(join(fixtureRoot, "package.scabi.json"), "utf8"),
));
Object.assign(manifest.bindings, {
  /* The same exact type a generated surface can only declare as `number`,
   * because type mapping runs from the underlying primitive and a brand does
   * not change it. Injected here beside the exact spelling so the cross-gate
   * runs both branches of the constant rule through the parent's translator. */
  fixture_count: {
    kind: "constant",
    declaration: { module: ".", name: "FixtureValue.count" },
    type: "i32",
    value: "17",
    dependencies: {
      adapterInputs: [],
      bindings: [],
      linkInputs: [],
      permissions: [],
    },
  },
  fixture_answer: {
    kind: "constant",
    declaration: { module: ".", name: "FixtureValue.answer" },
    type: "i32",
    value: "42",
    dependencies: {
      adapterInputs: [],
      bindings: [],
      linkInputs: [],
      permissions: [],
    },
  },
});
const translated = translateScabiNativeProgram(manifest, {
  imports: [
    "fixture_answer",
    "fixture_count",
    "i8_identity",
    "u8_identity",
    "i16_identity",
    "u16_identity",
    "i32_identity",
    "number_i32_identity",
    "number_u32_identity",
    "u32_identity",
    "i64_identity",
    "u64_identity",
    "usize_identity",
    "native_false",
    "native_invalid_boolean",
    "native_not",
    "native_true",
    "pair32_transform",
    "nested_pair32_transform",
    "padded_roundtrip",
    "hash_utf8",
    "c_string_observe",
    "hash_bytes",
    "call_scoped",
    "subscription_create",
    "subscription_emit",
    "subscription_emit_foreign",
    "fail_errno",
    "error_handle_fail",
    "error_out_divide",
    "fixture_errors_outstanding",
    "counter_create",
    "counter_add",
    "counter_value",
    "counter_value_or",
    "counter_base_value_or",
    "counter_label",
    "counter_required_label",
    "counter_destroyed_count",
    "counter_verify",
    "teller_create",
    "teller_tell",
    "teller_destroy",
    "tell_mark",
    "judge_create",
    "judge_ask",
    "judge_destroy",
    "notice_register",
    "notice_mark",
    "notice_fire",
    "maybe_register",
    "maybe_mark",
    "maybe_fire",
    "maybe_judge_create",
    "judge_ask_maybe",
    "span_label",
    "span_label_maybe",
    "tick_register",
    "tick_source_destroy",
    "tick_target_destroy",
    "unmapped_value",
    "tick_virtual",
    "tick_base",
    "tick_value",
    "tick_mark",
    "tick_fire",
    "error_out_i8",
    "error_out_u8",
  ],
  exports: [],
});
if (!translated.ok) {
  throw new Error(
    translated.diagnostics
      .map((diagnostic) => `${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`)
      .join("\n"),
  );
}

const declarationsDirectory = mkdtempSync(join(tmpdir(), "nts-scriptc-declarations-"));
const declarationsPath = join(declarationsDirectory, "package.d.ts");
writeFileSync(
  declarationsPath,
  `${readFileSync(join(fixtureRoot, "package.d.ts"), "utf8")}\n` +
    "export declare namespace FixtureValue {\n  const answer: i32;\n" +
    "  const count: number;\n}\n",
);

let result;
try {
  result = spawnSync(
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
        SCRIPTC_NATIVE_IR_DECLARATIONS: declarationsPath,
        SCRIPTC_NATIVE_FRONTEND_INPUT: JSON.stringify(translated.input),
      },
      stdio: "inherit",
    },
  );
} finally {
  rmSync(declarationsDirectory, { force: true, recursive: true });
}

if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
