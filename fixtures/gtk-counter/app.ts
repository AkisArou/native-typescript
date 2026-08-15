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

function exerciseGeneratedGtk(): i32 {
  const window = createWindow();
  const button = createButtonWithLabel("Generated: initial");
  window.setChild(button);
  const initial = button.getLabel();
  button.setLabel("Generated: updated");
  const updated = button.getLabel();
  window.destroy();
  button.dispose();
  window.dispose();
  if (initial === "Generated: initial" && updated === "Generated: updated") {
    return 41 as i32;
  }
  return 0 as i32;
}

runtimeStart();
const generatedResult = exerciseGeneratedGtk();

let observed = 0 as i32;
const counter = createCounter((count): void => {
  observed = count;
  queueMicrotask((): void => {
    observed = (observed + generatedResult) as i32;
    complete(observed);
  });
  quit();
});

counter.scheduleClick();
