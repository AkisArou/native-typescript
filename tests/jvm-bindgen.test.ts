import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  JvmIngestionError,
  ingestJvmClasses,
  readJarClassSources,
} from "@native-typescript/bindgen-jvm";
import type {
  JvmClass,
  JvmClassSelection,
  JvmClassSource,
  JvmDiagnosticCode,
  JvmSnapshot,
} from "@native-typescript/bindgen-jvm";

const repositoryRoot = resolve(import.meta.dirname, "..");

function fixtureSource(
  name: string,
  expectedDigest: string,
): JvmClassSource {
  const logicalPath = `fixtures/jvm/classes/fixture/${name}.class`;
  return {
    logicalPath,
    bytes: readFileSync(resolve(repositoryRoot, logicalPath)),
    expectedDigest,
  };
}

// The compiled fixture bytes are committed; a digest change means the
// fixtures were deliberately recompiled and these pins must move with them.
const widgetSource = () =>
  fixtureSource(
    "Widget",
    "sha256:453c1f9a1bbe3662b6bbaed5eeee05f4ef18c3c8ced2fb3d57ea90759c48a187",
  );
const buttonSource = () =>
  fixtureSource(
    "Button",
    "sha256:cff173f2640788075704a6f5bd0ae38f70ca8cfbad4b7f7430677c5b53cae2fd",
  );
const clickableSource = () =>
  fixtureSource(
    "Clickable",
    "sha256:fba0b6acf25ea63d173e98f6fc79f1707000855bce03704da1e1f0f1fb17ac10",
  );
const metricsSource = () =>
  fixtureSource(
    "Widget$Metrics",
    "sha256:55ec20c6f25a219ad2528e763b032ea43b56b8e2c5bf27fffbf80dd28dacd59a",
  );
const painterSource = () =>
  fixtureSource(
    "Widget$Painter",
    "sha256:143156be49b5c2a26cf79596e239b06b73534fc7c8840b920ef45afd6eeaf414",
  );

function allSources(): JvmClassSource[] {
  return [
    widgetSource(),
    buttonSource(),
    clickableSource(),
    metricsSource(),
    painterSource(),
  ];
}

const widgetSelection: JvmClassSelection = Object.freeze({
  binaryName: "fixture/Widget",
  constructors: Object.freeze(["()V", "(I)V"]),
  methods: Object.freeze([
    "depth",
    { name: "resize", descriptor: "(II)V" },
    { name: "resize", descriptor: "(D)V" },
    "measure",
    "acquire",
    "legacy",
    "generic",
    "nativeHandle",
  ]),
  fields: Object.freeze(["MAX_DEPTH", "SEED", "SCALE", "RATIO", "NAME", "depth"]),
});
const buttonSelection: JvmClassSelection = Object.freeze({
  binaryName: "fixture/Button",
  constructors: Object.freeze(["(Ljava/lang/String;)V"]),
  methods: Object.freeze(["click", "onClick"]),
});
const clickableSelection: JvmClassSelection = Object.freeze({
  binaryName: "fixture/Clickable",
  methods: Object.freeze(["onClick"]),
});
const metricsSelection: JvmClassSelection = Object.freeze({
  binaryName: "fixture/Widget$Metrics",
  fields: Object.freeze(["width", "height"]),
});

function ingestFixture(
  classes: readonly JvmClassSelection[] = [
    widgetSelection,
    buttonSelection,
    clickableSelection,
    metricsSelection,
  ],
  sources: readonly JvmClassSource[] = allSources(),
): JvmSnapshot {
  return ingestJvmClasses(sources, { classes });
}

function classNamed(snapshot: JvmSnapshot, binaryName: string): JvmClass {
  const found = snapshot.classes.find(
    (class_) => class_.binaryName === binaryName,
  );
  assert.notEqual(found, undefined, `class ${binaryName} in snapshot`);
  return found!;
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const key of Object.keys(value)) {
    assertDeepFrozen((value as Record<string, unknown>)[key], seen);
  }
}

function assertCodes(
  run: () => unknown,
  expected: readonly JvmDiagnosticCode[],
): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof JvmIngestionError);
    assert.deepEqual(
      error.diagnostics.map(({ code }) => code),
      expected,
    );
    return true;
  });
}

test("ingests a bounded selection into a frozen canonical snapshot", () => {
  const snapshot = ingestFixture();
  assertDeepFrozen(snapshot);
  assert.deepEqual(
    snapshot.classes.map(({ binaryName }) => binaryName),
    [
      "fixture/Button",
      "fixture/Clickable",
      "fixture/Widget",
      "fixture/Widget$Metrics",
    ],
  );
  assert.deepEqual(
    snapshot.sources.map(({ logicalPath }) => logicalPath),
    [...snapshot.sources.map(({ logicalPath }) => logicalPath)].sort(),
  );
  for (const source of snapshot.sources) {
    assert.match(source.digest, /^sha256:[0-9a-f]{64}$/u);
  }
  // The same inputs must produce the same snapshot, member for member.
  assert.deepEqual(ingestFixture(), snapshot);
});

