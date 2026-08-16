/* Signal payloads that are not plain numbers.
 *
 * A payload is copied into the callback turn, so anything that can be copied
 * can cross: an exact scalar of any width, an enumeration whose storage and
 * members Clang proved, and a UTF-8 string. The string matters most — GTK
 * hands the handler a pointer it may reuse the moment emission returns, and
 * delivery is queued, so what arrives has to be a copy taken when the signal
 * fired. All are checked against payloads GTK itself produces rather than
 * against ones this program emits.
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
} from "@native-typescript/gtk4";

if (!applicationStart()) throw new Error("the GTK target did not start");

let enumerationSeen = false;
let scalarSeen = false;
let stringSeen = false;
let failure = "";

function finishIfReady(): void {
  if (failure.length > 0) {
    console.log(failure);
    applicationQuit();
  } else if (enumerationSeen && scalarSeen && stringSeen) {
    console.log("payloads ok");
    applicationQuit();
  }
}

const deadline = setTimeout((): void => {
  console.log(
    "payload never delivered: " +
      `enumeration=${enumerationSeen} scalar=${scalarSeen} string=${stringSeen}`,
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

const buffer = new EntryBuffer(null, -1);
buffer.setText("native typescript", -1);
const inserted = buffer.onInsertedText((_sender, position, chars, characters): void => {
  /* The pointer GTK passed is long gone by the time this runs. */
  if (chars !== " rules") {
    failure = `inserted-text carried the wrong string: ${chars}`;
  } else if (chars.length !== 6) {
    failure = "inserted-text string has the wrong length";
  } else if (position !== 17 || characters !== 6) {
    failure = "inserted-text carried the wrong position or count";
  } else if (position + characters !== 23) {
    /* A payload that arrives as a plain number can be computed with the
     * moment it lands, without a construction to route the arithmetic
     * through. */
    failure = "inserted-text payloads would not add";
  }
  stringSeen = true;
  finishIfReady();
});
if (!inserted.connected) throw new Error("inserted-text did not connect");
const deleted = buffer.onDeletedText((_sender, position, characters): void => {
  /* delete_text(6, 10) removes "typescript" starting at index 6. */
  if (position !== 6) {
    failure = "deleted-text carried the wrong position";
  } else if (characters !== 10) {
    failure = "deleted-text carried the wrong count";
  }
  scalarSeen = true;
  finishIfReady();
});
if (!deleted.connected) throw new Error("deleted-text did not connect");

window.setDirection(TextDirection.Rtl);
buffer.insertText(17, " rules", -1);
buffer.deleteText(6, 10);
