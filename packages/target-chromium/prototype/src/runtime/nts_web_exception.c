#include "nts_web.h"

#include <stdlib.h>

void nts_web_exception_dispose(NtsWebException *exception) {
  if (exception == NULL) return;

  free(exception->name.data);
  free(exception->message.data);

  exception->status = NTS_WEB_OK;
  exception->legacy_code = 0;
  exception->name.data = NULL;
  exception->name.length = 0;
  exception->message.data = NULL;
  exception->message.length = 0;
}
