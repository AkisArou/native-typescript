/* How much of GTK 4 the binding algebra reaches, and what the rest is waiting
 * on.
 *
 * [The roadmap](../docs/roadmap.md) sequences the GTK work off exactly this
 * number and the bucket list under it — "what it refuses is the ordered list
 * of what to build next". That measurement was made by hand and its
 * instrument was not kept, so re-running it after a slice meant re-deriving
 * it. This is the instrument.
 *
 * What it measures is the ALGEBRA's reach, not any application's and not
 * whether the output compiles: ABI evidence is synthesized rather than probed,
 * because a census of thousands of members cannot shell out to Clang and
 * because refusals are decided from GIR before evidence is consulted. A
 * member counted here is one the generator will describe; whether the real
 * headers agree is what `pnpm test` is for.
 *
 * Every namespace the GIR declares an include for is supplied as an import,
 * because a member refused for lack of an import is not a member the algebra
 * cannot reach — and a census that conflated the two would rank an
 * unsupplied namespace above a real gap. Imports are ingested with everything
 * they declare selected, the same way the subject is.
 *
 *   node --experimental-strip-types scripts/gtk-surface-census.ts [Namespace]
 */
import { existsSync, readFileSync } from "node:fs";
import {
  digestClangAbiEvidence,
  renderCFunctionPointerType,
  renderCType,
} from "@native-typescript/bindgen-c";
import type {
  ClangAbiEvidenceSnapshot,
  ClangAbiProbe,
  ClangAbiValue,
} from "@native-typescript/bindgen-c";
import {
  generateGirClangAbiProbe,
  generateGObjectAdapterSource,
  generateGObjectScabiPackage,
  ingestGir,
} from "@native-typescript/bindgen-gir";
import type { GirSnapshot } from "@native-typescript/bindgen-gir";
import type { PackageIdentity } from "@native-typescript/scabi";

const namespace = process.argv[2] ?? "Gtk";
const version = namespace === "Gtk" ? "4.0" : "2.0";
const girPath = `/usr/share/gir-1.0/${namespace}-${version}.gir`;

/* Synthesized, not probed. Sizes and offsets are plausible rather than true;
 * nothing counted here depends on them, because a record that carries a
 * pointer is refused from its GIR fields before any layout is consulted. */
function evidence(probe: ClangAbiProbe): ClangAbiEvidenceSnapshot {
  const clang = {
    toolId: "tool/clang",
    version: "census",
    digest: `sha256:${"a".repeat(64)}`,
    target: "x86_64-unknown-linux-gnu",
  } as const;
  const functions = probe.functions.map((function_) => {
    const type = renderCFunctionPointerType(function_, "");
    return { id: function_.id, symbol: function_.symbol, expectedType: type, clangType: type };
  });
  const physical = (type: ClangAbiValue["type"]): ClangAbiValue => ({
    type,
    alignment: null,
    stackAlignment: null,
    extension: null,
    inRegister: false,
    byValue: null,
    structureReturn: null,
  });
  const word = { kind: "integer" as const, bits: 64 };
  const records = probe.records.map((record) => {
    const generated = record.definition === "generated";
    return {
      id: record.id,
      typeName: record.typeName,
      size: generated ? 16 : 8,
      alignment: 4,
      fields: record.fields.map((field, index) => ({
        name: field.name,
        expectedType: renderCType(field.type),
        clangType: renderCType(field.type),
        offset: index * (generated ? 8 : 4),
        size: generated ? 8 : 4,
        alignment: 4,
      })),
      callingConvention: {
        result: physical(
          generated ? { kind: "struct" as const, packed: false, fields: [word, word] } : word,
        ),
        parameters: generated ? [physical(word), physical(word)] : [physical(word)],
      },
    };
  });
  const enums = probe.enums.map((enum_) => ({
    id: enum_.id,
    typeName: enum_.typeName,
    clangType: enum_.typeName,
    size: 4,
    alignment: 4,
    signed: false,
    members: enum_.members.map((member) => ({ ...member })),
  }));
  const semantic = { probeDigest: probe.sourceDigest, clang, functions, records, enums };
  return {
    schema: "native-typescript.clang-abi-evidence",
    schemaVersion: 3,
    probeDigest: probe.sourceDigest,
    semanticDigest: digestClangAbiEvidence(semantic),
    clang,
    functions,
    records,
    enums,
  } as ClangAbiEvidenceSnapshot;
}

/* Everything except the snapshot, the adapter, and the evidence, which each
 * round supplies. Nothing here affects what projects — the target is a real
 * one so the shapes are plausible, not so the count depends on it. */
