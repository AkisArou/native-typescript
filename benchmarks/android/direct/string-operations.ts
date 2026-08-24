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

export function runStringNormalizeWorkload(
  value: string,
  iterations: number,
): number {
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    const normalized = value.trim().toLowerCase();
    checksum += normalized.length;
    index += 1;
  }
  return checksum;
}

export function runStringSliceWorkload(
  value: string,
  iterations: number,
): number {
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    const segment = value.slice(0, 17);
    checksum += segment.length;
    index += 1;
  }
  return checksum;
}

export function runStringPadWorkload(
  value: string,
  iterations: number,
): number {
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    const padded = value.padEnd(20, ".");
    checksum += padded.length;
    index += 1;
  }
  return checksum;
}

export function runStringSearchWorkload(
  value: string,
  iterations: number,
): number {
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    if (value.includes("typescript")) checksum += 1;
    checksum += value.charCodeAt(18);
    index += 1;
  }
  return checksum;
}
