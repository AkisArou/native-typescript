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
  JvmNullability,
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

/**
 * The annotation types this ingestion reads as stating nullability.
 *
 * Nullability is a convention carried by annotations rather than something
 * the JVM records, so there is no general rule to apply here — only a named,
 * closed set. Matching exact descriptors rather than a simple-name suffix
 * keeps an unrelated `NonNull` from some other library from being read as a
 * promise; a descriptor absent from both sets reads as `unstated`, which is
 * the answer this ingestion gave before the sets existed and is therefore
 * never a regression.
 *
 * The `Recently*` pair is what android.jar actually carries on surface
 * annotated after the fact, and it means the same thing.
 */
const NON_NULL_ANNOTATIONS: ReadonlySet<string> = new Set([
  "Landroid/annotation/NonNull;",
  "Landroidx/annotation/NonNull;",
  "Landroidx/annotation/RecentlyNonNull;",
  "Ljavax/annotation/Nonnull;",
  "Lorg/jetbrains/annotations/NotNull;",
]);

const NULLABLE_ANNOTATIONS: ReadonlySet<string> = new Set([
  "Landroid/annotation/Nullable;",
  "Landroidx/annotation/Nullable;",
  "Landroidx/annotation/RecentlyNullable;",
  "Ljavax/annotation/Nullable;",
  "Lorg/jetbrains/annotations/Nullable;",
]);

/**
 * What a set of annotation descriptors states about one position.
 *
 * A position carrying BOTH a non-null and a nullable annotation is a
 * contradiction in the class file rather than a case to resolve: picking a
 * side would be this ingestion deciding what the library meant. It reads as
 * `unstated`, which claims nothing.
 */
function nullabilityOf(
  annotations: readonly string[],
  type: JvmTypeReference,
): JvmNullability {
  /* Only a reference position HAS nullability. An annotation that landed on
   * an int says nothing about null, and recording it would put meaningless
   * variation into a snapshot that feeds a cache key. */
  if (type.kind === "primitive" || type.kind === "void") return "unstated";
  const nonNull = annotations.some((name) => NON_NULL_ANNOTATIONS.has(name));
  const nullable = annotations.some((name) => NULLABLE_ANNOTATIONS.has(name));
  if (nonNull && nullable) return "unstated";
  if (nonNull) return "non-null";
  if (nullable) return "nullable";
  return "unstated";
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
  /* JVMS 4.7.18 permits `num_parameters` to differ from the descriptor's
   * arity, and javac exercises that: an inner class's constructor omits its
   * synthetic leading parameters from the array. When the counts disagree
   * there is no alignment this code can justify — attaching a promise to the
   * wrong slot is worse than attaching none — so every parameter reads as
   * unstated, which is exactly what an unannotated class file gives. */
  const aligned =
    parsed.parameterAnnotations.length === signature.parameters.length;
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
    resultNullability: nullabilityOf(parsed.annotations, signature.result),
    parameterNullability: Object.freeze(
      signature.parameters.map((type, index) =>
        nullabilityOf(aligned ? parsed.parameterAnnotations[index]! : [], type)
      ),
    ),
  });
}

function freezeField(
  parsed: ParsedField,
  path: string,
  diagnostics: JvmDiagnostic[],
  selection: JvmField["selection"],
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
    nullability: nullabilityOf(parsed.annotations, type),
    selection,
  });
}

/**
 * A compile-time constant comes with its class.
 *
 * A `static final` field carrying a ConstantValue IS its value: projecting it
 * costs no call, no generated C, and no runtime — the manifest grows by a
 * literal. Making a program list each one was bookkeeping for a fact the
 * class file already states, and it cost a build per omission.
 *
 * Public only, because a constant the platform does not expose is not one a
 * program may name. A static final WITHOUT a ConstantValue is deliberately
 * not implied: reading one means a field access against a live class, which
 * is state crossing rather than a stated value, and a selection that names
 * one still gets that refusal.
 */
function isImpliedConstant(parsed: ParsedField): boolean {
  return (
    visibilityOf(parsed.accessFlags) === "public" &&
    (parsed.accessFlags & 0x0008) !== 0 &&
    (parsed.accessFlags & 0x0010) !== 0 &&
    parsed.constantValue !== null
  );
}

/**
 * Resolve bare-name and descriptor-qualified selections against a declared
 * member list. A bare name matching several overloads is refused with the
 * declared descriptors in the message, so the fix is copy-paste.
 */
/**
 * The nearest ancestor that DECLARES what `declares` is looking for, or
 * null when nothing in the chain does.
 *
 * Only the superclass chain, matching what ingestion implies: a member on
 * an implemented interface would resolve onto a class this projection does
 * not carry, so finding it there would trade one confusing failure for
 * another.
 */
