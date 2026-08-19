/**
 * Census of the JNIEnv function table, from the real jni.h: which
 * operations are unary-release resources (a handle whose destructor is one
 * symbol over the value itself), which are carried-state acquire/release
 * PAIRS (the release needs the owner AND the acquired view, sometimes a
 * mode), and which are copy accessors with no release at all.
 *
 * The question this instrument answers: is the JNI array/string element
 * lifecycle a result projection or a resource domain? The census shows the
 * platform itself splits the two - every carried-state pair over primitive
 * arrays and strings has a Region copy accessor beside it that needs no
 * release, so the copy PROJECTION never requires the pair, and the pair
 * exists solely for zero-copy borrowing: a thing acquired, held across a
 * region, and released with the state that acquired it.
 *
 *   node scripts/jni-pair-census.ts [path/to/jni.h]
 *
 * With no argument it reads jni.h from JAVA_HOME or the JDK that owns the
 * `java` on PATH. Names are extracted from the header's own struct - the
 * same evidence-over-inference rule as probe_offsets.c in the falsifier,
 * where a hand-written slot table once got ExceptionClear wrong.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

function discoverJniHeader(): string | null {
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
    const header = join(home, "include/jni.h");
    if (existsSync(header)) return header;
  }
  return null;
}

interface TableMember {
  readonly name: string;
  /** Parameter names/types beyond `JNIEnv *env`, textually. */
  readonly parameters: readonly string[];
}

function parseFunctionTable(headerText: string): TableMember[] {
  const start = headerText.indexOf("struct JNINativeInterface_ {");
  const end = headerText.indexOf("};", start);
  if (start === -1 || end === -1) {
    throw new Error("jni.h does not contain struct JNINativeInterface_");
  }
  const block = headerText.slice(start, end);
  const members: TableMember[] = [];
  const memberPattern = /\(JNICALL \*(\w+)\)\s*\(([^;]*?)\)\s*;/gsu;
  for (const match of block.matchAll(memberPattern)) {
    const [, name, argsText] = match;
    const parameters = argsText!
      .split(",")
      .map((parameter) => parameter.trim().replace(/\s+/gu, " "))
      .filter((parameter) => parameter.length > 0)
      .slice(1);
    members.push({ name: name!, parameters });
  }
  return members;
}

const headerPath = process.argv[2] ?? discoverJniHeader();
if (headerPath === null) {
  console.error("usage: node scripts/jni-pair-census.ts <path/to/jni.h>");
  process.exit(2);
}
const members = parseFunctionTable(readFileSync(headerPath, "utf8"));
const byName = new Map(members.map((member) => [member.name, member]));

console.log(`jni.h: ${headerPath}`);
console.log(`function-table members: ${members.length}`);

/* Carried-state pairs: a Release<X> whose Get<X> exists. Report what the
 * release actually needs - if it is more than the acquired value, a unary
 * destructor cannot express it. */
console.log("\ncarried-state acquire/release pairs (release beside Get):");
let pairCount = 0;
for (const member of members) {
  if (!member.name.startsWith("Release")) continue;
  const acquire = byName.get(`Get${member.name.slice("Release".length)}`);
  if (acquire === undefined) continue;
  pairCount++;
  console.log(
    `   Get/${member.name}  release takes: ${member.parameters.join(", ")}`,
  );
}
console.log(`   total pairs: ${pairCount}`);

/* Unary-release resources: the destructor is one symbol over the value. */
console.log("\nunary-release resources (destructor-as-data suffices):");
for (const member of members) {
  if (!member.name.startsWith("Delete")) continue;
  console.log(`   ${member.name}(${member.parameters.join(", ")})`);
}

/* Structural region pairs, named by the specification rather than by a
 * lexical Get/Release convention. */
console.log("\nstructural region pairs:");
for (const [enter, exit] of [
  ["PushLocalFrame", "PopLocalFrame"],
  ["MonitorEnter", "MonitorExit"],
]) {
  const present = byName.has(enter!) && byName.has(exit!);
  console.log(`   ${enter}/${exit}: ${present ? "present" : "MISSING"}`);
}

/* Copy accessors with no release: the projection path. For every pair over
 * primitive arrays and strings, one of these exists beside it. */
console.log("\ncopy accessors with no release (Region family):");
const regionMembers = members.filter((member) =>
  /Region$/u.test(member.name)
);
for (const member of regionMembers) console.log(`   ${member.name}`);
console.log(`   total: ${regionMembers.length}`);

/* The pairing fact the design question turns on: primitive-array and
 * string pairs each have a copy alternative; object arrays have neither a
 * bulk pin nor a pair - only per-element access. */
console.log("\nprojection-vs-borrow split:");
const primitives = ["Boolean", "Byte", "Char", "Short", "Int", "Long", "Float", "Double"];
for (const primitive of primitives) {
  const pair = byName.has(`Get${primitive}ArrayElements`) &&
    byName.has(`Release${primitive}ArrayElements`);
  const copy = byName.has(`Get${primitive}ArrayRegion`) &&
    byName.has(`Set${primitive}ArrayRegion`);
  console.log(`   ${primitive.toLowerCase()}[]: borrow-pair=${pair} copy=${copy}`);
}
console.log(
  `   String: chars-pairs=${byName.has("ReleaseStringChars") && byName.has("ReleaseStringUTFChars")} ` +
    `copy=${byName.has("GetStringRegion") && byName.has("GetStringUTFRegion")}`,
);
console.log(
  `   Object[]: bulk-pair=${byName.has("GetObjectArrayElements")} ` +
    `per-element=${byName.has("GetObjectArrayElement")}`,
);
