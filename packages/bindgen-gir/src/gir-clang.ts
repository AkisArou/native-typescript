import {
  CBindgenError,
  generateClangAbiProbe,
  parseCTypeCandidate,
} from "@native-typescript/bindgen-c";
import type {
  CBindgenDiagnostic,
  CEnumCandidate,
  CFunctionCandidate,
  CRecordCandidate,
  ClangAbiProbe,
  CTypeCandidate,
} from "@native-typescript/bindgen-c";
import type {
  GirCallable,
  GirRecord,
  GirSnapshot,
  GirTypeReference,
} from "./gir-model.ts";
import { ANSWER_FIELD } from "./gobject-adapter.ts";
import type { GObjectAdapterSource } from "./gobject-adapter.ts";

function physicalType(
  type: GirTypeReference,
  path: string,
  diagnostics: CBindgenDiagnostic[],
): CTypeCandidate | null {
  if (type.cType === null) {
    diagnostics.push({
      code: "NTS5001",
      severity: "error",
      path,
      message: "Selected GIR type has no C spelling for Clang reconciliation",
    });
    return null;
  }
  try {
    return parseCTypeCandidate(type.cType, path);
  } catch (error) {
    if (!(error instanceof CBindgenError)) throw error;
    diagnostics.push(...error.diagnostics);
    return null;
  }
}

/* Every GIR namespace reaches GLib, so the one spelling of a reported error
 * is known wherever a throwing member is. It is parsed once because it is the
 * same slot in every signature that has one. */
const errorOutCandidate: CTypeCandidate = parseCTypeCandidate("GError**", "error");

function functionCandidate(
  namespace: string,
  className: string,
  callable: GirCallable,
  diagnostics: CBindgenDiagnostic[],
): CFunctionCandidate | null {
  const path = `${namespace}/${className}/${callable.kind}/${callable.name}`;
  if (callable.cIdentifier === null) {
    diagnostics.push({
      code: "NTS5001",
      severity: "error",
      path,
      message: "Selected GIR callable has no C identifier",
    });
    return null;
  }
  const result = physicalType(callable.result.type, `${path}/result`, diagnostics);
  const parameters = callable.parameters.map((parameter, index) =>
    physicalType(parameter.type, `${path}/parameters/${index}`, diagnostics)
  );
  const validParameters = parameters.filter(
    (parameter): parameter is CTypeCandidate => parameter !== null,
  );
  if (result === null || validParameters.length !== parameters.length) {
    return null;
  }
  /* GIR omits the trailing `GError **` from a throws=1 callable, so the
   * candidate has to put it back. The header declares that parameter, and a
   * probe that asserted the shorter arity would be proving a signature no
   * function has — Clang would call it an ABI mismatch, correctly. */
  if (callable.throws) validParameters.push(errorOutCandidate);
  return {
    id: `${namespace}.${className}.${callable.kind}.${callable.name}`,
    symbol: callable.cIdentifier,
    result,
    parameters: validParameters,
  };
}

function enumCandidate(
  namespace: string,
  enum_: GirSnapshot["enumerations"][number],
): CEnumCandidate {
  return {
    id: `${namespace}.${enum_.name}.${enum_.kind}`,
    typeName: enum_.cType,
    members: enum_.members.map((member) => ({
      name: member.name,
      cIdentifier: member.cIdentifier,
      value: member.value,
    })),
  };
}

/**
 * Qualified GIR type names this snapshot's selected callables reach, such as
 * `Gio.ApplicationFlags` on `gtk_application_new()`.
 *
 * Only reached names are collected so a package's evidence depends on what it
 * actually uses rather than on everything the imported namespace selected.
 */
export function reachedForeignTypeNames(snapshot: GirSnapshot): ReadonlySet<string> {
  const names = new Set<string>();
  const ownPrefix = `${snapshot.namespace.name}.`;
  function visit(type: GirTypeReference): void {
    if (type.kind === "array") {
      visit(type.element);
      return;
    }
    // A reference qualified with this snapshot's own namespace names something
    // local, so it is not foreign however GIR chose to spell it.
    if (type.name.includes(".") && !type.name.startsWith(ownPrefix)) {
      names.add(type.name);
    }
    for (const argument of type.arguments) visit(argument);
  }
  for (const class_ of [...snapshot.classes, ...snapshot.interfaces]) {
    for (const callable of [
      ...class_.constructors,
      ...class_.methods,
      ...class_.signals,
    ]) {
      visit(callable.result.type);
      for (const parameter of callable.parameters) visit(parameter.type);
    }
  }
  for (const record of snapshot.records) {
    for (const field of record.fields) visit(field.type);
  }
  return names;
}

