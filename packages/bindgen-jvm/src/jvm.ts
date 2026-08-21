import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { parseClassFile } from "./classfile.ts";
import type { ParsedClass, ParsedField, ParsedMethod } from "./classfile.ts";
import { JvmIngestionError } from "./jvm-model.ts";
import type {
  JvmCallback,
  JvmCallbackSelection,
  JvmClass,
  JvmClassAccess,
  JvmClassSelection,
  JvmClassSource,
  JvmDeclarationReference,
  JvmDiagnostic,
  JvmDiagnosticCode,
  JvmField,
  JvmFieldAccess,
  JvmIngestionOptions,
  JvmMethod,
  JvmMethodAccess,
  JvmPrimitive,
  JvmSnapshot,
  JvmTypeReference,
  JvmVisibility,
} from "./jvm-model.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function diagnostic(
  code: JvmDiagnosticCode,
  path: string,
  message: string,
): JvmDiagnostic {
  return { code, severity: "error", path, message };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/* A binary name as class files spell one: slash-separated non-empty
 * segments, no dots, and none of the characters the descriptor grammar
 * reserves. Nested classes keep their `$`. */
function isValidBinaryName(name: string): boolean {
  if (name.length === 0) return false;
  const segments = name.split("/");
  return segments.every(
    (segment) => segment.length > 0 && !/[.;[]/u.test(segment),
  );
}

const primitiveByCode: ReadonlyMap<string, JvmPrimitive> = new Map([
  ["Z", "boolean"],
  ["B", "byte"],
  ["C", "char"],
  ["S", "short"],
  ["I", "int"],
  ["J", "long"],
  ["F", "float"],
  ["D", "double"],
]);

interface DescriptorCursor {
  readonly text: string;
  position: number;
}

function parseNonVoidType(
  cursor: DescriptorCursor,
  path: string,
  diagnostics: JvmDiagnostic[],
): JvmTypeReference | null {
  let dimensions = 0;
  while (cursor.text[cursor.position] === "[") {
    dimensions += 1;
    cursor.position += 1;
    if (dimensions > 255) {
      diagnostics.push(
        diagnostic("NTS6005", path, "Array descriptor exceeds 255 dimensions"),
      );
      return null;
    }
  }
  const code = cursor.text[cursor.position];
  if (code === undefined) {
    diagnostics.push(
      diagnostic("NTS6005", path, `Truncated descriptor '${cursor.text}'`),
    );
    return null;
  }
  let element:
    | { readonly kind: "primitive"; readonly name: JvmPrimitive }
    | { readonly kind: "object"; readonly binaryName: string };
  const primitive = primitiveByCode.get(code);
  if (primitive !== undefined) {
    cursor.position += 1;
    element = Object.freeze({ kind: "primitive" as const, name: primitive });
  } else if (code === "L") {
    const terminator = cursor.text.indexOf(";", cursor.position + 1);
    if (terminator === -1) {
      diagnostics.push(
        diagnostic(
          "NTS6005",
          path,
          `Unterminated object type in descriptor '${cursor.text}'`,
        ),
      );
      return null;
    }
    const binaryName = cursor.text.slice(cursor.position + 1, terminator);
    if (!isValidBinaryName(binaryName)) {
      diagnostics.push(
        diagnostic(
          "NTS6005",
          path,
          `Malformed binary name '${binaryName}' in descriptor '${cursor.text}'`,
        ),
      );
      return null;
    }
    cursor.position = terminator + 1;
    element = Object.freeze({ kind: "object" as const, binaryName });
  } else {
    diagnostics.push(
      diagnostic(
        "NTS6005",
        path,
        `Unknown type code '${code}' in descriptor '${cursor.text}'`,
      ),
    );
    return null;
  }
  if (dimensions === 0) return element;
  return Object.freeze({ kind: "array" as const, dimensions, element });
}

function parseFieldDescriptor(
  descriptor: string,
  path: string,
  diagnostics: JvmDiagnostic[],
): JvmTypeReference | null {
  const cursor: DescriptorCursor = { text: descriptor, position: 0 };
  const type = parseNonVoidType(cursor, path, diagnostics);
  if (type === null) return null;
  if (cursor.position !== descriptor.length) {
    diagnostics.push(
      diagnostic(
        "NTS6005",
        path,
        `Trailing characters in field descriptor '${descriptor}'`,
      ),
    );
    return null;
  }
  return type;
}

function parseMethodDescriptor(
  descriptor: string,
  path: string,
  diagnostics: JvmDiagnostic[],
): {
  readonly parameters: readonly JvmTypeReference[];
  readonly result: JvmTypeReference;
} | null {
  if (descriptor[0] !== "(") {
    diagnostics.push(
      diagnostic(
        "NTS6005",
        path,
        `Method descriptor '${descriptor}' does not start with '('`,
      ),
    );
    return null;
  }
  const cursor: DescriptorCursor = { text: descriptor, position: 1 };
  const parameters: JvmTypeReference[] = [];
  while (cursor.text[cursor.position] !== ")") {
    const parameter = parseNonVoidType(cursor, path, diagnostics);
    if (parameter === null) return null;
    parameters.push(parameter);
  }
  cursor.position += 1;
  let result: JvmTypeReference;
  if (cursor.text[cursor.position] === "V") {
    cursor.position += 1;
    result = Object.freeze({ kind: "void" as const });
  } else {
    const parsed = parseNonVoidType(cursor, path, diagnostics);
    if (parsed === null) return null;
    result = parsed;
  }
  if (cursor.position !== descriptor.length) {
    diagnostics.push(
      diagnostic(
        "NTS6005",
        path,
        `Trailing characters in method descriptor '${descriptor}'`,
      ),
    );
    return null;
  }
  return { parameters: Object.freeze(parameters), result };
}

function visibilityOf(flags: number): JvmVisibility {
  if ((flags & 0x0001) !== 0) return "public";
  if ((flags & 0x0004) !== 0) return "protected";
  if ((flags & 0x0002) !== 0) return "private";
  return "package";
}

function methodAccessOf(flags: number): JvmMethodAccess {
  return Object.freeze({
    visibility: visibilityOf(flags),
    static: (flags & 0x0008) !== 0,
    final: (flags & 0x0010) !== 0,
    abstract: (flags & 0x0400) !== 0,
    native: (flags & 0x0100) !== 0,
    synchronized: (flags & 0x0020) !== 0,
    bridge: (flags & 0x0040) !== 0,
    varargs: (flags & 0x0080) !== 0,
    synthetic: (flags & 0x1000) !== 0,
  });
}

function fieldAccessOf(flags: number): JvmFieldAccess {
  return Object.freeze({
    visibility: visibilityOf(flags),
    static: (flags & 0x0008) !== 0,
    final: (flags & 0x0010) !== 0,
    volatile: (flags & 0x0040) !== 0,
    transient: (flags & 0x0080) !== 0,
    enum: (flags & 0x4000) !== 0,
    synthetic: (flags & 0x1000) !== 0,
  });
}

function classAccessOf(flags: number): JvmClassAccess {
  return Object.freeze({
    visibility: visibilityOf(flags),
    final: (flags & 0x0010) !== 0,
    abstract: (flags & 0x0400) !== 0,
    synthetic: (flags & 0x1000) !== 0,
  });
}

function classKindOf(flags: number): JvmClass["kind"] {
  if ((flags & 0x2000) !== 0) return "annotation";
  if ((flags & 0x0200) !== 0) return "interface";
  if ((flags & 0x4000) !== 0) return "enum";
  return "class";
}

interface NormalizedMemberSelections<
  Exact extends { readonly name: string; readonly descriptor: string } = {
    readonly name: string;
    readonly descriptor: string;
  },
> {
  /** Bare-name selections; each name must resolve to exactly one member. */
  readonly names: ReadonlySet<string>;
  /** Descriptor-qualified selections, keyed `name descriptor`. */
  readonly exact: ReadonlyMap<string, Exact>;
}

function normalizeMemberSelections<
  Exact extends { readonly name: string; readonly descriptor: string },
>(
  selections: readonly (string | Exact)[],
  path: string,
  diagnostics: JvmDiagnostic[],
): NormalizedMemberSelections<Exact> {
  const names = new Set<string>();
  const exact = new Map<string, Exact>();
  const qualifiedNames = new Set<string>();
  for (const selection of selections) {
    if (typeof selection === "string") {
      if (selection.length === 0 || names.has(selection)) {
        diagnostics.push(
          diagnostic(
            "NTS6001",
            `${path}/${selection}`,
            `Invalid or duplicate member selection '${selection}'`,
          ),
        );
        continue;
      }
      names.add(selection);
      continue;
    }
    const key = `${selection.name} ${selection.descriptor}`;
    if (
      selection.name.length === 0 ||
      selection.descriptor.length === 0 ||
      exact.has(key)
    ) {
      diagnostics.push(
        diagnostic(
          "NTS6001",
          `${path}/${selection.name}`,
          `Invalid or duplicate member selection '${key}'`,
        ),
      );
      continue;
    }
    exact.set(key, selection);
    qualifiedNames.add(selection.name);
  }
  /* One name spelled both bare and descriptor-qualified has two different
   * resolution rules at once; refuse it rather than pick one. */
  for (const name of names) {
    if (qualifiedNames.has(name)) {
      diagnostics.push(
        diagnostic(
          "NTS6001",
          `${path}/${name}`,
          `Member '${name}' is selected both by bare name and by descriptor`,
        ),
      );
    }
  }
  return { names, exact };
}

interface NormalizedClassSelection {
  readonly binaryName: string;
  readonly constructors: ReadonlySet<string>;
  readonly methods: NormalizedMemberSelections;
  readonly fields: NormalizedMemberSelections;
  readonly callbacks: NormalizedMemberSelections<
    Exclude<JvmCallbackSelection, string>
  >;
}

/* The delivery value is validated where the selection is spelled; the
 * required-on-void / refused-on-answered algebra lives in the adapter,
 * which is the first stage that sees the resolved result kind. */
function normalizeCallbackSelections(
  selections: readonly JvmCallbackSelection[],
  path: string,
  diagnostics: JvmDiagnostic[],
): NormalizedMemberSelections<Exclude<JvmCallbackSelection, string>> {
  for (const selection of selections) {
    if (
      typeof selection !== "string" &&
      selection.delivery !== undefined &&
      selection.delivery !== "synchronous" &&
      selection.delivery !== "queued"
    ) {
      diagnostics.push(
        diagnostic(
          "NTS6001",
          `${path}/${selection.name}`,
          `Invalid callback delivery '${String(selection.delivery)}'; a ` +
            "void callback crosses 'synchronous' (during the caller's " +
            "frame) or 'queued' (at the runtime's pump)",
        ),
      );
    }
    if (
      typeof selection !== "string" &&
      selection.anchor !== undefined &&
      selection.anchor !== "instance" &&
      selection.anchor !== "class"
    ) {
      diagnostics.push(
        diagnostic(
          "NTS6001",
          `${path}/${selection.name}`,
          `Invalid callback anchor '${String(selection.anchor)}'; a ` +
            "registration attaches to an 'instance' the program holds or " +
            "to the 'class' whose instances a framework constructs",
        ),
      );
    }
  }
  return normalizeMemberSelections(selections, path, diagnostics);
}

function normalizeClassSelections(
  selections: readonly JvmClassSelection[],
  diagnostics: JvmDiagnostic[],
): Map<string, NormalizedClassSelection> {
  const normalized = new Map<string, NormalizedClassSelection>();
  for (const selection of selections) {
    const path = `class/${selection.binaryName}`;
    if (!isValidBinaryName(selection.binaryName)) {
      const hint = selection.binaryName.includes(".")
        ? "; spell it as a slashed binary name (java/lang/Object)"
        : "";
      diagnostics.push(
        diagnostic(
          "NTS6001",
          path,
          `Invalid JVM class selection '${selection.binaryName}'${hint}`,
        ),
      );
      continue;
    }
    if (normalized.has(selection.binaryName)) {
      diagnostics.push(
        diagnostic(
          "NTS6001",
          path,
          `Duplicate JVM class selection '${selection.binaryName}'`,
        ),
      );
      continue;
    }
    const constructors = new Set<string>();
    for (const descriptor of selection.constructors ?? []) {
      if (!descriptor.startsWith("(") || constructors.has(descriptor)) {
        diagnostics.push(
          diagnostic(
            "NTS6001",
            `${path}/constructor/${descriptor}`,
            `Invalid or duplicate constructor selection '${descriptor}'; ` +
              "constructors are selected by method descriptor",
          ),
        );
        continue;
      }
      constructors.add(descriptor);
    }
    normalized.set(selection.binaryName, {
      binaryName: selection.binaryName,
      constructors,
      methods: normalizeMemberSelections(
        selection.methods ?? [],
        `${path}/method`,
        diagnostics,
      ),
      fields: normalizeMemberSelections(
        selection.fields ?? [],
        `${path}/field`,
        diagnostics,
      ),
      callbacks: normalizeCallbackSelections(
        selection.callbacks ?? [],
        `${path}/callback`,
        diagnostics,
      ),
    });
  }
  return normalized;
}

function referenceTo(
  binaryName: string,
  selectedNames: ReadonlySet<string>,
): JvmDeclarationReference {
  return Object.freeze({
    kind: selectedNames.has(binaryName) ? ("internal" as const) : ("external" as const),
    binaryName,
  });
}

function freezeMethod(
  parsed: ParsedMethod,
  kind: JvmMethod["kind"],
  path: string,
  selectedNames: ReadonlySet<string>,
  diagnostics: JvmDiagnostic[],
): JvmMethod | null {
  const signature = parseMethodDescriptor(parsed.descriptor, path, diagnostics);
  if (signature === null) return null;
  return Object.freeze({
    kind,
    name: parsed.name,
    descriptor: parsed.descriptor,
    access: methodAccessOf(parsed.accessFlags),
    result: signature.result,
    parameters: signature.parameters,
    throws: Object.freeze(
      [...parsed.exceptions]
        .sort(compareText)
        .map((name) => referenceTo(name, selectedNames)),
    ),
    deprecated: parsed.deprecated,
    genericSignature: parsed.genericSignature,
  });
}

function freezeField(
  parsed: ParsedField,
  path: string,
  diagnostics: JvmDiagnostic[],
): JvmField | null {
  const type = parseFieldDescriptor(parsed.descriptor, path, diagnostics);
  if (type === null) return null;
  return Object.freeze({
    name: parsed.name,
    descriptor: parsed.descriptor,
    access: fieldAccessOf(parsed.accessFlags),
    type,
    constantValue:
      parsed.constantValue === null
        ? null
        : Object.freeze(parsed.constantValue),
    deprecated: parsed.deprecated,
    genericSignature: parsed.genericSignature,
  });
}

/**
 * Resolve bare-name and descriptor-qualified selections against a declared
 * member list. A bare name matching several overloads is refused with the
 * declared descriptors in the message, so the fix is copy-paste.
 */
function resolveMembers<Member extends { name: string; descriptor: string }>(
  declared: readonly Member[],
  selections: NormalizedMemberSelections,
  memberKind: string,
  path: string,
  diagnostics: JvmDiagnostic[],
): Member[] {
  const resolved: Member[] = [];
  for (const name of [...selections.names].sort(compareText)) {
    const candidates = declared.filter((member) => member.name === name);
    if (candidates.length === 0) {
      diagnostics.push(
        diagnostic(
          "NTS6003",
          `${path}/${name}`,
          `Selected JVM ${memberKind} '${name}' does not exist`,
        ),
      );
      continue;
    }
    if (candidates.length > 1) {
      const descriptors = candidates
        .map((member) => member.descriptor)
        .sort(compareText)
        .join(", ");
      diagnostics.push(
        diagnostic(
          "NTS6001",
          `${path}/${name}`,
          `JVM ${memberKind} '${name}' is overloaded; select one descriptor ` +
            `of: ${descriptors}`,
        ),
      );
      continue;
    }
    resolved.push(candidates[0]!);
  }
  for (const [, selection] of [...selections.exact.entries()].sort(
    (left, right) => compareText(left[0], right[0]),
  )) {
    const match = declared.find(
      (member) =>
        member.name === selection.name &&
        member.descriptor === selection.descriptor,
    );
    if (match === undefined) {
      diagnostics.push(
        diagnostic(
          "NTS6003",
          `${path}/${selection.name}`,
          `Selected JVM ${memberKind} '${selection.name}' with descriptor ` +
            `'${selection.descriptor}' does not exist`,
        ),
      );
      continue;
    }
    resolved.push(match);
  }
  return resolved;
}

export function ingestJvmClasses(
  sources: readonly JvmClassSource[],
  options: JvmIngestionOptions,
): JvmSnapshot {
  const diagnostics: JvmDiagnostic[] = [];
  const digests = new Map<string, string>();
  for (const source of sources) {
    if (
      source.logicalPath.length === 0 ||
      isAbsolute(source.logicalPath) ||
      /^[A-Za-z]:[\\/]/u.test(source.logicalPath) ||
      source.logicalPath.split(/[\\/]/u).includes("..")
    ) {
      diagnostics.push(
        diagnostic(
          "NTS6001",
          `source/${source.logicalPath}`,
          "JVM class source logicalPath must be non-empty, relative, and " +
            "cannot traverse parents",
        ),
      );
      continue;
    }
    if (digests.has(source.logicalPath)) {
      diagnostics.push(
        diagnostic(
          "NTS6001",
          `source/${source.logicalPath}`,
          `Duplicate JVM class source '${source.logicalPath}'`,
        ),
      );
      continue;
    }
    const digest = `sha256:${createHash("sha256").update(source.bytes).digest("hex")}`;
    if (
      source.expectedDigest !== undefined &&
      (!digestPattern.test(source.expectedDigest) ||
        source.expectedDigest !== digest)
    ) {
      diagnostics.push(
        diagnostic(
          "NTS6001",
          `source/${source.logicalPath}`,
          `JVM class source digest mismatch: expected ` +
            `${source.expectedDigest}, received ${digest}`,
        ),
      );
    }
    digests.set(source.logicalPath, digest);
  }
  const selections = normalizeClassSelections(options.classes, diagnostics);
  if (diagnostics.length > 0) throw new JvmIngestionError(diagnostics);

  const parsedByName = new Map<string, ParsedClass>();
  for (const source of sources) {
    const parsed = parseClassFile(
      source.bytes,
      `source/${source.logicalPath}`,
      diagnostics,
    );
    if (parsed === null) continue;
    if (parsedByName.has(parsed.binaryName)) {
      diagnostics.push(
        diagnostic(
          "NTS6001",
          `source/${source.logicalPath}`,
          `Class '${parsed.binaryName}' appears in more than one source`,
        ),
      );
      continue;
    }
    parsedByName.set(parsed.binaryName, parsed);
  }
  if (diagnostics.length > 0) throw new JvmIngestionError(diagnostics);

  const selectedNames = new Set(selections.keys());
  const classes: JvmClass[] = [];
  for (const selection of selections.values()) {
    const path = `class/${selection.binaryName}`;
    const parsed = parsedByName.get(selection.binaryName);
    if (parsed === undefined) {
      diagnostics.push(
        diagnostic(
          "NTS6003",
          path,
          `Selected JVM class '${selection.binaryName}' does not exist ` +
            "among the provided sources",
        ),
      );
      continue;
    }
    if ((parsed.accessFlags & 0x8000) !== 0) {
      diagnostics.push(
        diagnostic(
          "NTS6004",
          path,
          "A module descriptor is not a projectable class",
        ),
      );
      continue;
    }
    /* A static nested class is an ordinary class with a dotted spelling.
     * The other nesting shapes split into two different refusals:
     *
     * A local or anonymous class is OUTSIDE the algebra: it has no stable
     * declared identity, so it is not a bindable API surface at all.
     *
     * A non-static member class is an ordinary handle for methods and
     * fields — platform APIs return instances of these (Context.getTheme()
     * returns Resources$Theme) and the algebra already expresses methods
     * over an owned handle. Only CONSTRUCTION is different: JNI defines it
     * exactly (the enclosing instance is the constructor's leading
     * argument), but the selection model has no spelling for the
     * enclosing-instance requirement yet, so constructor selections are
     * DEFERRED rather than mis-projected at an arity the source never
     * wrote. The trigger for building it is the first selected surface that
     * must construct one. */
    if (parsed.nested !== null) {
      if (parsed.nested.outer === null || parsed.nested.innerName === null) {
        diagnostics.push(
          diagnostic(
            "NTS6004",
            path,
            `JVM class '${selection.binaryName}' is a local or anonymous ` +
              "class; it has no stable declared API surface and is not " +
              "projectable",
          ),
        );
        continue;
      }
      if (
        !parsed.nested.static &&
        (parsed.accessFlags & 0x0200) === 0 &&
        selection.constructors.size > 0
      ) {
        diagnostics.push(
          diagnostic(
            "NTS6004",
            path,
            `Constructors of the non-static inner class ` +
              `'${selection.binaryName}' take an enclosing instance, which ` +
              "the selection model does not spell yet; its methods and " +
              "fields project. Constructor selection is deferred, not " +
              "unsupported: it becomes buildable when a selected surface " +
              "must construct one.",
          ),
        );
        continue;
      }
    }
    const kind = classKindOf(parsed.accessFlags);
    /* The class file gives every interface java/lang/Object as its
     * superclass; the meaningful extends-relations are in the interface
     * list, so the superclass slot is null for anything but a class. */
    const superName =
      kind === "class" || kind === "enum" ? parsed.superName : null;
    if (
      superName !== null &&
      parsedByName.has(superName) &&
      !selectedNames.has(superName)
    ) {
      diagnostics.push(
        diagnostic(
          "NTS6006",
          `${path}/@superclass`,
          `JVM class '${selection.binaryName}' extends '${superName}', which ` +
            "is among the provided sources but is not selected. Select it, " +
            "or the projected class would lose its ancestry silently.",
        ),
      );
      continue;
    }
    const declaredConstructors = parsed.methods.filter(
      (method) => method.name === "<init>",
    );
    const constructors: JvmMethod[] = [];
    for (const descriptor of [...selection.constructors].sort(compareText)) {
      const match = declaredConstructors.find(
        (method) => method.descriptor === descriptor,
      );
      if (match === undefined) {
        const declared = declaredConstructors
          .map((method) => method.descriptor)
          .sort(compareText)
          .join(", ");
        diagnostics.push(
          diagnostic(
            "NTS6003",
            `${path}/constructor/${descriptor}`,
            `Selected JVM constructor '${descriptor}' does not exist; ` +
              `declared: ${declared.length > 0 ? declared : "none"}`,
          ),
        );
        continue;
      }
      const frozen = freezeMethod(
        match,
        "constructor",
        `${path}/constructor/${descriptor}`,
        selectedNames,
        diagnostics,
      );
      if (frozen !== null) constructors.push(frozen);
    }
    const declaredMethods = parsed.methods.filter(
      (method) => method.name !== "<init>" && method.name !== "<clinit>",
    );
    const methods = resolveMembers(
      declaredMethods,
      selection.methods,
      "method",
      `${path}/method`,
      diagnostics,
    )
      .map((method) =>
        freezeMethod(
          method,
          "method",
          `${path}/method/${method.name}`,
          selectedNames,
          diagnostics,
        ),
      )
      .filter((method): method is JvmMethod => method !== null);
    const callbacks = resolveMembers(
      declaredMethods,
      selection.callbacks,
      "callback",
      `${path}/callback`,
      diagnostics,
    )
      .map((method) =>
        freezeMethod(
          method,
          "method",
          `${path}/callback/${method.name}`,
          selectedNames,
          diagnostics,
        ),
      )
      .filter((method): method is JvmMethod => method !== null)
      .filter((method) => {
        /* RegisterNatives is legal only against a native method: that is a
         * fact the class file states, so its absence is a metadata refusal
         * rather than a generation one. */
        if (!method.access.native) {
          diagnostics.push(
            diagnostic(
              "NTS6004",
              `${path}/callback/${method.name}`,
              `Selected callback '${method.name}' is not a native method; ` +
                "a callback registration point is where Java declared the " +
                "implementation missing",
            ),
          );
          return false;
        }
        if (
          methods.some(
            (selected) =>
              selected.name === method.name &&
              selected.descriptor === method.descriptor,
          )
        ) {
          diagnostics.push(
            diagnostic(
              "NTS6001",
              `${path}/callback/${method.name}`,
              `'${method.name}' is selected as both a method and a ` +
                "callback; a registration point is not callable surface",
            ),
          );
          return false;
        }
        return true;
      })
      .map((method): JvmCallback => {
        /* The exact form is the only spelling that can state a delivery;
         * a bare-name selection resolves with none stated. */
        const stated = selection.callbacks.exact.get(
          `${method.name} ${method.descriptor}`,
        );
        return Object.freeze({
          ...method,
          delivery: stated?.delivery ?? null,
          anchor: stated?.anchor ?? "instance",
        });
      });
    const fields = resolveMembers(
      parsed.fields,
      selection.fields,
      "field",
      `${path}/field`,
      diagnostics,
    )
      .map((field) =>
        freezeField(field, `${path}/field/${field.name}`, diagnostics),
      )
      .filter((field): field is JvmField => field !== null);
    classes.push(
      Object.freeze({
        kind,
        binaryName: parsed.binaryName,
        classfileVersion: Object.freeze({
          major: parsed.major,
          minor: parsed.minor,
        }),
        access: classAccessOf(parsed.accessFlags),
        superclass:
          superName === null ? null : referenceTo(superName, selectedNames),
        interfaces: Object.freeze(
          [...parsed.interfaceNames]
            .sort(compareText)
            .map((name) => referenceTo(name, selectedNames)),
        ),
        nested: parsed.nested === null ? null : Object.freeze(parsed.nested),
        deprecated: parsed.deprecated,
        genericSignature: parsed.genericSignature,
        constructors: Object.freeze(
          constructors.sort((left, right) =>
            compareText(left.descriptor, right.descriptor)
          ),
        ),
        methods: Object.freeze(
          methods.sort((left, right) =>
            compareText(left.name, right.name) ||
            compareText(left.descriptor, right.descriptor)
          ),
        ),
        callbacks: Object.freeze(
          callbacks.sort((left, right) =>
            compareText(left.name, right.name) ||
            compareText(left.descriptor, right.descriptor)
          ),
        ),
        fields: Object.freeze(
          fields.sort((left, right) =>
            compareText(left.name, right.name) ||
            compareText(left.descriptor, right.descriptor)
          ),
        ),
      }),
    );
  }
  if (diagnostics.length > 0) throw new JvmIngestionError(diagnostics);

  return Object.freeze({
    schema: "native-typescript.jvm-snapshot",
    schemaVersion: 3,
    sources: Object.freeze(
      [...digests.entries()]
        .sort((left, right) => compareText(left[0], right[0]))
        .map(([logicalPath, digest]) =>
          Object.freeze({ logicalPath, digest })
        ),
    ),
    classes: Object.freeze(
      classes.sort((left, right) =>
        compareText(left.binaryName, right.binaryName)
      ),
    ),
  });
}
