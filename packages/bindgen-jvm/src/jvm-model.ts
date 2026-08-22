/**
 * The JVM analogue of the GIR model: what a bounded selection over Java
 * class-file metadata produces, and how ingestion fails.
 *
 * A class file is the platform's own authoritative metadata — it is what the
 * JVM itself loads — so ingestion is evidence, not inference. Everything the
 * snapshot states is read from the bytes; nothing is derived from a name or
 * a source-language convention.
 *
 * Diagnostic codes mirror the GIR taxonomy one range up:
 *   NTS6001 invalid caller input (selection, logical path, digest)
 *   NTS6002 malformed class file
 *   NTS6003 selected declaration or member does not exist
 *   NTS6004 selected declaration is outside the projection algebra
 *   NTS6005 malformed or unsupported metadata inside a well-formed file
 *   NTS6006 selection would silently lose ancestry
 *
 * NTS7xxx belongs to generation over an ingested snapshot:
 *   NTS7001 selected member is outside the generated-adapter algebra
 */

export type JvmDiagnosticCode =
  | "NTS6001"
  | "NTS6002"
  | "NTS6003"
  | "NTS6004"
  | "NTS6005"
  | "NTS6006"
  | "NTS7001";

export interface JvmDiagnostic {
  readonly code: JvmDiagnosticCode;
  readonly severity: "error";
  readonly path: string;
  readonly message: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedDiagnostics(
  diagnostics: readonly JvmDiagnostic[],
): readonly JvmDiagnostic[] {
  return Object.freeze(
    [...diagnostics]
      .sort((left, right) =>
        compareText(left.path, right.path) ||
        compareText(left.code, right.code) ||
        compareText(left.message, right.message)
      )
      .map((entry) => Object.freeze(entry)),
  );
}

function renderDiagnostics(
  stage: string,
  diagnostics: readonly JvmDiagnostic[],
): string {
  return `${stage} failed with ${diagnostics.length} error(s)\n${
    diagnostics
      .map(({ code, path, message }) => `${code} ${path}: ${message}`)
      .join("\n")
  }`;
}

export class JvmIngestionError extends Error {
  override readonly name = "JvmIngestionError";
  readonly diagnostics: readonly JvmDiagnostic[];

  constructor(diagnostics: readonly JvmDiagnostic[]) {
    const ordered = orderedDiagnostics(diagnostics);
    super(renderDiagnostics("JVM class metadata ingestion", ordered));
    this.diagnostics = ordered;
  }
}

export class JvmGenerationError extends Error {
  override readonly name = "JvmGenerationError";
  readonly diagnostics: readonly JvmDiagnostic[];

