#include "nts_web.h"

#include <stddef.h>

_Static_assert(sizeof(NtsWebHandle) == 16, "NtsWebHandle size drift");
_Static_assert(_Alignof(NtsWebHandle) == 8, "NtsWebHandle alignment drift");
_Static_assert(offsetof(NtsWebHandle, realm) == 0,
               "NtsWebHandle.realm offset drift");
_Static_assert(offsetof(NtsWebHandle, slot) == 8,
               "NtsWebHandle.slot offset drift");
_Static_assert(offsetof(NtsWebHandle, generation) == 12,
               "NtsWebHandle.generation offset drift");

_Static_assert(sizeof(NtsWebScabiHandleResult) == 24,
               "NtsWebScabiHandleResult size drift");
_Static_assert(_Alignof(NtsWebScabiHandleResult) == 8,
               "NtsWebScabiHandleResult alignment drift");
_Static_assert(offsetof(NtsWebScabiHandleResult, status) == 0,
               "NtsWebScabiHandleResult.status offset drift");
_Static_assert(offsetof(NtsWebScabiHandleResult, value) == 8,
               "NtsWebScabiHandleResult.value offset drift");

/* Identity signatures give target Clang one parameter and one result view of
 * every aggregate carried by the first generated SCABI binding. */
__attribute__((noinline, used)) NtsWebHandle
nts_abi_classify_record_0000(NtsWebHandle value) {
  return value;
}

NtsUtf8View nts_web_probe_utf8_view(NtsUtf8View value) {
  return value;
}

NtsWebHandleResult nts_web_probe_handle_result(NtsWebHandleResult value) {
  return value;
}

__attribute__((noinline, used)) NtsWebScabiHandleResult
nts_abi_classify_record_0001(
    NtsWebScabiHandleResult value) {
  return value;
}
