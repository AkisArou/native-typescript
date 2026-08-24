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
const classFixture = join(
  scriptcRoot,
  "tests/corpus/111-jvm-class-fields.ts",
);
const stringFixture = join(
  scriptcRoot,
  "tests/corpus/112-jvm-string-values.ts",
);
const byteFixture = join(
  scriptcRoot,
  "tests/corpus/113-jvm-byte-values.ts",
);
const stringIntrinsicFixture = join(
  scriptcRoot,
  "tests/corpus/114-jvm-string-intrinsics.ts",
);
const arrayFixture = join(
  scriptcRoot,
  "tests/corpus/115-jvm-array-values.ts",
);
const recordFixture = join(
  scriptcRoot,
  "tests/corpus/116-jvm-record-values.ts",
);
const unionFixture = join(
  scriptcRoot,
  "tests/corpus/117-jvm-union-values.ts",
);
const mapFixture = join(
  scriptcRoot,
  "tests/corpus/118-jvm-map-values.ts",
);
const setFixture = join(
  scriptcRoot,
  "tests/corpus/119-jvm-set-values.ts",
);
const mathFixture = join(
  scriptcRoot,
  "tests/corpus/120-jvm-math-values.ts",
);
const numberParsingFixture = join(
  scriptcRoot,
  "tests/corpus/121-jvm-number-parsing.ts",
);
const integerParameterFixture = join(
  scriptcRoot,
  "tests/corpus/122-jvm-integer-parameters.ts",
);
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

