import {
  TextView,
  type Activity,
} from "@native-typescript/jvm-android_benchmark";

/** Construct one real Android receiver, then keep every timed operation as a
 * direct primitive setter call inside ART. */
export function runSetterWorkload(
  activity: Activity,
  iterations: number,
): number {
  const view = new TextView(activity);
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    view.setTextSize(index & 1 ? 12 : 13);
    checksum += index & 1;
    index += 1;
  }
  return checksum;
}
