/**
 * The description a GTK application build reads instead of being wired by
 * hand.
 *
 * A project says which namespaces it wants and which members of them, because
 * that selection is the application's decision: generation is closed over
 * exactly what is asked for, so an unlisted class is not merely unused but
 * absent. Everything else — probe arguments, artifact identities, link order —
 * is derived, and is not the project's to state.
 *
 * Parsing is strict and total. A project that a build would reject halfway
 * through is rejected before any work starts, with the path of the offending
 * field, because the alternative is a Clang diagnostic about a header nobody
 * asked for.
 */

export interface GtkProjectNamespaceMember {
  readonly name: string;
  readonly constructors?: readonly string[];
  readonly methods?: readonly string[];
  readonly signals?: readonly string[];
  /** GObject property names to observe, spelled as GIR spells them
   * (`reveal-child`). Each becomes one `notify::` registration. */
  readonly notify?: readonly string[];
}

export interface GtkProjectNamespace {
  readonly name: string;
  readonly version: string;
  /** pkg-config modules whose headers the ABI probe includes. */
  readonly sdkModules: readonly string[];
  /** Namespaces this one references. Each must be listed before it. */
  readonly imports: readonly { readonly name: string; readonly version: string }[];
  readonly classes: readonly GtkProjectNamespaceMember[];
  readonly records: readonly { readonly name: string; readonly fields: readonly string[] }[];
  readonly enumerations: readonly {
    readonly name: string;
    readonly members: readonly string[];
  }[];
}

export interface GtkApplicationProject {
  readonly name: string;
  /** Entry point, relative to the project root. */
  readonly entry: string;
  /** Executable file name. */
  readonly output: string;
  readonly girDirectory: string;
  /** pkg-config modules the application links against. */
  readonly sdkModules: readonly string[];
  readonly target: {
    readonly triple: string;
    readonly executionPlatform: string;
  };
  readonly namespaces: readonly GtkProjectNamespace[];
}

const projectSchema = "native-typescript.project";
const projectSchemaVersion = 1;

class ProjectError extends Error {}

