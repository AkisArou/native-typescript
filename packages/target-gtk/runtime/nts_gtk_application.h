#ifndef NTS_GTK_APPLICATION_H
#define NTS_GTK_APPLICATION_H

#include <stdbool.h>
#include <stdint.h>

/* The GTK target's process bootstrap. Initialising GTK, attaching the GLib
 * owner runtime, and tearing both down again are what a GTK target does before
 * and after any TypeScript runs, so they belong here rather than to whichever
 * application happens to be linked.
 *
 * Every entry point below runs on the thread that called
 * nts_gtk_application_start, which becomes the runtime's owner thread. */

/* Initialises GTK and attaches the GLib owner runtime to the default main
 * context. Returns false if GTK cannot initialise (a headless session with no
 * display), if the runtime cannot attach, or if the application is already
 * started; the process is left unchanged in each case.
 *
 * Deliberately does not register teardown: an application that starts the
 * runtime also owns when it stops, because shutdown has to run after whatever
 * assertions or flushes that application performs. */
bool nts_gtk_application_start(void);

/* Whether start has succeeded and shutdown has not yet run. Native code that
 * creates GTK objects checks this rather than tracking its own flag. */
bool nts_gtk_application_is_running(void);

/* Asks the owner runtime to stop turning. Safe before start and after
 * shutdown, where it does nothing. Returns immediately: the loop drains the
 * turn already in flight, so callers must not assume the runtime is stopped
 * when this returns. */
void nts_gtk_application_quit(void);

/* Stops accepting retained callbacks, destroys the callback service, and
 * detaches the runtime. Returns false if the service was still holding work
 * when it was asked to shut down, which means a registration outlived the
 * object that owned it.
 *
 * Callers run their own teardown checks first and then call this, so a
 * diagnostic about their state is not lost behind a runtime failure. */
bool nts_gtk_application_shutdown(void);

#endif
