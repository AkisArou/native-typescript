// Generated from lib.dom.d.ts and Chromium normalized WebIDL; do not edit.
declare const nativeResource: unique symbol;
export declare abstract class EventTarget {
  readonly [nativeResource]: true;
  listen(type: string, callback: () => void): EventSubscription;
}
export declare abstract class Node extends EventTarget {
  appendChild(node: Node): Node;
}
export declare abstract class Element extends Node {}
export declare abstract class HTMLElement extends Element {}
export declare abstract class CharacterData extends Node {
  set data(value: string);
}
export declare abstract class Text extends CharacterData {}
export declare abstract class Document extends Node {
  get body(): HTMLElement | null;
  createElement(localName: string): Element;
  createTextNode(data: string): Text;
}
export interface EventSubscription {
  readonly [nativeResource]: true;
  dispose(): void;
}
export declare function currentDocument(): Document | null;
