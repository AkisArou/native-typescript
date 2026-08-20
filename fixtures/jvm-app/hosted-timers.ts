import {
  applicationComplete,
  applicationStart,
} from "@native-typescript/jvm-application";

/* The hosted scheduler's trigger program, committed BEFORE its arm: the
 * verdict rides a timer, which only a park that runs the real loop can
 * fire. Library emission requires an async_free module graph today, so
 * this program refuses by name — the hosted lane pins the diagnostic —
 * and it flips to live when the arm lands, exactly as withNul did. */
applicationStart();

setTimeout(() => {
  applicationComplete(0);
}, 10);
