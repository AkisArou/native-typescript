import { Rect, TextUtils } from "@native-typescript/jvm-android_benchmark";

/* This is the same boundary kernel as native/app.ts. It remains a checked
 * TypeScript input: the direct JVM backend consumes its ScriptC IR and the
 * binding sidecar generated from android.jar, while the Java Activity beside
 * it supplies only Android lifecycle, timing, and log transport. */
const LIGHT_OBJECT_ITERATIONS = 50000;
const STRING_ARGUMENT_ITERATIONS = 20000;

export function runLightObjects(): number {
  let checksum = 0;
  let index = 0;
  while (index < LIGHT_OBJECT_ITERATIONS) {
    const rectangle = new Rect(0, 0, 1, 1);
    checksum += rectangle.width();
    index += 1;
  }
  return checksum;
}

export function runStringArguments(
  asciiLeft: string,
  asciiRight: string,
  unicodeLeft: string,
  unicodeRight: string,
): number {
  let checksum = 0;
  let index = 0;
  while (index < STRING_ARGUMENT_ITERATIONS) {
    const equal = index & 1
      ? TextUtils.equals(asciiLeft, asciiRight)
      : TextUtils.equals(unicodeLeft, unicodeRight);
    if (equal) checksum += 1;
    index += 1;
  }
  return checksum;
}

/* Executable compilation retains reached functions. Module evaluation pays
 * one unmeasured call; the Activity performs the declared warmups before any
 * sample, so it cannot enter the result. */
runStringArguments(
  "settings/profile/42",
  "settings/profile/42",
  "Καλημέρα 👩‍💻 e\u0301",
  "Καλημέρα 👩‍💻 e\u0301",
);
runLightObjects();
