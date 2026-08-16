#include <gtk/gtk.h>

GtkButton *nts_gobject_adopt_gtk_button_new_with_label(const char *label);
void nts_gobject_release_gtk_button(GtkButton *value);

static int finalized = 0;

static void on_finalized(gpointer data, GObject *object) {
  (void)data;
  (void)object;
  finalized += 1;
}

int main(void) {
  gtk_init();
  GtkButton *button = nts_gobject_adopt_gtk_button_new_with_label("native");
  if (button == NULL) return 10;
  if (g_object_is_floating(button)) return 11;
  if (g_strcmp0(gtk_button_get_label(button), "native") != 0) return 12;

  g_object_weak_ref(G_OBJECT(button), on_finalized, NULL);
  nts_gobject_release_gtk_button(button);
  if (finalized != 1) return 13;
  return 0;
}
