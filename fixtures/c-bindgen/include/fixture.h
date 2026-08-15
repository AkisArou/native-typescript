#ifndef NTS_C_BINDGEN_FIXTURE_H
#define NTS_C_BINDGEN_FIXTURE_H

typedef struct NTSWidget NTSWidget;
typedef unsigned char NTSByte;
typedef long long NTSI64;

typedef enum NTSOrientation {
  NTS_ORIENTATION_UNKNOWN = -1,
  NTS_ORIENTATION_HORIZONTAL = 0,
  NTS_ORIENTATION_VERTICAL = 1
} NTSOrientation;

typedef struct NTSPoint {
  int x;
  NTSByte tag;
  double weight;
} NTSPoint;

typedef struct NTSPair {
  double x;
  double y;
} NTSPair;

typedef struct NTSLarge {
  NTSI64 x;
  NTSI64 y;
  NTSI64 z;
} NTSLarge;

NTSWidget *nts_widget_new(const char *label);
const char *nts_widget_get_label(NTSWidget *widget);
void nts_widget_set_label(NTSWidget *widget, const char *label);
NTSPoint nts_point_translate(NTSPoint point, int delta);

#endif
