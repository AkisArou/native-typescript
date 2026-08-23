#include "nts_web.h"

#include <stdbool.h>
#include <string.h>

static NtsUtf8View utf8_literal(const char *text) {
  NtsUtf8View value = {
      .data = (const uint8_t *)text,
      .length = strlen(text),
  };
  return value;
}

/* This is the first application-shaped probe for the Chromium bridge. It is
 * intentionally plain C and has no Chromium/Blink/V8 includes. */
bool nts_create_element_probe(NtsWebRealm *realm) {
  if (realm == NULL || !nts_web_realm_is_current(realm) ||
      !nts_web_realm_is_alive(realm)) {
    return false;
  }

  NtsWebHandleResult document = nts_web_document(realm);
  if (document.status != NTS_WEB_OK) {
    nts_web_exception_dispose(&document.exception);
    return false;
  }

  NtsWebHandleResult button = nts_web_document_create_element(
      realm, document.value, utf8_literal("button"));
  if (button.status != NTS_WEB_OK) {
    nts_web_exception_dispose(&button.exception);
    (void)nts_web_handle_release(realm, document.value);
    return false;
  }

  bool ok = nts_web_handle_release(realm, button.value) == NTS_WEB_OK;
  ok = nts_web_handle_release(realm, document.value) == NTS_WEB_OK && ok;
  return ok;
}

/* The invalid-name arm proves that Blink's own DOM validation reaches native
 * C as a DOMException rather than being swallowed or routed through V8. */
bool nts_create_element_exception_probe(NtsWebRealm *realm) {
  NtsWebHandleResult document = nts_web_document(realm);
  if (document.status != NTS_WEB_OK) return false;

  NtsWebHandleResult result = nts_web_document_create_element(
      realm, document.value, utf8_literal("invalid name"));

  bool ok = result.status == NTS_WEB_DOM_EXCEPTION &&
            result.exception.status == NTS_WEB_DOM_EXCEPTION &&
            result.exception.legacy_code == 5;
  nts_web_exception_dispose(&result.exception);
  ok = nts_web_handle_release(realm, document.value) == NTS_WEB_OK && ok;
  return ok;
}
