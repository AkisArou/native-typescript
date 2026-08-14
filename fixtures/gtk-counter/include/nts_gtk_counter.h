#ifndef NTS_GTK_COUNTER_H
#define NTS_GTK_COUNTER_H

#include <stdint.h>

typedef struct NtsGtkCounter NtsGtkCounter;
typedef void (*NtsGtkCounterCallback)(int32_t count, void *context);

int32_t nts_gtk_runtime_start(void);
NtsGtkCounter *nts_gtk_counter_create(NtsGtkCounterCallback callback,
                                      void *context);
void nts_gtk_counter_schedule_click(NtsGtkCounter *counter);
void nts_gtk_counter_destroy(NtsGtkCounter *counter);
void nts_gtk_runtime_quit(void);
void nts_gtk_runtime_complete(int32_t value);

#endif
