/**
 * How often does the counted-array shape appear in a real JVM surface?
 *
 * Walks every declared member of every class in an archive and tallies
 * array-typed results and parameters by element kind, for the bindable
 * (public/protected) surface and for everything declared. The finding this
 * instrument backs: on the JVM the counted shape is not one of two array
 * conventions, it is the only one - every array carries its length
 * (JNI's GetArrayLength) and no terminated variant exists - so the axis GIR
 * chooses per member ("length parameter or terminator") does not exist here.
 *
 *   node scripts/jvm-array-shape-count.ts [archive.jar|archive.jmod ...]
 *
 * With no arguments it measures what it can discover on the host: the
 * newest installed Android SDK platform's android.jar, and java.base.jmod
 * from JAVA_HOME or the JDK that owns the `java` on PATH. A measurement,
 * not a gate; it reaches the package's internal class-file reader
 * deliberately, like scripts/jvm-metadata-sweep.ts.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readJarClassSources } from "@native-typescript/bindgen-jvm";
import { parseClassFile } from "../packages/bindgen-jvm/src/classfile.ts";
import type { JvmDiagnostic } from "@native-typescript/bindgen-jvm";

function discoverAndroidJar(): string | null {
  const roots = [
    process.env["ANDROID_SDK_ROOT"],
    process.env["ANDROID_HOME"],
    join(homedir(), "Android/Sdk"),
  ].filter((root): root is string => root !== undefined && root.length > 0);
  for (const root of roots) {
    const platformsDir = join(root, "platforms");
    if (!existsSync(platformsDir)) continue;
    const platforms = readdirSync(platformsDir)
      .filter((name) => /^android-\d+(\.\d+)?$/u.test(name))
      .sort((left, right) =>
        parseFloat(right.slice("android-".length)) -
        parseFloat(left.slice("android-".length))
      );
    for (const platform of platforms) {
      const jar = join(platformsDir, platform, "android.jar");
      if (existsSync(jar)) return jar;
    }
  }
  return null;
}

function discoverJavaBaseJmod(): string | null {
  const homes = [process.env["JAVA_HOME"]].filter(
    (home): home is string => home !== undefined && home.length > 0,
  );
  const javaBinary = process.env["PATH"]?.split(":")
    .map((dir) => join(dir, "java"))
    .find((candidate) => existsSync(candidate));
  if (javaBinary !== undefined) {
    try {
      homes.push(dirname(dirname(realpathSync(javaBinary))));
    } catch {
      /* An unresolvable shim just means no discovery from PATH. */
    }
  }
  for (const home of homes) {
    const jmod = join(home, "jmods/java.base.jmod");
    if (existsSync(jmod)) return jmod;
  }
  return null;
}

const primitiveNames: ReadonlyMap<string, string> = new Map([
  ["Z", "boolean"],
  ["B", "byte"],
  ["C", "char"],
  ["S", "short"],
  ["I", "int"],
  ["J", "long"],
  ["F", "float"],
  ["D", "double"],
]);

function elementLabel(descriptor: string, from: number): string {
  const code = descriptor[from] ?? "?";
  const primitive = primitiveNames.get(code);
  if (primitive !== undefined) return primitive;
  if (code === "L") {
    const name = descriptor.slice(from + 1, descriptor.indexOf(";", from));
    return name === "java/lang/String" ? "String" : `L:${name}`;
  }
  return `?${code}`;
}

/** One type in a descriptor: [end, arrayDimensions, elementLabel | null]. */
function walkType(
  descriptor: string,
  at: number,
): [number, number, string | null] {
  let dimensions = 0;
  let i = at;
  while (descriptor[i] === "[") {
    dimensions++;
    i++;
  }
  const label = dimensions > 0 ? elementLabel(descriptor, i) : null;
  if (descriptor[i] === "L") return [descriptor.indexOf(";", i) + 1, dimensions, label];
  return [i + 1, dimensions, label];
}

