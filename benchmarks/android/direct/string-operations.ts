export function runStringOperationWorkload(
  value: string,
  iterations: number,
): number {
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    const trimmed = value.trim();
    const normalized = trimmed.toLowerCase();
    const segment = normalized.slice(0, 17);
    const padded = segment.padEnd(20, ".");
    checksum += segment.length;
    if (normalized.includes("typescript")) checksum += 1;
    checksum += trimmed.charCodeAt(18);
    checksum += padded.length;
    index += 1;
  }
  return checksum;
}
