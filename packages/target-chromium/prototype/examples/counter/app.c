#include "app.h"

#include <stdio.h>
#include <string.h>

static const NtsWebCallbackToken kClickCallback = {
    .slot = 1,
    .generation = 1,
};

typedef struct {
  NtsWebRealm *realm;
  NtsWebHandle button;
  NtsWebSubscription click_subscription;
  unsigned count;
  bool active;
  bool failed;
} NtsCounterState;

static NtsCounterState nts_counter;

static NtsUtf8View nts_utf8_literal(const char *text) {
  NtsUtf8View value;
  value.data = (const uint8_t *)text;
  value.length = strlen(text);
  return value;
}

static bool nts_take_handle_result(NtsWebHandleResult *result,
                                   NtsWebHandle *out_handle) {
  if (result->status == NTS_WEB_OK) {
    *out_handle = result->value;
    return true;
  }
  nts_web_exception_dispose(&result->exception);
  return false;
}

static bool nts_take_subscription_result(NtsWebSubscriptionResult *result,
                                         NtsWebSubscription *out_subscription) {
  if (result->status == NTS_WEB_OK) {
    *out_subscription = result->value;
    return true;
  }
  nts_web_exception_dispose(&result->exception);
  return false;
}

static bool nts_take_void_result(NtsWebVoidResult *result) {
  if (result->status == NTS_WEB_OK) return true;
  nts_web_exception_dispose(&result->exception);
  return false;
}

static void nts_release_if_live(NtsWebRealm *realm, NtsWebHandle *handle) {
  if (handle->generation == 0) return;
  (void)nts_web_handle_release(realm, *handle);
  handle->slot = 0;
  handle->generation = 0;
}

static void nts_dispose_subscription_if_live(
    NtsWebRealm *realm,
    NtsWebSubscription *subscription) {
  if (subscription->generation == 0) return;
  (void)nts_web_subscription_dispose(realm, *subscription);
  subscription->slot = 0;
  subscription->generation = 0;
}

/* This file intentionally mirrors the shape ScriptC-generated C should target.
 * It does not know about Blink C++ types and it does not evaluate JavaScript.
 * The callback token stands in for ScriptC's retained callback-table entry;
 * the captured button handle stands in for a native handle reachable from the
 * compiled closure. */
bool nts_counter_start(NtsWebRealm *realm) {
  NtsWebHandle document = {0};
  NtsWebHandle body = {0};
  NtsWebHandle heading = {0};
  NtsWebHandle button = {0};
  NtsWebSubscription click_subscription = {0};
  bool success = false;

  if (nts_counter.active || realm == NULL ||
      !nts_web_realm_is_current(realm) || !nts_web_realm_is_alive(realm)) {
    return false;
  }

  NtsWebHandleResult document_result = nts_web_document(realm);
  if (!nts_take_handle_result(&document_result, &document)) goto cleanup;

  NtsWebHandleResult body_result = nts_web_document_body(realm, document);
  if (!nts_take_handle_result(&body_result, &body) || body.generation == 0) {
    goto cleanup;
  }

  NtsWebHandleResult heading_result = nts_web_document_create_element(
      realm, document, nts_utf8_literal("h1"));
  if (!nts_take_handle_result(&heading_result, &heading)) goto cleanup;

  NtsWebVoidResult heading_text = nts_web_node_set_text_content(
      realm, heading, nts_utf8_literal("Native TypeScript"));
  if (!nts_take_void_result(&heading_text)) goto cleanup;

  NtsWebHandleResult button_result = nts_web_document_create_element(
      realm, document, nts_utf8_literal("button"));
  if (!nts_take_handle_result(&button_result, &button)) goto cleanup;

  NtsWebVoidResult button_text = nts_web_node_set_text_content(
      realm, button, nts_utf8_literal("Count: 0"));
  if (!nts_take_void_result(&button_text)) goto cleanup;

  NtsWebSubscriptionResult click_result =
      nts_web_event_target_add_event_listener(
          realm, button, nts_utf8_literal("click"), kClickCallback);
  if (!nts_take_subscription_result(&click_result, &click_subscription)) {
    goto cleanup;
  }

  NtsWebVoidResult append_heading =
      nts_web_node_append_child(realm, body, heading);
  if (!nts_take_void_result(&append_heading)) goto cleanup;

  NtsWebVoidResult append_button =
      nts_web_node_append_child(realm, body, button);
  if (!nts_take_void_result(&append_button)) goto cleanup;

  nts_counter.realm = realm;
  nts_counter.button = button;
  nts_counter.click_subscription = click_subscription;
  nts_counter.count = 0;
  nts_counter.active = true;
  nts_counter.failed = false;

  /* Ownership moved into the long-lived C state just as a compiled closure
   * would keep the handle and registration reachable. */
  button = (NtsWebHandle){0};
  click_subscription = (NtsWebSubscription){0};
  success = true;

cleanup:
  nts_dispose_subscription_if_live(realm, &click_subscription);
  nts_release_if_live(realm, &button);
  nts_release_if_live(realm, &heading);
  nts_release_if_live(realm, &body);
  nts_release_if_live(realm, &document);
  return success;
}

void nts_counter_dispatch_event(NtsWebRealm *realm,
                                NtsWebCallbackToken token,
                                void *context) {
  (void)context;
  if (!nts_counter.active || nts_counter.failed || realm != nts_counter.realm ||
      token.slot != kClickCallback.slot ||
      token.generation != kClickCallback.generation ||
      !nts_web_realm_is_alive(realm)) {
    return;
  }

  nts_counter.count += 1;
  char text[64];
  int length = snprintf(text, sizeof text, "Count: %u", nts_counter.count);
  if (length < 0 || (size_t)length >= sizeof text) {
    nts_counter.failed = true;
    return;
  }

  NtsUtf8View view = {
      .data = (const uint8_t *)text,
      .length = (size_t)length,
  };
  NtsWebVoidResult update =
      nts_web_node_set_text_content(realm, nts_counter.button, view);
  if (!nts_take_void_result(&update)) nts_counter.failed = true;
}

void nts_counter_stop(void) {
  if (!nts_counter.active) return;

  NtsWebRealm *realm = nts_counter.realm;
  if (realm != NULL && nts_web_realm_is_current(realm) &&
      nts_web_realm_is_alive(realm)) {
    nts_dispose_subscription_if_live(realm,
                                     &nts_counter.click_subscription);
    nts_release_if_live(realm, &nts_counter.button);
  }

  nts_counter = (NtsCounterState){0};
}

bool nts_counter_failed(void) {
  return nts_counter.failed;
}
