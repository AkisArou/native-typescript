import { spawnSync } from "node:child_process";

/**
 * Runs a built GTK executable under a throwaway X server and reports exactly
 * what it did. Both the library gate and the command-line gate assert on the
 * same shape, so neither can accidentally accept an outcome the other rejects.
 */

const applicationEnvironment = {
  GDK_BACKEND: "x11",
  GDK_DISABLE: "gl,vulkan",
  GSETTINGS_BACKEND: "memory",
  GSK_RENDERER: "cairo",
  /* GTK 4 ignores NO_AT_BRIDGE. Without this it reaches for the accessibility
   * bus and reports a CRITICAL when at-spi is not running, which depends on
   * the host rather than on the program and so comes and goes. */
  GTK_A11Y: "none",
  /* There is no quiet choice here. Without a session bus GTK warns that it
   * cannot acquire one; with a real one it warns that the host's portal
   * services are missing or the wrong version. Running without is the more
   * contained of the two: a private bus activates real desktop daemons. */
  DBUS_SESSION_BUS_ADDRESS: "disabled:",
} as const;

/**
 * GLib-formatted warnings about the host's desktop session, which say nothing
 * about the program under test.
 *
 * Only WARNING records naming the session bus or a portal are dropped.
 * A CRITICAL, an ERROR, an assertion, a sanitizer report, or anything the
 * program itself wrote survives and fails the gate — the point is to stop
 * pinning the developer's desktop, not to stop reading stderr.
 */
const hostSessionWarning =
  /^\(process:\d+\): \w+-WARNING \*\*: [\d:.]+: (?:Unable to acquire session bus|Cannot get portal)\b.*$/u;

function withoutHostSessionNoise(stderr: string): string {
  const kept = stderr
    .split("\n")
    .filter((line) => line.length > 0 && !hostSessionWarning.test(line));
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}

export interface ApplicationRun {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  /** Standard error with host desktop-session warnings removed. */
  readonly stderr: string;
}

export function runApplication(path: string): ApplicationRun {
  const run = spawnSync(
    "xvfb-run",
    ["-a", "--server-args=-screen 0 1024x768x24", path],
    { env: { ...process.env, ...applicationEnvironment }, encoding: "utf8" },
  );
  return {
    status: run.status,
    signal: run.signal,
    stdout: run.stdout,
    stderr: withoutHostSessionNoise(run.stderr),
  };
}
