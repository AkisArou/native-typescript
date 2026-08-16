declare const nativeScalar: unique symbol;
declare const nativeResource: unique symbol;

type NativeScalar<Name extends string, Carrier> = Carrier & {
  readonly [nativeScalar]: Name;
};

export type i32 = NativeScalar<"i32", number>;

export interface GtkCounter {
  readonly [nativeResource]: "GtkCounter";
  scheduleClick(): void;
  dispose(): void;
}

export declare function createCounter(callback: (count: i32) => void): GtkCounter;
export declare function closeCounter(): void;
export declare function complete(value: i32): void;