function fail(path: string, message: string): never {
  throw new ProjectError(`${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, "must be a non-empty string");
  }
  return value;
}

function textList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) fail(path, "must be an array of strings");
  return Object.freeze(
    value.map((entry, index) => text(entry, `${path}/${index}`)),
  );
}

function optionalTextList(
  source: Record<string, unknown>,
  key: string,
  path: string,
): readonly string[] | undefined {
  return source[key] === undefined
    ? undefined
    : textList(source[key], `${path}/${key}`);
}

function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}

function reject(source: Record<string, unknown>, known: readonly string[], path: string): void {
  for (const key of Object.keys(source)) {
    if (!known.includes(key)) fail(`${path}/${key}`, "is not a known field");
  }
}

function parseNamespace(value: unknown, path: string): GtkProjectNamespace {
  const source = record(value, path);
  reject(
    source,
    ["name", "version", "sdkModules", "imports", "classes", "records", "enumerations"],
    path,
  );
  const imports = (source["imports"] === undefined
    ? []
    : list(source["imports"], `${path}/imports`)
  ).map((entry, index) => {
    const imported = record(entry, `${path}/imports/${index}`);
    reject(imported, ["name", "version"], `${path}/imports/${index}`);
    return Object.freeze({
      name: text(imported["name"], `${path}/imports/${index}/name`),
      version: text(imported["version"], `${path}/imports/${index}/version`),
    });
  });
  const classes = (source["classes"] === undefined
    ? []
    : list(source["classes"], `${path}/classes`)
  ).map((entry, index) => {
    const classPath = `${path}/classes/${index}`;
    const class_ = record(entry, classPath);
    reject(class_, ["name", "constructors", "methods", "signals", "notify"], classPath);
    const constructors = optionalTextList(class_, "constructors", classPath);
    const methods = optionalTextList(class_, "methods", classPath);
    const signals = optionalTextList(class_, "signals", classPath);
    const notify = optionalTextList(class_, "notify", classPath);
    return Object.freeze({
      name: text(class_["name"], `${classPath}/name`),
      ...(constructors === undefined ? {} : { constructors }),
      ...(methods === undefined ? {} : { methods }),
      ...(signals === undefined ? {} : { signals }),
      ...(notify === undefined ? {} : { notify }),
    });
  });
  const records = (source["records"] === undefined
    ? []
    : list(source["records"], `${path}/records`)
  ).map((entry, index) => {
    const recordPath = `${path}/records/${index}`;
    const value_ = record(entry, recordPath);
    reject(value_, ["name", "fields"], recordPath);
    return Object.freeze({
      name: text(value_["name"], `${recordPath}/name`),
      fields: textList(value_["fields"], `${recordPath}/fields`),
    });
  });
  const enumerations = (source["enumerations"] === undefined
    ? []
    : list(source["enumerations"], `${path}/enumerations`)
  ).map((entry, index) => {
    const enumPath = `${path}/enumerations/${index}`;
    const value_ = record(entry, enumPath);
    reject(value_, ["name", "members"], enumPath);
    return Object.freeze({
      name: text(value_["name"], `${enumPath}/name`),
      members: textList(value_["members"], `${enumPath}/members`),
    });
  });
  return Object.freeze({
    name: text(source["name"], `${path}/name`),
    version: text(source["version"], `${path}/version`),
    sdkModules: textList(source["sdkModules"], `${path}/sdkModules`),
    imports: Object.freeze(imports),
    classes: Object.freeze(classes),
    records: Object.freeze(records),
    enumerations: Object.freeze(enumerations),
  });
}

export function parseGtkApplicationProject(source: string): GtkApplicationProject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new ProjectError(`/: is not valid JSON: ${(cause as Error).message}`);
  }
  const value = record(parsed, "/");
  reject(
    value,
    [
      "schema",
      "schemaVersion",
      "name",
      "target",
      "entry",
      "output",
      "girDirectory",
      "sdkModules",
      "namespaces",
    ],
    "",
  );
  if (value["schema"] !== projectSchema) {
    fail("/schema", `must be '${projectSchema}'`);
  }
  if (value["schemaVersion"] !== projectSchemaVersion) {
    fail("/schemaVersion", `must be ${projectSchemaVersion}`);
  }
  if (value["target"] !== "gtk4") {
    fail("/target", "must be 'gtk4' — no other target can build a project yet");
  }

  const namespaces = list(value["namespaces"], "/namespaces").map(
    (entry, index) => parseNamespace(entry, `/namespaces/${index}`),
  );
  if (namespaces.length === 0) {
    fail("/namespaces", "must select at least one namespace");
  }
  /* Imports resolve by position, so a forward reference is a project error
   * rather than something for the generator to discover. */
  const seen = new Set<string>();
  for (const [index, namespace] of namespaces.entries()) {
    for (const imported of namespace.imports) {
      const key = `${imported.name}-${imported.version}`;
      if (!seen.has(key)) {
        fail(
          `/namespaces/${index}/imports`,
          `imports ${key}, which is not selected before it`,
        );
      }
    }
    seen.add(`${namespace.name}-${namespace.version}`);
  }

  const name = text(value["name"], "/name");
  return Object.freeze({
    name,
    entry: text(value["entry"], "/entry"),
    output: value["output"] === undefined ? name : text(value["output"], "/output"),
    girDirectory:
      value["girDirectory"] === undefined
        ? "/usr/share/gir-1.0"
        : text(value["girDirectory"], "/girDirectory"),
    sdkModules:
      value["sdkModules"] === undefined
        ? Object.freeze(["gtk4"])
        : textList(value["sdkModules"], "/sdkModules"),
    target: Object.freeze({
      triple: "x86_64-unknown-linux-gnu",
      executionPlatform: "x86_64-linux",
    }),
    namespaces: Object.freeze(namespaces),
  });
}

export { ProjectError as GtkApplicationProjectError };
