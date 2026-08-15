#ifndef NTS_C_BINDGEN_FIXTURE_H
#define NTS_C_BINDGEN_FIXTURE_H

typedef struct NTSWidget NTSWidget;

NTSWidget *nts_widget_new(const char *label);
const char *nts_widget_get_label(NTSWidget *widget);
void nts_widget_set_label(NTSWidget *widget, const char *label);

#endif
