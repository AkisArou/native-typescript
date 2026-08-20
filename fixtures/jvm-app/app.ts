import {
  applicationComplete,
  applicationStart,
} from "@native-typescript/jvm-application";
import { Host, HostBridge, Widget } from "@native-typescript/jvm-fixture";

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
/* U+0000 in a Java string is ordinary data on the span arm: the length
 * comes from the compiler's slot, so the point survives where a
 * terminator would have ended the value. This line spent its life as a
 * named refusal; greet(null) above is why the arm had to keep null. */
const nulled = Widget.withNul();
if (nulled === null || nulled.length !== 3 || nulled !== "a\u0000b") {
  failed = true;
}

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

/* A String[] result: JNI's object-carried length comes back as the NUL
 * terminator the string-vector contract speaks; each element crosses the
 * UTF-16 bridge, non-BMP text included. */
const words = Widget.splitWords("alpha beta 🎉");
if (
  words.length !== 3 || words[0] !== "alpha" || words[1] !== "beta" ||
  words[2] !== "🎉"
) failed = true;
if (Widget.emptyWords().length !== 0) failed = true;

/* A String[] argument: content arrives in order and intact (the join is
 * the proof), NULL crosses as an omitted list and Java's own
 * NullPointerException arrives through the checked channel as an ordinary
 * catchable error — the first TS-level catch of a native failure in this
 * app, deliberately. */
if (Widget.joinWords(["alpha", "🎉"]) !== "alpha,🎉") failed = true;
if (Widget.countTags(["a", "b", "c"]) !== 3) failed = true;
let caught = false;
try {
  Widget.countTags(null);
} catch {
  caught = true;
}
if (!caught) failed = true;

/* Typed spans: signed content survives (sumInts), the length echo is the
 * units mirror (four elements must count four; a bytes-denominated count
 * crossing would build sixteen), floats come back REVERSED with exact
 * f32-representable values, and measure — the refusal that opened this
 * family's file — finally answers as a live Int32Array. */
if (Widget.sumInts(new Int32Array([1, -2, 4])) !== 3) failed = true;
if (Widget.countInts(new Int32Array(4)) !== 4) failed = true;
const reversedFloats = Widget.reverseFloats(new Float32Array([1.5, -2.25]));
if (
  reversedFloats.length !== 2 || reversedFloats[0] !== -2.25 ||
  reversedFloats[1] !== 1.5
) failed = true;
const measured = widget.measure("label", true);
if (measured.length !== 2 || measured[0] !== 5 || measured[1] !== 1) {
  failed = true;
}

/* The inward direction: Java calls the TypeScript handler through a
 * registered native method, its boolean answers steer Java's own loop, and
 * the closure's captured state proves the payloads arrived. After
 * disconnect, Java's call throws IllegalStateException, which arrives here
 * as an ordinary catchable error. */
let observed = 0;
const connection = widget.onPing((value) => {
  observed += value;
  return value % 2 === 0;
});
if (widget.ping(4) !== 2) failed = true;
if (observed !== 6) failed = true;
connection.disconnect();
let pingThrew = false;
try {
  widget.ping(1);
} catch {
  pingThrew = true;
}
if (!pingThrew) failed = true;

/* The queued inward direction: tick's deliveries drain AFTER this file's
 * top level returns, at the runtime's pump, so the exit-code decision
 * moves into the handler — the shape a platform lifecycle forces anyway.
 * The handler receives its sender, proves the payloads arrive in order,
 * and disconnects so the loop can exhaust.
 *
 * The VM is deliberately not destroyed: the runtime releases live handles
 * at shutdown, which needs the VM attached, and a JVM never fully unloads
 * anyway - process exit is its honest end. */
/* The generated subclass: HostBridge exists because this build wrote its
 * Java, and Host.run's own loop dispatches VIRTUALLY into the TypeScript
 * handler - the framework-constructs-your-class shape, on the desktop.
 * The plain base is the control: its un-overridden answer is false, so
 * its run accepts nothing, and the bridge accepting 2 proves the override
 * ran rather than the base. After disconnect the override still exists
 * and its missing registration throws - into Java, out of run, and into
 * this catch. */
const plainHost = new Host();
if (plainHost.run(2) !== 0) failed = true;
const bridge = new HostBridge();
const bridgeConnection = bridge.onEvent((value) => value % 2 === 0);
if (bridge.run(4) !== 2) failed = true;
bridgeConnection.disconnect();
let bridgeThrew = false;
try {
  bridge.run(1);
} catch {
  bridgeThrew = true;
}
if (!bridgeThrew) failed = true;

let ticks = 0;
let deliveries = 0;
const tickConnection = widget.onTick((sender, value) => {
  if (sender.depth() !== 7) failed = true;
  if (value !== deliveries) failed = true;
  deliveries += 1;
  ticks += value;
  if (deliveries === 3) {
    tickConnection.disconnect();
    applicationComplete(failed || ticks !== 3 ? 1 : 0);
  }
});
widget.tick(3);
/* Top level ends here; the pump drains the three deliveries and the
 * handler above decides the exit code. */