const baseOptions = {
  package: {
    name: `@native-typescript/${namespace.toLowerCase()}`,
    version: "0.0.0",
    namespace: `native-typescript.${namespace.toLowerCase()}`,
    instance: `native-typescript.${namespace.toLowerCase()}@0.0.0`,
  },
  target: {
    triple: "x86_64-unknown-linux-gnu",
    architecture: "x86_64",
    pointerWidth: 64,
    endianness: "little",
    objectFormat: "elf",
    minimumPlatformVersion: "glibc-2.17",
    abi: "sysv-amd64",
    features: ["gtk4", "glib-main-context"],
  },
  sdk: {
    vendor: "GNOME",
    name: namespace,
    version,
    deploymentTarget: "x86_64-unknown-linux-gnu",
    modules: ["gtk4"],
  },
  linkInputs: [{ id: "gtk4", kind: "system-library", name: "gtk4", order: 0 }],
  adapterInput: { id: "census.gobject-adapters", output: "gobject-adapters.o" },
} as const;

/* Everything the namespace declares, read straight out of the GIR.
 *
 * The selection has to be built from the document because ingestion is
 * selection-driven by design — it refuses to guess what a caller wanted. A
 * census wants all of it, which makes this the one caller that does. */
type Declared = {
  readonly classes: { name: string; methods: string[]; constructors: string[] }[];
  readonly interfaces: { name: string; methods: string[] }[];
  readonly records: { name: string; methods: string[] }[];
  readonly enumerations: { name: string; members: string[] }[];
};

function declaredSurface(source: string): Declared {
  const classes: Declared["classes"][number][] = [];
  const interfaces: Declared["interfaces"][number][] = [];
  const records: Declared["records"][number][] = [];
  const enumerations: Declared["enumerations"][number][] = [];
  /* A deliberately small reader rather than an XML library: the census needs
   * names and nesting, and nothing else in the document. */
  const owners = source.matchAll(
    /<(class|interface|record|enumeration|bitfield)\s+name="([^"]+)"([\s\S]*?)<\/\1>/gu,
  );
  for (const [, kind, name, body] of owners) {
    const named = (tag: string): string[] =>
      [...(body ?? "").matchAll(new RegExp(`<${tag}\\s+name="([^"]+)"`, "gu"))]
        .map((match) => match[1]!);
    if (kind === "class") {
      classes.push({ name: name!, methods: named("method"), constructors: named("constructor") });
    } else if (kind === "interface") {
      interfaces.push({ name: name!, methods: named("method") });
    } else if (kind === "record") {
      records.push({ name: name!, methods: named("method") });
    } else {
      enumerations.push({ name: name!, members: named("member") });
    }
  }
  return { classes, interfaces, records, enumerations };
}

/* The namespaces this one references, TRANSITIVELY, read from `<include>`
 * lines rather than from a list somebody maintains — a GIR that grows a
 * dependency should not need this file edited.
 *
 * Transitive because the direct includes are not the interesting ones: GTK
 * includes Gdk and Gsk, and everything a member is likely to refuse over —
 * Gio, GLib, GObject, Pango — arrives through them. Supplying only the direct
 * two would leave most cross-namespace refusals mislabelled as gaps. */
function includedNamespaces(source: string): { name: string; version: string }[] {
  const found = new Map<string, { name: string; version: string }>();
  const pending = [source];
  while (pending.length > 0) {
    const text = pending.pop()!;
    for (const match of text.matchAll(/<include name="([^"]+)" version="([^"]+)"\s*\/>/gu)) {
      const name = match[1]!;
      const version = match[2]!;
      const key = `${name}-${version}`;
      if (found.has(key)) continue;
      found.set(key, { name, version });
      const path = `/usr/share/gir-1.0/${key}.gir`;
      if (existsSync(path)) pending.push(readFileSync(path, "utf8"));
    }
  }
  return [...found.values()];
}

function diagnosticsOf(error: unknown): readonly { path: string; message: string }[] {
  const carried = (error as { diagnostics?: readonly { path: string; message: string }[] })
    .diagnostics;
  return carried ?? [];
}

