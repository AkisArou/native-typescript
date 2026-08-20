export type Sha256Digest = `sha256:${string}`;
export type NativeTypeId = string;
export type NativeBindingId = string;
export type LinkInputId = string;
export type AdapterInputId = string;
export type PermissionId = string;

export interface PackageIdentity {
  readonly name: string;
  readonly version: string;
  readonly namespace: string;
  readonly instance: string;
}

export interface TargetIdentity {
  readonly triple: string;
  readonly architecture: string;
  readonly pointerWidth: 32 | 64;
  readonly endianness: "little" | "big";
  readonly objectFormat: "elf" | "macho" | "coff" | "wasm";
  readonly minimumPlatformVersion: string;
  readonly abi: string;
  readonly features: readonly string[];
}

export interface SdkIdentity {
  readonly vendor: string;
  readonly name: string;
  readonly version: string;
  readonly metadataDigest: Sha256Digest;
  readonly toolchain: string;
  readonly toolchainVersion: string;
  readonly toolchainAbi: string;
  readonly deploymentTarget: string;
  readonly modules: readonly string[];
}

export interface GeneratorIdentity {
  readonly name: string;
  readonly version: string;
  readonly revision: string;
  readonly arguments: readonly string[];
  readonly inputDigests: readonly Sha256Digest[];
}

export interface VoidType {
  readonly kind: "void";
}

export interface IntegerType {
  readonly kind: "integer";
  readonly signed: boolean;
  readonly bits: 8 | 16 | 32 | 64 | "pointer";
}

export interface FloatType {
  readonly kind: "float";
  readonly bits: 32 | 64;
}

export interface BooleanType {
  readonly kind: "boolean";
  readonly storage: NativeTypeId;
  readonly falseValue: string;
  readonly trueValue: string;
}

export interface EnumType {
  readonly kind: "enum";
  readonly underlying: NativeTypeId;
  readonly members: Readonly<Record<string, string>>;
}

export interface FlagsType {
  readonly kind: "flags";
  readonly underlying: NativeTypeId;
  readonly members: Readonly<Record<string, string>>;
}

export interface PointerType {
  readonly kind: "pointer";
  readonly pointee: NativeTypeId;
  readonly mutability: "const" | "mutable";
  readonly nullable: boolean;
  readonly addressSpace: number;
}

export interface ArrayType {
  readonly kind: "array";
  readonly element: NativeTypeId;
  readonly length: number;
}

export interface SliceType {
  readonly kind: "slice";
  readonly element: NativeTypeId;
  readonly pointerType: NativeTypeId;
  readonly lengthType: NativeTypeId;
  readonly mutability: "const" | "mutable";
}

export interface NativeField {
  readonly name: string;
  readonly type: NativeTypeId;
  readonly offset: number;
  readonly bitField?: {
    readonly bitOffset: number;
    readonly bitWidth: number;
  };
  /** See {@link AbiResult.conversion}. The field keeps its exact storage; only
   * the source view of it changes. */
  readonly conversion?: NumberConversion;
}

/**
 * The source-visible carrier for a position whose native representation is an
 * exact integer.
 *
 * `"number"` declares the JavaScript-number conversion policy: the source sees
 * an ordinary `number`, an argument is checked into the native integer at the
 * boundary — finite, integral, in range, or a catchable TypeError — and a
 * result or field widens out of it exactly. Only an integer of at most 32 bits
 * may declare it, because a double carries wider integers non-injectively and
 * a silently rounded value is worse than a refused one.
 *
 * Absence is not a default policy but the other option: the position carries
 * the exact native representation, which is the only honest carrier for a
 * 64-bit or pointer-width integer.
 */
export type NumberConversion = "number";

export type NativePhysicalAbiType =
  | { readonly kind: "void" }
  | { readonly kind: "integer"; readonly bits: number }
  | {
      readonly kind: "float";
      readonly format: "half" | "bfloat" | "float" | "double" | "fp128" | "x86_fp80";
    }
  | { readonly kind: "pointer"; readonly addressSpace: number }
  | { readonly kind: "array"; readonly count: number; readonly element: NativePhysicalAbiType }
  | {
      readonly kind: "vector";
      readonly count: number;
      readonly scalable: boolean;
      readonly element: NativePhysicalAbiType;
    }
  | {
      readonly kind: "struct";
      readonly packed: boolean;
      readonly fields: readonly NativePhysicalAbiType[];
    }
  | { readonly kind: "aggregate" };

