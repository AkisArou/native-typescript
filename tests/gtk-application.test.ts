import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildGtkApplication,
  parseGtkApplicationProject,
} from "@native-typescript/target-gtk";
import { scriptCCompilerDistribution } from "@native-typescript/scriptc";
import { executable } from "./support/artifacts.ts";
import { bindingToolPath, systemGioGir, systemGtkGir } from "./support/gir-analysis.ts";
import { runApplication } from "./support/run-application.ts";

const workspace = join(import.meta.dirname, "..");
const scriptcRoot = join(workspace, "third_party/scriptc");
const fixtureRoot = join(workspace, "fixtures/gtk-application");
const windowFixtureRoot = join(workspace, "fixtures/gtk-window");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const hasGtk = spawnSync("pkg-config", ["--exists", "gtk4"]).status === 0;
const hasXvfb = spawnSync("xvfb-run", ["--help"]).status === 0;
const hasClang = spawnSync("clang", ["--version"]).status === 0;
const hasBubblewrap = spawnSync("bwrap", ["--version"]).status === 0;

const unavailable =
  process.platform !== "linux" ||
  process.arch !== "x64" ||
  !existsSync(systemGioGir) ||
  !existsSync(systemGtkGir) ||
  !hasGtk ||
  !hasXvfb ||
  !hasClang ||
  !hasBubblewrap;

test("a GTK project describes the surface it wants and nothing derived", () => {
  const project = parseGtkApplicationProject(
    readFileSync(join(fixtureRoot, "native-typescript.json"), "utf8"),
  );
  assert.equal(project.name, "gtk-application");
  assert.equal(project.entry, "app.ts");
  assert.deepEqual(
    project.namespaces.map(({ name, version }) => `${name}-${version}`),
    ["Gio-2.0", "Gtk-4.0"],
  );
  // Gtk depends on Gio, and a project states that rather than the build guessing.
  assert.deepEqual(project.namespaces[1]?.imports, [
    { name: "Gio", version: "2.0" },
  ]);
});

test("a GTK project that imports a namespace it has not selected is refused", () => {
  assert.throws(
    () =>
      parseGtkApplicationProject(
        JSON.stringify({
          schema: "native-typescript.project",
          schemaVersion: 1,
          name: "broken",
          target: "gtk4",
          entry: "app.ts",
          namespaces: [
            {
              name: "Gtk",
              version: "4.0",
              sdkModules: ["gtk4"],
              imports: [{ name: "Gio", version: "2.0" }],
              classes: [],
            },
          ],
        }),
      ),
    /\/namespaces\/0\/imports: imports Gio-2\.0, which is not selected before it/u,
  );
});

test("a GTK project rejects a field nobody defined", () => {
  assert.throws(
    () =>
      parseGtkApplicationProject(
        JSON.stringify({
          schema: "native-typescript.project",
          schemaVersion: 1,
          name: "typo",
          target: "gtk4",
          entry: "app.ts",
          namespaces: [
            { name: "Gtk", version: "4.0", sdkModules: ["gtk4"], klasses: [] },
          ],
        }),
      ),
    /\/namespaces\/0\/klasses: is not a known field/u,
  );
});

test(
  "a generated GTK application drives its own lifecycle with no hand-written C",
  { skip: unavailable || !existsSync(bindingToolPath) },
  async () => {
    /* Everything this executable calls is either generated from GIR or shipped
     * by the target. There is no fixture C at all, so a failure here is a
     * failure of the generated surface rather than of scaffolding written to
     * flatter it. The build itself is the product's own pipeline — a gate that
     * reassembled it would be proving something about the gate. */
    execFileSync(pnpm, [
      "--dir",
      scriptcRoot,
      "--filter",
      "@scriptc/compiler",
      "build",
    ]);
    assert.equal(existsSync(scriptCCompilerDistribution()), true);

    const project = parseGtkApplicationProject(
      readFileSync(join(fixtureRoot, "native-typescript.json"), "utf8"),
    );
    const scratch = mkdtempSync(join(tmpdir(), "nts-gtk-application-"));
    try {
      for (const backend of ["c", "llvm"] as const) {
        const built = await buildGtkApplication({
          projectRoot: fixtureRoot,
          project,
          scratch: join(scratch, backend),
          backend,
          tools: {
            clang: executable("clang"),
            node: process.execPath,
            pkgConfig: executable("pkg-config"),
            sandbox: executable("bwrap"),
          },
        });

        const declarations = new Map(
          built.generatedPackages.map(({ slug, path }) => [
            slug,
            readFileSync(join(path, "package.d.ts"), "utf8"),
          ]),
        );
        // The lifecycle the application calls is generated, not hand-written.
        assert.match(
          declarations.get("gio2") ?? "",
          /register\(cancellable: Cancellable\): void;/u,
        );
        assert.match(
          declarations.get("gio2") ?? "",
          /const NonUnique: ApplicationFlags;/u,
        );
        // Gtk.Application inherits its lifecycle across a package boundary.
        assert.match(
          declarations.get("gtk4") ?? "",
          /class Application extends GioApplication/u,
        );

        assert.deepEqual(runApplication(built.productPath), {
          status: 0,
          signal: null,
          stdout: "activated 1\n",
          stderr: "",
        }, backend);
      }
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  },
);

test(
  "an application that connects no signal still links its target's runtime",
  { skip: unavailable || !existsSync(bindingToolPath) },
  async () => {
    /* ScriptC includes a runtime service when the compiled program reaches it,
     * which is right for the program and wrong for the target: the GLib owner
     * runtime calls the retained-callback service whether or not the
     * application connects anything. The provider says so in
     * requires.compiler, and the build reads it. Without that this program
     * fails to link on seven undefined symbols.
     *
     * It is also the only project built from a single namespace. */
    execFileSync(pnpm, [
      "--dir",
      scriptcRoot,
      "--filter",
      "@scriptc/compiler",
      "build",
    ]);
    const project = parseGtkApplicationProject(
      readFileSync(join(windowFixtureRoot, "native-typescript.json"), "utf8"),
    );
    assert.equal(project.namespaces.length, 1);

    const scratch = mkdtempSync(join(tmpdir(), "nts-gtk-window-"));
    try {
      const built = await buildGtkApplication({
        projectRoot: windowFixtureRoot,
        project,
        scratch,
        backend: "c",
        tools: {
          clang: executable("clang"),
          node: process.execPath,
          pkgConfig: executable("pkg-config"),
          sandbox: executable("bwrap"),
        },
      });
      assert.deepEqual(runApplication(built.productPath), {
        status: 0,
        signal: null,
        stdout: "window ok\n",
        stderr: "",
      });
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  },
);
