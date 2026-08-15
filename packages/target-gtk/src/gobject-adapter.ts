import { createHash } from "node:crypto";
import {
  CBindgenError,
  parseCTypeCandidate,
  renderCType,
} from "@native-typescript/bindgen-c";
import type {
  CBindgenDiagnostic,
  CTypeCandidate,
} from "@native-typescript/bindgen-c";
import { planCObjectCompilation } from "@native-typescript/core";
import type {
  ArtifactActionDefinition,
  ArtifactActionInputArgument,
  ArtifactDefinition,
} from "@native-typescript/core";
import type {
  GirCallable,
  GirClass,
  GirSnapshot,
  GirTransferOwnership,
} from "./gir-model.ts";

export interface GObjectConstructorAdapter {
  readonly id: string;
  readonly className: string;
  readonly nativeType: string;
  readonly sourceSymbol: string;
  readonly adapterSymbol: string;
  readonly releaseSymbol: string;
  readonly sourceTransfer: "none" | "full";
  readonly acquisition: "ref-sink" | "sink-if-floating";
  readonly nullable: boolean;
}

export interface GObjectAdapterSource {
  readonly schema: "native-typescript.gobject-adapter-source";
  readonly schemaVersion: 1;
  readonly source: string;
  readonly sourceDigest: string;
  readonly constructors: readonly GObjectConstructorAdapter[];
}

export interface GObjectAdapterObjectPlan {
  readonly source: ArtifactDefinition;
  readonly object: ArtifactDefinition;
  readonly action: ArtifactActionDefinition;
}

function physicalType(
  cType: string | null,
  path: string,
  diagnostics: CBindgenDiagnostic[],
): CTypeCandidate | null {
  if (cType === null) {
    diagnostics.push({
      code: "NTS5001",
      severity: "error",
      path,
      message: "GObject adapter type has no C spelling",
    });
    return null;
  }
  try {
    return parseCTypeCandidate(cType, path);
  } catch (error) {
    if (!(error instanceof CBindgenError)) throw error;
    diagnostics.push(...error.diagnostics);
    return null;
  }
}

function sourceTransfer(
  transfer: GirTransferOwnership,
  path: string,
  diagnostics: CBindgenDiagnostic[],
): "none" | "full" | null {
  if (transfer === "none" || transfer === "full") return transfer;
  diagnostics.push({
    code: "NTS5001",
    severity: "error",
    path,
    message: "GObject constructors cannot transfer container-only ownership",
  });
  return null;
}

function generateConstructor(
  class_: GirClass,
  callable: GirCallable,
  diagnostics: CBindgenDiagnostic[],
): {
  readonly adapter: GObjectConstructorAdapter;
  readonly lines: readonly string[];
} | null {
  const path = `${class_.name}/constructor/${callable.name}`;
  const nativeClass = physicalType(class_.cType, `${path}/class`, diagnostics);
  const sourceResult = physicalType(
    callable.result.type.cType,
    `${path}/result`,
    diagnostics,
  );
  const parameters = callable.parameters.map((parameter, index) =>
    physicalType(parameter.type.cType, `${path}/parameters/${index}`, diagnostics)
  );
  const validParameters = parameters.filter(
    (parameter): parameter is CTypeCandidate => parameter !== null,
  );
  const transfer = sourceTransfer(
    callable.result.transferOwnership,
    `${path}/result/transferOwnership`,
    diagnostics,
  );
  if (
    callable.cIdentifier === null ||
    nativeClass === null ||
    nativeClass.kind !== "named" ||
    sourceResult === null ||
    sourceResult.kind !== "pointer" ||
    validParameters.length !== parameters.length ||
    transfer === null
  ) {
    if (callable.cIdentifier === null) {
      diagnostics.push({
        code: "NTS5001",
        severity: "error",
        path,
        message: "GObject constructor has no C identifier",
      });
    }
    if (nativeClass !== null && nativeClass.kind !== "named") {
      diagnostics.push({
        code: "NTS5001",
        severity: "error",
        path: `${path}/class`,
        message: "GObject class C type must be one named type",
      });
    }
    if (sourceResult !== null && sourceResult.kind !== "pointer") {
      diagnostics.push({
        code: "NTS5001",
        severity: "error",
        path: `${path}/result`,
        message: "GObject constructor result must be a pointer",
      });
    }
    return null;
  }

  const adapterSymbol = `nts_gobject_adopt_${callable.cIdentifier}`;
  const releaseSymbol = `nts_gobject_release_${class_.cSymbolPrefix}`;
  const parameterDeclarations = validParameters.map(
    (parameter, index) => `${renderCType(parameter)} parameter_${index.toString().padStart(4, "0")}`,
  );
  const parameterNames = validParameters.map(
    (_, index) => `parameter_${index.toString().padStart(4, "0")}`,
  );
  const nativeClassPointer = `${renderCType(nativeClass)} *`;
  const lines = [
    `${nativeClassPointer}${adapterSymbol}(${parameterDeclarations.length === 0 ? "void" : parameterDeclarations.join(", ")}) {`,
    `  ${renderCType(sourceResult)} value = ${callable.cIdentifier}(${parameterNames.join(", ")});`,
    "  if (value == NULL) return NULL;",
    ...(transfer === "none"
      ? ["  g_object_ref_sink(value);"]
      : [
          "  if (g_object_is_floating(value)) {",
          "    g_object_ref_sink(value);",
          "  }",
        ]),
    `  return (${nativeClassPointer})value;`,
    "}",
    "",
  ];
  return {
    adapter: Object.freeze({
      id: `${class_.name}.constructor.${callable.name}`,
      className: class_.name,
      nativeType: class_.cType,
      sourceSymbol: callable.cIdentifier,
      adapterSymbol,
      releaseSymbol,
      sourceTransfer: transfer,
      acquisition: transfer === "none" ? "ref-sink" : "sink-if-floating",
      nullable: callable.result.nullable,
    }),
    lines,
  };
}

