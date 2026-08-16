/* The GTK target's process bootstrap, as an application sees it.
 *
 * This is the target's own binding package rather than a generated one: it
 * describes hand-written C the target ships, so an application does not have
 * to know how GTK is initialised or how the owner runtime is attached. */

export declare function applicationStart(): boolean;

/* Asks the owner runtime to stop turning. The call returns immediately; the
 * turn already in flight still runs to completion. */
export declare function applicationQuit(): void;
