// Generated from lib.dom.d.ts and Chromium normalized WebIDL; do not edit.
declare const nativeScalar: unique symbol;
export type NTSWebRealmId = bigint & {
  readonly [nativeScalar]: "NTSWebRealmId";
};
export interface NTSWebHandle {
  readonly realm: NTSWebRealmId;
  readonly slot: number;
  readonly generation: number;
}
export declare enum NTSWebStatus {
  Ok = 0,
  InvalidArgument = 1,
  InvalidHandle = 2,
  WrongRealm = 3,
  WrongSequence = 4,
  ContextDestroyed = 5,
  TypeError = 6,
  RangeError = 7,
  SyntaxError = 8,
  DomException = 9,
  OperationDisabled = 10,
  OutOfMemory = 11,
}
export interface NTSWebScabiHandleResult {
  readonly status: NTSWebStatus;
  readonly value: NTSWebHandle;
}
export declare class NTSWebRealm {
  private readonly __nativeType: unique symbol;
}
export declare function documentCreateElementRaw(
  realm: NTSWebRealm,
  document: NTSWebHandle,
  localName: string,
): NTSWebScabiHandleResult;
export type NTSReachedDocumentCreateElement = (
  receiver: Document,
  localName: string,
) => Element;
