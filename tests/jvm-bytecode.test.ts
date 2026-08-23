import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadScriptCExecutablePlanners,
  loadScriptCJvmEmitter,
} from "@native-typescript/scriptc";
import { discoverJavaHome } from "@native-typescript/target-jvm";

const workspace = join(import.meta.dirname, "..");
const scriptcRoot = join(workspace, "third_party/scriptc");
const fixture = join(scriptcRoot, "tests/corpus/001-hello.ts");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const javaHome = discoverJavaHome();

function androidBuildTools(): { readonly d8: string } | null {
  for (const root of [
    process.env["ANDROID_SDK_ROOT"],
    process.env["ANDROID_HOME"],
    join(homedir(), "Android/Sdk"),
  ]) {
    if (root === undefined || root.length === 0) continue;
    const buildTools = join(root, "build-tools");
    if (!existsSync(buildTools)) continue;
    const versions = readdirSync(buildTools)
      .filter((entry) => /^\d+\.\d+\.\d+$/u.test(entry))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const version of versions) {
      const d8 = join(buildTools, version, process.platform === "win32" ? "d8.bat" : "d8");
      if (existsSync(d8)) return { d8 };
    }
  }
  return null;
}

interface MaterializedJvmFixture {
  readonly root: string;
  readonly classes: string;
  readonly classFile: string;
  readonly className: string;
  readonly node: ReturnType<typeof spawnSync>;
}

async function materialize(): Promise<MaterializedJvmFixture> {
  execFileSync(pnpm, ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"]);
  const planners = await loadScriptCExecutablePlanners();
  const emitter = await loadScriptCJvmEmitter();
  const planned = planners.planExecutableCompilation(fixture, { backend: "c" });
  if (!planned.ok) {
    throw new Error(planned.diagnostics.map(({ message }) => message).join("\n"));
  }

  const packageName = "dev.nts.generated";
  const simpleName = "Hello";
  const className = `${packageName}.${simpleName}`;
  const source = emitter.emitJvmSerializedModule(planned.plan.ir, {
    packageName,
    className: simpleName,
  });
  const root = mkdtempSync(join(tmpdir(), "nts-jvm-bytecode-"));
  const sources = join(root, "sources");
  const classes = join(root, "classes");
  const packagePath = join(...packageName.split("."));
  const sourceDirectory = join(sources, packagePath);
  mkdirSync(sourceDirectory, { recursive: true });
  mkdirSync(classes);
  const sourcePath = join(sourceDirectory, `${simpleName}.java`);
  writeFileSync(sourcePath, source);
  execFileSync(join(javaHome!, "bin/javac"), [
    "--release",
    "17",
    "-d",
    classes,
    sourcePath,
  ]);
  return {
    root,
    classes,
    classFile: join(classes, packagePath, `${simpleName}.class`),
    className,
    node: spawnSync(process.execPath, [fixture], { encoding: "utf8" }),
  };
}

test(
  "checked TypeScript becomes runnable JVM bytecode without JNI",
  { skip: javaHome === null ? "no JDK on this host" : false },
  async () => {
    const built = await materialize();
    try {
      const run = spawnSync(
        join(javaHome!, "bin/java"),
        ["-cp", built.classes, built.className],
        { encoding: "utf8" },
      );
      assert.equal(run.status, built.node.status);
      assert.equal(run.stdout, built.node.stdout);
      assert.equal(run.stderr, built.node.stderr);

      const bytecode = execFileSync(
        join(javaHome!, "bin/javap"),
        ["-classpath", built.classes, "-c", "-p", built.className],
        { encoding: "utf8" },
      );
      assert.match(
        bytecode,
        /java\/io\/PrintStream\.println:\(Ljava\/lang\/String;\)V/u,
      );
      assert.doesNotMatch(bytecode, / native /u);
      assert.doesNotMatch(bytecode, /JNI/u);
    } finally {
      rmSync(built.root, { recursive: true, force: true });
    }
  },
);

const buildTools = androidBuildTools();
test(
  "D8 accepts the generated JVM class as an Android DEX input",
  {
    skip: javaHome === null
      ? "no JDK on this host"
      : buildTools === null
        ? "no Android build-tools with D8 on this host"
        : false,
  },
  async () => {
    const built = await materialize();
    try {
      const dex = join(built.root, "classes.zip");
      execFileSync(buildTools!.d8, [
        "--min-api",
        "26",
        "--output",
        dex,
        built.classFile,
      ]);
      const entries = execFileSync(join(javaHome!, "bin/jar"), ["tf", dex], {
        encoding: "utf8",
      });
      assert.match(entries, /^classes\.dex$/mu);
    } finally {
      rmSync(built.root, { recursive: true, force: true });
    }
  },
);
