#include "nts_glib_runtime.h"

#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static ScrOwnerGatewayWakeFn configured_wake;
static void *configured_wake_context;
static ScrAttachedLoopPendingFn configured_pending;
static ScrAttachedLoopPollFn configured_poll;
static void *configured_loop_context;
static _Atomic size_t pending_callbacks;
static ScrRetainedCallbackDispatch dispatch_results[16];
static size_t dispatch_result_count;
static size_t dispatch_result_index;
static ScrLoopCheckpointResult checkpoint_results[16];
static size_t checkpoint_result_count;
static size_t checkpoint_result_index;
static size_t dispatch_count;
static size_t checkpoint_count;
static NtsGlibFailure failures[16];
static size_t failure_count;
static bool exception_pending;
static int exit_code_hint;
static pthread_t owner_thread;
static char order[64];
static size_t order_length;

static void record(char marker) {
  assert(order_length + 1 < sizeof order);
  order[order_length++] = marker;
  order[order_length] = '\0';
}

bool scr_retained_callbacks_configure(ScrOwnerGatewayWakeFn wake,
                                      void *wake_context) {
  if (configured_wake != NULL) return false;
  configured_wake = wake;
  configured_wake_context = wake_context;
  return true;
}

bool scr_retained_callbacks_pending(void) {
  return atomic_load_explicit(&pending_callbacks, memory_order_acquire) != 0;
}

bool scr_loop_set_attached(ScrAttachedLoopPendingFn pending,
                           ScrAttachedLoopPollFn poll, void *context) {
  if (configured_poll != NULL) return false;
  configured_pending = pending;
  configured_poll = poll;
  configured_loop_context = context;
  return true;
}

bool scr_loop_clear_attached(void *context) {
  if (configured_poll == NULL || configured_loop_context != context) {
    return false;
  }
  configured_pending = NULL;
  configured_poll = NULL;
  configured_loop_context = NULL;
  return true;
}

ScrRetainedCallbackDispatch scr_retained_callbacks_dispatch(void) {
  assert(pthread_equal(pthread_self(), owner_thread));
  size_t before = atomic_load_explicit(&pending_callbacks,
                                       memory_order_acquire);
  for (;;) {
    if (before == 0) return SCR_RETAINED_CALLBACK_DISPATCH_IDLE;
    if (atomic_compare_exchange_weak_explicit(
            &pending_callbacks, &before, before - 1, memory_order_acq_rel,
            memory_order_acquire)) {
      break;
    }
  }
  assert(dispatch_result_index < dispatch_result_count);
  ScrRetainedCallbackDispatch result =
      dispatch_results[dispatch_result_index++];
  dispatch_count++;
  record('D');
  if (result == SCR_RETAINED_CALLBACK_DISPATCH_EXCEPTION) {
    exception_pending = true;
  }
  if (before > 1) configured_wake(configured_wake_context);
  return result;
}

ScrLoopCheckpointResult scr_loop_checkpoint(void) {
  assert(pthread_equal(pthread_self(), owner_thread));
  assert(checkpoint_result_index < checkpoint_result_count);
  ScrLoopCheckpointResult result =
      checkpoint_results[checkpoint_result_index++];
  checkpoint_count++;
  record('C');
  if (result == SCR_LOOP_CHECKPOINT_EXCEPTION) exception_pending = true;
  return result;
}

bool scr_exc_pending(void) { return exception_pending; }

void scr_exc_print_uncaught(void) { exception_pending = false; }

void scr_exit_code_note(int code) { exit_code_hint = code; }

_Noreturn void scr_trap(const char *message) {
  fputs(message, stderr);
  abort();
}

static void failure_sink(void *context, NtsGlibFailure failure) {
  assert(context == &failures);
  assert(pthread_equal(pthread_self(), owner_thread));
  assert(failure_count < sizeof failures / sizeof failures[0]);
  failures[failure_count++] = failure;
  record('F');
  if (failure == NTS_GLIB_FAILURE_CALLBACK_EXCEPTION ||
      failure == NTS_GLIB_FAILURE_CHECKPOINT_EXCEPTION) {
    assert(exception_pending);
    exception_pending = false;
  }
}

static void plan_dispatch(ScrRetainedCallbackDispatch result,
                          ScrLoopCheckpointResult checkpoint) {
  assert(dispatch_result_count <
         sizeof dispatch_results / sizeof dispatch_results[0]);
  assert(checkpoint_result_count <
         sizeof checkpoint_results / sizeof checkpoint_results[0]);
  dispatch_results[dispatch_result_count++] = result;
  checkpoint_results[checkpoint_result_count++] = checkpoint;
}

static void admit(void) {
  size_t before = atomic_fetch_add_explicit(&pending_callbacks, 1,
                                             memory_order_acq_rel);
  if (before == 0) configured_wake(configured_wake_context);
}

static void *admit_foreign(void *unused) {
  (void)unused;
  admit();
  return NULL;
}

