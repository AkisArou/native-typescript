/** A bounded membership index exercises Set's ordinary hot path without
 * making dynamic key construction the dominant operation. Periodic deletion
 * and reinsertion keeps tombstones and insertion order observable; the
 * occasional drain prevents an implementation that stores membership alone
 * from satisfying the workload. */
export function runSetOperationWorkload(iterations: number): number {
  const keys = [
    "alpha", "beta", "gamma", "delta",
    "epsilon", "zeta", "eta", "theta",
    "iota", "kappa", "lambda", "mu",
    "nu", "xi", "omicron", "pi",
  ];
  const active = new Set<string>();
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    const key = keys[index & 15]!;
    if (!active.has(key)) {
      active.add(key);
      checksum += 1;
    }
    if ((index & 31) === 0) {
      const evictionKey = keys[(index >>> 5) & 15]!;
      if (active.has(evictionKey)) checksum += 3;
      if (active.delete(evictionKey)) checksum += 5;
      active.add(evictionKey);
    }
    if ((index & 255) === 0) {
      for (const member of active) checksum += member.length;
    }
    checksum += active.size;
    index += 1;
  }
  return checksum;
}