function declaringAncestor(
  start: string,
  parsedByName: ReadonlyMap<string, ParsedClass>,
  declares: (parsed: ParsedClass) => boolean,
): string | null {
  const walked = new Set<string>([start]);
  let current = parsedByName.get(start);
  while (current !== undefined) {
    const kind = classKindOf(current.accessFlags);
    if (kind !== "class" && kind !== "enum") return null;
    const superName = current.superName;
    if (superName === null || walked.has(superName)) return null;
    const parsedSuper = parsedByName.get(superName);
    if (parsedSuper === undefined) return null;
    walked.add(superName);
    if (declares(parsedSuper)) return superName;
    current = parsedSuper;
  }
  return null;
}

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

  /* A class's ancestry comes with it.
   *
   * A class cannot BE itself without the chain above it: TextView is a
   * View, and projecting it without View drops every inherited member and
   * the upcast that makes the receiver usable where a View is wanted.
   * Requiring the chain to be listed made a caller discover it one failed
   * build at a time, and an ancestor with no selected members costs one
   * handle type and no generated C — so the boundary does not move, only
   * the number of rounds it takes to find it.
   *
   * Superclasses only, not interfaces. `extends` is what a projected class
   * needs to be itself; implying every implemented interface would sweep
   * in Serializable and Comparable, which say nothing about the surface a
   * program asked for.
   *
   * The walk stops at the first ancestor the sources do not carry, which
   * is the deliberate boundary an external reference already spells —
   * java/lang/Object is the usual one.
   */
  for (const binaryName of [...selections.keys()]) {
    /* A cycle is not well-formed and the JVM rejects one at load time, but
     * these bytes have not been loaded by anything. Remembering the walk
     * turns a hang with no diagnostic into an ordinary stop; the malformed
     * hierarchy is still reported downstream by whatever reads it. */
    const walked = new Set<string>([binaryName]);
    let current = parsedByName.get(binaryName);
    while (current !== undefined) {
      const kind = classKindOf(current.accessFlags);
      /* Every interface records Object as its superclass, so only a class
       * or enum has a meaningful one to walk. */
      if (kind !== "class" && kind !== "enum") break;
      const superName = current.superName;
      if (superName === null) break;
      if (walked.has(superName)) break;
      const parsedSuper = parsedByName.get(superName);
      if (parsedSuper === undefined) break;
      walked.add(superName);
      if (!selections.has(superName)) {
        const path = `class/${superName}`;
        selections.set(superName, {
          binaryName: superName,
          constructors: new Set<string>(),
          methods: normalizeMemberSelections([], `${path}/method`, diagnostics),
          fields: normalizeMemberSelections([], `${path}/field`, diagnostics),
          callbacks: normalizeCallbackSelections(
            [],
            `${path}/callback`,
            diagnostics,
          ),
        });
      }
      current = parsedSuper;
    }
  }

  /* A member resolves on the class that DECLARES it.
   *
   * `Button` inherits `setText` from `TextView`, so selecting it on Button
   * used to fail with "does not exist" — correct about the class file and
   * useless as advice, because the call is legal either way: the upcast
   * chain is what makes a Button usable where a TextView is wanted, and it
   * exists whether or not a caller knew which ancestor to name. This only
   * removes the requirement to know.
   *
   * Methods only. A constructor is never inherited. A callback is a native
   * method the class itself declares, so there is nothing to inherit. And
   * a FIELD deliberately stays put: a constant projects into a namespace
   * merged with its declaring class, and TypeScript does not inherit a
   * merged namespace through `extends`, so moving the selection would make
   * ingestion succeed while `Button.MAX_LINES` still did not resolve —
   * trading a clear refusal for a confusing one.
   */
  const movedMethods: {
    readonly from: string;
    readonly to: string;
    readonly name: string;
    readonly descriptor: string | null;
  }[] = [];
  for (const [binaryName, selection] of selections) {
    const parsed = parsedByName.get(binaryName);
    if (parsed === undefined) continue;
    for (const name of selection.methods.names) {
      /* Declared here — including an override, which is the class file's
       * own answer and needs no walk. */
      if (parsed.methods.some((method) => method.name === name)) continue;
      const owner = declaringAncestor(
        binaryName,
        parsedByName,
        (ancestor) => ancestor.methods.some((method) => method.name === name),
      );
      if (owner !== null) {
        movedMethods.push({ from: binaryName, to: owner, name, descriptor: null });
      }
    }
    for (const exact of selection.methods.exact.values()) {
      const declaredHere = parsed.methods.some(
        (method) =>
          method.name === exact.name && method.descriptor === exact.descriptor,
      );
      if (declaredHere) continue;
      const owner = declaringAncestor(
        binaryName,
        parsedByName,
        (ancestor) =>
          ancestor.methods.some(
            (method) =>
              method.name === exact.name &&
              method.descriptor === exact.descriptor,
          ),
      );
      if (owner !== null) {
        movedMethods.push({
          from: binaryName,
          to: owner,
          name: exact.name,
          descriptor: exact.descriptor,
        });
      }
    }
  }
  if (movedMethods.length > 0) {
    const rebuilt = new Map<
      string,
      { names: Set<string>; exact: Map<string, { name: string; descriptor: string }> }
    >();
    for (const [binaryName, selection] of selections) {
      rebuilt.set(binaryName, {
        names: new Set(selection.methods.names),
        exact: new Map(selection.methods.exact),
      });
    }
    for (const move of movedMethods) {
      /* The owner is always selected: it was reached by the same walk that
       * implied the ancestry above, so it is already in this map. */
      const from = rebuilt.get(move.from)!;
      const to = rebuilt.get(move.to)!;
      if (move.descriptor === null) {
        from.names.delete(move.name);
        to.names.add(move.name);
        continue;
      }
      const key = `${move.name} ${move.descriptor}`;
      from.exact.delete(key);
      to.exact.set(key, { name: move.name, descriptor: move.descriptor });
    }
    for (const [binaryName, selection] of [...selections.entries()]) {
      const methods = rebuilt.get(binaryName)!;
      selections.set(binaryName, { ...selection, methods });
    }
  }

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
    const namedFields = resolveMembers(
      parsed.fields,
      selection.fields,
      "field",
      `${path}/field`,
      diagnostics,
    );
    const namedFieldKeys = new Set(
      namedFields.map((field) => `${field.name} ${field.descriptor}`),
    );
    const fields = [
      ...namedFields.map((field) =>
        freezeField(field, `${path}/field/${field.name}`, diagnostics, "named"),
      ),
      ...parsed.fields
        .filter(
          (field) =>
            !namedFieldKeys.has(`${field.name} ${field.descriptor}`) &&
            isImpliedConstant(field),
        )
        .map((field) =>
          freezeField(
            field,
            `${path}/field/${field.name}`,
            diagnostics,
            "implied",
          ),
        ),
    ].filter((field): field is JvmField => field !== null);
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
    schemaVersion: 6,
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