function importedSnapshot(
  name: string,
  girVersion: string,
): { snapshot: GirSnapshot; package: PackageIdentity } | null {
  const path = `/usr/share/gir-1.0/${name}-${girVersion}.gir`;
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const slug = name.toLowerCase() + girVersion.replace(/\./gu, "");
  /* An import converges the same way the subject does — an SDK declares
   * members outside the ingestion contract (variadics, non-introspectable
   * calls) and a whole-namespace selection meets all of them. What an import
   * contributes is its TYPES, so a member dropped here costs the census
   * nothing; the alternative is dropping the namespace and mislabelling every
   * type in it as unsupplied. */
  const surface = declaredSurface(text);
  const dropped = new Set<string>();
  for (let round = 1; round <= 40; round++) {
    const selection = {
      logicalPath: `system-sdk/gir/${name}-${girVersion}.gir`,
      namespace: { name, version: girVersion },
      classes: surface.classes
        .filter((item) => !dropped.has(`${item.name}#!`))
        .map((item) => ({
          ...item,
          methods: item.methods.filter((m) => !dropped.has(`${item.name}#${m}`)),
          constructors: item.constructors.filter((c) => !dropped.has(`${item.name}#${c}`)),
        })),
      interfaces: surface.interfaces
        .filter((item) => !dropped.has(`${item.name}#!`))
        .map((item) => ({
          ...item,
          methods: item.methods.filter((m) => !dropped.has(`${item.name}#${m}`)),
        })),
      records: surface.records
        .filter((item) => !dropped.has(`${item.name}#!`))
        .map((item) => ({
          ...item,
          methods: item.methods.filter((m) => !dropped.has(`${item.name}#${m}`)),
        })),
      enumerations: surface.enumerations.filter(
        (item) => !dropped.has(`${item.name}#*`) && !dropped.has(`${item.name}#!`),
      ),
    };
    try {
      return {
        snapshot: ingestGir(text, selection),
        package: {
          name: `@native-typescript/${slug}`,
          version: "0.0.0",
          namespace: `native-typescript.${slug}`,
          instance: `native-typescript.${slug}@0.0.0`,
        },
      };
    } catch (error) {
      let shrank = false;
      for (const diagnostic of diagnosticsOf(error)) {
        const indexed =
          /^(classes|interfaces|records|enumerations)\/(\d+)\/(methods|constructors|members)\/(\d+)/u
            .exec(diagnostic.path);
        if (indexed !== null) {
          const [, group, ownerIndex, kind, memberIndex] = indexed;
          const owner = (selection as Record<string, { name: string }[]>)[group!]?.[
            Number(ownerIndex)
          ];
          if (owner === undefined) continue;
          const member = kind === "members"
            ? "*"
            : (owner as unknown as Record<string, string[]>)[kind!]?.[Number(memberIndex)];
          if (member === undefined) continue;
          if (dropped.has(`${owner.name}#${member}`)) continue;
          dropped.add(`${owner.name}#${member}`);
          shrank = true;
          continue;
        }
        const named =
          /(?:^|\/)(?:class|interface|record|enumeration|bitfield)\/([A-Za-z0-9_]+)\/(?:method|constructor)\/([^/]+)/u
            .exec(diagnostic.path);
        if (named !== null && !dropped.has(`${named[1]}#${named[2]}`)) {
          dropped.add(`${named[1]}#${named[2]}`);
          shrank = true;
          continue;
        }
        /* A refusal naming a declaration and no member is about the
         * declaration itself — a record with no `get-type`, a class whose
         * parent is unreachable — so the whole thing goes. */
        const owner =
          /(?:^|\/)(?:class|interface|record|enumeration|bitfield)\/([A-Za-z0-9_]+)/u
            .exec(diagnostic.path)?.[1];
        if (owner !== undefined && !dropped.has(`${owner}#!`)) {
          dropped.add(`${owner}#!`);
          shrank = true;
        }
      }
      if (!shrank) return null;
    }
  }
  return null;
}

const source = readFileSync(girPath, "utf8");
const declared = declaredSurface(source);

/* Ingested once and reused every round: the imports do not change as the
 * subject's selection shrinks, and re-reading five GIRs per round would
 * dominate the runtime. */
let imports: { snapshot: GirSnapshot; package: PackageIdentity }[] | null = null;
function importedNamespaces() {
  if (imports !== null) return imports;
  const wanted = includedNamespaces(source);
  const resolved = wanted
    .map(({ name, version: girVersion }) => importedSnapshot(name, girVersion));
  const missing = wanted.filter((_, index) => resolved[index] === null);
  if (missing.length > 0) {
    console.log(
      `imports not supplied (their types stay in the refusal list): ${
        missing.map(({ name, version: v }) => `${name}-${v}`).join(", ")
      }`,
    );
  }
  imports = resolved.filter((entry) => entry !== null);
  console.log(
    `imports supplied: ${imports.map(({ package: p }) => p.namespace).join(", ") || "(none)"}`,
  );
  return imports;
}
const declaredMethods =
  declared.classes.reduce((total, class_) => total + class_.methods.length, 0) +
  declared.interfaces.reduce((total, item) => total + item.methods.length, 0) +
  declared.records.reduce((total, record) => total + record.methods.length, 0);
