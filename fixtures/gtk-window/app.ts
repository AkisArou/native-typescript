/* A GTK application that connects no signal.
 *
 * The target's owner runtime calls ScriptC's retained-callback service whether
 * or not the application uses it, so the service has to be linked because the
 * target requires it and not because this program reached it. Nothing here
 * reaches it: there is no signal, no timer, and no callback of any kind. */

import { Window } from "@native-typescript/gtk4";
import {
  applicationQuit,
  applicationStart,
} from "@native-typescript/gtk-application";

if (!applicationStart()) throw new Error("the GTK target did not start");

/* A getter that can report its value as absent projects as a method, so each
 * read is plainly a fresh call into GTK rather than a field. */
const window = new Window();
window.setTitle("Native TypeScript");
if (window.getTitle() !== "Native TypeScript") {
  throw new Error("the window did not keep its title");
}
window.present();
window.destroy();
console.log("window ok");
applicationQuit();
