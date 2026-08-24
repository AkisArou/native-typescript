/** A bounded string-key cache exercises the ordinary Map hot path without
 * making dynamic key construction the dominant operation. Deletion followed
 * by reinsertion keeps tombstones and insertion-order maintenance in the
 * measured work; get() also exercises the exact number | undefined result. */
export function runMapOperationWorkload(iterations: number): number {
  const keys = [
    "alpha", "beta", "gamma", "delta",
    "epsilon", "zeta", "eta", "theta",
    "iota", "kappa", "lambda", "mu",
    "nu", "xi", "omicron", "pi",
  ];
  const counts = new Map<string, number>();
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    const key = keys[index & 15]!;
    const previous = counts.get(key);
    const next = previous === undefined ? (index & 7) + 1 : previous + 1;
    counts.set(key, next);
    if ((index & 31) === 0) {
      const evictionKey = keys[(index >>> 5) & 15]!;
      if (counts.has(evictionKey)) checksum += 3;
      if (counts.delete(evictionKey)) checksum += 5;
      counts.set(evictionKey, next + 2);
    }
    checksum += next + counts.size;
    index += 1;
  }
  return checksum;
}
