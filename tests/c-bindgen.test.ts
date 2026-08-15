import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  CBindgenError,
  generateClangAbiProbe,
  parseCTypeCandidate,
  parseClangAbiEvidence,
  parseClangRecordCallingConventions,
  planClangAbiProbe,
} from "@native-typescript/bindgen-c";
import type {
  CFunctionCandidate,
  ClangAbiType,
  CRecordCandidate,
  CQualifier,
  CTypeCandidate,
} from "@native-typescript/bindgen-c";
import {
  ArtifactExecutionError,
  defineArtifactGraph,
  digestArtifactPath,
  executeArtifactGraph,
} from "@native-typescript/core";
import type {
  ArtifactActionDefinition,
  ArtifactDefinition,
} from "@native-typescript/core";

const fixtureHeaders = join(
  import.meta.dirname,
  "..",
  "fixtures/c-bindgen/include",
);
const target = "x86_64-unknown-linux-gnu";
const executionPlatform = "x86_64-linux";

function executable(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching explicit PATH entries.
    }
  }
  throw new Error(`Required executable is unavailable: ${name}`);
}

function digest(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function clangIdentity(path: string): ArtifactActionDefinition["tool"] {
  const probe = spawnSync(path, ["--version"], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const version = /clang version ([^\s]+)/u.exec(probe.stdout)?.[1];
  assert.ok(version);
  return { id: "tool/clang", version, digest: digest(path) };
}

function named(
  name: string,
  qualifiers: readonly CQualifier[] = [],
): CTypeCandidate {
  return { kind: "named", name, qualifiers };
}

function pointer(
  pointee: CTypeCandidate,
  qualifiers: readonly CQualifier[] = [],
): CTypeCandidate {
  return { kind: "pointer", qualifiers, pointee };
}

function abiValue(type: ClangAbiType) {
  return {
    type,
    alignment: null,
    stackAlignment: null,
    extension: null,
    inRegister: false,
    byValue: null,
    structureReturn: null,
  } as const;
}

function fixtureFunctions(
  mutableGetLabel = false,
): readonly CFunctionCandidate[] {
  const widgetPointer = pointer(named("NTSWidget"));
  const constCharPointer = pointer(named("char", ["const"]));
  return [
    {
      id: "fixture.point.translate",
      symbol: "nts_point_translate",
      result: named("NTSPoint"),
      parameters: [named("NTSPoint"), named("int")],
    },
    {
      id: "fixture.widget.new",
      symbol: "nts_widget_new",
      result: widgetPointer,
      parameters: [constCharPointer],
    },
    {
      id: "fixture.widget.get-label",
      symbol: "nts_widget_get_label",
      result: mutableGetLabel ? pointer(named("char")) : constCharPointer,
      parameters: [widgetPointer],
    },
    {
      id: "fixture.widget.set-label",
      symbol: "nts_widget_set_label",
      result: named("void"),
      parameters: [widgetPointer, constCharPointer],
    },
  ];
}

function fixtureRecords(): readonly CRecordCandidate[] {
  return [{
    id: "fixture.point",
    typeName: "NTSPoint",
    fields: [
      { name: "x", type: named("int") },
      { name: "tag", type: named("NTSByte") },
      { name: "weight", type: named("double") },
    ],
  }];
}

test("C candidates produce a canonical immutable Clang probe", () => {
  const forward = generateClangAbiProbe({
    includes: ["fixture.h"],
    functions: fixtureFunctions(),
    records: fixtureRecords(),
  });
  const reverse = generateClangAbiProbe({
    includes: ["fixture.h"],
    functions: [...fixtureFunctions()].reverse(),
    records: [...fixtureRecords()].reverse(),
  });

  assert.equal(forward.schemaVersion, 1);
  assert.equal(forward.source, reverse.source);
  assert.equal(forward.sourceDigest, reverse.sourceDigest);
  assert.equal(forward.contractDigest, reverse.contractDigest);
  assert.match(forward.sourceDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(
    forward.source,
    /typedef const char \* \(\*nts_abi_expected_0001\)\(NTSWidget \*\);/u,
  );
  assert.match(forward.source, /record_0000_field_0002_offset/u);
  assert.match(forward.source, /__builtin_types_compatible_p/u);
  assert.match(forward.source, /struct nts_abi_probe_snapshot_[0-9a-f]{16}/u);
  assert.equal(Object.isFrozen(forward), true);
  assert.equal(Object.isFrozen(forward.functions), true);
  assert.equal(Object.isFrozen(forward.functions[0]?.result), true);
});

test("C candidate validation rejects unsafe source spellings and duplicates", () => {
  assert.throws(
    () => generateClangAbiProbe({
      includes: ["../fixture.h", "../fixture.h"],
      functions: [
        ...fixtureFunctions(),
        {
          ...fixtureFunctions()[0]!,
          symbol: "not-a-c-symbol",
        },
      ],
      records: [
        ...fixtureRecords(),
        { ...fixtureRecords()[0]!, id: fixtureFunctions()[0]!.id },
      ],
    }),
    (error) => {
      assert.ok(error instanceof CBindgenError);
      assert.equal(error.diagnostics.every(({ code }) => code.startsWith("NTS5")), true);
      assert.equal(Object.isFrozen(error.diagnostics), true);
      return true;
    },
  );
});

test("the candidate type parser is narrow, structured, and non-authoritative", () => {
  assert.deepEqual(parseCTypeCandidate("const char **"), {
    kind: "pointer",
    qualifiers: [],
    pointee: {
      kind: "pointer",
      qualifiers: [],
      pointee: {
        kind: "named",
        name: "char",
        qualifiers: ["const"],
      },
    },
  });
  assert.throws(() => parseCTypeCandidate("unsigned int"), CBindgenError);
  assert.throws(() => parseCTypeCandidate("char (*)(int)"), CBindgenError);
});

test("Clang verifies selected function and record ABI and emits structured evidence", async () => {
  const clangPath = executable("clang");
  const sandboxPath = executable("bwrap");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "native-typescript-bindgen-c-"));
  try {
    const probe = generateClangAbiProbe({
      includes: ["fixture.h"],
      functions: fixtureFunctions(),
      records: fixtureRecords(),
    });
    const sourcePath = join(temporaryRoot, "probe.c");
    writeFileSync(sourcePath, probe.source);
    const headerDigest = (await digestArtifactPath(fixtureHeaders, "directory")).digest;
    const headerArtifact: ArtifactDefinition = {
      id: "sdk/fixture-headers",
      kind: "sdk",
      entryType: "directory",
      mediaType: "inode/directory",
      target,
      domain: "target",
      cache: "none",
      origin: {
        kind: "source",
        digest: headerDigest,
        fileName: "fixture-headers",
        logicalPath: "fixtures/c-bindgen/include",
      },
    };
    const tool = clangIdentity(clangPath);
    const plan = planClangAbiProbe({
      probe,
      sourceArtifactId: "source/c-bindgen/probe",
      rawAstArtifactId: "metadata/c-bindgen/raw-ast",
      rawLlvmArtifactId: "metadata/c-bindgen/raw-llvm",
      astActionId: "inspect/c-bindgen/ast",
      llvmActionId: "inspect/c-bindgen/calling-convention",
      logicalPath: "generated/c-bindgen/fixture-probe.c",
      arguments: [
        { kind: "literal", value: "-I" },
        { kind: "input-path", artifact: headerArtifact.id },
      ],
      tool,
      executionPlatform,
      target,
    });
    assert.deepEqual(plan.astAction.arguments[0], {
      kind: "literal",
      value: `--target=${target}`,
    });
    assert.deepEqual(plan.llvmAction.arguments[0], {
      kind: "literal",
      value: `--target=${target}`,
    });
    assert.equal(plan.rawLlvm.mediaType, "text/x-llvm");
    assert.equal(Object.isFrozen(plan), true);
    const graph = defineArtifactGraph({
      artifacts: [plan.source, headerArtifact, plan.rawAst, plan.rawLlvm],
      actions: [plan.astAction, plan.llvmAction],
    });
    const report = await executeArtifactGraph(graph, {
      buildRoot: join(temporaryRoot, "build"),
      sourcePaths: {
        [plan.source.id]: sourcePath,
        [headerArtifact.id]: fixtureHeaders,
      },
      tools: { [tool.id]: { path: clangPath } },
      sandbox: { kind: "bubblewrap", path: sandboxPath },
    });
    const ast = report.artifacts.find(({ id }) => id === plan.rawAst.id);
    const llvm = report.artifacts.find(({ id }) => id === plan.rawLlvm.id);
    assert.ok(ast);
    assert.ok(llvm);
    const evidence = parseClangAbiEvidence(
      readFileSync(ast.path, "utf8"),
      readFileSync(llvm.path, "utf8"),
      {
      probe,
      clang: {
        toolId: tool.id,
        version: tool.version,
        digest: tool.digest,
        target,
      },
      },
    );
    assert.deepEqual(evidence.functions.map(({ symbol }) => symbol), [
      "nts_point_translate",
      "nts_widget_get_label",
      "nts_widget_new",
      "nts_widget_set_label",
    ]);
    assert.equal(
      evidence.functions.every(({ clangType }) => clangType.includes("(*)")),
      true,
    );
    assert.deepEqual(evidence.records, [{
      id: "fixture.point",
      typeName: "NTSPoint",
      size: 16,
      alignment: 8,
      fields: [
        {
          name: "x",
          expectedType: "int",
          clangType: "int",
          offset: 0,
          size: 4,
          alignment: 4,
        },
        {
          name: "tag",
          expectedType: "NTSByte",
          clangType: "unsigned char",
          offset: 4,
          size: 1,
          alignment: 1,
        },
        {
          name: "weight",
          expectedType: "double",
          clangType: "double",
          offset: 8,
          size: 8,
          alignment: 8,
        },
      ],
      callingConvention: {
        result: abiValue({
          kind: "struct",
          packed: false,
          fields: [
            { kind: "integer", bits: 64 },
            { kind: "float", format: "double" },
          ],
        }),
        parameters: [
          abiValue({ kind: "integer", bits: 64 }),
          abiValue({ kind: "float", format: "double" }),
        ],
      },
    }]);
    assert.match(evidence.semanticDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(Object.isFrozen(evidence), true);
    assert.equal(Object.isFrozen(evidence.functions[0]), true);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Clang rejects a candidate that disagrees with the header", async () => {
  const clangPath = executable("clang");
  const sandboxPath = executable("bwrap");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "native-typescript-bindgen-mismatch-"));
  try {
    const probe = generateClangAbiProbe({
      includes: ["fixture.h"],
      functions: fixtureFunctions(true),
      records: fixtureRecords(),
    });
    const sourcePath = join(temporaryRoot, "probe.c");
    writeFileSync(sourcePath, probe.source);
    const headerArtifact: ArtifactDefinition = {
      id: "sdk/fixture-headers",
      kind: "sdk",
      entryType: "directory",
      mediaType: "inode/directory",
      target,
      domain: "target",
      cache: "none",
      origin: {
        kind: "source",
        digest: (await digestArtifactPath(fixtureHeaders, "directory")).digest,
        fileName: "fixture-headers",
        logicalPath: "fixtures/c-bindgen/include",
      },
    };
    const tool = clangIdentity(clangPath);
    const plan = planClangAbiProbe({
      probe,
      sourceArtifactId: "source/c-bindgen/probe",
      rawAstArtifactId: "metadata/c-bindgen/raw-ast",
      rawLlvmArtifactId: "metadata/c-bindgen/raw-llvm",
      astActionId: "inspect/c-bindgen/ast",
      llvmActionId: "inspect/c-bindgen/calling-convention",
      logicalPath: "generated/c-bindgen/mismatch-probe.c",
      arguments: [
        { kind: "literal", value: "-I" },
        { kind: "input-path", artifact: headerArtifact.id },
      ],
      tool,
      executionPlatform,
      target,
    });
    const graph = defineArtifactGraph({
      artifacts: [plan.source, headerArtifact, plan.rawAst, plan.rawLlvm],
      actions: [plan.astAction, plan.llvmAction],
    });
    await assert.rejects(
      executeArtifactGraph(graph, {
        buildRoot: join(temporaryRoot, "build"),
        sourcePaths: {
          [plan.source.id]: sourcePath,
          [headerArtifact.id]: fixtureHeaders,
        },
        tools: { [tool.id]: { path: clangPath } },
        sandbox: { kind: "bubblewrap", path: sandboxPath },
      }),
      (error) =>
        error instanceof ArtifactExecutionError &&
        /NTS5004 C ABI mismatch for fixture\.widget\.get-label/u.test(error.stderr),
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Clang rejects a selected record field that disagrees with the header", () => {
  const clangPath = executable("clang");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "native-typescript-bindgen-record-mismatch-"));
  try {
    const point = fixtureRecords()[0]!;
    const probe = generateClangAbiProbe({
      includes: ["fixture.h"],
      functions: fixtureFunctions(),
      records: [{
        ...point,
        fields: point.fields.map((field) =>
          field.name === "tag" ? { ...field, type: named("int") } : field
        ),
      }],
    });
    const sourcePath = join(temporaryRoot, "probe.c");
    writeFileSync(sourcePath, probe.source);
    const result = spawnSync(
      clangPath,
      ["-std=gnu11", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-I", fixtureHeaders, sourcePath],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NTS5004 C record field mismatch for fixture\.point\.tag/u);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Clang calling evidence preserves direct, expanded, and indirect target ABI forms", () => {
  const clangPath = executable("clang");
  const probe = generateClangAbiProbe({
    includes: ["fixture.h"],
    functions: [],
    records: [{
      id: "fixture.pair",
      typeName: "NTSPair",
      fields: [
        { name: "x", type: named("double") },
        { name: "y", type: named("double") },
      ],
    }, {
      id: "fixture.large",
      typeName: "NTSLarge",
      fields: [
        { name: "x", type: named("NTSI64") },
        { name: "y", type: named("NTSI64") },
        { name: "z", type: named("NTSI64") },
      ],
    }],
  });
  const classify = (targetTriple: string) => {
    const result = spawnSync(
      clangPath,
      [
        `--target=${targetTriple}`,
        "-std=gnu11",
        "-O0",
        "-S",
        "-emit-llvm",
        "-I",
        fixtureHeaders,
        "-x",
        "c",
        "-o",
        "-",
        "-",
      ],
      { input: probe.source, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return parseClangRecordCallingConventions(result.stdout, probe);
  };

  const sysvClassifications = classify("x86_64-unknown-linux-gnu");
  const sysv = sysvClassifications[1]!;
  assert.deepEqual(sysv.result.type, {
    kind: "struct",
    packed: false,
    fields: [
      { kind: "float", format: "double" },
      { kind: "float", format: "double" },
    ],
  });
  assert.deepEqual(sysv.parameters.map(({ type }) => type), [
    { kind: "float", format: "double" },
    { kind: "float", format: "double" },
  ]);
  const sysvLarge = sysvClassifications[0]!;
  assert.deepEqual(sysvLarge.result.type, { kind: "void" });
  assert.deepEqual(sysvLarge.parameters[0]?.structureReturn, {
    kind: "named",
    name: "%struct.NTSLarge",
  });
  assert.deepEqual(sysvLarge.parameters[1]?.byValue, {
    kind: "named",
    name: "%struct.NTSLarge",
  });
  assert.equal(sysvLarge.parameters[1]?.alignment, 8);

  const aarch64 = classify("aarch64-unknown-linux-gnu")[1]!;
  assert.deepEqual(aarch64.result.type, { kind: "named", name: "%struct.NTSPair" });
  assert.deepEqual(aarch64.parameters[0]?.type, {
    kind: "array",
    count: 2,
    element: { kind: "float", format: "double" },
  });
  assert.equal(aarch64.parameters[0]?.stackAlignment, 8);

  const windows = classify("x86_64-w64-windows-gnu")[1]!;
  assert.deepEqual(windows.result.type, { kind: "void" });
  assert.deepEqual(windows.parameters[0]?.structureReturn, {
    kind: "named",
    name: "%struct.NTSPair",
  });
  assert.deepEqual(windows.parameters[1]?.type, { kind: "pointer", addressSpace: 0 });
  assert.throws(
    () => parseClangRecordCallingConventions("target triple = \"invalid\"", probe),
    CBindgenError,
  );
});
