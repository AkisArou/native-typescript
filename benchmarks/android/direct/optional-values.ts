function maybeNumber(index: number): number | undefined {
  return (index & 3) === 0 ? undefined : index & 255;
}

function maybeLabel(index: number): string | undefined {
  return index & 1 ? "alpha" : undefined;
}

/** Two ordinary optional-result calls per iteration. The numeric result
 * exercises a true tagged scalar union while the string result can remain a
 * nullable ART reference. Both are consumed immediately so ART gets the same
 * scalar-replacement opportunity as Kotlin's nullable values. */
export function runOptionalValueWorkload(iterations: number): number {
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    const numeric = maybeNumber(index);
    checksum += numeric === undefined ? 11 : numeric + 3;
    const label = maybeLabel(index);
    checksum += label === undefined ? 7 : label.length;
    index += 1;
  }
  return checksum;
}
