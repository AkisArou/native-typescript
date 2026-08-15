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
  GirSnapshot,
  GirTypeReference,
} from "./gir-model.ts";
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
  return {
    id: `${namespace}.${className}.${callable.kind}.${callable.name}`,
    symbol: callable.cIdentifier,
    result,
    parameters: validParameters,
  };
}

export function generateGirClangAbiProbe(
  snapshot: GirSnapshot,
  adapter: GObjectAdapterSource,
): ClangAbiProbe {
  const diagnostics: CBindgenDiagnostic[] = [];
  const functions: CFunctionCandidate[] = [];
  const records: CRecordCandidate[] = [];
  const enums: CEnumCandidate[] = snapshot.enumerations.map((enum_) => ({
    id: `${snapshot.namespace.name}.${enum_.name}.${enum_.kind}`,
    typeName: enum_.cType,
    members: enum_.members.map((member) => ({
      name: member.name,
      cIdentifier: member.cIdentifier,
      value: member.value,
    })),
  }));
  for (const class_ of snapshot.classes) {
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
  for (const record of snapshot.records) {
    const fields = record.fields.map((field, index) => ({
      name: field.name,
      type: physicalType(
        field.type,
        `${snapshot.namespace.name}/${record.name}/field/${index}`,
        diagnostics,
      ),
    }));
    if (fields.every((field) => field.type !== null)) {
      records.push({
        id: `${snapshot.namespace.name}.${record.name}.record`,
        typeName: record.cType,
        definition: "external",
        fields: fields.map((field) => ({
          name: field.name,
          type: field.type!,
        })),
      });
    }
  }
  for (const method of adapter.valueMethods) {
    const fields = method.outputs.map((output, index) => ({
      name: output.fieldName,
      type: physicalType(
        {
          kind: "named",
          name: output.recordName,
          cType: output.nativeType,
          arguments: [],
        },
        `${snapshot.namespace.name}/${method.className}/method/${method.sourceSymbol}/result/${index}`,
        diagnostics,
      ),
    }));
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
