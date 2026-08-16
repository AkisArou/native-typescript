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

/* Returns the declared type rather than a literal. Assigning a literal would
 * narrow every later read of window.title to that literal, and a native getter
 * cannot honour a narrowing — GTK is free to return anything the declaration
 * allows. */
function chosenTitle(present: boolean): string | null {
  return present ? "Native TypeScript" : null;
}

const window = new Window();
window.title = chosenTitle(true);
if (window.title !== "Native TypeScript") {
  throw new Error("the window did not keep its title");
}
window.present();
window.destroy();
console.log("window ok");
applicationQuit();