export interface NativePhysicalAbiValue {
  readonly type: NativePhysicalAbiType;
  readonly alignment: number | null;
  readonly stackAlignment: number | null;
  readonly extension: "sign" | "zero" | null;
  readonly inRegister: boolean;
  readonly byValue: boolean;
  readonly structureReturn: boolean;
}

export interface NativeAggregateAbiPassing {
  readonly result: NativePhysicalAbiValue;
  readonly parameters: readonly NativePhysicalAbiValue[];
}

export interface NativeLayout {
  readonly size: number;
  readonly alignment: number;
  readonly packing: "default" | number;
  readonly triviallyCopyable: boolean;
  readonly destruction: "trivial" | "binding";
  /** Authoritative target-compiler classification of an identity function
   * that returns and accepts this nominal aggregate by value. */
  readonly abiPassing?: NativeAggregateAbiPassing;
}

export interface StructType extends NativeLayout {
  readonly kind: "struct";
  readonly fields: readonly NativeField[];
}

export interface UnionType extends NativeLayout {
  readonly kind: "union";
  readonly fields: readonly NativeField[];
  readonly discriminator?: NativeTypeId;
}

export interface OpaqueValueType extends NativeLayout {
  readonly kind: "opaque-value";
  readonly nativeName: string;
}

/** A direct, representation-preserving conversion to another opaque handle
 * type. Casts that adjust or query the foreign pointer require an adapter
 * binding and are deliberately not described as identity upcasts. */
export interface IdentityHandleUpcast {
  readonly kind: "identity";
  readonly target: NativeTypeId;
}

export interface HandleType {
  readonly kind: "handle";
  readonly nativeName: string;
  readonly threadSafety: "confined" | "sendable" | "shared";
  readonly identity: "none" | "pointer" | "binding" | "platform";
  readonly upcasts: readonly IdentityHandleUpcast[];
  /**
   * The binding that releases one reference to this object.
   *
   * How a handle is released is a property of what it names rather than of
   * the call that produced one: every producer of a GdkDisplay hands back the
   * same object, and one function ends this program's claim on it. Naming it
   * here is what lets an owned position exist at all — a position of this
   * type names no destructor of its own — and what lets a package that
   * imports the type receive one, since importing the type imports this.
   *
   * Absent when nothing owns one: a handle only ever borrowed needs no way to
   * be released, and inventing one would be an ownership-consuming call
   * outside the destructor slice.
   */
  readonly destructor?: NativeBindingId;
}

export interface CallbackContext {
  readonly placement: "none" | "first" | "last";
  readonly type?: NativeTypeId;
}

export interface CallbackType {
  readonly kind: "callback";
  readonly signature: FunctionSignature;
  readonly context: CallbackContext;
}

export type NativeType =
  | VoidType
  | IntegerType
  | FloatType
  | BooleanType
  | EnumType
  | FlagsType
  | PointerType
  | ArrayType
  | SliceType
  | StructType
  | UnionType
  | OpaqueValueType
  | HandleType
  | CallbackType
;

export type OwnershipContract =
  | { readonly kind: "value" }
  | {
      readonly kind: "borrowed";
      readonly scope:
        | "call"
        | "callback"
        | "receiver"
        | "registration"
        | "returned-owner";
      readonly anchor?: string;
    }
  | {
      readonly kind: "owned";
      readonly transfer: "to-runtime";
      /**
       * The binding that releases this value, named here because its type
       * cannot name one: one `u8*` is freed by the allocator that produced it
       * and another is not, so the producer is the only honest place to say
       * so. A handle names its destructor on the type instead, and an owned
       * handle position that repeats it here is refused.
       */
      readonly destructor?: NativeBindingId;
    }
  | { readonly kind: "owned"; readonly transfer: "to-native" }
  | { readonly kind: "call-scoped" };