console.log(
  `${namespace}-${version} declares ${declared.classes.length} classes, ` +
    `${declared.interfaces.length} interfaces, ${declared.records.length} records, ` +
    `${declared.enumerations.length} enumerations, ${declaredMethods} methods`,
);

/* Generate, drop what was refused, repeat. Ingestion and generation both
 * report every refusal they find in one pass and then stop, so converging on
 * the projectable subset means removing the named members and asking again —
 * which is also what produces the bucket list, since each removal is recorded
 * with the reason that caused it. */
type Refusal = { readonly owner: string; readonly member: string; readonly reason: string };

const refusals: Refusal[] = [];
const dropped = new Set<string>();
const droppedOwners = new Set<string>();

function key(owner: string, member: string): string {
  return `${owner}#${member}`;
}

/* A diagnostic path names where the refusal was found. The census needs the
 * MEMBER it belongs to, which is the first `<owner>/<kind>/<member>` triple
 * in the path — everything after it locates the position inside that member
 * and would split one refusal into several. */
function locate(path: string): { owner: string; member: string } | null {
  const match =
    /(?:^|\/)([A-Z][A-Za-z0-9_]*)\/(?:method|constructor|function|property|signal)\/([^/]+)/u.exec(
      path,
    );
  if (match === null) return null;
  return { owner: match[1]!, member: match[2]! };
}

function selection() {
  const keep = <T extends { name: string; methods: string[] }>(items: readonly T[]) =>
    items
      .filter((item) => !droppedOwners.has(item.name))
      .map((item) => ({
        ...item,
        methods: item.methods.filter((method) => !dropped.has(key(item.name, method))),
        ...("constructors" in item
          ? {
              constructors: (item as { constructors: string[] }).constructors.filter(
                (constructor) => !dropped.has(key(item.name, constructor)),
              ),
            }
          : {}),
      }));
  return {
    logicalPath: `system-sdk/gir/${namespace}-${version}.gir`,
    namespace: { name: namespace, version },
    classes: keep(declared.classes),
    interfaces: keep(declared.interfaces),
    records: keep(declared.records),
    enumerations: declared.enumerations.filter((item) => !droppedOwners.has(item.name)),
  };
}

