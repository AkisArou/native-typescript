import { createElementOnce } from "@native-typescript/chromium-benchmark-native";

export function createElements(iterations: number): number {
  let checksum = 0;
  for (let index = 0; index < iterations; index += 1) {
    checksum += createElementOnce();
  }
  return checksum;
}