export type MarshallingContract =
  | {
      readonly kind: "string";
      readonly encoding: "utf-8";
      readonly length:
        | { readonly kind: "parameter"; readonly parameter: string }
        | { readonly kind: "nul" };
      readonly termination: "none" | "nul";
      readonly embeddedNul: "allow" | "reject";
      /**
       * What frees the pointer once its bytes have been copied, for a RESULT
       * the caller must dispose of. Absent for a string the callee keeps and
       * for every input.
       *
       * The same field a string vector carries, because it is the same
       * question about the same kind of pointer — what ends this program's
       * claim on it. An owned `char *` and an owned `char **` differ in what
       * is copied, not in what happens afterwards.
       */
      readonly release?: string;
    }
  | {
      readonly kind: "bytes";
      /**
       * Where the extent comes from, for an INPUT: a sibling position the
       * caller fills, and WHAT IT COUNTS.
       *
       * `units` is required rather than defaulted. Both readings exist in
       * real signatures — a `memcpy`-shaped function takes bytes, an
       * array-shaped one takes elements — and for `u8` they are the same
       * number, which is exactly how a compiler projection named for bytes
       * emitted an element count for as long as only `u8` crossed. Which
       * count a foreign signature takes is an ABI-adjacent fact, and this
       * manifest does not infer those.
       *
       * Absent on a RESULT, and deliberately not reused there. A returned
       * span's length is written by the callee into a slot the compiler owns
       * and no manifest names — the same footing as the trailing error slot.
       * Spelling the two the same way would make one field mean "the caller
       * filled this" in one position and "the callee wrote this" in another,
       * distinguished only by where you found it.
       */
      readonly length?: {
        readonly kind: "parameter";
        readonly parameter: string;
        readonly units: "elements" | "bytes";
      };
      readonly mutability: "const" | "mutable";
      /**
       * The span's element, for a RESULT. Absent means `u8`, which is what
       * every span meant before wider elements crossed.
       *
       * Carried in both directions now that the length beside an input says
       * what it counts. A result's length is the compiler's own slot and
       * counts ELEMENTS by construction; an input's says so explicitly.
       */
      readonly elem?: "u8" | "u32" | "i32" | "f32";
      /**
       * What frees the span once its bytes have been copied, for a RESULT the
       * caller must dispose of. Absent for a span the callee keeps and for
       * every input.
       *
       * The same field a string and a string vector carry, because it is the
       * same question about the same kind of pointer.
       */
      readonly release?: string;
    }
  /**
   * A vector of C strings ending at a NULL slot — what a C API means by
   * `char **`. The element type is not stated here because the position's
   * own type states it: the slot is a pointer whose pointee is the string
   * type, so the vector is described where every other type is.
   *
   * A COUNTED vector, whose length arrives in a separate position rather than
   * as a terminator, is a different contract and is not implemented. It is
   * absent rather than defaulted so that a generator meeting one produces a
   * diagnostic instead of a vector that ends in the wrong place.
   */
  | {
      readonly kind: "string-vector";
      readonly encoding: "utf-8";
      readonly termination: "nul";
      /** How an element carrying a NUL byte is treated. `reject` is the only
       * implemented answer: such a string has no `char *` form, and storing
       * the absence would end the vector where the element is. */
      readonly embeddedNul: "reject";
      /**
       * What frees the vector once its elements have been copied, for a
       * RESULT the caller must dispose of. Absent for a vector the callee
       * keeps and for every input, where the caller frees nothing.
       *
       * A symbol rather than a policy, which is what lets one contract cover
       * conventions an SDK distinguishes: a transfer that hands over the
       * elements too and one that hands over only the vector differ in which
       * function frees it and in nothing else.
       */
      readonly release?: string;
    };

export type PassMode = "value" | "pointer" | "hidden-return";

export interface AbiResult {
  readonly type: NativeTypeId;
  readonly passMode: PassMode;
  readonly nullable: boolean;
  readonly ownership: OwnershipContract;
  readonly marshal?: MarshallingContract;
  /** The source-visible carrier for this position when it is not the native
   * type's own representation. See {@link NumberConversion}. */
  readonly conversion?: NumberConversion;
}

export interface AbiParameter extends AbiResult {
  readonly name: string;
  readonly callback?: CallbackContract;
}

export interface FunctionSignature {
  readonly callingConvention: "c";
  readonly variadic: false;
  readonly parameters: readonly AbiParameter[];
  readonly result: AbiResult;
}

