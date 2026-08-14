#ifndef NTS_GLIB_RUNTIME_H
#define NTS_GLIB_RUNTIME_H

#include <glib.h>

#include "scr_runtime.h"

typedef struct NtsGlibRuntime NtsGlibRuntime;

typedef enum {
  NTS_GLIB_FAILURE_CALLBACK_EXCEPTION = 1,
  NTS_GLIB_FAILURE_UNHANDLED_REJECTION = 2,
  NTS_GLIB_FAILURE_CHECKPOINT_EXCEPTION = 3,
} NtsGlibFailure;

/* Runs on the owning GMainContext. A callback/checkpoint exception is pending
 * while the sink runs and must be consumed before it returns. */
typedef void (*NtsGlibFailureSink)(void *context, NtsGlibFailure failure);

/* Creates an adapter for context (NULL selects the default context). The
 * caller owns one reference and must call nts_glib_runtime_detach after the
 * retained-callback service has stopped and been destroyed. */
NtsGlibRuntime *nts_glib_runtime_new(GMainContext *context, gint priority,
                                     NtsGlibFailureSink failure_sink,
                                     void *failure_context);

/* Configures the current ScriptC instance's retained-callback service and pins
 * this thread as its owner. Must be called once before native registrations are
 * created. Dispatching the context from another thread is an affinity trap. */
bool nts_glib_runtime_start(NtsGlibRuntime *runtime);

/* Prevents already-scheduled GLib sources from entering ScriptC and releases
 * the caller's reference. Call on the owner immediately after successfully
 * destroying the retained-callback service; runtime is invalid afterward. */
void nts_glib_runtime_detach(NtsGlibRuntime *runtime);

#endif
