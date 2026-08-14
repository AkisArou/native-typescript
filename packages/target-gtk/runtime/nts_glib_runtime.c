#include "nts_glib_runtime.h"

#include <stdatomic.h>
#include <stdlib.h>

struct NtsGlibRuntime {
  _Atomic size_t references;
  _Atomic bool active;
  _Atomic bool loop_pending;
  _Atomic bool failed;
  GMainContext *main_context;
  gint priority;
  NtsGlibFailureSink failure_sink;
  void *failure_context;
  GThread *owner_thread;
  bool started;
};

static NtsGlibRuntime *nts_glib_runtime_retain(NtsGlibRuntime *runtime) {
  atomic_fetch_add_explicit(&runtime->references, 1, memory_order_relaxed);
  return runtime;
}

static void nts_glib_runtime_release(gpointer opaque) {
  NtsGlibRuntime *runtime = opaque;
  if (atomic_fetch_sub_explicit(&runtime->references, 1,
                                memory_order_acq_rel) != 1) {
    return;
  }
  g_main_context_unref(runtime->main_context);
  free(runtime);
}

static void nts_glib_runtime_default_failure(void *context,
                                             NtsGlibFailure failure) {
  (void)context;
  if (failure == NTS_GLIB_FAILURE_CALLBACK_EXCEPTION ||
      failure == NTS_GLIB_FAILURE_CHECKPOINT_EXCEPTION) {
    scr_exc_print_uncaught();
  }
  scr_exit_code_note(1);
}

static void nts_glib_runtime_report(NtsGlibRuntime *runtime,
                                    NtsGlibFailure failure) {
  runtime->failure_sink(runtime->failure_context, failure);
  if ((failure == NTS_GLIB_FAILURE_CALLBACK_EXCEPTION ||
       failure == NTS_GLIB_FAILURE_CHECKPOINT_EXCEPTION) &&
      scr_exc_pending()) {
    scr_trap("native-typescript: GLib failure sink left an exception pending\n");
  }
  atomic_store_explicit(&runtime->failed, true, memory_order_release);
  atomic_store_explicit(&runtime->loop_pending, false, memory_order_release);
  g_main_context_wakeup(runtime->main_context);
}

static gboolean nts_glib_runtime_dispatch(gpointer opaque) {
  NtsGlibRuntime *runtime = opaque;
  if (!atomic_load_explicit(&runtime->active, memory_order_acquire)) {
    return G_SOURCE_REMOVE;
  }
  if (!g_main_context_is_owner(runtime->main_context) ||
      g_thread_self() != runtime->owner_thread) {
    scr_trap("native-typescript: GLib runtime dispatched outside its owner thread\n");
  }

  ScrRetainedCallbackDispatch dispatched = scr_retained_callbacks_dispatch();
  if (dispatched == SCR_RETAINED_CALLBACK_DISPATCH_IDLE) {
    return G_SOURCE_REMOVE;
  }
  if (dispatched == SCR_RETAINED_CALLBACK_DISPATCH_EXCEPTION) {
    nts_glib_runtime_report(runtime, NTS_GLIB_FAILURE_CALLBACK_EXCEPTION);
  }

  ScrLoopCheckpointResult checkpoint = scr_loop_checkpoint();
  if (checkpoint == SCR_LOOP_CHECKPOINT_EXCEPTION) {
    nts_glib_runtime_report(runtime, NTS_GLIB_FAILURE_CHECKPOINT_EXCEPTION);
  } else if (checkpoint == SCR_LOOP_CHECKPOINT_UNHANDLED_REJECTION) {
    nts_glib_runtime_report(runtime, NTS_GLIB_FAILURE_UNHANDLED_REJECTION);
  }
  return G_SOURCE_REMOVE;
}

static void nts_glib_runtime_wake(void *opaque) {
  NtsGlibRuntime *runtime = opaque;
  if (!atomic_load_explicit(&runtime->active, memory_order_acquire)) return;

  /* g_main_context_invoke_full may call inline when the current thread owns
   * the context. A fresh idle source is deliberately attached instead: even
   * an owner-thread native callback must return through its factory/call frame
   * before compiled TypeScript can observe the admitted event. */
  GSource *source = g_idle_source_new();
  g_source_set_priority(source, runtime->priority);
  g_source_set_callback(source, nts_glib_runtime_dispatch,
                        nts_glib_runtime_retain(runtime),
                        nts_glib_runtime_release);
  g_source_attach(source, runtime->main_context);
  g_source_unref(source);
}

