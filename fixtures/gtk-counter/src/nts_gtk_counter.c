#include "nts_gtk_counter.h"

#include <gtk/gtk.h>
#include <stdbool.h>
#include <stdlib.h>

#include "nts_glib_runtime.h"

struct NtsGtkCounter {
  GtkWidget *window;
  GtkWidget *button;
  gulong clicked_handler;
  guint scheduled_click;
  NtsGtkCounterCallback callback;
  void *callback_context;
  int32_t count;
};

static NtsGlibRuntime *nts_runtime;
static NtsGtkCounter *nts_active_counter;
static int32_t nts_completion = -1;
static int32_t nts_destroyed_counters;

static void nts_gtk_counter_close_window(NtsGtkCounter *counter) {
  if (counter == NULL || counter->window == NULL) return;
  if (counter->clicked_handler != 0) {
    g_signal_handler_disconnect(counter->button, counter->clicked_handler);
    counter->clicked_handler = 0;
  }
  gtk_window_destroy(GTK_WINDOW(counter->window));
  counter->window = NULL;
  counter->button = NULL;
}

static void nts_gtk_runtime_cleanup(void) {
  scr_retained_callbacks_stop_accepting();
  if (nts_active_counter != NULL || nts_completion != 42 ||
      nts_destroyed_counters != 1 || scr_retained_callbacks_pending() ||
      scr_retained_callbacks_active() != 0 ||
      !scr_retained_callbacks_destroy()) {
    abort();
  }
  nts_glib_runtime_detach(nts_runtime);
  nts_runtime = NULL;
}

int32_t nts_gtk_runtime_start(void) {
  if (nts_runtime != NULL || !gtk_init_check()) return 0;
  NtsGlibRuntime *runtime = nts_glib_runtime_new(
      NULL, G_PRIORITY_DEFAULT, NULL, NULL);
  if (runtime == NULL) return 0;
  if (!nts_glib_runtime_start(runtime)) {
    nts_glib_runtime_detach(runtime);
    return 0;
  }
  nts_runtime = runtime;
  scr_atexit(nts_gtk_runtime_cleanup);
  return 1;
}

static void nts_gtk_counter_clicked(GtkButton *button, gpointer opaque) {
  (void)button;
  NtsGtkCounter *counter = opaque;
  counter->count += 1;
  counter->callback(counter->count, counter->callback_context);
}

NtsGtkCounter *nts_gtk_counter_create(NtsGtkCounterCallback callback,
                                      void *context) {
  if (nts_runtime == NULL || nts_active_counter != NULL) return NULL;
  NtsGtkCounter *counter = calloc(1, sizeof *counter);
  if (counter == NULL) return NULL;

  counter->callback = callback;
  counter->callback_context = context;
  counter->window = gtk_window_new();
  counter->button = gtk_button_new_with_label("Count: 0");
  gtk_window_set_title(GTK_WINDOW(counter->window), "Native TypeScript GTK");
  gtk_window_set_default_size(GTK_WINDOW(counter->window), 360, 160);
  gtk_window_set_child(GTK_WINDOW(counter->window), counter->button);
  counter->clicked_handler = g_signal_connect(
      counter->button, "clicked", G_CALLBACK(nts_gtk_counter_clicked), counter);
  nts_active_counter = counter;
  gtk_window_present(GTK_WINDOW(counter->window));
  return counter;
}

static gboolean nts_gtk_counter_emit_click(gpointer opaque) {
  NtsGtkCounter *counter = opaque;
  counter->scheduled_click = 0;
  if (counter->button != NULL) {
    g_signal_emit_by_name(counter->button, "clicked");
  }
  return G_SOURCE_REMOVE;
}

void nts_gtk_counter_schedule_click(NtsGtkCounter *counter) {
  if (counter->scheduled_click != 0 || counter->button == NULL) return;
  GSource *source = g_idle_source_new();
  g_source_set_priority(source, G_PRIORITY_DEFAULT);
  g_source_set_callback(source, nts_gtk_counter_emit_click, counter, NULL);
  counter->scheduled_click = g_source_attach(source, NULL);
  g_source_unref(source);
}

void nts_gtk_counter_destroy(NtsGtkCounter *counter) {
  if (counter == NULL) return;
  if (counter->scheduled_click != 0) {
    g_source_remove(counter->scheduled_click);
    counter->scheduled_click = 0;
  }
  nts_gtk_counter_close_window(counter);
  if (nts_active_counter == counter) nts_active_counter = NULL;
  nts_destroyed_counters += 1;
  free(counter);
}

void nts_gtk_runtime_quit(void) {
  nts_gtk_counter_close_window(nts_active_counter);
  nts_glib_runtime_request_stop(nts_runtime);
}

void nts_gtk_runtime_complete(int32_t value) { nts_completion = value; }
