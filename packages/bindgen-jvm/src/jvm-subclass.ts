/**
 * Generates JAVA SOURCE: a subclass of a selected base whose chosen
 * overridable methods are declared `@Override public native`. The generated
 * source is compiled by the same javac action every Java half rides, and the
 * native overrides are ordinary callback registration points — virtual
 * dispatch is what turns base-class "framework" code into calls on
 * TypeScript handlers. The Android analogue is the framework constructing a
 * MainActivity: a callback before it is anything else.
 *
 * The algebra is the retained callback contract's, stated here so refusal
 * happens where the subclass is named rather than three stages later:
 * overrides ANSWER with a boolean or TELL with void, and both run during
 * the caller's frame — an override exists to be observed by the framework
 * code that dispatched it, so the queued arm is never an override's
 * delivery, and the generator states `delivery: "synchronous"` on every
 * void override it emits. (The void-synchronous arm arrived with fork
 * 3c33818a, with fixture/Lifecycle as its committed evidence; the handle
 * payload arm with fork 0309d850.) Payloads are exact scalars and
 * objects: an object crosses as an owned handle the adapter promotes,
 * and whether its class projects is the adapter's refusal, made where
 * the selection is known — generation admits any object javac can spell.
 *
 * Each override also carries its native super binding: an ordinary
 * generated method whose body is `super.name(...)`, the only spelling of
 * the base implementation once virtual dispatch lands on the override —
 * the Android analogue is an onCreate that must call super.onCreate().
 */

import { createHash } from "node:crypto";
import { JvmGenerationError } from "./jvm-model.ts";
import type {
  JvmCallbackAnchor,
  JvmCallbackSelection,
  JvmClass,
  JvmDiagnostic,
  JvmMemberSelection,
  JvmMethod,
  JvmPrimitive,
  JvmSnapshot,
} from "./jvm-model.ts";

export interface JvmSubclassSelection {
  /** The base, as the class file spells it (`fixture/Host`). */
  readonly baseBinaryName: string;
  /** Overridable methods the subclass implements in TypeScript. */
  readonly overrides: readonly JvmMemberSelection[];
  /** Emits `static { System.loadLibrary(name); }`, for a subclass the
   * PLATFORM constructs: nothing else runs first, so the class that is
   * the entry point is the only place the native half can be loaded.
   * An Android Activity is the case that needs it; a subclass some
   * other program instantiates does not, because that program already
   * loaded the library before it could name the class. */
  readonly loadLibrary?: string;
  /** Where the generated class lives, as a binary name
   * (`com/example/app/MainActivity`). Defaults to the base's package
   * with `Bridge` appended to its simple name, which is right when the
   * base is the application's own. It is NOT right when the base
   * belongs to the platform: Android refuses to load application
   * classes defined in the `android.*` namespace, so an Activity
   * subclass must name a package the application owns. */
  readonly subclassBinaryName?: string;
  /** What the overrides' registrations attach to. `class` is for a
   * subclass the PLATFORM constructs — the instances are never handed to
   * the program, so there is nothing to register against — and it is the
   * same fact that makes `loadLibrary` necessary, stated separately
   * because inferring one decision from another hides both. */
  readonly anchor?: JvmCallbackAnchor;
}

export interface JvmSubclassSource {
  readonly schema: "native-typescript.jvm-subclass-source";
  readonly schemaVersion: 3;
  readonly baseBinaryName: string;
  readonly subclassBinaryName: string;
  /** The generated Java, compiled against the base's classes. */
  readonly source: string;
  readonly sourceDigest: string;
  /** Where the source lives relative to a source root: the package path
   * javac expects (`fixture/HostBridge.java`). */
  readonly logicalPath: string;
  /** The overrides as a `callbacks:` selection on the SUBCLASS — exactly
   * what the ingestion of the compiled result should be handed. Void
   * overrides carry `delivery: "synchronous"`: the framework code that
   * dispatched an override observes it, so the queued arm is never an
   * override's delivery. */
  readonly callbacks: readonly JvmCallbackSelection[];
  /** The native super bindings as a `methods:` selection on the SUBCLASS:
   * one `ntsSuper<Name>` per override, whose body is the base
   * implementation reached non-virtually (javac compiles `super.name(...)`
   * to invokespecial). Ordinary instance methods — the adapter needs no
   * new machinery to call the code an override replaced. */
  readonly methods: readonly JvmMemberSelection[];
}

function diagnostic(path: string, message: string): JvmDiagnostic {
  return { code: "NTS7001", severity: "error", path, message };
}

/** The Java source spelling of a scalar payload. */
const javaScalarNames: Readonly<Record<JvmPrimitive, string>> = Object.freeze({
  boolean: "boolean",
  byte: "byte",
  char: "char",
  short: "short",
  int: "int",
  long: "long",
  float: "float",
  double: "double",
});

