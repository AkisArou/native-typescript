import {
  TextView,
  type Activity,
} from "@native-typescript/jvm-android_benchmark";

/** Allocate a real Android widget per operation and apply one primitive
 * argument so ART cannot discard the receiver as an unused allocation. */
export function runConstructorWorkload(
  activity: Activity,
  iterations: number,
): number {
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    const view = new TextView(activity);
    view.setMinimumHeight(index & 1);
    checksum += index & 1;
    index += 1;
  }
  return checksum;
}
