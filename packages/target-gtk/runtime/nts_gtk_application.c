#include "nts_gtk_application.h"

#include <gtk/gtk.h>

#include "nts_glib_runtime.h"

/* One runtime per process: GTK itself is a process-wide singleton, so a second
 * attach would hand two owner threads the same main context. */
static NtsGlibRuntime *nts_gtk_application_runtime;

bool nts_gtk_application_start(void) {
  if (nts_gtk_application_runtime != NULL) return false;
  if (!gtk_init_check()) return false;
  NtsGlibRuntime *runtime =
      nts_glib_runtime_new(NULL, G_PRIORITY_DEFAULT, NULL, NULL);
  if (runtime == NULL) return false;
  if (!nts_glib_runtime_start(runtime)) {
    nts_glib_runtime_detach(runtime);
    return false;
  }
  nts_gtk_application_runtime = runtime;
  return true;
}

bool nts_gtk_application_is_running(void) {
  return nts_gtk_application_runtime != NULL;
}

void nts_gtk_application_quit(void) {
  nts_glib_runtime_request_stop(nts_gtk_application_runtime);
}

bool nts_gtk_application_shutdown(void) {
  if (nts_gtk_application_runtime == NULL) return false;
  scr_retained_callbacks_stop_accepting();
  /* Every clause runs: pending work and a live registration are distinct
   * faults, and destroy must be attempted even when one of them holds, so the
   * runtime is detached exactly once either way. */
  bool drained = !scr_retained_callbacks_pending();
  bool idle = scr_retained_callbacks_active() == 0;
  bool destroyed = scr_retained_callbacks_destroy();
  nts_glib_runtime_detach(nts_gtk_application_runtime);
  nts_gtk_application_runtime = NULL;
  return drained && idle && destroyed;
}
