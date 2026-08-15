import {
  CBindgenError,
  generateClangFunctionProbe,
  parseCTypeCandidate,
} from "@native-typescript/bindgen-c";
import type {
  CBindgenDiagnostic,
  CFunctionCandidate,
  ClangFunctionProbe,
  CTypeCandidate,
} from "@native-typescript/bindgen-c";
import type {
  GirCallable,
  GirSnapshot,
  GirTypeReference,
} from "./gir-model.ts";

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

export function generateGirClangFunctionProbe(
  snapshot: GirSnapshot,
): ClangFunctionProbe {
  const diagnostics: CBindgenDiagnostic[] = [];
  const functions: CFunctionCandidate[] = [];
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
  if (diagnostics.length > 0) throw new CBindgenError(diagnostics);
  return generateClangFunctionProbe({
    includes: snapshot.cIncludes,
    functions,
  });
}