export function generateGObjectAdapterSource(
  snapshot: GirSnapshot,
): GObjectAdapterSource {
  const diagnostics: CBindgenDiagnostic[] = [];
  const constructors: GObjectConstructorAdapter[] = [];
  const lines = [
    "/* Generated by @native-typescript/target-gtk. */",
    ...snapshot.cIncludes.map((include) => `#include <${include}>`),
    "",
  ];
  for (const class_ of snapshot.classes) {
    const classConstructors: GObjectConstructorAdapter[] = [];
    for (const callable of class_.constructors) {
      const generated = generateConstructor(class_, callable, diagnostics);
      if (generated === null) continue;
      classConstructors.push(generated.adapter);
      constructors.push(generated.adapter);
      lines.push(...generated.lines);
    }
    if (classConstructors.length > 0) {
      const first = classConstructors[0]!;
      lines.push(
        `void ${first.releaseSymbol}(${first.nativeType} *value) {`,
        "  if (value != NULL) g_object_unref(value);",
        "}",
        "",
      );
    }
  }
  if (constructors.length === 0) {
    diagnostics.push({
      code: "NTS5001",
      severity: "error",
      path: "constructors",
      message: "GObject adapter generation requires a selected constructor",
    });
  }
  if (diagnostics.length > 0) throw new CBindgenError(diagnostics);

  const source = lines.join("\n");
  return Object.freeze({
    schema: "native-typescript.gobject-adapter-source",
    schemaVersion: 1,
    source,
    sourceDigest: `sha256:${createHash("sha256").update(source).digest("hex")}`,
    constructors: Object.freeze(constructors),
  });
}

export function planGObjectAdapterObject(input: {
  readonly adapter: GObjectAdapterSource;
  readonly sourceArtifactId: string;
  readonly objectArtifactId: string;
  readonly actionId: string;
  readonly logicalPath: string;
  readonly artifactFileName: string;
  readonly arguments: readonly ArtifactActionInputArgument[];
  readonly tool: ArtifactActionDefinition["tool"];
  readonly executionPlatform: string;
  readonly target: string;
}): GObjectAdapterObjectPlan {
  const source: ArtifactDefinition = Object.freeze({
    id: input.sourceArtifactId,
    kind: "generated-source",
    entryType: "file",
    mediaType: "text/x-c",
    target: input.target,
    domain: "target",
    cache: "exportable",
    origin: Object.freeze({
      kind: "source",
      digest: input.adapter.sourceDigest,
      fileName: "gobject-adapters.c",
      logicalPath: input.logicalPath,
    }),
  });
  const compilation = planCObjectCompilation({
    actionId: input.actionId,
    artifactId: input.objectArtifactId,
    artifactFileName: input.artifactFileName,
    source: { artifact: input.sourceArtifactId },
    arguments: [
      { kind: "literal", value: "-std=gnu11" },
      { kind: "literal", value: "-Wall" },
      { kind: "literal", value: "-Wextra" },
      { kind: "literal", value: "-Werror" },
      ...input.arguments,
    ],
    tool: input.tool,
    executionPlatform: input.executionPlatform,
    target: input.target,
    deterministic: false,
    cacheable: false,
  });
  return Object.freeze({
    source,
    object: compilation.artifact,
    action: compilation.action,
  });
}
