/* The sanitized retained-callback lane.
 *
 * The ordinary lanes prove behavior: the right values arrive, in the right
 * order, and the right errors are raised. They say nothing about references,
 * so a registration whose closure is never released passes every one of them.
 * That is not hypothetical — the substrate merge shipped exactly that leak,
 * and the only thing that caught it was building these two suites with the
 * sanitizer and reading the runtime's own reference audit at exit.
 *
 * Kept out of `pnpm test` because an ASan build of every fixture is minutes,
 * not seconds. Run it after anything that touches registration lifetime,
 * payload ownership, or the delivery transport.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const scriptcRoot = fileURLToPath(new URL("../third_party/scriptc/", import.meta.url));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

/* Both suites, because they exercise different halves: the profile's
 * conformance cases cover registrations nothing owns, and the native-IR cases
 * cover the ones a handle owns. A leak in either is a leak.
 *
 * One invocation each, so a sanitized build's memory does not have to hold
 * both at once and so a failure names one suite. */
const suites = [
  join("tests", "harness", "ffi.test.ts"),
  join("tests", "harness", "native-ir.test.ts"),
];

let failed = false;
for (const suite of suites) {
  const result = spawnSync(
    pnpm,
    ["exec", "vitest", "run", suite, "--testTimeout=120000"],
    {
      cwd: scriptcRoot,
      stdio: "inherit",
      env: { ...process.env, SCRIPTC_SAN: "1" },
    },
  );
  if (result.error !== undefined) {
    console.error(`sanitized lane could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
