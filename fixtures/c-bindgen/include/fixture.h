#ifndef NTS_C_BINDGEN_FIXTURE_H
#define NTS_C_BINDGEN_FIXTURE_H

typedef struct NTSWidget NTSWidget;
typedef unsigned char NTSByte;

typedef struct NTSPoint {
  int x;
  NTSByte tag;
  double weight;
} NTSPoint;

NTSWidget *nts_widget_new(const char *label);
const char *nts_widget_get_label(NTSWidget *widget);
void nts_widget_set_label(NTSWidget *widget, const char *label);
NTSPoint nts_point_translate(NTSPoint point, int delta);

#endif
