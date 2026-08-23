#ifndef NTS_COUNTER_APP_H
#define NTS_COUNTER_APP_H

#include <stdbool.h>

#include "nts_web.h"

#ifdef __cplusplus
extern "C" {
#endif

bool nts_counter_start(NtsWebRealm *realm);
void nts_counter_dispatch_event(NtsWebRealm *realm,
                                NtsWebCallbackToken token,
                                void *context);
void nts_counter_stop(void);
bool nts_counter_failed(void);

#ifdef __cplusplus
}
#endif

#endif
