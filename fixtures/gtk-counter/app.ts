import {
  complete,
  createCounter,
  quit,
  runtimeStart,
  type i32,
} from "@native-typescript/gtk-counter-fixture";
import {
  Button,
  Window,
  type gdouble,
  type gint,
} from "@native-typescript/gtk4";

runtimeStart();
let generatedReady = false;
let counterReady = false;
let failed = false;
let generatedValue = 0 as i32;
let observed = 0 as i32;

function finishIfReady(): void {
  if (failed) {
    complete(0 as i32);
    quit();
  } else if (generatedReady && counterReady) {
    complete((generatedValue + observed) as i32);
    quit();
  }
}

const window = new Window();
const button = Button.withLabel("Generated: initial");
const initial = button.label;
button.label = "Generated: updated";
button.setVisible(false);
button.setVisible(true);
button.opacity = 0.75 as gdouble;
button.opacity = button.opacity;
window.setChild(button);
window.setDefaultSize(640 as gint, 480 as gint);
window.present();
window.setDefaultSize(button.getWidth(), 480 as gint);
const clicked = button.onClicked((sender): void => {
  const updated = sender.label;
  if (
    initial === "Generated: initial" &&
    updated === "Generated: updated"
  ) {
    generatedValue = 41 as i32;
    generatedReady = true;
  } else {
    failed = true;
  }
  window.destroy();
  finishIfReady();
});
if (!clicked.connected) failed = true;

const temporary = button.onClicked((): void => {
  failed = true;
});
if (!temporary.connected) failed = true;
temporary.disconnect();
if (temporary.connected) failed = true;
temporary.disconnect();
if (temporary.connected) failed = true;

const counter = createCounter((count): void => {
  observed = count;
  queueMicrotask((): void => {
    counterReady = true;
    finishIfReady();
  });
});

const activated = button.activate();
if (!activated) {
  failed = true;
  window.destroy();
}
counter.scheduleClick();
