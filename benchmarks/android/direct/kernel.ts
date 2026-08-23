import {
  Base64,
  Button,
  ClickBridge,
  Rect,
  TextUtils,
  TextView,
} from "@native-typescript/jvm-android_benchmark";
import type {
  Activity,
  JvmConnection,
  LinearLayout,
} from "@native-typescript/jvm-android_benchmark";

/* This is the same boundary kernel as native/app.ts. It remains a checked
 * TypeScript input: the direct JVM backend consumes its ScriptC IR and the
 * binding sidecar generated from android.jar, while the Java Activity beside
 * it supplies only Android lifecycle, timing, and log transport. */
const LIGHT_OBJECT_ITERATIONS = 50000;
const SETTER_ITERATIONS = 50000;
const CALLBACK_ITERATIONS = 50000;
const CALLBACK_PAYLOAD_ITERATIONS = 20000;
const STRING_ARGUMENT_ITERATIONS = 20000;
const STRING_RESULT_ITERATIONS = 10000;
const BYTE_ARRAY_ITERATIONS = 2000;
const HANDLE_RESULT_ITERATIONS = 32000;
const HANDLE_RESULT_CHILDREN = 16;

let callbackCount = 0;
let retainedCallback: JvmConnection | null = null;
let callbackPayloadChecksum = 0;
let retainedPayloadCallback: JvmConnection | null = null;

export function runLightObjects(): number {
  let checksum = 0;
  let index = 0;
  while (index < LIGHT_OBJECT_ITERATIONS) {
    const rectangle = new Rect(0, 0, 1, 1);
    checksum += rectangle.width();
    index += 1;
  }
  return checksum;
}

export function runSetters(activity: Activity): number {
  const view = new TextView(activity);
  let checksum = 0;
  let index = 0;
  while (index < SETTER_ITERATIONS) {
    view.setTextSize(index & 1 ? 12 : 13);
    checksum += index & 1;
    index += 1;
  }
  return checksum;
}

/** Registration is deliberately outside the timed loop. The returned
 * connection is rooted just as the JNI benchmark roots its registrations;
 * dropping it would cancel the callback and benchmark absence instead of
 * delivery. */
export function prepareCallbacks(activity: Activity): Button {
  const button = new Button(activity);
  const clicks = new ClickBridge();
  retainedCallback = clicks.onClick((_view) => {
    callbackCount += 1;
  });
  button.setOnClickListener(clicks);
  return button;
}

export function runCallbacks(button: Button): number {
  if (retainedCallback === null) return -1;
  callbackCount = 0;
  let index = 0;
  while (index < CALLBACK_ITERATIONS) {
    button.callOnClick();
    index += 1;
  }
  return callbackCount;
}

/** The delivered View stays an ordinary Java reference. Calling getId here
 * proves the payload is usable by TypeScript rather than merely forwarded to
 * an otherwise-empty handler. */
export function prepareCallbackPayload(activity: Activity): Button {
  const button = new Button(activity);
  const clicks = new ClickBridge();
  retainedPayloadCallback = clicks.onClick((view) => {
    if (view !== null) callbackPayloadChecksum += view.getId();
  });
  button.setOnClickListener(clicks);
  return button;
}

export function runCallbackPayload(button: Button): number {
  if (retainedPayloadCallback === null) return -1;
  callbackPayloadChecksum = 0;
  let index = 0;
  while (index < CALLBACK_PAYLOAD_ITERATIONS) {
    button.callOnClick();
    index += 1;
  }
  return callbackPayloadChecksum;
}

export function runStringArguments(
  asciiLeft: string,
  asciiRight: string,
  unicodeLeft: string,
  unicodeRight: string,
): number {
  let checksum = 0;
  let index = 0;
  while (index < STRING_ARGUMENT_ITERATIONS) {
    const equal = index & 1
      ? TextUtils.equals(asciiLeft, asciiRight)
      : TextUtils.equals(unicodeLeft, unicodeRight);
    if (equal) checksum += 1;
    index += 1;
  }
  return checksum;
}

export function runStringResults(rectangle: Rect): number {
  let checksum = 0;
  let index = 0;
  while (index < STRING_RESULT_ITERATIONS) {
    checksum += rectangle.flattenToString().length;
    index += 1;
  }
  return checksum;
}

export function runByteArrays(input: Uint8Array): number {
  let checksum = 0;
  let index = 0;
  while (index < BYTE_ARRAY_ITERATIONS) {
    checksum += Base64.encode(input, 2).length;
    index += 1;
  }
  return checksum;
}

export function runHandleResults(container: LinearLayout): number {
  let checksum = 0;
  let index = 0;
  while (index < HANDLE_RESULT_ITERATIONS) {
    const child = container.getChildAt(index & (HANDLE_RESULT_CHILDREN - 1));
    if (child !== null) checksum += child.getId();
    index += 1;
  }
  return checksum;
}

/* The Java Activity is the external caller. The executable plan names these
 * functions as explicit roots, so no fake module-evaluation calls are needed
 * to keep them alive. */