test("projects the Widget surface exactly as the class file states it", () => {
  const widget = classNamed(ingestFixture(), "fixture/Widget");
  assert.equal(widget.kind, "class");
  assert.deepEqual(widget.superclass, {
    kind: "external",
    binaryName: "java/lang/Object",
  });
  assert.equal(widget.nested, null);

  assert.deepEqual(
    widget.constructors.map(({ descriptor }) => descriptor),
    ["()V", "(I)V"],
  );
  assert.equal(widget.constructors[0]!.name, "<init>");
  assert.equal(widget.constructors[0]!.result.kind, "void");

  const methodKeys = widget.methods.map(
    ({ name, descriptor }) => `${name}${descriptor}`,
  );
  assert.deepEqual(methodKeys, [
    "acquire()Lfixture/Widget;",
    "depth()I",
    "generic(Ljava/lang/Object;)Ljava/lang/Object;",
    "legacy()V",
    "measure(Ljava/lang/String;Z)[I",
    "nativeHandle()J",
    "resize(D)V",
    "resize(II)V",
  ]);

  const acquire = widget.methods.find(({ name }) => name === "acquire")!;
  assert.equal(acquire.access.static, true);
  assert.deepEqual(acquire.result, {
    kind: "object",
    binaryName: "fixture/Widget",
  });
  assert.deepEqual(acquire.throws, [
    { kind: "external", binaryName: "java/io/IOException" },
  ]);

  const measure = widget.methods.find(({ name }) => name === "measure")!;
  assert.deepEqual(measure.parameters, [
    { kind: "object", binaryName: "java/lang/String" },
    { kind: "primitive", name: "boolean" },
  ]);
  assert.deepEqual(measure.result, {
    kind: "array",
    dimensions: 1,
    element: { kind: "primitive", name: "int" },
  });

  assert.equal(widget.methods.find(({ name }) => name === "legacy")!.deprecated, true);
  const generic = widget.methods.find(({ name }) => name === "generic")!;
  assert.equal(generic.genericSignature, "<T:Ljava/lang/Object;>(TT;)TT;");
  const nativeHandle = widget.methods.find(({ name }) => name === "nativeHandle")!;
  assert.equal(nativeHandle.access.native, true);
  assert.deepEqual(nativeHandle.result, { kind: "primitive", name: "long" });

  const fieldByName = new Map(widget.fields.map((field) => [field.name, field]));
  assert.deepEqual(fieldByName.get("MAX_DEPTH")!.constantValue, {
    kind: "int",
    value: "32",
  });
  assert.deepEqual(fieldByName.get("SEED")!.constantValue, {
    kind: "long",
    value: (0x9e3779b97f4a7c15n - (1n << 64n)).toString(10),
  });
  assert.deepEqual(fieldByName.get("SCALE")!.constantValue, {
    kind: "float",
    bits: "0x3fc00000",
  });
  assert.deepEqual(fieldByName.get("RATIO")!.constantValue, {
    kind: "double",
    bits: "0x3fd0000000000000",
  });
  assert.deepEqual(fieldByName.get("NAME")!.constantValue, {
    kind: "string",
    value: "widget",
  });
  const depth = fieldByName.get("depth")!;
  assert.equal(depth.constantValue, null);
  assert.equal(depth.access.visibility, "protected");
  assert.equal(depth.access.static, false);
});

test("hierarchy references split internal from external at the selection", () => {
  const snapshot = ingestFixture();
  const button = classNamed(snapshot, "fixture/Button");
  assert.deepEqual(button.superclass, {
    kind: "internal",
    binaryName: "fixture/Widget",
  });
  assert.deepEqual(button.interfaces, [
    { kind: "internal", binaryName: "fixture/Clickable" },
  ]);
  const clickable = classNamed(snapshot, "fixture/Clickable");
  assert.equal(clickable.kind, "interface");
  assert.equal(clickable.superclass, null);
  assert.equal(clickable.methods[0]!.access.abstract, true);
  const metrics = classNamed(snapshot, "fixture/Widget$Metrics");
  assert.deepEqual(metrics.nested, {
    outer: "fixture/Widget",
    innerName: "Metrics",
    static: true,
  });
});

test("a pinned digest mismatch is refused", () => {
  const tampered = { ...widgetSource(), expectedDigest: `sha256:${"0".repeat(64)}` };
  assertCodes(
    () => ingestJvmClasses([tampered], { classes: [widgetSelection] }),
    ["NTS6001"],
  );
});

test("malformed class files are refused with a positioned diagnostic", () => {
  const source = widgetSource();
  const truncated: JvmClassSource = {
    logicalPath: source.logicalPath,
    bytes: source.bytes.slice(0, 40),
  };
  assertCodes(
    () => ingestJvmClasses([truncated], { classes: [widgetSelection] }),
    ["NTS6002"],
  );
  const notAClass: JvmClassSource = {
    logicalPath: "fixtures/jvm/classes/fixture/Widget.class",
    bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  };
  assertCodes(
    () => ingestJvmClasses([notAClass], { classes: [widgetSelection] }),
    ["NTS6002"],
  );
});

