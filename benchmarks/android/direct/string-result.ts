import type { Rect } from "@native-typescript/jvm-android_benchmark";

/** Keep each fresh Java String result in ART and consume only its length.
 * Direct JVM must not manufacture a JNI handle or transcode the value. */
export function runStringResultWorkload(
  rectangle: Rect,
  iterations: number,
): number {
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    checksum += rectangle.flattenToString().length;
    index += 1;
  }
  return checksum;
}
