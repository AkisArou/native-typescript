/* The JVM target's process bootstrap, as an application sees it.
 *
 * This is the target's own binding package rather than a generated one: it
 * describes hand-written C the target ships, so an application does not
 * have to know how the JavaVM is created or how binding packages attach.
 * The classpath is a runtime input (NT_JVM_CLASSPATH); starting a JVM that
 * cannot be created, or binding a package whose classes are absent from
 * that classpath, throws with the platform's own message. */

export declare function applicationStart(): void;

export declare function applicationStop(): void;

/* Notes the process exit code the runtime reports when the program ends. */
export declare function applicationComplete(code: number): void;
