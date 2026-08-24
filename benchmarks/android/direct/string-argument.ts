import { TextUtils } from "@native-typescript/jvm-android_benchmark";

/** Compare distinct-but-equal Java strings. The Activity constructs the
 * inputs outside the timed region; this loop measures only two reference
 * arguments plus Android's real equality operation. */
export function runStringArgumentWorkload(
  asciiLeft: string,
  asciiRight: string,
  unicodeLeft: string,
  unicodeRight: string,
  iterations: number,
): number {
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    const equal = index & 1
      ? TextUtils.equals(asciiLeft, asciiRight)
      : TextUtils.equals(unicodeLeft, unicodeRight);
    if (equal) checksum += 1;
    index += 1;
  }
  return checksum;
}
