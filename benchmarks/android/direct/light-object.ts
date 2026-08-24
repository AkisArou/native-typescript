import { Rect } from "@native-typescript/jvm-android_benchmark";

/** Shared loop body for the legacy exported-kernel harness and the
 * compiler-emitted Activity. Keeping the boundary in one side-effect-free
 * module lets whole-program reachability select this workload without also
 * rooting callback-registration globals from the remaining scenarios. */
export function runLightObjectWorkload(iterations: number): number {
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    const rectangle = new Rect(0, 0, 1, 1);
    checksum += rectangle.width();
    index += 1;
  }
  return checksum;
}
