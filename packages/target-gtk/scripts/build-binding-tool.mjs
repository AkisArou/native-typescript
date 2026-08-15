import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(
  packageRoot,
  "node_modules/.runtime/gtk-binding-tool-cli.mjs",
);

await mkdir(dirname(output), { recursive: true });
await build({
  entryPoints: [resolve(packageRoot, "src/gtk-binding-tool-cli.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "bundle",
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
});
