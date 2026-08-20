import {
  applicationComplete,
  applicationStart,
} from "@native-typescript/jvm-application";
import { Host, HostBridge, Widget } from "@native-typescript/jvm-fixture";

/* The hosted program: a JVM this runtime did NOT create loaded the library,
 * JNI_OnLoad adopted it, and the owner thread is running this top level
 * inside the library init. applicationStart is mode-aware — here it does
 * only the ScriptC half, on the instance's own thread — and
 * applicationComplete ends the HOST process with this program's verdict,
 * which is the lane's observable. */
applicationStart();

let failed = false;

const widget = new Widget(7);
if (widget.depth() !== 7) failed = true;
if (Widget.greet("host") !== "hi host!") failed = true;

const plainHost = new Host();
if (plainHost.run(2) !== 0) failed = true;
const bridge = new HostBridge();
const connection = bridge.onEvent((value) => value % 2 === 0);
if (bridge.run(4) !== 2) failed = true;
connection.disconnect();

applicationComplete(failed ? 1 : 0);
