/* Signal payloads that are not gint or gdouble.
 *
 * A payload is copied into the callback turn, so any type that is a value can
 * cross: an exact scalar of any width, and an enumeration, whose storage and
 * members Clang proved. Both are checked here against payloads GTK itself
 * produces rather than against ones this program emits.
 *
 * Delivery is queued to the runtime owner rather than made synchronously, so
 * every assertion runs inside the callback. Nothing here may assume a payload
 * has arrived just because the call that causes it has returned. */

import {
  applicationQuit,
  applicationStart,
} from "@native-typescript/gtk-application";
import {
  EntryBuffer,
  TextDirection,
  Window,
  type gint,
  type guint,
} from "@native-typescript/gtk4";

if (!applicationStart()) throw new Error("the GTK target did not start");

let enumerationSeen = false;
let scalarSeen = false;
let failure = "";

function finishIfReady(): void {
  if (failure.length > 0) {
    console.log(failure);
    applicationQuit();
  } else if (enumerationSeen && scalarSeen) {
    console.log("payloads ok");
    applicationQuit();
  }
}

const deadline = setTimeout((): void => {
  console.log(
    `payload never delivered: enumeration=${enumerationSeen} scalar=${scalarSeen}`,
  );
  applicationQuit();
}, 10_000);

const window = new Window();
window.setDirection(TextDirection.Ltr);
const direction = window.onDirectionChanged((sender, previousDirection): void => {
  if (previousDirection !== TextDirection.Ltr) {
    failure = "direction-changed carried the wrong enumeration";
  } else if (sender.getDirection() !== TextDirection.Rtl) {
    failure = "direction-changed sender does not report the new direction";
  }
  enumerationSeen = true;
  clearTimeout(deadline);
  finishIfReady();
});
if (!direction.connected) throw new Error("direction-changed did not connect");

const buffer = new EntryBuffer(null, -1 as gint);
buffer.setText("native typescript", -1 as gint);
const deleted = buffer.onDeletedText((_sender, position, characters): void => {
  /* delete_text(6, 10) removes "typescript" starting at index 6. */
  if (position !== (6 as guint)) {
    failure = "deleted-text carried the wrong position";
  } else if (characters !== (10 as guint)) {
    failure = "deleted-text carried the wrong count";
  }
  scalarSeen = true;
  finishIfReady();
});
if (!deleted.connected) throw new Error("deleted-text did not connect");

window.setDirection(TextDirection.Rtl);
buffer.deleteText(6 as guint, 10 as gint);
