import {
  TextView,
  type Activity,
} from "@native-typescript/jvm-android_benchmark";

/** Combine direct JavaScript-number formatting with a real CharSequence
 * setter. Both the dynamic String and the TextView stay inside ART. */
export function runTextUpdateWorkload(
  activity: Activity,
  iterations: number,
): number {
  const view = new TextView(activity);
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    const text = `Count: ${index & 1023}`;
    view.setText(text);
    checksum += text.length;
    index += 1;
  }
  return checksum;
}
