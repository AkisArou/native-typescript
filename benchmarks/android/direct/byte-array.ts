import { Base64 } from "@native-typescript/jvm-android_benchmark";

/** Android's byte[] API consumes the Uint8Array representation directly;
 * the returned byte[] remains a Java array and only its length is observed. */
export function runByteArrayWorkload(
  input: Uint8Array,
  iterations: number,
): number {
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    checksum += Base64.encode(input, 2).length;
    index += 1;
  }
  return checksum;
}
