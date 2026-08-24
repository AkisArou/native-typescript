/** An idiomatic higher-order array pipeline per iteration. It exercises
 * indexed callback arguments, an immutable capture, intermediate arrays, and
 * reduction while keeping every result observable. */
export function runArrayPipelineWorkload(iterations: number): number {
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    const delta = index & 7;
    const result = [index & 255, 2, 3, 4]
      .map((value, position) => value * 2 + position + delta)
      .filter((value) => value > 7)
      .reduce((sum, value) => sum + value, 0);
    checksum += result;
    index += 1;
  }
  return checksum;
}
