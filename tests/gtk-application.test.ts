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
const payloadFixtureRoot = join(workspace, "fixtures/gtk-signal-payload");
const widgetsFixtureRoot = join(workspace, "fixtures/gtk-widgets");
const callbackFailureFixtureRoot = join(workspace, "fixtures/gtk-callback-failure");
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
        // register() reports failure through a GError and still answers with
        // its own boolean, because the failure goes in a slot the compiler
        // owns rather than in the result.
        assert.match(
          declarations.get("gio2") ?? "",
          /register\(cancellable: Cancellable \| null\): boolean;/u,
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
  "an exception escaping a GTK handler fails the process",
  { skip: unavailable || !existsSync(bindingToolPath) },
  async () => {
    /* An application that exits 0 while its handler threw is worse than one
     * that crashes: nothing downstream can tell the difference between that
     * and success. Both backends emit their own `main`, and the branch that
     * turns a failed loop into a non-zero return lives in each of them, so
     * both are checked rather than one standing in for the other.
     *
     * What makes this worth a build is that the status does NOT come from the
     * exit-code hint the failure sink also sets. It comes from the sink
     * marking the runtime failed, which makes the attached poll answer FAILED,
     * which makes `scr_loop_run` return true, which the emitted `main` returns
     * as 1. A sibling target found its own version of that chain was dead
     * plumbing — every assertion had passed because the happy path had zero on
     * both sides. */
    const project = parseGtkApplicationProject(
      readFileSync(join(callbackFailureFixtureRoot, "native-typescript.json"), "utf8"),
    );
    const scratch = mkdtempSync(join(tmpdir(), "nts-gtk-callback-failure-"));
    try {
      for (const backend of ["c", "llvm"] as const) {
        const built = await buildGtkApplication({
          projectRoot: callbackFailureFixtureRoot,
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

        assert.deepEqual(runApplication(built.productPath), {
          status: 1,
          signal: null,
          /* The handler ran and reached its end: the failure is the throw,
           * not the handler never being reached, which would exit 0 for a
           * reason this gate must not accept. */
          stdout: "activated\n",
          stderr: "Uncaught Error: the handler failed\n",
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

test(
  "signal payloads carry exact scalars, enumerations, and copied strings",
  { skip: unavailable || !existsSync(bindingToolPath) },
  async () => {
    /* Every payload is produced by GTK — a direction change and two buffer
     * edits — rather than emitted by the program, and every value is checked,
     * so one that marshalled wrongly fails here rather than merely links.
     *
     * The string is the one that could not simply be passed through. GTK hands
     * the handler a pointer it may reuse the moment emission returns, and
     * delivery is queued, so what arrives is a copy taken when the signal
     * fired. */
    execFileSync(pnpm, [
      "--dir",
      scriptcRoot,
      "--filter",
      "@scriptc/compiler",
      "build",
    ]);
    const project = parseGtkApplicationProject(
      readFileSync(join(payloadFixtureRoot, "native-typescript.json"), "utf8"),
    );
    const scratch = mkdtempSync(join(tmpdir(), "nts-gtk-payload-"));
    try {
      /* Each backend builds its own trampoline, and the string payload is the
       * first thing that made them differ. */
      for (const backend of ["c", "llvm"] as const) {
      const built = await buildGtkApplication({
        projectRoot: payloadFixtureRoot,
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
      const declarations = readFileSync(
        join(built.generatedPackages[0]!.path, "package.d.ts"),
        "utf8",
      );
      assert.match(
        declarations,
        /onDirectionChanged\(callback: \(widget: Widget, previousDirection: TextDirection\) => void\): SignalConnection;/u,
      );
      assert.match(
        declarations,
        /onDeletedText\(callback: \(entryBuffer: EntryBuffer, position: guint, nChars: guint\) => void\): SignalConnection;/u,
      );
      assert.match(
        declarations,
        /onInsertedText\(callback: \(entryBuffer: EntryBuffer, position: guint, chars: string, nChars: guint\) => void\): SignalConnection;/u,
      );
      assert.deepEqual(runApplication(built.productPath), {
        status: 0,
        signal: null,
        stdout: "payloads ok\n",
        stderr: "",
      }, backend);
      }
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  },
);

test(
  "a realistic widget surface generates, links, and reports its own state",
  { skip: unavailable || !existsSync(bindingToolPath) },
  async () => {
    /* Breadth rather than depth. Twenty-eight GTK classes are constructed,
     * wired into one window, and then read back, so a member that stopped
     * projecting — or projected and returned the wrong value — fails here
     * instead of being found by whoever first tried to use it.
     *
     * The application asserts against live GTK state: a shared adjustment
     * really is shared, a list row really knows its index. */
    execFileSync(pnpm, [
      "--dir",
      scriptcRoot,
      "--filter",
      "@scriptc/compiler",
      "build",
    ]);
    const project = parseGtkApplicationProject(
      readFileSync(join(widgetsFixtureRoot, "native-typescript.json"), "utf8"),
    );
    /* Looked up by name: the project states its namespaces in dependency
     * order, and Gdk joining it ahead of Gtk is not a fact about the Gtk
     * selection. */
    const gtk = project.namespaces.find(({ name }) => name === "Gtk");
    assert.equal(gtk?.classes.length, 32);
    /* Breadth is the point, and it is the thing a fixture loses quietly: a
     * member the application does not call still has to generate and link, and
     * three real defects were found by widening this selection rather than by
     * running it. The count guards against it shrinking unnoticed. */
    const members = gtk!.classes.reduce(
      (total, class_) =>
        total + (class_.methods?.length ?? 0) +
        (class_.constructors?.length ?? 0) + (class_.signals?.length ?? 0),
      0,
    );
    assert.ok(members >= 145, `selection covers only ${members} members`);

    const scratch = mkdtempSync(join(tmpdir(), "nts-gtk-widgets-"));
    try {
      for (const backend of ["c", "llvm"] as const) {
      const built = await buildGtkApplication({
        projectRoot: widgetsFixtureRoot,
        project,
        scratch: join(scratch, backend),
        /* The nullable handle result and the owned handle payload are emitted
         * separately by each backend, and the payload trampoline is the one
         * place a backend has to branch inside a callback. */
        backend,
        tools: {
          clang: executable("clang"),
          node: process.execPath,
          pkgConfig: executable("pkg-config"),
          sandbox: executable("bwrap"),
        },
      });
      /* By slug rather than by position: the project lists its namespaces in
       * dependency order, and which index Gtk lands on is not a fact about
       * the Gtk surface. */
      const gtkPackage = built.generatedPackages.find(
        ({ slug }) => slug === "gtk4",
      );
      const declarations = readFileSync(
        join(gtkPackage!.path, "package.d.ts"),
        "utf8",
      );
      // Ancestry crosses several levels, and one class comes from gio2.
      assert.match(declarations, /class Scale extends Range/u);
      assert.match(declarations, /class ToggleButton extends Button/u);
      assert.match(declarations, /class ApplicationWindow extends Window/u);
      assert.match(declarations, /class Application extends GioApplication/u);
      /* A signal payload is an object the handler never constructed. It has to
       * arrive as the class GIR names, not as an opaque pointer. */
      assert.match(
        declarations,
        /onRowActivated\(callback: \(listBox: ListBox, row: ListBoxRow\) => void\)/u,
      );
      /* Output parameters do not reach TypeScript. Two `int *` slots become a
       * record of branded scalars, which the application reads back after
       * setting them. */
      assert.match(
        declarations,
        /export interface WidgetSizeRequest \{\n  readonly width: gint;\n  readonly height: gint;\n\}/u,
      );
      assert.match(declarations, /getSizeRequest\(\): WidgetSizeRequest;/u);
      /* An input crosses into a value-returning method as any other argument
       * would: an enumeration by value, an object borrowed for the call. */
      assert.match(
        declarations,
        /measure\(orientation: Orientation, forSize: gint\): WidgetMeasure;/u,
      );
      assert.match(declarations, /queryChild\(child: Widget\): GridQueryChild;/u);
      /* A deprecated member binds like any other — the probe reads its ABI
       * from the same headers — and the declaration is where the caller finds
       * out. The application calls this one, so the gate covers compiling and
       * linking a deprecated symbol, not only declaring it. */
      assert.match(
        declarations,
        /@deprecated Deprecated by the library since version 4\.10\.[\s\S]{0,40}show\(\): void;/u,
      );

      assert.deepEqual(runApplication(built.productPath), {
        status: 0,
        signal: null,
        stdout: "widgets ok\n",
        stderr: "",
      }, backend);
      }
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  },
);