static void *iterate_foreign(void *opaque) {
  GMainContext *context = opaque;
  (void)g_main_context_iteration(context, true);
  return NULL;
}

static void iterate_until(GMainContext *context, size_t expected_dispatches) {
  while (dispatch_count < expected_dispatches) {
    assert(g_main_context_iteration(context, true));
  }
}

int main(int argc, char **argv) {
  owner_thread = pthread_self();
  GMainContext *context = g_main_context_new();
  assert(context != NULL);
  NtsGlibRuntime *runtime = nts_glib_runtime_new(
      context, G_PRIORITY_DEFAULT, failure_sink, &failures);
  assert(runtime != NULL);
  assert(nts_glib_runtime_start(runtime));
  assert(!nts_glib_runtime_start(runtime));
  assert(configured_pending(configured_loop_context));
  assert(configured_poll(configured_loop_context, 0.0) ==
         SCR_ATTACHED_LOOP_POLL_COMPLETE);
  assert(configured_poll(configured_loop_context, 1.25) ==
         SCR_ATTACHED_LOOP_POLL_COMPLETE);

  if (argc == 2 && strcmp(argv[1], "wrong-owner") == 0) {
    plan_dispatch(SCR_RETAINED_CALLBACK_DISPATCH_DELIVERED,
                  SCR_LOOP_CHECKPOINT_COMPLETE);
    admit();
    pthread_t wrong_owner;
    assert(pthread_create(&wrong_owner, NULL, iterate_foreign, context) == 0);
    (void)pthread_join(wrong_owner, NULL);
    assert(0 && "wrong-owner dispatch returned");
  }

  /* Owner wakes are posted, never invoked inline. Two queued events become
   * two callback/checkpoint turns even though the first wake is coalesced. */
  plan_dispatch(SCR_RETAINED_CALLBACK_DISPATCH_DELIVERED,
                SCR_LOOP_CHECKPOINT_COMPLETE);
  plan_dispatch(SCR_RETAINED_CALLBACK_DISPATCH_DELIVERED,
                SCR_LOOP_CHECKPOINT_COMPLETE);
  admit();
  admit();
  assert(dispatch_count == 0);
  assert(configured_poll(configured_loop_context, 0.0) ==
         SCR_ATTACHED_LOOP_POLL_COMPLETE);
  assert(dispatch_count == 1);
  assert(configured_poll(configured_loop_context, 0.0) ==
         SCR_ATTACHED_LOOP_POLL_COMPLETE);
  assert(dispatch_count == 2);
  assert(strcmp(order, "DCDC") == 0);

  plan_dispatch(SCR_RETAINED_CALLBACK_DISPATCH_DELIVERED,
                SCR_LOOP_CHECKPOINT_COMPLETE);
  pthread_t producer;
  assert(pthread_create(&producer, NULL, admit_foreign, NULL) == 0);
  assert(pthread_join(producer, NULL) == 0);
  iterate_until(context, 3);
  assert(strcmp(order, "DCDCDC") == 0);

  /* Callback and checkpoint exceptions reach the owner sink. Once consumed,
   * the microtask checkpoint or following host turn may proceed. */
  plan_dispatch(SCR_RETAINED_CALLBACK_DISPATCH_EXCEPTION,
                SCR_LOOP_CHECKPOINT_COMPLETE);
  admit();
  iterate_until(context, 4);
  assert(failure_count == 1);
  assert(failures[0] == NTS_GLIB_FAILURE_CALLBACK_EXCEPTION);
  assert(strcmp(order, "DCDCDCDFC") == 0);

  plan_dispatch(SCR_RETAINED_CALLBACK_DISPATCH_DELIVERED,
                SCR_LOOP_CHECKPOINT_EXCEPTION);
  admit();
  iterate_until(context, 5);
  assert(failure_count == 2);
  assert(failures[1] == NTS_GLIB_FAILURE_CHECKPOINT_EXCEPTION);

  plan_dispatch(SCR_RETAINED_CALLBACK_DISPATCH_DELIVERED,
                SCR_LOOP_CHECKPOINT_UNHANDLED_REJECTION);
  admit();
  iterate_until(context, 6);
  assert(failure_count == 3);
  assert(failures[2] == NTS_GLIB_FAILURE_UNHANDLED_REJECTION);
  assert(!exception_pending);
  assert(checkpoint_count == 6);

  nts_glib_runtime_request_stop(runtime);
  assert(!configured_pending(configured_loop_context));

  /* A source already attached at detach holds the adapter memory safely but
   * observes inactive state and cannot enter ScriptC. */
  configured_wake(configured_wake_context);
  nts_glib_runtime_detach(runtime);
  assert(configured_poll == NULL);
  assert(g_main_context_iteration(context, false));
  assert(dispatch_count == 6);
  while (g_main_context_pending(context)) {
    (void)g_main_context_iteration(context, false);
  }
  g_main_context_unref(context);
  assert(exit_code_hint == 0);
  puts("glib runtime: ok");
  return 0;
}
