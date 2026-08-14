import {
  complete,
  createCounter,
  quit,
  runtimeStart,
  type i32,
} from "@native-typescript/gtk-counter-fixture";

runtimeStart();

let observed = 0 as i32;
const counter = createCounter((count): void => {
  observed = count;
  queueMicrotask((): void => {
    observed = (observed + (41 as i32)) as i32;
    complete(observed);
  });
  quit();
});

counter.scheduleClick();
