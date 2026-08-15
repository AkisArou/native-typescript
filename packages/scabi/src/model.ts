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

export interface NativeLayout {
  readonly size: number;
  readonly alignment: number;
  readonly packing: "default" | number;
  readonly triviallyCopyable: boolean;
  readonly destruction: "trivial" | "binding";
  /** Authoritative by-value ABI lowering. `indirect` means parameters are
   * copied into ABI-owned argument storage and results use caller-provided
   * return storage. Layout alone is deliberately not used to rediscover a
   * platform ABI's register-classification rules. */
  readonly abiPassing?: {
    readonly kind: "indirect";
    readonly alignment: number;
  };
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

export interface HandleType {
  readonly kind: "handle";
  readonly nativeName: string;
  readonly threadSafety: "confined" | "sendable" | "shared";
  readonly identity: "none" | "pointer" | "binding" | "platform";
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

export interface CallbackContract {
  readonly lifetime: "call" | "once" | "retained" | "weak" | "until-cancelled";
  readonly registrationOwner: string;
  readonly cancellationBinding?: NativeBindingId;
  readonly contextParameter?: string;
  readonly allowedInvocationExecutors: readonly ExecutorIdentity[];
  readonly deliveryExecutor: ExecutorIdentity;
  readonly synchronousReturn: boolean;
  readonly arguments: readonly CallbackArgumentContract[];
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

export interface ScabiManifest {
  readonly schema: "native-typescript.scabi";
  readonly schemaVersion: 1;
  readonly package: PackageIdentity;
  readonly target: TargetIdentity;
  readonly sdk: SdkIdentity;
  readonly generator: GeneratorIdentity;
  readonly declarations: DeclarationContract;
  readonly types: Readonly<Record<NativeTypeId, NativeType>>;
  readonly bindings: Readonly<Record<NativeBindingId, NativeBinding>>;
  readonly linkInputs: readonly LinkInput[];
  readonly adapterInputs: readonly AdapterInput[];
  readonly permissions: readonly PermissionRequirement[];
  readonly platform?: Readonly<Record<string, unknown>>;
}