export function generateGirClangAbiProbe(
  snapshot: GirSnapshot,
  adapter: GObjectAdapterSource,
  importedSnapshots: readonly GirSnapshot[] = [],
): ClangAbiProbe {
  const diagnostics: CBindgenDiagnostic[] = [];
  const functions: CFunctionCandidate[] = [];
  const records: CRecordCandidate[] = [];
  // A package proves the storage of every enum it reaches against its own SDK
  // headers, including one another namespace owns. Independent proof is what
  // catches SDK skew between two packages built from different headers.
  const reachedForeign = reachedForeignTypeNames(snapshot);
  const enums: CEnumCandidate[] = [
    ...snapshot.enumerations.map((enum_) =>
      enumCandidate(snapshot.namespace.name, enum_)
    ),
    ...importedSnapshots.flatMap((imported) =>
      imported.enumerations
        .filter((enum_) =>
          reachedForeign.has(`${imported.namespace.name}.${enum_.name}`)
        )
        .map((enum_) => enumCandidate(imported.namespace.name, enum_))
    ),
  ].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  for (const class_ of [...snapshot.classes, ...snapshot.interfaces]) {
    for (const callable of [...class_.constructors, ...class_.methods]) {
      const candidate = functionCandidate(
        snapshot.namespace.name,
        class_.name,
        callable,
        diagnostics,
      );
      if (candidate !== null) functions.push(candidate);
    }
  }
  /* A package proves the layout of every record it reaches against its own
   * SDK headers, including one another namespace owns — the same rule the
   * enumerations above follow, and for the same reason: independent proof is
   * what catches SDK skew between two packages built from different headers.
   *
   * A layout record is a VALUE. It crosses a package boundary as a plain
   * object, never as a pointer into memory one side allocated, so there is
   * nothing for the two packages to agree about at runtime and no identity to
   * import. What each needs is the size and the field offsets, and each can
   * measure them: `gtk/gtk.h` includes `gdk/gdk.h`, so a Gtk probe can size a
   * GdkRectangle exactly as well as a Gdk one can. */
  function pushRecordCandidate(
    namespaceName: string,
    record: GirRecord,
    selected: boolean,
  ): void {
    /* A record this project SELECTED must project or say why; one merely
     * REACHED through another namespace's type reference need not. If a
     * foreign record's field has no C spelling here, this package simply does
     * not project that record, and the member naming it is refused where the
     * reference is — with a diagnostic that names the member and the type,
     * which a bare field path does not. Sending the field diagnostic up
     * instead would fail the whole generation over a type nobody asked to
     * declare. */
    const fieldDiagnostics = selected ? diagnostics : [];
    const fields = record.fields.map((field, index) => ({
      name: field.name,
      type: physicalType(
        field.type,
        `${namespaceName}/${record.name}/field/${index}`,
        fieldDiagnostics,
      ),
    }));
    if (fields.every((field) => field.type !== null)) {
      records.push({
        id: `${namespaceName}.${record.name}.record`,
        typeName: record.cType,
        definition: "external",
        fields: fields.map((field) => ({
          name: field.name,
          type: field.type!,
        })),
      });
    }
  }
  for (const record of snapshot.records) {
    pushRecordCandidate(snapshot.namespace.name, record, true);
  }
  for (const imported of importedSnapshots) {
    for (const record of imported.records) {
      if (!reachedForeign.has(`${imported.namespace.name}.${record.name}`)) {
        continue;
      }
      pushRecordCandidate(imported.namespace.name, record, false);
    }
  }
  for (const method of adapter.valueMethods) {
    /* A member that also says whether it worked carries the answer in the
     * result's leading field, so the probe has to know the record starts
     * there — otherwise every output's proven offset is one field late. */
    const answerField = method.answers
      ? [{
          name: ANSWER_FIELD,
          type: physicalType(
            { kind: "named" as const, name: "gboolean", cType: "gboolean", arguments: [] },
            `${snapshot.namespace.name}/${method.className}/method/${method.sourceSymbol}/result/answer`,
            diagnostics,
          ),
        }]
      : [];
    const fields = [...answerField, ...method.outputs.map((output, index) => ({
      name: output.fieldName,
      type: physicalType(
        {
          kind: "named",
          name: output.sourceName,
          cType: output.nativeType,
          arguments: [],
        },
        `${snapshot.namespace.name}/${method.className}/method/${method.sourceSymbol}/result/${index}`,
        diagnostics,
      ),
    }))];
    if (fields.every((field) => field.type !== null)) {
      records.push({
        id: `${snapshot.namespace.name}.${method.id}.result`,
        typeName: method.resultNativeType,
        definition: "generated",
        fields: fields.map((field) => ({ name: field.name, type: field.type! })),
      });
    }
  }
  if (diagnostics.length > 0) throw new CBindgenError(diagnostics);
  return generateClangAbiProbe({
    includes: snapshot.cIncludes,
    functions,
    records,
    enums,
  });
}
