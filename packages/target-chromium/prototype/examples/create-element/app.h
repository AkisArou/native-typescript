#ifndef NTS_CREATE_ELEMENT_APP_H
#define NTS_CREATE_ELEMENT_APP_H

#include <stdbool.h>

#include "nts_web.h"

#ifdef __cplusplus
extern "C" {
#endif

bool nts_create_element_probe(NtsWebRealm *realm);
bool nts_create_element_exception_probe(NtsWebRealm *realm);

#ifdef __cplusplus
}
#endif

#endif
