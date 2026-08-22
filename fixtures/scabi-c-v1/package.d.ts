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

/* The conversions between an exact scalar and an ordinary number. The
 * translator synthesizes one pair for every exact type a manifest reaches;
 * declaring them is what makes them callable. They are operations because no
 * syntax names a direction, and named rather than spelled `Number(v)` and
 * `BigInt(n)` because JavaScript's conversions mean something else at an
 * exact width: one rounds silently where this refuses, and the other is
 * arbitrary precision where this slot is 64 bits wide.
 *
 * `fromNumber` throws a TypeError on a value the slot cannot hold; `toNumber`
 * throws a RangeError past 32 bits when the double would not denote the same
 * integer. Arithmetic needs nothing here: `(a / b) as i32` is an ordinary
 * operator expression inside its construction. */
export declare namespace i32 {
  function toNumber(value: i32): number;
  function fromNumber(value: number): i32;
}

export declare namespace u32 {
  function toNumber(value: u32): number;
  function fromNumber(value: number): u32;
}

export declare namespace i64 {
  function toNumber(value: i64): number;
  function fromNumber(value: number): i64;
}

export declare namespace u64 {
  function toNumber(value: u64): number;
  function fromNumber(value: number): u64;
}

export declare namespace f64 {
  function toNumber(value: f64): number;
  function fromNumber(value: number): f64;
}

export interface Padded {
  readonly tag: u8;
  readonly value: u64;
  readonly ratio: f64;
}

export interface Pair32 {
  readonly first: i32;
  readonly second: i32;
}

export interface NestedPair32 {
  readonly left: Pair32;
  readonly right: Pair32;
  readonly marker: i64;
}

export interface OwnedBytes {
  readonly [nativeResource]: "OwnedBytes";
  dispose(): void;
}

/* Accepts an optional counter: null is a valid argument, not a failure. */
export declare function counterValueOr(
  counter: Counter | null,
  fallback: i32,
): i32;

/* The same over the base of the hierarchy, so a derived handle widens into
 * the optional slot rather than being refused by it. */
export declare function counterBaseValueOr(
  counter: CounterBase | null,
  fallback: i32,
): i32;

export interface Subscription {
  readonly [nativeResource]: "Subscription";
  emit(value: i32): i32;
  emitForeign(value: i32): i32;
  dispose(): void;
}

/* Two synchronous registrations that hand the handler an OBJECT while it runs
 * inside the caller's frame — the pair neither delivery shape could express
 * before. The counter is the handler's: it arrives with a reference, and the
 * cell that receives it is what gives that reference back. */
export interface Teller {
  readonly [nativeResource]: "Teller";
  /* Invokes the handler and then reads its mark, so a delivery that arrived on
   * a later turn answers 0 where the truth is 1. */
  tell(seed: i32): i32;
  dispose(): void;
}

/* The `onKeyDown` shape: answers a boolean while holding both a scalar and an
 * object. */
export interface Judge {
  readonly [nativeResource]: "Judge";
  ask(code: i32, seed: i32): i32;
  /* The same question where the subject may be absent. */
  askMaybe(code: i32, seed: i32): i32;
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

/* The same C identity through the JavaScript-number carrier: the source sees
 * an ordinary number, checked into the exact slot at the boundary and widened
 * back out of it. A second binding over one symbol, which is legal because a
 * binding declares a contract — only one of them may be reached per program. */
export declare function numberI32Identity(value: number): number;
export declare function numberU32Identity(value: number): number;
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
export declare function nestedPair32Transform(value: NestedPair32): NestedPair32;
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
export declare function tellWith(callback: (subject: Counter) => void): Teller;
export declare function tellMark(): void;
export declare function judgeWith(
  callback: (code: i32, subject: Counter) => boolean,
): Judge;
/* A registration nothing owns — no handle comes back, and nothing can cancel
 * it, because there is no receiver whose lifetime bounds it. */
export declare function noticeWith(callback: (subject: Counter) => void): void;
export declare function noticeMark(): void;
export declare function noticeFire(seed: i32): i32;

/* A native class a TypeScript class may EXTEND. The platform shape: the
 * framework constructs the object and calls a member on it, so the program
 * declares the member rather than registering a function, and `this` is the
 * object the framework made. */
export declare class TickSource {
  dispose(): void;
  value(): i32;
  /* What `super.onTick(...)` reaches. Declared on the base because that is
   * where the base implementation lives; the manifest names the binding. */
  baseTick(seed: i32): void;
  /* The member a subclass overrides. A platform base really does declare its
   * lifecycle members — Activity declares onCreate — so `override` is legal
   * for the ordinary TypeScript reason rather than by special arrangement. */
  onTick(seed: i32): void;
}
export declare function tickMark(): void;
export declare function tickFire(seed: i32): i32;
/* The same registration where the payload may be absent: the handler receives
 * `Counter | null` and tests it, because a platform that hands a lifecycle an
 * object on one call and nothing on another is describing a value rather than
 * a failure. */
export declare function maybeWith(
  callback: (subject: Counter | null) => void,
): void;
export declare function maybeMark(): void;
export declare function maybeFire(seed: i32): i32;
/* The owner-scoped withheld payload: answers while holding a subject that may
 * not be there, and the receiver's disposal is what cancels it. */
export declare function maybeJudgeWith(
  callback: (code: i32, subject: Counter | null) => boolean,
): Judge;
/* UTF-8 text arriving as a pointer and a length rather than a terminator, so
 * the bytes may contain NUL. The fixture's label does. */
export declare function spanLabel(): string;
export declare function spanLabelMaybe(which: i32): string | null;
export declare function failErrno(errorNumber: i32): never;
/* Reports failure by returning an owned error object rather than a code. */
export declare function errorHandleFail(code: i32): void;
/** Fails through a trailing slot, so the quotient survives the call. */
export declare function errorOutDivide(numerator: i32, divisor: i32): i32;
/** The same trailing slot under a sub-word result, in both signednesses. */
export declare function errorOutU8(value: i32): u8;
export declare function errorOutI8(value: i32): i8;
export declare function fixtureErrorsOutstanding(): i32;

export interface FixtureLibraryExports {
  ntsTsAddI32(left: i32, right: i32): i32;
}