  constructor(diagnostics: readonly JvmDiagnostic[]) {
    const ordered = orderedDiagnostics(diagnostics);
    super(renderDiagnostics("JVM adapter generation", ordered));
    this.diagnostics = ordered;
  }
}

/**
 * One class file to ingest. `bytes` are the exact classfile bytes; the digest
 * is computed over them and optionally pinned. The logical path identifies
 * the source in diagnostics and in the snapshot — never a physical location.
 */
export interface JvmClassSource {
  readonly logicalPath: string;
  readonly bytes: Uint8Array;
  readonly expectedDigest?: string;
}

/**
 * A member selection. The string form selects by name and requires the name
 * to be unique among the class's declared members of that kind — overloads
 * make a bare name ambiguous, and the diagnostic lists the declared
 * descriptors so the fix is copy-paste. The object form is always exact.
 */
export type JvmMemberSelection =
  | string
  | { readonly name: string; readonly descriptor: string };

/** Which arm a VOID callback crosses on. `synchronous` runs the handler
 * during the caller's frame — the telling form, what a lifecycle override
 * needs because the framework observes it. `queued` copies the payload and
 * delivers at the runtime's pump — safe from any thread. */
export type JvmCallbackDelivery = "synchronous" | "queued";

/**
 * A callback selection. A void native method genuinely has both deliveries
 * and the class file cannot say which, so the selection must: `delivery` is
 * required for a void callback (which forces the exact object form) and
 * refused for an answered (boolean) one, whose single delivery is already
 * its own statement. The adapter owns that algebra; ingestion records the
 * stated delivery faithfully.
 */
export type JvmCallbackSelection =
  | string
  | {
      readonly name: string;
      readonly descriptor: string;
      readonly delivery?: JvmCallbackDelivery;
      readonly anchor?: JvmCallbackAnchor;
    };

/**
 * What a registration is attached to.
 *
 * `instance` is the default and the ordinary case: a program that holds
 * an object registers a handler on THAT object, and the trampoline finds
 * it by identity.
 *
 * `class` is for the objects a FRAMEWORK constructs. An Android Activity
 * is the case: the platform creates it, calls its lifecycle methods, and
 * never hands it over first — so there is no instant at which a program
 * could name the instance, and a per-instance registration is not late,
 * it is impossible. A class-anchored registration answers for every
 * instance of its class, and the receiver arrives as the handler's first
 * argument, which is the only way the handler can know which one called.
 */
export type JvmCallbackAnchor = "instance" | "class";

/**
 * A class to project, spelled as the class file spells it: the slashed
 * binary name (`java/lang/Object`, `fixture/Widget$Metrics`).
 *
 * Constructors are selected by descriptor alone — the descriptor IS a
 * constructor's identity, exactly as JNI's `GetMethodID(cls, "<init>", d)`
 * spells it. Members are the class's own declared members; inherited surface
 * comes from selecting the ancestor, as in GIR.
 */
export interface JvmClassSelection {
  readonly binaryName: string;
  readonly constructors?: readonly string[];
  readonly methods?: readonly JvmMemberSelection[];
  readonly fields?: readonly JvmMemberSelection[];
  /** Native methods selected as CALLBACK REGISTRATION points: TypeScript
   * provides the implementation Java calls, rather than calling in. The
   * member must carry ACC_NATIVE — that is the metadata fact that makes
   * RegisterNatives legal — and must not also be selected as a method. */
  readonly callbacks?: readonly JvmCallbackSelection[];
}

export interface JvmIngestionOptions {
  readonly classes: readonly JvmClassSelection[];
}

/**
 * A reference from one declaration to another. `internal` means the referent
 * is part of this selection; `external` is a deliberate boundary — the
 * selected surface stops there (`java/lang/Object` is the usual case).
 */
export interface JvmDeclarationReference {
  readonly kind: "internal" | "external";
  readonly binaryName: string;
}

export type JvmPrimitive =
  | "boolean"
  | "byte"
  | "char"
  | "short"
  | "int"
  | "long"
  | "float"
  | "double";

/**
 * A type as a descriptor spells it. `void` appears only as a method result;
 * ingestion rejects it anywhere else as malformed metadata.
 */
export type JvmTypeReference =
  | { readonly kind: "void" }
  | { readonly kind: "primitive"; readonly name: JvmPrimitive }
  | { readonly kind: "object"; readonly binaryName: string }
  | {
      readonly kind: "array";
      readonly dimensions: number;
      readonly element:
        | { readonly kind: "primitive"; readonly name: JvmPrimitive }
        | { readonly kind: "object"; readonly binaryName: string };
    };

/**
 * What a class file STATES about whether a reference position may be null.
 *
 * Three states rather than two, because "the library promised a value" and
 * "the library said nothing" are different facts even though both currently
 * lower to the same nullable slot. Collapsing them would throw away the only
 * evidence a later consumer has for tightening a signature.
 *
 * `unstated` is overwhelmingly the common case: nullability is a convention
 * carried by annotations, not something the JVM records, so a class compiled
 * without them says nothing at all.
 */
export type JvmNullability = "non-null" | "nullable" | "unstated";

export type JvmVisibility = "public" | "protected" | "package" | "private";

export interface JvmMethodAccess {
  readonly visibility: JvmVisibility;
  readonly static: boolean;
  readonly final: boolean;
  readonly abstract: boolean;
  readonly native: boolean;
  readonly synchronized: boolean;
  readonly bridge: boolean;
  readonly varargs: boolean;
  readonly synthetic: boolean;
}

export interface JvmFieldAccess {
  readonly visibility: JvmVisibility;
  readonly static: boolean;
  readonly final: boolean;
  readonly volatile: boolean;
  readonly transient: boolean;
  readonly enum: boolean;
  readonly synthetic: boolean;
}

export interface JvmClassAccess {
  readonly visibility: JvmVisibility;
  readonly final: boolean;
  readonly abstract: boolean;
  readonly synthetic: boolean;
}

/**
 * A `ConstantValue` a static final field carries. Integral values are
 * canonical decimal strings; floating values carry the exact IEEE-754 bit
 * pattern as fixed-width hex, because a decimal rendering of a float is a
 * formatting decision and the snapshot may feed a cache key.
 */
export type JvmConstantValue =
  | { readonly kind: "int"; readonly value: string }
  | { readonly kind: "long"; readonly value: string }
  | { readonly kind: "float"; readonly bits: string }
  | { readonly kind: "double"; readonly bits: string }
  | { readonly kind: "string"; readonly value: string };

export interface JvmMethod {
  readonly kind: "constructor" | "method";
  /** `<init>` for constructors, exactly as the class file spells it. */
  readonly name: string;
  /** The exact JVM descriptor — the identity JNI resolves the member by. */
  readonly descriptor: string;
  readonly access: JvmMethodAccess;
  readonly result: JvmTypeReference;
  readonly parameters: readonly JvmTypeReference[];
  /** Declared checked exceptions, from the `Exceptions` attribute. */
  readonly throws: readonly JvmDeclarationReference[];
  readonly deprecated: boolean;
  /**
   * The raw `Signature` attribute when the member is generic. Carried so a
   * consumer can detect erasure rather than discover it; the descriptor
   * remains the ABI identity.
   */
  readonly genericSignature: string | null;
  /**
   * What the class file states about the result, and about each parameter in
   * declaration order. A primitive or void position is always `unstated`:
   * nullability is not a property such a slot has, and recording an
   * annotation that landed on one would put meaningless variation into a
   * snapshot that feeds a cache key.
   */
  readonly resultNullability: JvmNullability;
  readonly parameterNullability: readonly JvmNullability[];
}

export interface JvmField {
  readonly name: string;
  readonly descriptor: string;
  readonly access: JvmFieldAccess;
  readonly type: JvmTypeReference;
  readonly constantValue: JvmConstantValue | null;
  readonly deprecated: boolean;
  readonly genericSignature: string | null;
  readonly nullability: JvmNullability;
}

/** Where a nested class sits, from the `InnerClasses` attribute. */
export interface JvmNesting {
  /** Null for a local or anonymous class, which has no enclosing member name. */
  readonly outer: string | null;
  /** Null for an anonymous class. */
  readonly innerName: string | null;
  readonly static: boolean;
}

export interface JvmClass {
  readonly kind: "class" | "interface" | "enum" | "annotation";
  readonly binaryName: string;
  readonly classfileVersion: {
    readonly major: number;
    readonly minor: number;
  };
  readonly access: JvmClassAccess;
  /** Null for interfaces and for `java/lang/Object` itself. */
  readonly superclass: JvmDeclarationReference | null;
  readonly interfaces: readonly JvmDeclarationReference[];
  /** Null for a top-level class. */
  readonly nested: JvmNesting | null;
  readonly deprecated: boolean;
  readonly genericSignature: string | null;
  readonly constructors: readonly JvmMethod[];
  readonly methods: readonly JvmMethod[];
  /** Selected callback registration points: native methods whose
   * implementation TypeScript provides. Always ACC_NATIVE. */
  readonly callbacks: readonly JvmCallback[];
  readonly fields: readonly JvmField[];
}

/** A selected callback: the native method plus the delivery the selection
 * stated, null when it stated none. Recording rather than resolving keeps
 * the delivery algebra — required on void, refused on answered — in the
 * adapter, beside the rest of the callback contract. */
export interface JvmCallback extends JvmMethod {
  readonly delivery: JvmCallbackDelivery | null;
  /** What the registration attaches to; `instance` unless stated. */
  readonly anchor: JvmCallbackAnchor;
}

export interface JvmSnapshot {
  readonly schema: "native-typescript.jvm-snapshot";
  readonly schemaVersion: 4;
  readonly sources: readonly {
    readonly logicalPath: string;
    readonly digest: string;
  }[];
  readonly classes: readonly JvmClass[];
}