/** The three the compiler reasons about, plus one it does not: a named
 * dispatcher is an identity the embedder resolves. A platform's UI thread is
 * `named("ui")` rather than a case in a compiler's vocabulary. */
export type ExecutorIdentity =
  | { readonly kind: "runtime-owner" }
  | { readonly kind: "any-attached-thread" }
  | { readonly kind: "same-as-caller" }
  | { readonly kind: "named-dispatcher"; readonly name: string };

export interface ThreadContract {
  readonly executor: ExecutorIdentity;
  readonly behavior:
    | "require"
    | "dispatch-async"
    | "dispatch-sync"
    | "any";
  readonly blocking: boolean;
}

export interface CallbackArgumentContract {
  readonly parameter: string;
  readonly transport: "borrow" | "copy" | "retain" | "transfer";
}

export type CallbackSourceArgumentContract =
  | {
      readonly kind: "callback-parameter";
      readonly parameter: string;
    }
  | { readonly kind: "registration-owner" };

export interface CallbackContract {
  /** What owns the registration, and therefore how long it lives:
   * `"native-call"` for a call-scoped callback, `"result"` for one the
   * returned value owns, or the name of the parameter that owns it. A
   * separate lifetime would say the same thing a second time and could
   * disagree with this one.
   *
   * The delivery executor is likewise absent: it follows from the owner and
   * from `synchronousReturn`, and the compiler derives it. */
  readonly registrationOwner: string;
  readonly cancellationBinding?: NativeBindingId;
  readonly contextParameter?: string;
  readonly allowedInvocationExecutors: readonly ExecutorIdentity[];
  readonly synchronousReturn: boolean;
  readonly arguments: readonly CallbackArgumentContract[];
  /** Ordered managed callback parameters. Omission is the identity projection
   * of physical callback parameters in ABI order. */
  readonly sourceArguments?: readonly CallbackSourceArgumentContract[];
}

/** The conventions with a lowering behind them. The compiler expresses these
 * as three orthogonal axes — how a failure is recognised, where its message
 * comes from, what must be released — so a convention this list does not name
 * is usually one detector away rather than a new concept. It is added here
 * when a binding needs it, never before. */
export type ErrorContract =
  | { readonly kind: "no-fail" }
  | { readonly kind: "nullable" }
  | { readonly kind: "errno"; readonly failureValue: string }
  /** The operation returns an owned error object, or null on success. The
   * message is read through `message` and copied into the thrown error, then
   * the object is released through `release` — including when a callback has
   * already left an exception pending, so it is never stranded. Requires the
   * `error-channel` result projection, which is what keeps the pointer from
   * becoming a source value. */
  | {
      readonly kind: "error-handle";
      readonly message: NativeBindingId;
      readonly release: NativeBindingId;
    }
  /** The operation writes an owned error object into a trailing slot and keeps
   * its own result — which is what a `GError **` parameter is, and what lets a
   * failable operation hand something back. Read and released exactly as
   * `error-handle` is; the difference is only where the object arrives, and
   * therefore whether the result is free to mean something. */
  | {
      readonly kind: "error-out";
      readonly message: NativeBindingId;
      readonly release: NativeBindingId;
    };

export interface BindingDependencies {
  readonly bindings: readonly NativeBindingId[];
  readonly linkInputs: readonly LinkInputId[];
  readonly adapterInputs: readonly AdapterInputId[];
  readonly permissions: readonly PermissionId[];
}

export interface BindingAvailability {
  readonly minimumPlatformVersion: string;
  readonly unavailableFeatures: readonly string[];
}

export interface DeclarationReference {
  readonly module: string;
  readonly name: string;
}

/** Source declarations covered by this manifest. Native type IDs are ABI
 * identities and need not resemble their exported TypeScript names, so the
 * relationship is explicit rather than inferred from spelling. */
export interface DeclarationContract {
  readonly digest: Sha256Digest;
  readonly types: Readonly<Record<NativeTypeId, DeclarationReference>>;
}

export type CallableBindingKind =
  | "function"
  | "constructor"
  | "factory"
  | "method"
  | "static-method"
  | "getter"
  | "setter"
  | "listener"
  | "export";