static bool nts_glib_runtime_loop_pending(void *opaque) {
  NtsGlibRuntime *runtime = opaque;
  return atomic_load_explicit(&runtime->active, memory_order_acquire) &&
         (atomic_load_explicit(&runtime->loop_pending, memory_order_acquire) ||
          scr_retained_callbacks_pending() != 0);
}

static gboolean nts_glib_runtime_deadline(gpointer opaque) {
  (void)opaque;
  return G_SOURCE_REMOVE;
}

static ScrAttachedLoopPollResult nts_glib_runtime_poll(
    void *opaque, double max_wait_ms) {
  NtsGlibRuntime *runtime = opaque;
  if (g_thread_self() != runtime->owner_thread) {
    scr_trap("native-typescript: GLib runtime polled outside its owner thread\n");
  }

  GSource *deadline = NULL;
  bool may_block = max_wait_ms != 0.0;
  if (max_wait_ms > 0.0) {
    guint interval;
    if (max_wait_ms >= (double)G_MAXUINT) {
      interval = G_MAXUINT;
    } else {
      interval = (guint)max_wait_ms;
      if ((double)interval < max_wait_ms) interval += 1;
    }
    deadline = g_timeout_source_new(interval);
    g_source_set_priority(deadline, runtime->priority);
    g_source_set_callback(deadline, nts_glib_runtime_deadline, NULL, NULL);
    g_source_attach(deadline, runtime->main_context);
  }

  (void)g_main_context_iteration(runtime->main_context, may_block);
  if (deadline != NULL) {
    g_source_destroy(deadline);
    g_source_unref(deadline);
  }
  return atomic_load_explicit(&runtime->failed, memory_order_acquire)
             ? SCR_ATTACHED_LOOP_POLL_FAILED
             : SCR_ATTACHED_LOOP_POLL_COMPLETE;
}

NtsGlibRuntime *nts_glib_runtime_new(GMainContext *context, gint priority,
                                     NtsGlibFailureSink failure_sink,
                                     void *failure_context) {
  NtsGlibRuntime *runtime = calloc(1, sizeof *runtime);
  if (runtime == NULL) return NULL;
  atomic_init(&runtime->references, 1);
  atomic_init(&runtime->active, true);
  atomic_init(&runtime->loop_pending, false);
  atomic_init(&runtime->failed, false);
  runtime->main_context =
      context == NULL ? g_main_context_ref(g_main_context_default())
                      : g_main_context_ref(context);
  runtime->priority = priority;
  runtime->failure_sink = failure_sink == NULL
                              ? nts_glib_runtime_default_failure
                              : failure_sink;
  runtime->failure_context = failure_context;
  return runtime;
}

bool nts_glib_runtime_start(NtsGlibRuntime *runtime) {
  if (runtime == NULL || runtime->started ||
      !atomic_load_explicit(&runtime->active, memory_order_acquire)) {
    return false;
  }
  runtime->owner_thread = g_thread_self();
  atomic_store_explicit(&runtime->loop_pending, true, memory_order_release);
  if (!scr_loop_set_attached(nts_glib_runtime_loop_pending,
                             nts_glib_runtime_poll, runtime)) {
    atomic_store_explicit(&runtime->loop_pending, false, memory_order_release);
    return false;
  }
  if (!scr_retained_callbacks_configure(nts_glib_runtime_wake, runtime)) {
    if (!scr_loop_clear_attached(runtime)) {
      scr_trap("native-typescript: failed to roll back GLib loop attachment\n");
    }
    atomic_store_explicit(&runtime->loop_pending, false, memory_order_release);
    return false;
  }
  runtime->started = true;
  return true;
}

void nts_glib_runtime_request_stop(NtsGlibRuntime *runtime) {
  if (runtime == NULL) return;
  atomic_store_explicit(&runtime->loop_pending, false, memory_order_release);
  g_main_context_wakeup(runtime->main_context);
}

void nts_glib_runtime_detach(NtsGlibRuntime *runtime) {
  if (runtime == NULL) return;
  if (runtime->started && g_thread_self() != runtime->owner_thread) {
    scr_trap("native-typescript: GLib runtime detached outside its owner thread\n");
  }
  atomic_store_explicit(&runtime->active, false, memory_order_release);
  atomic_store_explicit(&runtime->loop_pending, false, memory_order_release);
  g_main_context_wakeup(runtime->main_context);
  if (runtime->started && !scr_loop_clear_attached(runtime)) {
    scr_trap("native-typescript: GLib runtime lost its loop attachment\n");
  }
  nts_glib_runtime_release(runtime);
}
