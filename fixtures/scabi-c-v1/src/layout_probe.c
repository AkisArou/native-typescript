#include "nts_scabi_fixture.h"

#include <stdio.h>

int main(void) {
  printf(
      "{\"alignment\":%zu,\"fields\":{\"ratio\":%zu,\"tag\":%zu,\"value\":%zu},\"size\":%zu}\n",
      _Alignof(NtsPadded),
      offsetof(NtsPadded, ratio),
      offsetof(NtsPadded, tag),
      offsetof(NtsPadded, value),
      sizeof(NtsPadded));
  return 0;
}
