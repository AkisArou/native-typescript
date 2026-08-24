/** A deterministic numeric kernel keeps every result observable while
 * exercising the static Math operations used by layout, animation, geometry,
 * and data-normalization code. The quarter-step inputs cover both signs and
 * avoid integer-only constant folding; random is excluded because the four
 * runtimes intentionally expose different generators. */
export function runMathOperationWorkload(iterations: number): number {
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    const value = ((index & 1_023) - 512) / 8 +
      (index & 1 ? 0.25 : -0.25);
    const minimum = Math.min(value, -value);
    const maximum = Math.max(value, -value);
    checksum += Math.floor(value);
    checksum += Math.ceil(value);
    checksum += Math.trunc(value);
    checksum += Math.round(value);
    checksum += Math.trunc(Math.abs(value));
    checksum += Math.trunc(minimum);
    checksum += Math.trunc(maximum);
    index += 1;
  }
  return checksum;
}
