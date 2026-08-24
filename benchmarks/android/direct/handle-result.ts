import type { LinearLayout } from "@native-typescript/jvm-android_benchmark";

/** Repeatedly obtain a nullable Java receiver and consume it immediately.
 * Direct JVM keeps both the container and each result as ordinary ART
 * references, with Java null as the nullable-union representation. */
export function runHandleResultWorkload(
  container: LinearLayout,
  iterations: number,
  children: number,
): number {
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    const child = container.getChildAt(index & (children - 1));
    if (child !== null) checksum += child.getId();
    index += 1;
  }
  return checksum;
}