test(
  "direct JVM strings preserve JavaScript concatenation, equality, and number text",
  { skip: javaHome === null ? "no JDK on this host" : false },
  async () => {
    execFileSync(pnpm, ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"]);
    const planners = await loadScriptCExecutablePlanners();
    const emitter = await loadScriptCJvmEmitter();
    const planned = planners.planExecutableCompilation(stringFixture, {
      backend: "c",
      externalFunctionRoots: [
        "joined",
        "equal",
        "notEqual",
        "numberText",
        "maybeText",
        "nullableLength",
      ],
    });
    assert.equal(
      planned.ok,
      true,
      planned.ok ? undefined : planned.diagnostics.map(({ message }) => message).join("\n"),
    );
    if (!planned.ok) return;

    const packageName = "dev.nts.generated";
    const simpleName = "StringValues";
    const source = emitter.emitJvmSerializedModule(planned.plan.ir, {
      packageName,
      className: simpleName,
      functionExports: [{
        functionName: "joined",
        methodName: "joined",
      }, {
        functionName: "equal",
        methodName: "equal",
      }, {
        functionName: "notEqual",
        methodName: "notEqual",
      }, {
        functionName: "numberText",
        methodName: "numberText",
      }, {
        functionName: "maybeText",
        methodName: "maybeText",
      }, {
        functionName: "nullableLength",
        methodName: "nullableLength",
      }],
    });
    const root = mkdtempSync(join(tmpdir(), "nts-jvm-string-values-"));
    try {
      const sourceDirectory = join(root, "sources", ...packageName.split("."));
      const classes = join(root, "classes");
      mkdirSync(sourceDirectory, { recursive: true });
      mkdirSync(classes);
      const sourcePath = join(sourceDirectory, `${simpleName}.java`);
      const harnessPath = join(sourceDirectory, "StringValuesHarness.java");
      writeFileSync(sourcePath, source);
      writeFileSync(
        harnessPath,
        `package ${packageName};\n` +
          "public final class StringValuesHarness {\n" +
          "  public static void main(String[] args) {\n" +
          `    System.out.println(${simpleName}.joined(42.0d, true));\n` +
          `    System.out.println(${simpleName}.equal(new String(\"same\"), new String(\"same\")));\n` +
          `    System.out.println(${simpleName}.notEqual(\"left\", \"right\"));\n` +
          "    double[] values = {-0.0d, 1e-7d, 1e-6d, 1e20d, 1e21d, " +
            "Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, Double.NaN, " +
            "1.2345678901234567d};\n" +
          `    for (double value : values) System.out.println(${simpleName}.numberText(value));\n` +
          `    System.out.println(${simpleName}.nullableLength(${simpleName}.maybeText(\"four\", true)));\n` +
          `    System.out.println(${simpleName}.nullableLength(${simpleName}.maybeText(\"four\", false)));\n` +
          "  }\n" +
          "}\n",
      );
      execFileSync(join(javaHome!, "bin/javac"), [
        "--release",
        "17",
        "-d",
        classes,
        sourcePath,
        harnessPath,
      ]);
      const run = spawnSync(
        join(javaHome!, "bin/java"),
        ["-cp", classes, `${packageName}.StringValuesHarness`],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(
        run.stdout,
        "value=42 enabled=true\n" +
          "true\n" +
          "true\n" +
          "0\n" +
          "1e-7\n" +
          "0.000001\n" +
          "100000000000000000000\n" +
          "1e+21\n" +
          "Infinity\n" +
          "-Infinity\n" +
          "NaN\n" +
          "1.2345678901234567\n" +
          "4.0\n" +
          "-1.0\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "direct JVM Uint8Array construction and stores stay in Java byte arrays",
  { skip: javaHome === null ? "no JDK on this host" : false },
  async () => {
    execFileSync(pnpm, ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"]);
    const planners = await loadScriptCExecutablePlanners();
    const emitter = await loadScriptCJvmEmitter();
    const planned = planners.planExecutableCompilation(byteFixture, {
      backend: "c",
      externalFunctionRoots: ["filledBytes", "copiedBytes", "emptyBytes"],
    });
    assert.equal(
      planned.ok,
      true,
      planned.ok ? undefined : planned.diagnostics.map(({ message }) => message).join("\n"),
    );
    if (!planned.ok) return;

    const packageName = "dev.nts.generated";
    const simpleName = "ByteValues";
    const source = emitter.emitJvmSerializedModule(planned.plan.ir, {
      packageName,
      className: simpleName,
      functionExports: [{
        functionName: "filledBytes",
        methodName: "filledBytes",
      }, {
        functionName: "copiedBytes",
        methodName: "copiedBytes",
      }, {
        functionName: "emptyBytes",
        methodName: "emptyBytes",
      }],
    });
    const root = mkdtempSync(join(tmpdir(), "nts-jvm-byte-values-"));
    try {
      const sourceDirectory = join(root, "sources", ...packageName.split("."));
      const classes = join(root, "classes");
      mkdirSync(sourceDirectory, { recursive: true });
      mkdirSync(classes);
      const sourcePath = join(sourceDirectory, `${simpleName}.java`);
      const harnessPath = join(sourceDirectory, "ByteValuesHarness.java");
      writeFileSync(sourcePath, source);
      writeFileSync(
        harnessPath,
        `package ${packageName};\n` +
          "public final class ByteValuesHarness {\n" +
          "  private static int checksum(byte[] values) {\n" +
          "    int result = 0;\n" +
          "    for (byte value : values) result += value & 255;\n" +
          "    return result;\n" +
          "  }\n" +
          "  public static void main(String[] args) {\n" +
          `    byte[] filled = ${simpleName}.filledBytes(4.0d);\n` +
          "    System.out.println(filled.length + \":\" + checksum(filled) + \":\" + (filled[0] & 255));\n" +
          `    byte[] copied = ${simpleName}.copiedBytes(filled);\n` +
          "    filled[0] = 0;\n" +
          "    System.out.println(filled[0] + \":\" + (copied[0] & 255));\n" +
          `    System.out.println(${simpleName}.emptyBytes().length);\n` +
          `    System.out.println(${simpleName}.filledBytes(Double.NaN).length);\n` +
          `    System.out.println(${simpleName}.filledBytes(-0.5d).length);\n` +
          "    try {\n" +
          `      ${simpleName}.filledBytes(-1.0d);\n` +
          "      System.out.println(\"missing RangeError\");\n" +
          "    } catch (RuntimeException error) {\n" +
          "      System.out.println(error.getClass().getSimpleName() + \":\" + error.getMessage());\n" +
          "    }\n" +
          "  }\n" +
          "}\n",
      );
      execFileSync(join(javaHome!, "bin/javac"), [
        "--release",
        "17",
        "-d",
        classes,
        sourcePath,
        harnessPath,
      ]);
      const run = spawnSync(
        join(javaHome!, "bin/java"),
        ["-cp", classes, `${packageName}.ByteValuesHarness`],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(
        run.stdout,
        "4:310:244\n" +
          "0:244\n" +
          "0\n" +
          "0\n" +
          "0\n" +
          "NtsRangeError:Invalid typed array length: -1\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "direct JVM string methods preserve JavaScript indexing and Unicode behavior",
  { skip: javaHome === null ? "no JDK on this host" : false },
  async () => {
    execFileSync(pnpm, ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"]);
    const roots = [
      "codeAt",
      "characterAt",
      "findText",
      "hasText",
      "startsWithText",
      "endsWithText",
      "sliced",
      "substring",
      "repeated",
      "padded",
      "trimmed",
      "cased",
      "wellFormed",
      "repaired",
      "splitCount",
      "splitPart",
    ];
    const planned = (await loadScriptCExecutablePlanners())
      .planExecutableCompilation(stringIntrinsicFixture, {
        backend: "c",
        externalFunctionRoots: roots,
      });
    assert.equal(
      planned.ok,
      true,
      planned.ok ? undefined : planned.diagnostics.map(({ message }) => message).join("\n"),
    );
    if (!planned.ok) return;

    const packageName = "dev.nts.generated";
    const simpleName = "StringIntrinsics";
    const source = (await loadScriptCJvmEmitter()).emitJvmSerializedModule(
      planned.plan.ir,
      {
        packageName,
        className: simpleName,
        functionExports: roots.map((functionName) => ({
          functionName,
          methodName: functionName,
        })),
      },
    );
    const root = mkdtempSync(join(tmpdir(), "nts-jvm-string-intrinsics-"));
    try {
      const sourceDirectory = join(root, "sources", ...packageName.split("."));
      const classes = join(root, "classes");
      mkdirSync(sourceDirectory, { recursive: true });
      mkdirSync(classes);
      const sourcePath = join(sourceDirectory, `${simpleName}.java`);
      const harnessPath = join(sourceDirectory, "StringIntrinsicsHarness.java");
      writeFileSync(sourcePath, source);
      writeFileSync(
        harnessPath,
        `package ${packageName};\n` +
          "public final class StringIntrinsicsHarness {\n" +
          "  public static void main(String[] args) {\n" +
          `    System.out.println(${simpleName}.codeAt("A\\ud83d\\udc69", 1.0d));\n` +
          `    System.out.println(${simpleName}.codeAt("A", 9.0d));\n` +
          `    System.out.println("[" + ${simpleName}.characterAt("A", 9.0d) + "]");\n` +
          `    System.out.println(${simpleName}.findText("bananas", "na", 2.9d));\n` +
          `    System.out.println(${simpleName}.hasText("bananas", "na", 3.0d));\n` +
          `    System.out.println(${simpleName}.startsWithText("native-typescript", "native"));\n` +
          `    System.out.println(${simpleName}.endsWithText("native-typescript", "script"));\n` +
          `    System.out.println(${simpleName}.sliced("abcdef", -4.0d, -1.0d));\n` +
          `    System.out.println(${simpleName}.substring("abcdef", 4.0d, 1.0d));\n` +
          `    System.out.println(${simpleName}.repeated("ab", 3.0d));\n` +
          `    System.out.println(${simpleName}.padded("7", 3.0d, "0"));\n` +
          `    System.out.println(${simpleName}.trimmed("\\u00a0 x \\u00a0"));\n` +
          `    System.out.println(${simpleName}.cased("Stra\\u00dfe"));\n` +
          `    System.out.println(${simpleName}.wellFormed("\\ud800X"));\n` +
         `    System.out.println(${simpleName}.repaired("\\ud800X"));\n` +
          `    System.out.println(${simpleName}.splitCount("a::b::", "::", 10.0d));\n` +
          `    System.out.println("[" + ${simpleName}.splitPart("a::b::", "::", 10.0d, 2.0d) + "]");\n` +
          `    System.out.println(${simpleName}.splitCount("A\\ud83d\\udc69", "", 10.0d));\n` +
          `    System.out.println((double)${simpleName}.splitPart("A\\ud83d\\udc69", "", 10.0d, 1.0d).charAt(0));\n` +
          `    System.out.println(${simpleName}.splitCount("a::b::c", "::", 2.0d));\n` +
         "    try {\n" +
          `      ${simpleName}.repeated("x", -1.0d);\n` +
          "      System.out.println(\"missing RangeError\");\n" +
          "    } catch (RuntimeException error) {\n" +
          "      System.out.println(error.getClass().getSimpleName() + \":\" + error.getMessage());\n" +
          "    }\n" +
          "  }\n" +
          "}\n",
      );
      execFileSync(join(javaHome!, "bin/javac"), [
        "--release",
        "17",
        "-d",
        classes,
        sourcePath,
        harnessPath,
      ]);
      const run = spawnSync(
        join(javaHome!, "bin/java"),
        ["-cp", classes, `${packageName}.StringIntrinsicsHarness`],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(
        run.stdout,
        "55357.0\n" +
          "NaN\n" +
          "[]\n" +
          "2.0\n" +
          "true\n" +
          "true\n" +
          "true\n" +
          "cde\n" +
          "bcd\n" +
          "ababab\n" +
          "007700\n" +
          "x:\u0078 \u00a0:\u00a0 x\n" +
          "stra\u00dfe:STRASSE\n" +
          "false\n" +
         "\ufffdX\n" +
          "3.0\n" +
          "[]\n" +
          "3.0\n" +
          "55357.0\n" +
          "2.0\n" +
         "NtsRangeError:Invalid count value\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "direct JVM arrays keep numbers and booleans unboxed and preserve string equality",
  { skip: javaHome === null ? "no JDK on this host" : false },
  async () => {
    execFileSync(pnpm, ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"]);
    const roots = [
      "mutateNumbers",
      "reservedPushOrder",
      "findString",
      "mutateBooleans",
      "arrayPipeline",
      "capturedPipeline",
      "mutateCapturedTotal",
      "namedPipeline",
      "spreadLiteralOrder",
      "selfSpreadArray",
    ];
    const planned = (await loadScriptCExecutablePlanners())
      .planExecutableCompilation(arrayFixture, {
        backend: "c",
        externalFunctionRoots: roots,
      });
    assert.equal(
      planned.ok,
      true,
      planned.ok ? undefined : planned.diagnostics.map(({ message }) => message).join("\n"),
    );
    if (!planned.ok) return;

    const packageName = "dev.nts.generated";
    const simpleName = "ArrayValues";
    const source = (await loadScriptCJvmEmitter()).emitJvmSerializedModule(
      planned.plan.ir,
      {
        packageName,
        className: simpleName,
        functionExports: roots.map((functionName) => ({
          functionName,
          methodName: functionName,
        })),
      },
    );
    const root = mkdtempSync(join(tmpdir(), "nts-jvm-array-values-"));
    try {
      const sourceDirectory = join(root, "sources", ...packageName.split("."));
      const classes = join(root, "classes");
      mkdirSync(sourceDirectory, { recursive: true });
      mkdirSync(classes);
      const sourcePath = join(sourceDirectory, `${simpleName}.java`);
      const harnessPath = join(sourceDirectory, "ArrayValuesHarness.java");
      writeFileSync(sourcePath, source);
      writeFileSync(
        harnessPath,
        `package ${packageName};\n` +
          "public final class ArrayValuesHarness {\n" +
          "  public static void main(String[] args) {\n" +
          `    System.out.println(${simpleName}.mutateNumbers(10.0d));\n` +
          `    System.out.println(${simpleName}.reservedPushOrder());\n` +
          `    System.out.println(${simpleName}.findString(new String(\"same\")));\n` +
          `    System.out.println(${simpleName}.mutateBooleans(true));\n` +
          `    System.out.println(${simpleName}.mutateBooleans(false));\n` +
          `    System.out.println(${simpleName}.arrayPipeline(10.0d));\n` +
          `    System.out.println(${simpleName}.capturedPipeline(10.0d, 4.0d));\n` +
          `    System.out.println(${simpleName}.mutateCapturedTotal(10.0d));\n` +
          `    System.out.println(${simpleName}.namedPipeline(10.0d));\n` +
          `    System.out.println(${simpleName}.spreadLiteralOrder());\n` +
          `    System.out.println(${simpleName}.selfSpreadArray());\n` +
          "  }\n" +
          "}\n",
      );
      execFileSync(join(javaHome!, "bin/javac"), [
        "--release",
        "17",
        "-d",
        classes,
        sourcePath,
        harnessPath,
      ]);
      const run = spawnSync(
        join(javaHome!, "bin/java"),
        ["-cp", classes, `${packageName}.ArrayValuesHarness`],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(
        run.stdout,
        "27.0\n3011.0\n11.0\ntrue\nfalse\n39.0\n27.0\n16.0\n13.0\n5555666.0\n6123.0\n",
      );

      const nestedBytecode = readdirSync(join(classes, ...packageName.split(".")))
        .filter((entry) => entry.startsWith(`${simpleName}$NtsArray`))
        .map((entry) =>
          execFileSync(
            join(javaHome!, "bin/javap"),
            [
              "-classpath",
              classes,
              "-p",
              `${packageName}.${entry.slice(0, -".class".length)}`,
            ],
            { encoding: "utf8" },
          )
        )
        .join("\n");
      assert.match(nestedBytecode, /double\[\] data;/u);
      assert.match(nestedBytecode, /boolean\[\] data;/u);
      assert.match(nestedBytecode, /java\.lang\.String\[\] data;/u);
      assert.match(nestedBytecode, /private int length\(\);/u);
      assert.match(nestedBytecode, /private double get\(int\);/u);
      assert.match(nestedBytecode, /private double get\(double\);/u);
      assert.match(
        nestedBytecode,
        /private dev\.nts\.generated\.ArrayValues\$NtsArray\d+\(double\[\], int\);/u,
      );
      assert.match(nestedBytecode, /private int push\(double\);/u);
      assert.match(nestedBytecode, /private int push\(double, double\);/u);
      assert.match(nestedBytecode, /private int push\(double\.\.\.\);/u);
      assert.doesNotMatch(nestedBytecode, /java\.lang\.Object\[\]/u);
      assert.doesNotMatch(nestedBytecode, /ArrayList/u);

      const ownerBytecode = execFileSync(
        join(javaHome!, "bin/javap"),
        ["-classpath", classes, "-c", "-p", `${packageName}.${simpleName}`],
        { encoding: "utf8" },
      );
      assert.doesNotMatch(ownerBytecode, /Double\.valueOf|Boolean\.valueOf/u);
      assert.match(ownerBytecode, /InvokeDynamic/u);
      assert.match(ownerBytecode, /NtsArray\d+\.get:\(I\)D/u);
      assert.match(ownerBytecode, /NtsArray\d+\.push:\(D\)I/u);
      assert.match(ownerBytecode, /NtsArray\d+\.push:\(DD\)I/u);
      assert.match(
        ownerBytecode,
        /ntsArrayLiteral\d+:\(DDD\)Ldev\/nts\/generated\/ArrayValues\$NtsArray\d+;/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "direct JVM fixed records use exact fields and preserve literal evaluation order",
  { skip: javaHome === null ? "no JDK on this host" : false },
  async () => {
    execFileSync(pnpm, ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"]);
    const roots = ["recordFields", "recordEvaluationOrder"];
    const planned = (await loadScriptCExecutablePlanners())
      .planExecutableCompilation(recordFixture, {
        backend: "c",
        externalFunctionRoots: roots,
      });
    assert.equal(
      planned.ok,
      true,
      planned.ok ? undefined : planned.diagnostics.map(({ message }) => message).join("\n"),
    );
    if (!planned.ok) return;

    const packageName = "dev.nts.generated";
    const simpleName = "RecordValues";
    const source = (await loadScriptCJvmEmitter()).emitJvmSerializedModule(
      planned.plan.ir,
      {
        packageName,
        className: simpleName,
        functionExports: roots.map((functionName) => ({
          functionName,
          methodName: functionName,
        })),
      },
    );
    const root = mkdtempSync(join(tmpdir(), "nts-jvm-record-values-"));
    try {
      const sourceDirectory = join(root, "sources", ...packageName.split("."));
      const classes = join(root, "classes");
      mkdirSync(sourceDirectory, { recursive: true });
      mkdirSync(classes);
      const sourcePath = join(sourceDirectory, `${simpleName}.java`);
      const harnessPath = join(sourceDirectory, "RecordValuesHarness.java");
      writeFileSync(sourcePath, source);
      writeFileSync(
        harnessPath,
        `package ${packageName};\n` +
          "public final class RecordValuesHarness {\n" +
          "  public static void main(String[] args) {\n" +
          `    System.out.println(${simpleName}.recordFields(10.0d, "xy"));\n` +
          `    System.out.println(${simpleName}.recordEvaluationOrder());\n` +
          "  }\n" +
          "}\n",
      );
      execFileSync(join(javaHome!, "bin/javac"), [
        "--release",
        "17",
        "-d",
        classes,
        sourcePath,
        harnessPath,
      ]);
      const run = spawnSync(
        join(javaHome!, "bin/java"),
        ["-cp", classes, `${packageName}.RecordValuesHarness`],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, "20.0\n1212.0\n");

      const nestedBytecode = readdirSync(join(classes, ...packageName.split(".")))
        .filter((entry) => entry.startsWith(`${simpleName}$NtsRecord`))
        .map((entry) =>
          execFileSync(
            join(javaHome!, "bin/javap"),
            [
              "-classpath",
              classes,
              "-p",
              `${packageName}.${entry.slice(0, -".class".length)}`,
            ],
            { encoding: "utf8" },
          )
        )
        .join("\n");
      assert.match(nestedBytecode, /double r_/u);
      assert.match(nestedBytecode, /boolean r_/u);
      assert.match(nestedBytecode, /java\.lang\.String r_/u);
      assert.doesNotMatch(nestedBytecode, /java\.lang\.Object|HashMap/u);

      const ownerBytecode = execFileSync(
        join(javaHome!, "bin/javap"),
        ["-classpath", classes, "-c", "-p", `${packageName}.${simpleName}`],
        { encoding: "utf8" },
      );
      assert.doesNotMatch(ownerBytecode, /Double\.valueOf|Boolean\.valueOf|JNI/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "direct JVM unions keep optional references nullable and scalar payloads unboxed",
  { skip: javaHome === null ? "no JDK on this host" : false },
  async () => {
    execFileSync(pnpm, ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"]);
    const roots = [
      "optionalNumber",
      "optionalNumberIdentity",
      "optionalNumberKinds",
      "optionalNumberArray",
      "optionalRecord",
      "optionalString",
      "optionalArray",
      "mixedValue",
    ];
    const planned = (await loadScriptCExecutablePlanners())
      .planExecutableCompilation(unionFixture, {
        backend: "c",
        externalFunctionRoots: roots,
      });
    assert.equal(
      planned.ok,
      true,
      planned.ok ? undefined : planned.diagnostics.map(({ message }) => message).join("\n"),
    );
    if (!planned.ok) return;

    const packageName = "dev.nts.generated";
    const simpleName = "UnionValues";
    const source = (await loadScriptCJvmEmitter()).emitJvmSerializedModule(
      planned.plan.ir,
      {
        packageName,
        className: simpleName,
        functionExports: roots.map((functionName) => ({
          functionName,
          methodName: functionName,
        })),
      },
    );
    const root = mkdtempSync(join(tmpdir(), "nts-jvm-union-values-"));
    try {
      const sourceDirectory = join(root, "sources", ...packageName.split("."));
      const classes = join(root, "classes");
      mkdirSync(sourceDirectory, { recursive: true });
      mkdirSync(classes);
      const sourcePath = join(sourceDirectory, `${simpleName}.java`);
      const harnessPath = join(sourceDirectory, "UnionValuesHarness.java");
      writeFileSync(sourcePath, source);
      writeFileSync(
        harnessPath,
        `package ${packageName};\n` +
          "public final class UnionValuesHarness {\n" +
          "  public static void main(String[] args) {\n" +
          `    System.out.println(${simpleName}.optionalNumber(10.0d, true));\n` +
          `    System.out.println(${simpleName}.optionalNumber(10.0d, false));\n` +
          `    System.out.println(${simpleName}.optionalNumberIdentity(-0.0d, true));\n` +
          `    System.out.println(${simpleName}.optionalNumberIdentity(Double.NaN, true));\n` +
          `    System.out.println(${simpleName}.optionalNumberIdentity(5.0d, false));\n` +
          `    System.out.println(${simpleName}.optionalNumberKinds(Double.NaN, 0.0d));\n` +
          `    System.out.println(${simpleName}.optionalNumberKinds(-0.0d, 0.0d));\n` +
          `    System.out.println(${simpleName}.optionalNumberKinds(7.0d, 1.0d));\n` +
          `    System.out.println(${simpleName}.optionalNumberKinds(7.0d, 2.0d));\n` +
          `    System.out.println(${simpleName}.optionalNumberArray());\n` +
          `    System.out.println(${simpleName}.optionalRecord(10.0d, true));\n` +
          `    System.out.println(${simpleName}.optionalRecord(10.0d, false));\n` +
          `    System.out.println(${simpleName}.optionalString("four", true));\n` +
          `    System.out.println(${simpleName}.optionalString("four", false));\n` +
          `    System.out.println(${simpleName}.optionalArray(10.0d, true));\n` +
          `    System.out.println(${simpleName}.optionalArray(10.0d, false));\n` +
          `    System.out.println(${simpleName}.mixedValue(10.0d, 0.0d));\n` +
          `    System.out.println(${simpleName}.mixedValue(10.0d, 1.0d));\n` +
          `    System.out.println(${simpleName}.mixedValue(10.0d, 2.0d));\n` +
          "  }\n" +
          "}\n",
      );
      execFileSync(join(javaHome!, "bin/javac"), [
        "--release",
        "17",
        "-d",
        classes,
        sourcePath,
        harnessPath,
      ]);
      const run = spawnSync(
        join(javaHome!, "bin/java"),
        ["-cp", classes, `${packageName}.UnionValuesHarness`],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(
        run.stdout,
        "13.0\n11.0\n-0.0\nNaN\n91.0\n33.0\n44.0\n11.0\n22.0\n15.0\n" +
          "10.0\n5.0\n4.0\n7.0\n12.0\n9.0\n12.0\n3.0\n5.0\n",
      );

      const unionClasses = readdirSync(join(classes, ...packageName.split(".")))
        .filter((entry) => entry.startsWith(`${simpleName}$NtsUnion`));
      assert.equal(unionClasses.length, 1);
      const nestedBytecode = unionClasses
        .map((entry) =>
          execFileSync(
            join(javaHome!, "bin/javap"),
            [
              "-classpath",
              classes,
              "-p",
              `${packageName}.${entry.slice(0, -".class".length)}`,
            ],
            { encoding: "utf8" },
          )
        )
        .join("\n");
      assert.match(nestedBytecode, /private final int tag;/u);
      assert.match(nestedBytecode, /private final double payload\d+;/u);
      assert.match(nestedBytecode, /private final java\.lang\.String payload\d+;/u);
      assert.doesNotMatch(nestedBytecode, /java\.lang\.Object|java\.lang\.Double/u);

      const ownerBytecode = execFileSync(
        join(javaHome!, "bin/javap"),
        ["-classpath", classes, "-c", "-p", `${packageName}.${simpleName}`],
        { encoding: "utf8" },
      );
      assert.match(ownerBytecode, /java\/lang\/Double\.doubleToLongBits:\(D\)J/u);
      assert.match(ownerBytecode, /java\/lang\/Double\.longBitsToDouble:\(J\)D/u);
      assert.doesNotMatch(ownerBytecode, /Double\.valueOf|JNI/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "direct JVM maps keep exact storage and JavaScript live iteration semantics",
  { skip: javaHome === null ? "no JDK on this host" : false },
  async () => {
    execFileSync(pnpm, ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"]);
    const roots = [
      "stringNumberMap",
      "numberStringMap",
      "booleanMap",
      "unionValueMap",
      "nullableValueMap",
      "undefinedValueMap",
      "liveIterationMap",
      "clearDuringIterationMap",
      "rehashAndCompactMap",
    ];
    const planned = (await loadScriptCExecutablePlanners())
      .planExecutableCompilation(mapFixture, {
        backend: "c",
        externalFunctionRoots: roots,
      });
    assert.equal(
      planned.ok,
      true,
      planned.ok ? undefined : planned.diagnostics.map(({ message }) => message).join("\n"),
    );
    if (!planned.ok) return;

    const packageName = "dev.nts.generated";
    const simpleName = "MapValues";
    const source = (await loadScriptCJvmEmitter()).emitJvmSerializedModule(
      planned.plan.ir,
      {
        packageName,
        className: simpleName,
        functionExports: roots.map((functionName) => ({
          functionName,
          methodName: functionName,
        })),
      },
    );
    const root = mkdtempSync(join(tmpdir(), "nts-jvm-map-values-"));
    try {
      const sourceDirectory = join(root, "sources", ...packageName.split("."));
      const classes = join(root, "classes");
      mkdirSync(sourceDirectory, { recursive: true });
      mkdirSync(classes);
      const sourcePath = join(sourceDirectory, `${simpleName}.java`);
      const harnessPath = join(sourceDirectory, "MapValuesHarness.java");
      writeFileSync(sourcePath, source);
      writeFileSync(
        harnessPath,
        `package ${packageName};\n` +
          "public final class MapValuesHarness {\n" +
          "  public static void main(String[] args) {\n" +
          `    System.out.println(${simpleName}.stringNumberMap(10.0d));\n` +
          `    System.out.println(${simpleName}.numberStringMap(4.0d));\n` +
          `    System.out.println(${simpleName}.booleanMap());\n` +
          `    System.out.println(${simpleName}.unionValueMap(false));\n` +
          `    System.out.println(${simpleName}.unionValueMap(true));\n` +
          `    System.out.println(${simpleName}.nullableValueMap(false));\n` +
          `    System.out.println(${simpleName}.nullableValueMap(true));\n` +
          `    System.out.println(${simpleName}.undefinedValueMap());\n` +
          `    System.out.println(${simpleName}.liveIterationMap());\n` +
          `    System.out.println(${simpleName}.clearDuringIterationMap());\n` +
          `    System.out.println(${simpleName}.rehashAndCompactMap());\n` +
          "  }\n" +
          "}\n",
      );
      execFileSync(join(javaHome!, "bin/javac"), [
        "--release",
        "17",
        "-d",
        classes,
        sourcePath,
        harnessPath,
      ]);
      const run = spawnSync(
        join(javaHome!, "bin/java"),
        ["-cp", classes, `${packageName}.MapValuesHarness`],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(
        run.stdout,
        "19.0\n15.0\n2.0\n5.0\n9.0\n4.0\n7.0\n2.0\n11.0\n102.0\n11760.0\n",
      );

      const nestedBytecode = readdirSync(join(classes, ...packageName.split(".")))
        .filter((entry) => entry.startsWith(`${simpleName}$NtsMap`))
        .map((entry) =>
          execFileSync(
            join(javaHome!, "bin/javap"),
            [
              "-classpath",
              classes,
              "-p",
              `${packageName}.${entry.slice(0, -".class".length)}`,
            ],
            { encoding: "utf8" },
          )
        )
        .join("\n");
      assert.match(nestedBytecode, /java\.lang\.String\[\] keys;/u);
      assert.match(nestedBytecode, /double\[\] keys;/u);
      assert.match(nestedBytecode, /double\[\] values;/u);
      assert.match(nestedBytecode, /java\.lang\.String\[\] values;/u);
      assert.match(nestedBytecode, /boolean\[\] values;/u);
      assert.match(nestedBytecode, /private long get\(java\.lang\.String\);/u);
      assert.doesNotMatch(
        nestedBytecode,
        /java\.lang\.Object|java\.util\.(?:HashMap|LinkedHashMap)|java\.lang\.(?:Double|Boolean)/u,
      );

      const ownerBytecode = execFileSync(
        join(javaHome!, "bin/javap"),
        ["-classpath", classes, "-c", "-p", `${packageName}.${simpleName}`],
        { encoding: "utf8" },
      );
      assert.match(ownerBytecode, /java\/lang\/Double\.longBitsToDouble:\(J\)D/u);
      assert.doesNotMatch(ownerBytecode, /Double\.valueOf|Boolean\.valueOf|JNI/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "direct JVM sets keep exact storage and JavaScript live iteration semantics",
  { skip: javaHome === null ? "no JDK on this host" : false },
  async () => {
    execFileSync(pnpm, ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"]);
    const roots = [
      "stringSet",
      "numberSet",
      "seededEvaluationOrderSet",
      "spreadSet",
      "liveIterationSet",
      "clearDuringIterationSet",
      "combinedSets",
      "rehashAndCompactSet",
      "directSetIteration",
    ];
    const planned = (await loadScriptCExecutablePlanners())
      .planExecutableCompilation(setFixture, {
        backend: "c",
        externalFunctionRoots: roots,
      });
    assert.equal(
      planned.ok,
      true,
      planned.ok ? undefined : planned.diagnostics.map(({ message }) => message).join("\n"),
    );
    if (!planned.ok) return;

    const packageName = "dev.nts.generated";
    const simpleName = "SetValues";
    const source = (await loadScriptCJvmEmitter()).emitJvmSerializedModule(
      planned.plan.ir,
      {
        packageName,
        className: simpleName,
        functionExports: roots.map((functionName) => ({
          functionName,
          methodName: functionName,
        })),
      },
    );
    const root = mkdtempSync(join(tmpdir(), "nts-jvm-set-values-"));
    try {
      const sourceDirectory = join(root, "sources", ...packageName.split("."));
      const classes = join(root, "classes");
      mkdirSync(sourceDirectory, { recursive: true });
      mkdirSync(classes);
      const sourcePath = join(sourceDirectory, `${simpleName}.java`);
      const harnessPath = join(sourceDirectory, "SetValuesHarness.java");
      writeFileSync(sourcePath, source);
      writeFileSync(
        harnessPath,
        `package ${packageName};\n` +
          "public final class SetValuesHarness {\n" +
          "  public static void main(String[] args) {\n" +
          `    System.out.println(${simpleName}.stringSet(\"gamma\"));\n` +
          `    System.out.println(${simpleName}.numberSet(4.0d));\n` +
          `    System.out.println(${simpleName}.seededEvaluationOrderSet());\n` +
          `    System.out.println(${simpleName}.spreadSet());\n` +
          `    System.out.println(${simpleName}.liveIterationSet());\n` +
          `    System.out.println(${simpleName}.clearDuringIterationSet());\n` +
          `    System.out.println(${simpleName}.combinedSets());\n` +
          `    System.out.println(${simpleName}.rehashAndCompactSet());\n` +
          `    System.out.println(${simpleName}.directSetIteration());\n` +
          "  }\n" +
          "}\n",
      );
      execFileSync(join(javaHome!, "bin/javac"), [
        "--release",
        "17",
        "-d",
        classes,
        sourcePath,
        harnessPath,
      ]);
      const run = spawnSync(
        join(javaHome!, "bin/java"),
        ["-cp", classes, `${packageName}.SetValuesHarness`],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(
        run.stdout,
        "10.0\n15.0\n1212.0\n7.0\n19.0\n102.0\n5238.0\n4656.0\n6.0\n",
      );

      const nestedBytecode = readdirSync(join(classes, ...packageName.split(".")))
        .filter((entry) => entry.startsWith(`${simpleName}$NtsSet`))
        .map((entry) =>
          execFileSync(
            join(javaHome!, "bin/javap"),
            [
              "-classpath",
              classes,
              "-p",
              `${packageName}.${entry.slice(0, -".class".length)}`,
            ],
            { encoding: "utf8" },
          )
        )
        .join("\n");
      assert.match(nestedBytecode, /java\.lang\.String\[\] elements;/u);
      assert.match(nestedBytecode, /double\[\] elements;/u);
      assert.match(nestedBytecode, /boolean\[\] live;/u);
      assert.match(nestedBytecode, /int\[\] table;/u);
      assert.doesNotMatch(nestedBytecode, /\[\] values;/u);
      assert.doesNotMatch(
        nestedBytecode,
        /java\.lang\.Object|java\.util\.(?:HashSet|LinkedHashSet)|java\.lang\.Double/u,
      );

      const ownerBytecode = execFileSync(
        join(javaHome!, "bin/javap"),
        ["-classpath", classes, "-c", "-p", `${packageName}.${simpleName}`],
        { encoding: "utf8" },
      );
      assert.doesNotMatch(ownerBytecode, /Double\.valueOf|JNI/u);

      const arrayBytecode = readdirSync(join(classes, ...packageName.split(".")))
        .filter((entry) => entry.startsWith(`${simpleName}$NtsArray`))
        .map((entry) =>
          execFileSync(
            join(javaHome!, "bin/javap"),
            [
              "-classpath",
              classes,
              "-c",
              "-p",
              `${packageName}.${entry.slice(0, -".class".length)}`,
            ],
            { encoding: "utf8" },
          )
        )
        .join("\n");
      assert.match(arrayBytecode, /java\/lang\/System\.arraycopy/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "direct JVM math preserves JavaScript edge cases as primitive bytecode",
  { skip: javaHome === null ? "no JDK on this host" : false },
  async () => {
    execFileSync(pnpm, ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"]);
    const roots = [
      "mathTransforms",
      "mathEdges",
      "extremaArity",
      "spreadExtrema",
      "variadicMathOrder",
      "randomInvariant",
    ];
    const planned = (await loadScriptCExecutablePlanners())
      .planExecutableCompilation(mathFixture, {
        backend: "c",
        externalFunctionRoots: roots,
      });
    assert.equal(
      planned.ok,
      true,
      planned.ok ? undefined : planned.diagnostics.map(({ message }) => message).join("\n"),
    );
    if (!planned.ok) return;

    const packageName = "dev.nts.generated";
    const simpleName = "MathValues";
    const source = (await loadScriptCJvmEmitter()).emitJvmSerializedModule(
      planned.plan.ir,
      {
        packageName,
        className: simpleName,
        functionExports: roots.map((functionName) => ({
          functionName,
          methodName: functionName,
        })),
      },
    );
    const root = mkdtempSync(join(tmpdir(), "nts-jvm-math-values-"));
    try {
      const sourceDirectory = join(root, "sources", ...packageName.split("."));
      const classes = join(root, "classes");
      mkdirSync(sourceDirectory, { recursive: true });
      mkdirSync(classes);
      const sourcePath = join(sourceDirectory, `${simpleName}.java`);
      const harnessPath = join(sourceDirectory, "MathValuesHarness.java");
      writeFileSync(sourcePath, source);
      writeFileSync(
        harnessPath,
        `package ${packageName};\n` +
          "public final class MathValuesHarness {\n" +
          "  public static void main(String[] args) {\n" +
          `    System.out.println(${simpleName}.mathTransforms(2.6d));\n` +
          `    System.out.println(${simpleName}.mathEdges());\n` +
          `    System.out.println(${simpleName}.extremaArity());\n` +
          `    System.out.println(${simpleName}.spreadExtrema());\n` +
          `    System.out.println(${simpleName}.variadicMathOrder());\n` +
          `    System.out.println(${simpleName}.randomInvariant(4096.0d));\n` +
          "  }\n" +
          "}\n",
      );
      execFileSync(join(javaHome!, "bin/javac"), [
        "--release",
        "17",
        "-d",
        classes,
        sourcePath,
        harnessPath,
      ]);
      const run = spawnSync(
        join(javaHome!, "bin/java"),
        ["-cp", classes, `${packageName}.MathValuesHarness`],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(
        run.stdout,
        "8.6\n1023.0\n63.0\n897.0\n1233.0\n4096.0\n",
      );

      const ownerBytecode = execFileSync(
        join(javaHome!, "bin/javap"),
        ["-classpath", classes, "-c", "-p", `${packageName}.${simpleName}`],
        { encoding: "utf8" },
      );
      assert.match(ownerBytecode, /java\/lang\/Math\.floor:\(D\)D/u);
      assert.match(ownerBytecode, /java\/lang\/Math\.ceil:\(D\)D/u);
      assert.match(ownerBytecode, /java\/lang\/Math\.abs:\(D\)D/u);
      assert.match(ownerBytecode, /java\/lang\/Math\.random:\(\)D/u);
      assert.match(ownerBytecode, /Method ntsMathRound:\(D\)D/u);
      assert.match(ownerBytecode, /Method ntsMathMaxArray:/u);
      assert.doesNotMatch(
        ownerBytecode,
        /java\/lang\/(?:Double|Number)\.valueOf|java\/util\/|JNI/u,
      );

      const arrayBytecode = readdirSync(join(classes, ...packageName.split(".")))
        .filter((entry) => entry.startsWith(`${simpleName}$NtsArray`))
        .map((entry) =>
          execFileSync(
            join(javaHome!, "bin/javap"),
            [
              "-classpath",
              classes,
              "-p",
              `${packageName}.${entry.slice(0, -".class".length)}`,
            ],
            { encoding: "utf8" },
          )
        )
        .join("\n");
      assert.match(arrayBytecode, /double\[\] data;/u);
      assert.doesNotMatch(arrayBytecode, /java\.lang\.Object\[\]/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "direct JVM numeric parsing preserves JavaScript grammar without JNI",
  { skip: javaHome === null ? "no JDK on this host" : false },
  async () => {
    execFileSync(pnpm, ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"]);
    const roots = [
      "numberPredicates",
      "numericSameValue",
      "predicateEvaluationOrder",
      "parseIntegerEdges",
      "parseFloatEdges",
      "convertStringEdges",
      "parsedInteger",
      "parsedFloat",
      "convertedNumber",
    ];
    const planned = (await loadScriptCExecutablePlanners())
      .planExecutableCompilation(numberParsingFixture, {
        backend: "c",
        externalFunctionRoots: roots,
      });
    assert.equal(
      planned.ok,
      true,
      planned.ok ? undefined : planned.diagnostics.map(({ message }) => message).join("\n"),
    );
    if (!planned.ok) return;

    const packageName = "dev.nts.generated";
    const simpleName = "NumberParsing";
    const source = (await loadScriptCJvmEmitter()).emitJvmSerializedModule(
      planned.plan.ir,
      {
        packageName,
        className: simpleName,
        functionExports: roots.map((functionName) => ({
          functionName,
          methodName: functionName,
        })),
      },
    );
    const root = mkdtempSync(join(tmpdir(), "nts-jvm-number-parsing-"));
    try {
      const sourceDirectory = join(root, "sources", ...packageName.split("."));
      const classes = join(root, "classes");
      mkdirSync(sourceDirectory, { recursive: true });
      mkdirSync(classes);
      const sourcePath = join(sourceDirectory, `${simpleName}.java`);
      const harnessPath = join(sourceDirectory, "NumberParsingHarness.java");
      writeFileSync(sourcePath, source);
      writeFileSync(
        harnessPath,
        `package ${packageName};\n` +
          "public final class NumberParsingHarness {\n" +
          "  public static void main(String[] args) {\n" +
          `    System.out.println(${simpleName}.numberPredicates());\n` +
          `    System.out.println(${simpleName}.numericSameValue());\n` +
          `    System.out.println(${simpleName}.predicateEvaluationOrder());\n` +
          `    System.out.println(${simpleName}.parseIntegerEdges());\n` +
          `    System.out.println(${simpleName}.parseFloatEdges());\n` +
          `    System.out.println(${simpleName}.convertStringEdges());\n` +
          "  }\n" +
          "}\n",
      );
      execFileSync(join(javaHome!, "bin/javac"), [
        "--release",
        "17",
        "-d",
        classes,
        sourcePath,
        harnessPath,
      ]);
      const run = spawnSync(
        join(javaHome!, "bin/java"),
        ["-cp", classes, `${packageName}.NumberParsingHarness`],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, "4095.0\n31.0\n3.0\n1023.0\n255.0\n1023.0\n");

      const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
      const parseIntegerCases: Array<readonly [string, number]> = [
        ["42", 0], ["  42  ", 0], ["\t\n-17", 0], ["3.9", 0],
        ["1e3", 0], ["12abc", 0], ["abc12", 0], ["0x1F", 0],
        ["-0x20", 0], ["0x", 0], ["ff", 16], ["0x1A", 16],
        ["101", 2], ["777", 8], ["z", 36], ["hello", 30],
        ["ff", 1], ["ff", 37], ["11", 2.9], ["11", Number.NaN],
        ["11", Number.POSITIVE_INFINITY], ["ff", 4_294_967_312],
        ["-0", 0], ["0000", 0], ["18446744073709551615", 10],
        ["18446744073709551616", 10],
        ["zzzzzzzzzzzz", 36], ["zzzzzzzzzzzzz", 36],
        ["123456789012345678901234567890", 10],
        ["deadbeefdeadbeefdeadbeefdeadbeef", 16],
        ["1".repeat(80), 35], ["7".repeat(30), 36],
        ["1" + "0".repeat(309), 10], ["１２３", 10], ["١٢٣", 10],
      ];
      for (let radix = 2; radix <= 36; radix += 1) {
        let digits = "";
        for (let index = 0; index < 80; index += 1) {
          const digit = index === 0 ? 1 : (index * 17 + radix * 11) % radix;
          digits += alphabet[digit]!;
        }
        parseIntegerCases.push([`${radix % 2 === 0 ? "-" : "+"}${digits}tail`, radix]);
      }
      const parseFloatCases = [
        "3.14abc", "  42  ", "abc", ".5", "1e3", "-2.5e-2",
        "Infinity", "+Infinitytail", "-Infinity", "", ".", "1.",
        "1e", "1e+", "1e-4tail", "0x10", "-0", "5e-324",
        "2.2250738585072014e-308", "1.7976931348623157e308", "1e309",
        "4.9406564584124654e-324tail",
      ];
      const numberCases = [
        "", " ", "42", "  -12.5e2  ", ".5", "1.", "1e3",
        "Infinity", "+Infinity", "-Infinity", "infinity", "NaN",
        "0x10", "0Xdeadbeef", "0o777", "0b10101", "-0x10", "+0b1",
        "0x", "0o8", "0b2", "12px", "1e", ".", "-0", "5e-324",
        "1.7976931348623157e308", "1e309", `0x${"f".repeat(300)}`,
      ];
      const javaDouble = (value: number): string =>
        Number.isNaN(value) ? "Double.NaN"
        : value === Number.POSITIVE_INFINITY ? "Double.POSITIVE_INFINITY"
        : value === Number.NEGATIVE_INFINITY ? "Double.NEGATIVE_INFINITY"
        : Object.is(value, -0) ? "-0.0d"
        : `${value}d`;
      const javaStrings = (values: readonly string[]): string =>
        values.map((value) => JSON.stringify(value)).join(", ");
      const vectorHarnessPath = join(sourceDirectory, "NumberParsingVectors.java");
      writeFileSync(
        vectorHarnessPath,
        `package ${packageName};\n` +
          "public final class NumberParsingVectors {\n" +
          "  private static void print(double value) {\n" +
          "    System.out.println(Double.isNaN(value) ? \"NaN\" : Long.toHexString(Double.doubleToRawLongBits(value)));\n" +
          "  }\n" +
          "  public static void main(String[] args) {\n" +
          `    String[] integers = new String[]{${javaStrings(parseIntegerCases.map(([value]) => value))}};\n` +
          `    double[] radices = new double[]{${parseIntegerCases.map(([, radix]) => javaDouble(radix)).join(", ")}};\n` +
          `    for (int index = 0; index < integers.length; index += 1) print(${simpleName}.parsedInteger(integers[index], radices[index]));\n` +
          `    String[] floats = new String[]{${javaStrings(parseFloatCases)}};\n` +
          `    for (String value : floats) print(${simpleName}.parsedFloat(value));\n` +
          `    String[] numbers = new String[]{${javaStrings(numberCases)}};\n` +
          `    for (String value : numbers) print(${simpleName}.convertedNumber(value));\n` +
          "  }\n" +
          "}\n",
      );
      execFileSync(join(javaHome!, "bin/javac"), [
        "--release",
        "17",
        "-cp",
        classes,
        "-d",
        classes,
        vectorHarnessPath,
      ]);
      const vectors = spawnSync(
        join(javaHome!, "bin/java"),
        ["-cp", classes, `${packageName}.NumberParsingVectors`],
        { encoding: "utf8" },
      );
      assert.equal(vectors.status, 0, vectors.stderr);
      const bits = (value: number): string => {
        if (Number.isNaN(value)) return "NaN";
        const bytes = new ArrayBuffer(8);
        new Float64Array(bytes)[0] = value;
        return new BigUint64Array(bytes)[0]!.toString(16);
      };
      const expectedVectors = [
        ...parseIntegerCases.map(([value, radix]) => bits(parseInt(value, radix))),
        ...parseFloatCases.map((value) => bits(parseFloat(value))),
        ...numberCases.map((value) => bits(Number(value))),
      ].join("\n") + "\n";
      assert.equal(vectors.stdout, expectedVectors);

      const bytecode = execFileSync(
        join(javaHome!, "bin/javap"),
        ["-classpath", classes, "-c", "-p", `${packageName}.${simpleName}`],
        { encoding: "utf8" },
      );
      assert.match(bytecode, /java\/lang\/Double\.parseDouble:\(Ljava\/lang\/String;\)D/u);
      assert.match(bytecode, /java\/math\/BigInteger\.doubleValue:\(\)D/u);
      assert.match(bytecode, /Method ntsParseInt:\(Ljava\/lang\/String;D\)D/u);
      assert.match(bytecode, /Method ntsParseInt:\(Ljava\/lang\/String;I\)D/u);
      assert.match(bytecode, /Method ntsParseFloat:\(Ljava\/lang\/String;\)D/u);
      assert.match(bytecode, /Method ntsStringToNumber:\(Ljava\/lang\/String;\)D/u);
      assert.doesNotMatch(
        bytecode,
        /java\/lang\/(?:Double|Number)\.valueOf|java\/util\/regex|JNI/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "direct JVM specializes closed integer parameters without narrowing public number ABI",
  { skip: javaHome === null ? "no JDK on this host" : false },
  async () => {
    execFileSync(pnpm, ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"]);
    const planners = await loadScriptCExecutablePlanners();
    const emitter = await loadScriptCJvmEmitter();
    const roots = [
      "directIntegerParameter",
      "publicNumberParameter",
      "callPublicNumberParameter",
    ];
    const planned = planners.planExecutableCompilation(integerParameterFixture, {
      backend: "c",
      externalFunctionRoots: roots,
    });
    assert.equal(
      planned.ok,
      true,
      planned.ok ? undefined : planned.diagnostics.map(({ message }) => message).join("\n"),
    );
    if (!planned.ok) return;

    const packageName = "dev.nts.generated";
    const simpleName = "IntegerParameters";
    const className = `${packageName}.${simpleName}`;
    const source = emitter.emitJvmSerializedModule(planned.plan.ir, {
      packageName,
      className: simpleName,
      functionExports: roots.map((functionName) => ({
        functionName,
        methodName: functionName,
      })),
    });
    const integerHelperMatch = source.match(
      /private static (int|double) (f_[0-9a-f]+)\(int [^)]+\) \{/u,
    );
    const integerHelperReturn = integerHelperMatch?.[1];
    const integerHelper = integerHelperMatch?.[2];
    assert.ok(
      integerHelper !== undefined && integerHelperReturn !== undefined,
      "expected one closed helper with an int parameter",
    );

    const root = mkdtempSync(join(tmpdir(), "nts-jvm-integer-parameters-"));
    try {
      const sourceDirectory = join(root, "sources", ...packageName.split("."));
      const classes = join(root, "classes");
      mkdirSync(sourceDirectory, { recursive: true });
      mkdirSync(classes);
      const sourcePath = join(sourceDirectory, `${simpleName}.java`);
      const harnessPath = join(sourceDirectory, "IntegerParametersHarness.java");
      writeFileSync(sourcePath, source);
      writeFileSync(
        harnessPath,
        `package ${packageName};\n` +
          "public final class IntegerParametersHarness {\n" +
          "  public static void main(String[] args) {\n" +
          `    System.out.println(${simpleName}.directIntegerParameter());\n` +
          `    System.out.println(${simpleName}.publicNumberParameter(511.75));\n` +
          `    System.out.println(${simpleName}.callPublicNumberParameter());\n` +
          "  }\n" +
          "}\n",
      );
      execFileSync(join(javaHome!, "bin/javac"), [
        "--release",
        "17",
        "-d",
        classes,
        sourcePath,
        harnessPath,
      ]);
      const run = spawnSync(
        join(javaHome!, "bin/java"),
        ["-cp", classes, `${packageName}.IntegerParametersHarness`],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, "2016.0\n255.0\n255.0\n");

      const bytecode = execFileSync(
        join(javaHome!, "bin/javap"),
        ["-classpath", classes, "-c", "-p", "-s", className],
        { encoding: "utf8" },
      );
      assert.match(
        bytecode,
        new RegExp(
          `private static ${integerHelperReturn} ${integerHelper}\\(int\\);\\n` +
            `    descriptor: \\(I\\)${integerHelperReturn === "int" ? "I" : "D"}`,
          "u",
        ),
      );
      const helperStart = bytecode.indexOf(
        `private static ${integerHelperReturn} ${integerHelper}(int);`,
      );
      const helperEnd = bytecode.indexOf("\n\n", helperStart);
      assert.ok(helperStart >= 0 && helperEnd > helperStart);
      assert.doesNotMatch(
        bytecode.slice(helperStart, helperEnd),
        /ntsToInt32/u,
      );
      assert.match(
        bytecode,
        /public static double publicNumberParameter\(double\);\n    descriptor: \(D\)D/u,
      );
      assert.doesNotMatch(bytecode, / native |JNI/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "managed class fields, inheritance, and virtual dispatch stay inside ART",
  { skip: javaHome === null ? "no JDK on this host" : false },
  async () => {
    execFileSync(pnpm, ["--dir", scriptcRoot, "--filter", "@scriptc/compiler", "build"]);
    const planners = await loadScriptCExecutablePlanners();
    const emitter = await loadScriptCJvmEmitter();
    const planned = planners.planExecutableCompilation(classFixture, {
      backend: "c",
      externalFunctionRoots: ["classFields", "integerFieldBitwise"],
    });
    assert.equal(
      planned.ok,
      true,
      planned.ok ? undefined : planned.diagnostics.map(({ message }) => message).join("\n"),
    );
    if (!planned.ok) return;

    const packageName = "dev.nts.generated";
    const simpleName = "ClassFields";
    const className = `${packageName}.${simpleName}`;
    const source = emitter.emitJvmSerializedModule(planned.plan.ir, {
      packageName,
      className: simpleName,
      functionExports: [{
        functionName: "classFields",
        methodName: "classFields",
      }, {
        functionName: "integerFieldBitwise",
        methodName: "integerFieldBitwise",
      }],
    });
    const root = mkdtempSync(join(tmpdir(), "nts-jvm-class-fields-"));
    try {
      const sourceDirectory = join(root, "sources", ...packageName.split("."));
      const classes = join(root, "classes");
      mkdirSync(sourceDirectory, { recursive: true });
      mkdirSync(classes);
      const sourcePath = join(sourceDirectory, `${simpleName}.java`);
      const harnessPath = join(sourceDirectory, "ClassFieldsHarness.java");
      writeFileSync(sourcePath, source);
      writeFileSync(
        harnessPath,
        `package ${packageName};\n` +
          "public final class ClassFieldsHarness {\n" +
          "  public static void main(String[] args) {\n" +
          `    System.out.println(${simpleName}.classFields());\n` +
          `    System.out.println(${simpleName}.integerFieldBitwise());\n` +
          "  }\n" +
          "}\n",
      );
      execFileSync(join(javaHome!, "bin/javac"), [
        "--release",
        "17",
        "-d",
        classes,
        sourcePath,
        harnessPath,
      ]);
      const run = spawnSync(
        join(javaHome!, "bin/java"),
        ["-cp", classes, `${packageName}.ClassFieldsHarness`],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, "42.0\n240.0\n");

      const bytecode = execFileSync(
        join(javaHome!, "bin/javap"),
        ["-classpath", classes, "-c", "-p", className],
        { encoding: "utf8" },
      );
      const nestedBytecode = readdirSync(join(classes, ...packageName.split(".")))
        .filter((entry) => entry.startsWith(`${simpleName}$`) && entry.endsWith(".class"))
        .map((entry) =>
          execFileSync(
            join(javaHome!, "bin/javap"),
            [
              "-classpath",
              classes,
              "-c",
              "-p",
              `${packageName}.${entry.slice(0, -".class".length)}`,
            ],
            { encoding: "utf8" },
          )
        )
        .join("\n");
      assert.match(bytecode, /invokevirtual .*\.m_[0-9a-f]+:\(D\)D/u);
      assert.match(bytecode, /putfield .*\.d_[0-9a-f]+:I/u);
      assert.match(nestedBytecode, /\bint m_[0-9a-f]+\(\);/u);
      assert.match(nestedBytecode, /\bireturn\b/u);
      assert.doesNotMatch(
        bytecode,
        /invokestatic\s+#[0-9]+\s+\/\/ Method ntsToInt32:/u,
      );
      assert.doesNotMatch(bytecode, / native /u);
      assert.doesNotMatch(bytecode, /JNI/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
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
