import { applicationComplete, applicationStart } from "@native-typescript/jvm-application";
import { Widget } from "@native-typescript/jvm-fixture";

/* The sticky-failure program: the first queued delivery throws, the second
 * tries to complete with success. The recorded failure must settle the
 * exit code - a process that ran a throwing handler may not exit 0. */
applicationStart();

const widget = new Widget(1);
let first = true;
const connection = widget.onTick((sender, value) => {
  void sender;
  void value;
  if (first) {
    first = false;
    throw new Error("deliberate failure in a queued handler");
  }
  connection.disconnect();
  applicationComplete(0);
});
widget.tick(2);
