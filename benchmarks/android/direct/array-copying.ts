/** Four ordinary JavaScript array transformations per iteration. Negative
 * indices are load-bearing: implementations must apply JS relative-index
 * semantics rather than hard-code the resulting ranges. */
export function runArrayCopyingWorkload(iterations: number): number {
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    const source = [index & 255, 2, 3, 4, 5, 6, 7, 8];
    const middle = source.slice(-6, -1);
    middle.reverse();
    const restored = middle.toReversed();
    const changed = restored.with(-2, (index & 255) + 10);
    checksum += source[0]! + middle[0]! + restored[0]! + changed[3]! +
      changed[4]! + middle.length + restored.length + changed.length;
    index += 1;
  }
  return checksum;
}