export interface CallableBinding {
  readonly kind: CallableBindingKind;
  readonly declaration: DeclarationReference;
  /** How the call is materialized. One field today, because a C symbol is the
   * only call target implemented, and a record rather than a bare string
   * because that is the position a descriptor or a capsule occupies when
   * another one is.
   *
   * It used to carry `kind: "c-symbol" | "adapter-symbol"`, which was build
   * information wearing a signature costume: who PRODUCES a symbol — the SDK
   * or a generated adapter — changes what gets built and nothing about the
   * call. The adapter input already lists the bindings it provides, so the
   * envelope said it twice and could say it two ways. */
  readonly entry: {
    readonly symbol: string;
  };
  readonly signature: FunctionSignature;
  readonly thread: ThreadContract;
  readonly error: ErrorContract;
  readonly dependencies: BindingDependencies;
  readonly availability?: BindingAvailability;
}

export interface ConstantBinding {
  readonly kind: "constant";
  readonly declaration: DeclarationReference;
  readonly type: NativeTypeId;
  readonly value: string | number | boolean;
  readonly dependencies: BindingDependencies;
  readonly availability?: BindingAvailability;
}

export type NativeBinding = CallableBinding | ConstantBinding;

export interface LinkInput {
  readonly id: LinkInputId;
  readonly kind:
    | "static-library"
    | "shared-library"
    | "system-library"
    | "framework"
    | "object"
    | "weak-import"
    | "link-group"
    | "exported-symbol-list"
    | "runtime-component";
  readonly name: string;
  readonly order: number;
}

export interface AdapterInput {
  readonly id: AdapterInputId;
  readonly family: string;
  readonly language: "c" | "c++" | "objective-c++" | "java" | "kotlin" | "swift";
  readonly bindings: readonly NativeBindingId[];
  readonly outputs: readonly string[];
  readonly options: Readonly<Record<string, string | number | boolean>>;
}

export interface PermissionRequirement {
  readonly id: PermissionId;
  readonly kind: string;
  readonly description: string;
}

/**
 * A native type this manifest references but another package defines.
 *
 * The owning package identity is explicit because a native type's compiler
 * identity is scoped to the package instance that defines it. An importer must
 * name that instance to reference the same type, and composition verifies the
 * import against the package that actually provides it.
 *
 * `type` is the type's ID inside the owning package, which need not match the
 * ID the importer uses locally.
 */
export interface TypeImport {
  readonly package: PackageIdentity;
  readonly type: NativeTypeId;
  /**
   * The owning package's binding that releases one reference, when this
   * import is owned here.
   *
   * A handle names its destructor on its type, and an importer never sees the
   * definition — so owning one means restating which binding that is, in the
   * owner's identity. Like the type ID itself this is derived by the same
   * function that produced it in the owning package rather than kept by hand,
   * and composition proves the two agree.
   */
  readonly destructor?: NativeBindingId;
}

/**
 * The manifest format's current version, exported so a producer names it once
 * rather than carrying a literal.
 *
 * Every bump before this one required every producer to edit its own copy,
 * and each time a producer that had not yet edited it stopped compiling
 * against a workspace that had. That is a coordination cost with no
 * information in it: a producer does not choose the version, it reports the
 * one it was built against.
 */
export const SCABI_SCHEMA_VERSION = 8;

export interface ScabiManifest {
  readonly schema: "native-typescript.scabi";
  readonly schemaVersion: typeof SCABI_SCHEMA_VERSION;
  readonly package: PackageIdentity;
  readonly target: TargetIdentity;
  readonly sdk: SdkIdentity;
  readonly generator: GeneratorIdentity;
  readonly declarations: DeclarationContract;
  /** Native types owned by other packages. Absent when nothing is imported. */
  readonly imports?: Readonly<Record<NativeTypeId, TypeImport>>;
  readonly types: Readonly<Record<NativeTypeId, NativeType>>;
  readonly bindings: Readonly<Record<NativeBindingId, NativeBinding>>;
  readonly linkInputs: readonly LinkInput[];
  readonly adapterInputs: readonly AdapterInput[];
  readonly permissions: readonly PermissionRequirement[];
  readonly platform?: Readonly<Record<string, unknown>>;
}
