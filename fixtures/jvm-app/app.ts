import {
  applicationComplete,
  applicationStart,
} from "@native-typescript/jvm-application";
import { Widget } from "@native-typescript/jvm-fixture";

/* The target brings the JVM up and binds every registered package; from
 * here on everything is ordinary generated surface. Scalars, handles,
 * statics, and strings each get one check, so a wrong crossing fails the
 * exit code rather than a assertion nobody reads. */
applicationStart();

let failed = false;

const widget = new Widget(7);
if (widget.depth() !== 7) failed = true;
if (Widget.checkedAdd(2, 3) !== 5) failed = true;

const grown = widget.resized(9);
if (grown === null || grown.depth() !== 9) failed = true;
if (widget.compareDepth(grown) >= 0) failed = true;
if (widget.compareDepth(null) !== -1) failed = true;

const text = widget.label(5);
if (text !== "widget-5") failed = true;
const greeting = Widget.greet("native");
if (greeting !== "hi native!") failed = true;
if (Widget.greet(null) !== null) failed = true;

/* A byte[] argument crosses as a borrowed span: 1+2+3+250 = 256 proves the
 * bytes arrive unsigned and intact, the subarray proves the view's offset
 * is honored rather than its buffer's start, and the empty span proves a
 * zero-length array is still built. */
if (Widget.sumBytes(new Uint8Array([1, 2, 3, 250])) !== 256) failed = true;
const framed = new Uint8Array([9, 1, 2, 3, 250, 9]);
if (Widget.sumBytes(framed.subarray(1, 5)) !== 256) failed = true;
if (Widget.sumBytes(new Uint8Array(0)) !== 0) failed = true;

/* A byte[] result comes back REVERSED, not echoed, so a copy that read the
 * right bytes into the wrong place fails differently from one that read
 * the wrong bytes; the offset view proves the input half again under the
 * result path, and the empty result is a real zero-length array. */
const reversed = Widget.reverseBytes(framed.subarray(1, 5));
if (
  reversed.length !== 4 || reversed[0] !== 250 || reversed[1] !== 3 ||
  reversed[2] !== 2 || reversed[3] !== 1
) failed = true;
/* Chained deliberately: a native call used directly as a member-access
 * receiver is the shape fork 252ea14c admitted, and this is its live
 * coverage. */
if (Widget.reverseBytes(new Uint8Array(0)).length !== 0) failed = true;

/* The VM is deliberately not destroyed: the runtime releases live handles
 * at shutdown, which needs the VM attached, and a JVM never fully unloads
 * anyway - process exit is its honest end. applicationStop exists for a
 * program that has released everything and knows it. */
applicationComplete(failed ? 1 : 0);
