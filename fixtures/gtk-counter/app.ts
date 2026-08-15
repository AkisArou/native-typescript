import {
  complete,
  createCounter,
  quit,
  runtimeStart,
  type i32,
} from "@native-typescript/gtk-counter-fixture";
import {
  createButtonWithLabel,
  createWindow,
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

const window = createWindow();
const button = createButtonWithLabel("Generated: initial");
const initial = button.getLabel();
button.setLabel("Generated: updated");
window.setChild(button);
window.present();
const subscription = button.onClicked((): void => {
  const updated = button.getLabel();
  if (initial === "Generated: initial" && updated === "Generated: updated") {
    generatedValue = 41 as i32;
    generatedReady = true;
  } else {
    failed = true;
  }
  subscription.dispose();
  window.destroy();
  button.dispose();
  window.dispose();
  finishIfReady();
});

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
  subscription.dispose();
  window.destroy();
  button.dispose();
  window.dispose();
}
counter.scheduleClick();
