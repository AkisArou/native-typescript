interface BenchmarkRow {
  count: number;
  label: string;
  active: boolean;
}

/** One fixed-shape object lifetime per iteration. The alternating string and
 * boolean fields prevent this from degenerating into a number-only struct,
 * while the mutation and observable checksum exercise ordinary property
 * access without introducing dynamic-key semantics. */
export function runRecordObjectWorkload(iterations: number): number {
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    const row: BenchmarkRow = {
      label: index & 1 ? "alpha" : "Καλημέρα",
      count: index & 255,
      active: (index & 3) === 0,
    };
    row.count += row.label.length;
    if (row.active) row.count += 3;
    checksum += row.count;
    index += 1;
  }
  return checksum;
}
