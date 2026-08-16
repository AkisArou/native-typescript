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
}

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

export interface PlatformObjectType {
  readonly kind: "platform-object";
  readonly family: string;
  readonly nativeName: string;
  readonly threadSafety: "confined" | "sendable" | "shared";
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
  | PlatformObjectType;

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
      readonly destructor: NativeBindingId;
    }
  | { readonly kind: "owned"; readonly transfer: "to-native" }
  | {
      readonly kind: "retained";
      readonly retain: NativeBindingId;
      readonly release: NativeBindingId;
    }
  | { readonly kind: "weak"; readonly upgrade: NativeBindingId }
  | { readonly kind: "autoreleased"; readonly retain: NativeBindingId }
  | { readonly kind: "call-scoped" }
  | { readonly kind: "process-proxy"; readonly release: NativeBindingId };

export type MarshallingContract =
  | {
      readonly kind: "string";
      readonly encoding: "utf-8" | "utf-16" | "latin-1";
      readonly length:
        | { readonly kind: "parameter"; readonly parameter: string }
        | { readonly kind: "nul" };
      readonly termination: "none" | "nul";
      readonly embeddedNul: "allow" | "reject";
    }
  | {
      readonly kind: "bytes";
      readonly length: { readonly kind: "parameter"; readonly parameter: string };
      readonly mutability: "const" | "mutable";
    };

export type PassMode =
  | "value"
  | "pointer"
  | "reference"
  | "hidden-return"
  | "platform-object";

export interface AbiResult {
  readonly type: NativeTypeId;
  readonly passMode: PassMode;
  readonly nullable: boolean;
  readonly ownership: OwnershipContract;
  readonly marshal?: MarshallingContract;
}

export interface AbiParameter extends AbiResult {
  readonly name: string;
  readonly callback?: CallbackContract;
}

export interface FunctionSignature {
  readonly callingConvention:
    | "c"
    | "system"
    | "stdcall"
    | "fastcall"
    | "thiscall"
    | "vectorcall";
  readonly variadic: false;
  readonly parameters: readonly AbiParameter[];
  readonly result: AbiResult;
}

export type ExecutorIdentity =
  | { readonly kind: "runtime-owner" }
  | { readonly kind: "platform-ui" }
  | { readonly kind: "any-attached-thread" }
  | { readonly kind: "same-as-receiver" }
  | { readonly kind: "same-as-caller" }
  | { readonly kind: "callback-defined" }
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
  readonly lifetime: "call" | "once" | "retained" | "weak" | "until-cancelled";
  readonly registrationOwner: string;
  readonly cancellationBinding?: NativeBindingId;
  readonly contextParameter?: string;
  readonly allowedInvocationExecutors: readonly ExecutorIdentity[];
  readonly deliveryExecutor: ExecutorIdentity;
  readonly synchronousReturn: boolean;
  readonly arguments: readonly CallbackArgumentContract[];
  /** Ordered managed callback parameters. Omission is the identity projection
   * of physical callback parameters in ABI order. */
  readonly sourceArguments?: readonly CallbackSourceArgumentContract[];
  readonly reentrancy: "forbidden" | "allowed" | "required";
  readonly postDisposal: "not-invoked" | "may-race";
  readonly shutdown: "drain" | "discard";
}

export type ErrorContract =
  | { readonly kind: "no-fail" }
  | { readonly kind: "nullable" }
  | { readonly kind: "sentinel"; readonly failureValue: string }
  | { readonly kind: "errno"; readonly failureValue: string }
  | { readonly kind: "status-code"; readonly successValues: readonly string[] }
  | { readonly kind: "hresult" }
  | { readonly kind: "jni-pending-exception" }
  | { readonly kind: "nserror"; readonly parameter: string }
  | { readonly kind: "platform-exception"; readonly adapter: AdapterInputId }
  | {
      readonly kind: "async-callback";
      readonly successCallback: string;
      readonly errorCallback: string;
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
  readonly entry: {
    readonly kind: "c-symbol" | "adapter-symbol";
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
}

export interface ScabiManifest {
  readonly schema: "native-typescript.scabi";
  readonly schemaVersion: 1;
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
