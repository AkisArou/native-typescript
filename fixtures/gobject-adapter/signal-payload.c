#include <gtk/gtk.h>

typedef struct NtsGtkSignalConnection NtsGtkSignalConnection;

GtkDrawingArea *nts_gobject_adopt_gtk_drawing_area_new(void);
/* One release serves the whole upcast chain, so it is typed at the root
 * the class reaches rather than at the class — which is why the call below
 * casts. Generated code never needs to: a handle crosses as `void *`. */
void nts_gobject_release_gtk_widget(GtkWidget *value);
NtsGtkSignalConnection *nts_gobject_connect_gtk_drawing_area_resize(
    GtkDrawingArea *instance,
    void (*callback)(gint width, gint height, void *context),
    void *context);
void nts_gtk_signal_connection_release(NtsGtkSignalConnection *connection);

typedef struct PayloadObservation {
  gint calls;
  gint width;
  gint height;
} PayloadObservation;

static void observe_resize(gint width, gint height, void *opaque) {
  PayloadObservation *observation = opaque;
  observation->calls += 1;
  observation->width = width;
  observation->height = height;
}

int main(void) {
  gtk_init();

  GtkDrawingArea *area = nts_gobject_adopt_gtk_drawing_area_new();
  if (area == NULL || g_object_is_floating(area)) return 10;

  PayloadObservation observation = {0};
  NtsGtkSignalConnection *connection =
      nts_gobject_connect_gtk_drawing_area_resize(area, observe_resize, &observation);
  if (connection == NULL) return 11;

  g_signal_emit_by_name(area, "resize", 320, 180);
  if (observation.calls != 1 || observation.width != 320 || observation.height != 180) {
    return 12;
  }

  nts_gtk_signal_connection_release(connection);
  g_signal_emit_by_name(area, "resize", 640, 360);
  if (observation.calls != 1) return 13;

  nts_gobject_release_gtk_widget((GtkWidget *)area);
  return 0;
}