function resolveOverride(
  base: JvmClass,
  selection: JvmMemberSelection,
  path: string,
  diagnostics: JvmDiagnostic[],
): JvmMethod | null {
  const name = typeof selection === "string" ? selection : selection.name;
  const matches = base.methods.filter((method) =>
    typeof selection === "string"
      ? method.name === selection
      : method.name === selection.name &&
        method.descriptor === selection.descriptor
  );
  if (matches.length === 0) {
    diagnostics.push(diagnostic(
      path,
      `Override '${name}' does not exist on '${base.binaryName}' or is not ` +
        "among its selected methods; the base snapshot must select what " +
        "the subclass overrides",
    ));
    return null;
  }
  if (matches.length > 1) {
    const descriptors = matches.map(({ descriptor }) => descriptor).join(", ");
    diagnostics.push(diagnostic(
      path,
      `Override '${name}' is overloaded (${descriptors}); select it by ` +
        "descriptor",
    ));
    return null;
  }
  return matches[0]!;
}

export function generateJvmSubclassSource(
  snapshot: JvmSnapshot,
  selection: JvmSubclassSelection,
): JvmSubclassSource {
  const diagnostics: JvmDiagnostic[] = [];
  const base = snapshot.classes.find(
    ({ binaryName }) => binaryName === selection.baseBinaryName,
  );
  const path = `subclass/${selection.baseBinaryName}`;
  if (base === undefined) {
    throw new JvmGenerationError([
      diagnostic(path, "The base class is not in the snapshot"),
    ]);
  }
  if (base.kind !== "class") {
    diagnostics.push(diagnostic(path, `'${base.binaryName}' is not a class`));
  }
  if (base.access.final) {
    diagnostics.push(diagnostic(
      path,
      `'${base.binaryName}' is final; a final class has no subclasses in ` +
        "Java's own rules",
    ));
  }
  if (base.access.visibility !== "public") {
    diagnostics.push(diagnostic(
      path,
      `'${base.binaryName}' is not public; the generated subclass could ` +
        "not extend it from its own compilation",
    ));
  }
  /* The generated subclass leans on the implicit default constructor, so
   * the base must offer an accessible no-arg one. Pass-through constructors
   * are their own slice with their own demand. */
  const noArg = base.constructors.find(
    ({ descriptor }) => descriptor === "()V",
  );
  if (
    noArg === undefined ||
    (noArg.access.visibility !== "public" &&
      noArg.access.visibility !== "protected")
  ) {
    diagnostics.push(diagnostic(
      path,
      `'${base.binaryName}' has no accessible no-arg constructor among its ` +
        "selected constructors; pass-through constructors are a named next " +
        "slice",
    ));
  }
  if (selection.overrides.length === 0) {
    diagnostics.push(diagnostic(
      path,
      "A subclass with no overrides is the base class; select at least one",
    ));
  }

  const overrideLines: string[] = [];
  const callbacks: JvmCallbackSelection[] = [];
  const superMethods: JvmMemberSelection[] = [];
  for (const overrideSelection of selection.overrides) {
    const name = typeof overrideSelection === "string"
      ? overrideSelection
      : overrideSelection.name;
    const overridePath = `${path}/override/${name}`;
    const method = resolveOverride(
      base,
      overrideSelection,
      overridePath,
      diagnostics,
    );
    if (method === null) continue;
    if (method.access.final) {
      diagnostics.push(diagnostic(
        overridePath,
        `'${name}' is final; Java itself refuses the override`,
      ));
      continue;
    }
    if (method.access.static) {
      diagnostics.push(diagnostic(
        overridePath,
        `'${name}' is static; static methods hide rather than override, ` +
          "and a hidden method is never dispatched virtually",
      ));
      continue;
    }
    if (
      method.access.visibility !== "public" &&
      method.access.visibility !== "protected"
    ) {
      diagnostics.push(diagnostic(
        overridePath,
        `'${name}' is ${method.access.visibility}; an override must see ` +
          "what it overrides",
      ));
      continue;
    }
    const answers = method.result.kind === "primitive" &&
      method.result.name === "boolean";
    const tells = method.result.kind === "void";
    if (!answers && !tells) {
      diagnostics.push(diagnostic(
        `${overridePath}/result`,
        "An override crosses as a retained callback, which answers with a " +
          "boolean or tells with void; any other result would make the " +
          "handler's value the dispatching call's without a contract for it",
      ));
      continue;
    }
    const parameters: string[] = [];
    let refused = false;
    method.parameters.forEach((parameter, index) => {
      if (
        parameter.kind === "primitive" &&
        parameter.name !== "float" &&
        parameter.name !== "boolean"
      ) {
        parameters.push(`${javaScalarNames[parameter.name]} a${index}`);
        return;
      }
      /* An object payload crosses as an owned handle (fork 0309d850): the
       * adapter promotes the frame-scoped reference and the cell's
       * destructor gives it back. Generation admits any object javac can
       * spell — whether the payload's class projects is the adapter's
       * fact, refused there where the selection is known. The source
       * spelling is the binary name with dots, `$` included: a member
       * class is `Outer.Inner` in Java source. */
      if (parameter.kind === "object") {
        parameters.push(
          `${parameter.binaryName.replace(/[/$]/gu, ".")} a${index}`,
        );
        return;
      }
      diagnostics.push(diagnostic(
        `${overridePath}/parameters/${index}`,
        parameter.kind === "primitive"
          ? `Payload ${parameter.name} is outside the retained contract's ` +
            "exact-scalar set"
          : "An array payload is outside the retained contract; spans do " +
            "not cross callbacks",
      ));
      refused = true;
    });
    if (refused) continue;
    /* The super binding rides beside the override: the same signature as
     * an ordinary method whose body is the base implementation, reached
     * non-virtually because javac compiles `super.name(...)` to
     * invokespecial. Virtual dispatch on the receiver always lands on the
     * native override, so this generated method is the ONLY spelling of
     * "the code the override replaced". The `ntsSuper` prefix is the
     * collision guard: a base declaring such a name would be generated
     * code colliding with generated code. */
    const superName = `ntsSuper${method.name[0]!.toUpperCase()}${
      method.name.slice(1)
    }`;
    const argumentNames = parameters.map((_, index) => `a${index}`);
    const javaResult = answers ? javaScalarNames.boolean : "void";
    overrideLines.push(
      "  @Override",
      `  public native ${javaResult} ${method.name}(${
        parameters.join(", ")
      });`,
      "",
      `  public ${javaResult} ${superName}(${parameters.join(", ")}) {`,
      `    ${answers ? "return " : ""}super.${method.name}(${
        argumentNames.join(", ")
      });`,
      "  }",
      "",
    );
    /* A void override's delivery is decided here, not left to the
     * selection downstream: the framework observes what it dispatched. */
    const anchored = selection.anchor === "class";
    callbacks.push(
      tells || anchored
        ? Object.freeze({
            name: method.name,
            descriptor: method.descriptor,
            ...(tells ? { delivery: "synchronous" as const } : {}),
            ...(anchored ? { anchor: "class" as const } : {}),
          })
        : typeof overrideSelection === "string"
          ? overrideSelection
          : Object.freeze({ ...overrideSelection }),
    );
    superMethods.push(Object.freeze({
      name: superName,
      descriptor: method.descriptor,
    }));
  }
  if (diagnostics.length > 0) throw new JvmGenerationError(diagnostics);

  const subclassBinaryName = selection.subclassBinaryName ??
    `${base.binaryName}Bridge`;
  const lastSlash = subclassBinaryName.lastIndexOf("/");
  const packageName = lastSlash < 0
    ? null
    : subclassBinaryName.slice(0, lastSlash).replace(/\//gu, ".");
  const subclassSimpleName = subclassBinaryName.slice(lastSlash + 1);
  /* The base is named in full rather than by simple name: the subclass
   * may live in a package the base does not, and a fully qualified
   * extends clause is correct in both cases. */
  const baseSourceName = base.binaryName.replace(/[/$]/gu, ".");
  const source = [
    "/* Generated by @native-typescript/bindgen-jvm. */",
    ...(packageName === null ? [] : [`package ${packageName};`, ""]),
    /* Final: the bridge is the boundary, not a base for further bases. */
    `public final class ${subclassSimpleName} extends ${baseSourceName} {`,
    ...(selection.loadLibrary === undefined
      ? []
      : [
          /* The platform constructs this class, so its own initializer is
           * the first code that runs — and therefore the only place the
           * native half can be loaded before a native override is
           * dispatched. */
          "  static {",
          `    System.loadLibrary("${selection.loadLibrary}");`,
          "  }",
          "",
        ]),
    ...overrideLines.slice(0, -1),
    "}",
    "",
  ].join("\n");
  return Object.freeze({
    schema: "native-typescript.jvm-subclass-source",
    schemaVersion: 3,
    baseBinaryName: base.binaryName,
    subclassBinaryName,
    source,
    sourceDigest: `sha256:${createHash("sha256").update(source).digest("hex")}`,
    logicalPath: `${subclassBinaryName}.java`,
    callbacks: Object.freeze(callbacks),
    methods: Object.freeze(superMethods),
  });
}