test("selections that do not exist fail precisely", () => {
  assertCodes(
    () => ingestFixture([{ binaryName: "fixture/Missing" }]),
    ["NTS6003"],
  );
  assertCodes(
    () =>
      ingestFixture([
        { binaryName: "fixture/Widget", methods: ["missingMethod"] },
      ]),
    ["NTS6003"],
  );
  assertCodes(
    () => ingestFixture([{ binaryName: "fixture/Widget", constructors: ["(F)V"] }]),
    ["NTS6003"],
  );
});

test("an overloaded bare-name selection demands a descriptor", () => {
  try {
    ingestFixture([{ binaryName: "fixture/Widget", methods: ["resize"] }]);
    assert.fail("expected JvmIngestionError");
  } catch (error) {
    assert.ok(error instanceof JvmIngestionError);
    assert.equal(error.diagnostics.length, 1);
    assert.equal(error.diagnostics[0]!.code, "NTS6001");
    assert.match(error.diagnostics[0]!.message, /\(D\)V/u);
    assert.match(error.diagnostics[0]!.message, /\(II\)V/u);
  }
});

test("a non-static inner class projects as a handle but defers construction", () => {
  // Methods and fields are ordinary; the snapshot carries the nesting facts.
  const snapshot = ingestFixture([
    widgetSelection,
    { binaryName: "fixture/Widget$Painter" },
  ]);
  assert.deepEqual(classNamed(snapshot, "fixture/Widget$Painter").nested, {
    outer: "fixture/Widget",
    innerName: "Painter",
    static: false,
  });
  // Construction needs the enclosing-instance spelling, which is deferred —
  // and the diagnostic must say "deferred", not "unsupported".
  try {
    ingestFixture([
      widgetSelection,
      {
        binaryName: "fixture/Widget$Painter",
        constructors: ["(Lfixture/Widget;)V"],
      },
    ]);
    assert.fail("expected JvmIngestionError");
  } catch (error) {
    assert.ok(error instanceof JvmIngestionError);
    assert.equal(error.diagnostics[0]!.code, "NTS6004");
    assert.match(error.diagnostics[0]!.message, /deferred, not\s+unsupported/u);
    assert.match(error.diagnostics[0]!.message, /enclosing instance/u);
  }
});

test("an unselected superclass among the sources is a silent-ancestry error", () => {
  assertCodes(
    () => ingestFixture([buttonSelection, clickableSelection]),
    ["NTS6006"],
  );
});

function fixtureJarBytes(): Uint8Array {
  return readFileSync(
    resolve(repositoryRoot, "fixtures/jvm/fixture.jar"),
  );
}

test("a jar yields exactly its class entries, bytes identical to the files", () => {
  const sources = readJarClassSources(fixtureJarBytes(), "fixtures/jvm/fixture.jar");
  assert.deepEqual(
    sources.map(({ logicalPath }) => logicalPath).sort(),
    [
      "fixtures/jvm/fixture.jar!/fixture/Button.class",
      "fixtures/jvm/fixture.jar!/fixture/Clickable.class",
      "fixtures/jvm/fixture.jar!/fixture/Widget$Metrics.class",
      "fixtures/jvm/fixture.jar!/fixture/Widget$Painter.class",
      "fixtures/jvm/fixture.jar!/fixture/Widget.class",
    ],
  );
  const widgetEntry = sources.find(({ logicalPath }) =>
    logicalPath.endsWith("/Widget.class"),
  )!;
  assert.deepEqual(Buffer.from(widgetEntry.bytes), Buffer.from(widgetSource().bytes));
});

test("jar-fed ingestion produces the same classes as file-fed ingestion", () => {
  const fromJar = ingestJvmClasses(
    readJarClassSources(fixtureJarBytes(), "fixtures/jvm/fixture.jar"),
    {
      classes: [
        widgetSelection,
        buttonSelection,
        clickableSelection,
        metricsSelection,
      ],
    },
  );
  assert.deepEqual(fromJar.classes, ingestFixture().classes);
});

test("a jmod-style archive with leading bytes still reads", () => {
  const jar = fixtureJarBytes();
  const jmodish = new Uint8Array(4 + jar.byteLength);
  jmodish.set([0x4a, 0x4d, 0x01, 0x00], 0);
  jmodish.set(jar, 4);
  const sources = readJarClassSources(jmodish, "fixtures/jvm/fixture.jmodish");
  assert.equal(sources.length, 5);
});

test("archives that are not ZIP fail precisely", () => {
  assertCodes(
    () => readJarClassSources(new Uint8Array([1, 2, 3, 4]), "junk"),
    ["NTS6002"],
  );
  assertCodes(
    () => readJarClassSources(fixtureJarBytes().slice(0, 64), "truncated"),
    ["NTS6002"],
  );
});

test("a dotted class selection is refused with the slashed spelling hinted", () => {
  try {
    ingestFixture([{ binaryName: "fixture.Widget" }]);
    assert.fail("expected JvmIngestionError");
  } catch (error) {
    assert.ok(error instanceof JvmIngestionError);
    assert.equal(error.diagnostics[0]!.code, "NTS6001");
    assert.match(error.diagnostics[0]!.message, /slashed binary name/u);
  }
});