let projected = 0;
for (let round = 1; round <= 40; round++) {
  let refused = 0;
  try {
    const snapshot = ingestGir(source, selection());
    const adapter = generateGObjectAdapterSource(
      snapshot,
      importedNamespaces().map(({ snapshot: imported }) => imported),
    );
    const imports = importedNamespaces();
    const importedSnapshots = imports.map(({ snapshot: imported }) => imported);
    const generated = generateGObjectScabiPackage({
      ...baseOptions,
      snapshot,
      importedNamespaces: imports,
      gobjectAdapter: adapter,
      evidence: evidence(
        generateGirClangAbiProbe(snapshot, adapter, importedSnapshots),
      ),
    });
    projected = Object.values(generated.manifest.bindings).filter(
      (binding) => binding.kind !== "constant",
    ).length;
    console.log(`converged after ${round} round(s)`);
    break;
  } catch (error) {
    const current = selection();
    /* `gtk_recent_manager_purge_items` is the namespace, the owner and the
     * member in snake case; reversing it is a lookup rather than a parse,
     * because an owner name can itself contain the separator. */
    const bindingOwners = new Map<string, { owner: string; member: string }>();
    const snake = (value: string): string =>
      value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
    for (const group of [current.classes, current.interfaces, current.records]) {
      for (const owner of group as { name: string; methods: string[]; constructors?: string[] }[]) {
        for (const member of [...owner.methods, ...(owner.constructors ?? [])]) {
          bindingOwners.set(
            `${snake(namespace)}_${snake(owner.name)}_${member}`,
            { owner: owner.name, member },
          );
        }
      }
    }
    for (const diagnostic of diagnosticsOf(error)) {
      /* Ingestion reports positions in the SELECTION it was handed, by index;
       * generation reports them by name. Both name one member, so both are
       * resolved to one before anything is dropped. */
      const indexed =
        /^(classes|interfaces|records|enumerations)\/(\d+)\/(methods|constructors|members)\/(\d+)/u
          .exec(diagnostic.path);
      if (indexed !== null) {
        const [, group, ownerIndex, kind, memberIndex] = indexed;
        const owner = (current as Record<string, { name: string }[]>)[group!]?.[
          Number(ownerIndex)
        ];
        if (owner === undefined) continue;
        if (kind === "members") {
          /* An enumeration is selected member by member and its members are
           * not independently useful, so a refused member takes the
           * enumeration with it. */
          if (!droppedOwners.has(owner.name)) {
            droppedOwners.add(owner.name);
            refusals.push({
              owner: owner.name,
              member: "(whole enumeration)",
              reason: diagnostic.message,
            });
            refused++;
          }
          continue;
        }
        const member = (owner as unknown as Record<string, string[]>)[kind!]?.[
          Number(memberIndex)
        ];
        if (member === undefined || dropped.has(key(owner.name, member))) continue;
        dropped.add(key(owner.name, member));
        refusals.push({ owner: owner.name, member, reason: diagnostic.message });
        refused++;
        continue;
      }
      /* A manifest-validation refusal names a BINDING, which is the one path
       * dialect that does not carry the declaration it came from. The id is
       * derived from the namespace, owner and member, so it is derived back
       * the same way rather than guessed at. */
      const bound = /^\/bindings\/([a-z0-9_]+)/u.exec(diagnostic.path);
      if (bound !== null) {
        const found2 = bindingOwners.get(bound[1]!);
        if (found2 !== undefined && !dropped.has(key(found2.owner, found2.member))) {
          dropped.add(key(found2.owner, found2.member));
          refusals.push({ ...found2, reason: diagnostic.message });
          refused++;
        }
        continue;
      }
      /* A property refusal names the property, and a property is not a
       * selectable member: it is the getter and setter, which are. Dropping
       * the pair is what removes it. */
      const property = /(?:^|\/)([A-Z][A-Za-z0-9_]*)\/property\/([^/]+)/u.exec(diagnostic.path);
      if (property !== null) {
        const owner = property[1]!;
        const stem = property[2]!.replaceAll("-", "_");
        let removed = false;
        for (const accessor of [`get_${stem}`, `set_${stem}`, `is_${stem}`]) {
          if (dropped.has(key(owner, accessor))) continue;
          dropped.add(key(owner, accessor));
          removed = true;
        }
        if (removed) {
          refusals.push({ owner, member: `${stem} (accessor pair)`, reason: diagnostic.message });
          refused++;
        }
        continue;
      }
      const found = locate(diagnostic.path);
      if (found === null) {
        /* A refusal that names no member is about the declaration itself —
         * an unresolvable parent, a record with no copy and free — so the
         * owner goes. Its name is the segment after the declaration kind,
         * which is what distinguishes it from the namespace's own name
         * sitting earlier in the same path. */
        const owner =
          /(?:^|\/)(?:class|interface|record|enumeration|bitfield)\/([A-Za-z0-9_]+)/u.exec(
            diagnostic.path,
          )?.[1] ??
          /(?:^|\/)([A-Z][A-Za-z0-9_]*)\//u.exec(diagnostic.path)?.[1];
        if (owner !== undefined && !droppedOwners.has(owner)) {
          droppedOwners.add(owner);
          refusals.push({ owner, member: "(whole declaration)", reason: diagnostic.message });
          refused++;
        }
        continue;
      }
      if (dropped.has(key(found.owner, found.member))) continue;
      dropped.add(key(found.owner, found.member));
      refusals.push({ ...found, reason: diagnostic.message });
      refused++;
    }
    if (refused === 0) {
      console.error("stalled: refusals repeat without shrinking the selection");
      console.error(diagnosticsOf(error).slice(0, 3));
      process.exit(1);
    }
  }
}

const byReason = new Map<string, number>();
for (const refusal of refusals) {
  byReason.set(refusal.reason, (byReason.get(refusal.reason) ?? 0) + 1);
}
console.log(`\nprojected bindings: ${projected}`);
console.log(`refused members:    ${refusals.length}\n`);
console.log(
  "what the refusals are waiting on, largest first",
  "(qualified type names mean an unsupplied import, not a missing algebra):",
);
for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(count).padStart(4)}  ${reason}`);
}

/* A bucket is a number until you can see what is in it. The second argument
 * lists the members behind whichever reasons it matches, which is what turns
 * a count into a slice somebody can scope. */
const filter = process.argv[3];
if (filter !== undefined) {
  const matched = refusals.filter((refusal) =>
    refusal.reason.toLowerCase().includes(filter.toLowerCase())
  );
  console.log(`\n${matched.length} member(s) matching ${JSON.stringify(filter)}:`);
  for (const refusal of matched.sort((a, b) =>
    `${a.owner}.${a.member}`.localeCompare(`${b.owner}.${b.member}`)
  )) {
    console.log(`  ${refusal.owner}.${refusal.member}`);
  }
}