/**
 * The classes that must accompany a selection for its ancestry to survive.
 *
 * Ingestion implies an ancestor it can SEE, but a caller that reads class
 * files out of an archive decides what ingestion can see before ingestion
 * runs — and an ancestor whose bytes were never extracted is not
 * present-but-unselected, it is absent. That distinction is invisible to
 * the guard inside ingestion and is exactly how an Android selection could
 * project `TextView` with an external `View` and lose every inherited
 * member without a diagnostic.
 *
 * So the caller asks first. `lookup` answers with a class's bytes or
 * undefined, and the walk stops where the archive stops, which is the same
 * boundary an external reference already spells.
 *
 * Returned in canonical order, and the input names are NOT included — this
 * answers "what else", so a caller can extract exactly the difference.
 *
 * `unavailable` is the other half, and it exists because stopping quietly
 * where the archive stops is how ancestry gets lost. An archive that is
 * SUPPOSED to be complete — android.jar carries every superclass of every
 * one of its 6,270 classes — has a real anomaly when it is not, and the
 * caller that knows completeness was expected is the one that can say so.
 * Reporting it here rather than refusing keeps the walk usable for callers
 * whose archive is deliberately partial.
 */
export interface JvmAncestryRequirement {
  readonly required: readonly string[];
  /** A class the walk reached whose superclass the archive does not carry.
   * Names WHO needed it, because the caller never wrote that name and an
   * error about a class absent from their input explains nothing. */
  readonly unavailable: readonly {
    readonly binaryName: string;
    readonly superclass: string;
  }[];
}

export function requiredJvmAncestry(
  lookup: (binaryName: string) => Uint8Array | undefined,
  selected: readonly string[],
): JvmAncestryRequirement {
  const have = new Set(selected);
  const added = new Set<string>();
  const unavailable: { binaryName: string; superclass: string }[] = [];
  for (const binaryName of selected) {
    /* A well-formed class hierarchy is acyclic and the JVM enforces it at
     * load time, but this reads bytes nobody has loaded yet. Walking a
     * cycle would hang a build with no diagnostic, so the walk remembers
     * where it has been and stops rather than trusting the input. */
    const walked = new Set<string>([binaryName]);
    let bytes = lookup(binaryName);
    while (bytes !== undefined) {
      const parsed = parseClassFile(bytes, `ancestry/${binaryName}`, []);
      if (parsed === null) break;
      const kind = classKindOf(parsed.accessFlags);
      if (kind !== "class" && kind !== "enum") break;
      const superName = parsed.superName;
      if (superName === null || walked.has(superName)) break;
      const superBytes = lookup(superName);
      if (superBytes === undefined) {
        unavailable.push({
          binaryName: parsed.binaryName,
          superclass: superName,
        });
        break;
      }
      walked.add(superName);
      if (!have.has(superName)) {
        have.add(superName);
        added.add(superName);
      }
      bytes = superBytes;
    }
  }
  return Object.freeze({
    required: Object.freeze([...added].sort(compareText)),
    unavailable: Object.freeze(
      unavailable
        .sort((left, right) =>
          compareText(left.binaryName, right.binaryName) ||
          compareText(left.superclass, right.superclass)
        )
        .map((entry) => Object.freeze(entry)),
    ),
  });
}
