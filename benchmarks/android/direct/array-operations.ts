/** One complete dynamic-array lifetime per iteration. The values remain
 * observable so ART may optimize the representation but cannot erase the
 * array semantics the four benchmark implementations share. */
export function runArrayOperationWorkload(iterations: number): number {
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    const values = [index & 255, 3, 5, 7];
    values.push(1024, 13);
    values[1] = 17;
    checksum += values.length;
    checksum += values[0]! + values[1]! + values[5]!;
    checksum += values.indexOf(1024);
    if (values.includes(13)) checksum += 1;
    checksum += values.pop()!;
    index += 1;
  }
  return checksum;
}
