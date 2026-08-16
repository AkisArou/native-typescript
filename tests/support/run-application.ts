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
  NO_AT_BRIDGE: "1",
  /* A registering GtkApplication probes desktop portals over the session bus.
   * Whether that bus exists is a property of the machine, not of the program,
   * so the application is run without one — being non-unique, it never needed
   * a bus name. */
  DBUS_SESSION_BUS_ADDRESS: "disabled:",
} as const;

export interface ApplicationRun {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
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
    stderr: run.stderr,
  };
}
