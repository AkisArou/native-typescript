/* Drives a GTK application's whole lifecycle from TypeScript, with no
 * hand-written C of its own.
 *
 * Everything below is either generated from GIR or shipped by the target:
 * `Application` comes from gtk4 and inherits its lifecycle from gio2 across a
 * package boundary, `ApplicationFlags` and `Cancellable` come from gio2, and
 * the process bootstrap comes from the GTK target. Nothing here blocks — the
 * runtime's attached GMainContext turns the loop, so `g_application_run()` is
 * never reached. */

import { ApplicationFlags, Cancellable } from "@native-typescript/gio2";
import { Application } from "@native-typescript/gtk4";
import {
  applicationQuit,
  applicationStart,
} from "@native-typescript/gtk-application";

if (!applicationStart()) throw new Error("the GTK target did not start");

const application = new Application(
  "org.nativeTypeScript.LifecycleGate",
  ApplicationFlags.NonUnique,
);

let activations = 0;

/* Nothing should keep the loop turning once activation has been observed. If
 * the signal never arrives the process would otherwise hang, so the deadline
 * reports that distinctly instead. */
const deadline = setTimeout((): void => {
  console.log("activate was never delivered");
  applicationQuit();
}, 10_000);

const connection = application.onActivate((sender): void => {
  activations += 1;
  /* A non-unique application never defers to another instance, so this must
   * be the primary one. */
  if (sender.getIsRemote()) throw new Error("activated a remote application");
  clearTimeout(deadline);
  console.log(`activated ${activations}`);
  sender.quit();
  applicationQuit();
});

if (!connection.connected) throw new Error("activate did not connect");

/* register() reports failure through a GError. It is the throwing projection:
 * success returns nothing, failure raises with the GError's own message. */
application.register(new Cancellable());

if (application.getIsRemote()) throw new Error("registered as remote");

application.activate();
