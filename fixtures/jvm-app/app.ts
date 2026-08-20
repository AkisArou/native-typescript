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

/* The VM is deliberately not destroyed: the runtime releases live handles
 * at shutdown, which needs the VM attached, and a JVM never fully unloads
 * anyway - process exit is its honest end. applicationStop exists for a
 * program that has released everything and knows it. */
applicationComplete(failed ? 1 : 0);
