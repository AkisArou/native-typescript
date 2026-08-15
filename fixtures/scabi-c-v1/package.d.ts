declare const nativeScalar: unique symbol;
declare const nativeResource: unique symbol;
declare const nativeCounterBaseResource: unique symbol;
declare const nativeCounterMiddleResource: unique symbol;

type NativeScalar<Name extends string, Carrier> = Carrier & {
  readonly [nativeScalar]: Name;
};

export type i8 = NativeScalar<"i8", number>;
export type u8 = NativeScalar<"u8", number>;
export type i16 = NativeScalar<"i16", number>;
export type u16 = NativeScalar<"u16", number>;
export type i32 = NativeScalar<"i32", number>;
export type u32 = NativeScalar<"u32", number>;
export type i64 = NativeScalar<"i64", bigint>;
export type u64 = NativeScalar<"u64", bigint>;
export type usize = NativeScalar<"usize", bigint>;
export type f32 = NativeScalar<"f32", number>;
export type f64 = NativeScalar<"f64", number>;

export interface Padded {
  readonly tag: u8;
  readonly value: u64;
  readonly ratio: f64;
}

export interface Pair32 {
  readonly first: i32;
  readonly second: i32;
}

export interface OwnedBytes {
  readonly [nativeResource]: "OwnedBytes";
  dispose(): void;
}

export interface Subscription {
  readonly [nativeResource]: "Subscription";
  emit(value: i32): i32;
  emitForeign(value: i32): i32;
  dispose(): void;
}

export interface CounterBase {
  readonly [nativeCounterBaseResource]: true;
  value(): i32;
}

export interface CounterMiddle extends CounterBase {
  readonly [nativeCounterMiddleResource]: true;
}

export interface Counter extends CounterMiddle {
  readonly [nativeResource]: "Counter";
  add(delta: i32): i32;
  label(): string | null;
  requiredLabel(): string;
  dispose(): void;
}

export declare function i8Identity(value: i8): i8;
export declare function u8Identity(value: u8): u8;
export declare function i16Identity(value: i16): i16;
export declare function u16Identity(value: u16): u16;
export declare function i32Identity(value: i32): i32;
export declare function u32Identity(value: u32): u32;
export declare function i64Identity(value: i64): i64;
export declare function u64Identity(value: u64): u64;
export declare function usizeIdentity(value: usize): usize;
export declare function f32Identity(value: f32): f32;
export declare function f64Identity(value: f64): f64;
export declare function nativeFalse(): boolean;
export declare function nativeInvalidBoolean(): boolean;
export declare function nativeNot(value: boolean): boolean;
export declare function nativeTrue(): boolean;
export declare function paddedRoundtrip(value: Padded): Padded;
export declare function pair32Transform(value: Pair32): Pair32;
export declare function hashUtf8(value: string): u64;
export declare function cStringObserve(value: string): void;
export declare function hashBytes(value: Uint8Array): u64;
export declare function allocateBytes(length: usize): OwnedBytes;
export declare function callScoped(
  callback: (value: i32) => i32,
  value: i32,
): i32;
export declare function subscribe(
  callback: (value: i32) => void,
): Subscription;
export declare function createCounter(initialValue: i32): Counter;
export declare function counterDestroyedCount(): i32;
export declare function counterVerify(
  actualValue: i32,
  actualDestroyed: i32,
  expectedValue: i32,
  expectedDestroyed: i32,
): i32;
export declare function failErrno(errorNumber: i32): never;

export interface FixtureLibraryExports {
  ntsTsAddI32(left: i32, right: i32): i32;
}
