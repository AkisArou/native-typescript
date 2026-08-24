#ifndef NTS_CHROMIUM_SCRIPT_C_RUNTIME_COMPAT_H
#define NTS_CHROMIUM_SCRIPT_C_RUNTIME_COMPAT_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

void nts_chromium_scriptc_random_bytes(void* output, size_t length);

#ifdef __cplusplus
}
#endif

#define arc4random_buf nts_chromium_scriptc_random_bytes

#endif