function topEntries(map: ReadonlyMap<string, number>): string {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([key, count]) => `${key}=${count}`)
    .join(" ");
}

function measureArchive(path: string): void {
  const label = path.split("/").slice(-2).join("/");
  const sources = readJarClassSources(readFileSync(path), label);
  let methodsAll = 0;
  let methodsBindable = 0;
  let arrayResults = 0;
  let arrayResultsBindable = 0;
  let multiDimResults = 0;
  let methodsWithArrayParam = 0;
  let methodsWithArrayParamBindable = 0;
  let arrayParams = 0;
  let arrayFields = 0;
  let stringArrayResults = 0;
  const resultElements = new Map<string, number>();
  const paramElements = new Map<string, number>();
  const stringArrayExamples: string[] = [];

  function bump(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  for (const source of sources) {
    const diagnostics: JvmDiagnostic[] = [];
    const parsed = parseClassFile(source.bytes, source.logicalPath, diagnostics);
    if (parsed === null) continue;
    for (const method of parsed.methods) {
      if (method.name === "<clinit>") continue;
      const bindable = (method.accessFlags & 0x0005) !== 0;
      methodsAll++;
      if (bindable) methodsBindable++;
      const descriptor = method.descriptor;
      let i = 1;
      let sawArrayParam = false;
      while (descriptor[i] !== ")" && i < descriptor.length) {
        const [next, dimensions, element] = walkType(descriptor, i);
        if (dimensions > 0) {
          arrayParams++;
          sawArrayParam = true;
          if (bindable && element !== null) bump(paramElements, element);
        }
        i = next;
      }
      if (sawArrayParam) {
        methodsWithArrayParam++;
        if (bindable) methodsWithArrayParamBindable++;
      }
      const [, resultDimensions, resultElement] = walkType(descriptor, i + 1);
      if (resultDimensions > 0) {
        arrayResults++;
        if (resultDimensions > 1) multiDimResults++;
        if (bindable) {
          arrayResultsBindable++;
          if (resultElement !== null) bump(resultElements, resultElement);
          if (resultElement === "String" && resultDimensions === 1) {
            stringArrayResults++;
            if (stringArrayExamples.length < 5) {
              stringArrayExamples.push(`${parsed.binaryName}.${method.name}`);
            }
          }
        }
      }
    }
    for (const field of parsed.fields) {
      if (field.descriptor.startsWith("[")) arrayFields++;
    }
  }

  console.log(`== ${label} (${path})`);
  console.log(
    `   methods declared=${methodsAll} bindable(public|protected)=${methodsBindable}`,
  );
  console.log(
    `   array RESULTS: bindable=${arrayResultsBindable} ` +
      `(${(100 * arrayResultsBindable / methodsBindable).toFixed(1)}% of bindable) ` +
      `all=${arrayResults} multiDim=${multiDimResults}`,
  );
  console.log(`     result elements: ${topEntries(resultElements)}`);
  console.log(
    `   array PARAMS: methods-with>=1 bindable=${methodsWithArrayParamBindable} ` +
      `(${(100 * methodsWithArrayParamBindable / methodsBindable).toFixed(1)}%) ` +
      `total array params=${arrayParams}`,
  );
  console.log(`     param elements: ${topEntries(paramElements)}`);
  console.log(`   array-typed fields: ${arrayFields}`);
  console.log(
    `   String[] results (bindable): ${stringArrayResults}` +
      `  e.g. ${stringArrayExamples.join(", ")}`,
  );
}

const archives = process.argv.slice(2);
if (archives.length === 0) {
  const androidJar = discoverAndroidJar();
  if (androidJar !== null) archives.push(androidJar);
  const javaBase = discoverJavaBaseJmod();
  if (javaBase !== null) archives.push(javaBase);
}
if (archives.length === 0) {
  console.error(
    "usage: node scripts/jvm-array-shape-count.ts <archive.jar|archive.jmod ...>",
  );
  process.exit(2);
}
for (const archive of archives) measureArchive(archive);
