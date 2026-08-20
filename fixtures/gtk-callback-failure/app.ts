/* An application whose signal handler throws, to prove the process says so.
 *
 * A GTK callback runs during a GMainContext iteration, not inside the call
 * that connected it, so an exception escaping one has no caller left to
 * receive it. What must not happen is the program exiting successfully
 * anyway: an application that reports success while its handler failed is
 * worse than one that crashes, because nothing downstream can tell.
 *
 * The route is worth naming because it is not the obvious one. The GLib
 * runtime does not decide the status; it reports the failure, which makes the
 * attached poll answer FAILED, which makes `scr_loop_run` return true, which
 * is what the emitted `main` turns into a non-zero return. The exit-code hint
 * is not what carries this — a sibling target discovered its own equivalent
 * plumbing was dead precisely because a happy path where both sides are zero
 * proves nothing about a failing one. */

import { ApplicationFlags, Cancellable } from "@native-typescript/gio2";
import { Application } from "@native-typescript/gtk4";
import {
  applicationQuit,
  applicationStart,
} from "@native-typescript/gtk-application";

if (!applicationStart()) throw new Error("the GTK target did not start");

const application = new Application(
  "org.nativeTypeScript.CallbackFailureGate",
  ApplicationFlags.NonUnique,
);

/* If activation never arrives the handler never runs, and a process that
 * exited 0 because nothing happened would look exactly like the bug this
 * gate exists to catch. The deadline makes that case say so instead. */
const deadline = setTimeout((): void => {
  console.log("activate was never delivered");
  applicationQuit();
}, 10_000);

const connection = application.onActivate((sender): void => {
  clearTimeout(deadline);
  console.log("activated");
  sender.quit();
  applicationQuit();
  throw new Error("the handler failed");
});

if (!connection.connected) throw new Error("activate did not connect");

application.register(new Cancellable());
application.activate();
