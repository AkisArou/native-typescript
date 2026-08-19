/**
 * Reality sweep for the JVM metadata ingestion in packages/bindgen-jvm:
 * run every class of a real platform archive through ingestion with every
 * declared member selected, and tally what the algebra accepts, what it
 * refuses by design, and what it cannot read.
 *
 * This is the instrument behind the recorded claim that the reader handles
 * real platform metadata cleanly and fast enough that lazy-parse machinery
 * is unjustified: re-run it when that claim is doubted. It is a
 * measurement, not a gate, and it reaches into the package's internal
 * class-file reader deliberately - enumerating the declared members it is
 * about to select is the measurement.
 *
 *   node scripts/jvm-metadata-sweep.ts [archive.jar|archive.jmod ...]
 *
 * With no arguments it sweeps what it can discover on the host: the newest
 * installed Android SDK platform's android.jar, and java.base.jmod from
 * JAVA_HOME or the JDK that owns the `java` on PATH.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  JvmIngestionError,
  ingestJvmClasses,
  readJarClassSources,
} from "@native-typescript/bindgen-jvm";
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

function sweepArchive(path: string): void {
  const t0 = performance.now();
  const bytes = readFileSync(path);
  const label = path.split("/").slice(-2).join("/");
  const sources = readJarClassSources(bytes, label);
  const tRead = performance.now();

  let parsed = 0;
  let parseFailures = 0;
  let ingested = 0;
  let methods = 0;
  let fields = 0;
  let constants = 0;
  const buckets = new Map<string, { count: number; example: string }>();

  function bucket(codes: string, example: string): void {
    const existing = buckets.get(codes);
    if (existing === undefined) buckets.set(codes, { count: 1, example });
    else existing.count++;
  }

  for (const source of sources) {
    const diagnostics: JvmDiagnostic[] = [];
    const declared = parseClassFile(
      source.bytes,
      source.logicalPath,
      diagnostics,
    );
    if (declared === null) {
      parseFailures++;
      bucket(
        `parse:${diagnostics.map(({ code }) => code).join(",")}`,
        `${source.logicalPath}: ${diagnostics[0]?.message}`,
      );
      continue;
    }
    parsed++;
    try {
      const snapshot = ingestJvmClasses([source], {
        classes: [
          {
            binaryName: declared.binaryName,
            constructors: declared.methods
              .filter(({ name }) => name === "<init>")
              .map(({ descriptor }) => descriptor),
            methods: declared.methods
              .filter(({ name }) => name !== "<init>" && name !== "<clinit>")
              .map(({ name, descriptor }) => ({ name, descriptor })),
            fields: declared.fields.map(({ name, descriptor }) => ({
              name,
              descriptor,
            })),
          },
        ],
      });
      ingested++;
      const class_ = snapshot.classes[0]!;
      methods += class_.methods.length + class_.constructors.length;
      fields += class_.fields.length;
      constants += class_.fields.filter(
        ({ constantValue }) => constantValue !== null,
      ).length;
    } catch (error) {
      if (!(error instanceof JvmIngestionError)) throw error;
      bucket(
        [...new Set(error.diagnostics.map(({ code }) => code))].join(","),
        `${source.logicalPath}: ${error.diagnostics[0]?.message}`,
      );
    }
  }
  const t1 = performance.now();
  console.log(`== ${label} (${path})`);
  console.log(
    `   entries=${sources.length} read+inflate=${(tRead - t0).toFixed(0)}ms ` +
      `sweep=${(t1 - tRead).toFixed(0)}ms`,
  );
  console.log(
    `   parsed=${parsed} parseFailures=${parseFailures} fullMemberIngest=${ingested}`,
  );
  console.log(
    `   members: methods+ctors=${methods} fields=${fields} constants=${constants}`,
  );
  for (const [codes, { count, example }] of [...buckets.entries()].sort()) {
    console.log(`   refused ${codes}: ${count}  e.g. ${example}`);
  }
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
    "usage: node scripts/jvm-metadata-sweep.ts <archive.jar|archive.jmod ...>",
  );
  process.exit(2);
}
for (const archive of archives) sweepArchive(archive);
