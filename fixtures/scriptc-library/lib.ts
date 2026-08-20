/* A library the parent workspace plans rather than builds.
 *
 * Deliberately small: what the gate proves is that the pinned compiler
 * exposes a library planner pair the workspace can reach through its loader,
 * and that the plan carries no path. Whether the archive's bytes are correct
 * is the fork's own conformance suite's question, over far more fixtures
 * than one. */
export function add(a: number, b: number): number {
  return a + b;
}

export function invert(x: boolean): boolean {
  return !x;
}
