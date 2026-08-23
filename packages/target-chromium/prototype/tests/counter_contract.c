#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "nts_web.h"
#include "../examples/counter/app.h"

struct NtsWebRealm {
  bool alive;
};

enum {
  HANDLE_DOCUMENT = 1,
  HANDLE_BODY = 2,
  HANDLE_HEADING = 3,
  HANDLE_BUTTON = 4,
};

static NtsWebCallbackToken captured_callback;
static unsigned released_handles;
static unsigned disposed_subscriptions;
static char button_text[64];

static NtsWebHandle handle(uint32_t slot) {
  NtsWebHandle value = {.slot = slot, .generation = 1};
  return value;
}

static NtsWebHandleResult handle_result(uint32_t slot) {
  NtsWebHandleResult result = {0};
  result.status = NTS_WEB_OK;
  result.value = handle(slot);
  result.exception.status = NTS_WEB_OK;
  return result;
}

static NtsWebVoidResult void_result(void) {
  NtsWebVoidResult result = {0};
  result.status = NTS_WEB_OK;
  result.exception.status = NTS_WEB_OK;
  return result;
}

bool nts_web_realm_is_current(const NtsWebRealm *realm) {
  return realm != NULL;
}

bool nts_web_realm_is_alive(const NtsWebRealm *realm) {
  return realm != NULL && realm->alive;
}

NtsWebHandleResult nts_web_document(NtsWebRealm *realm) {
  assert(realm->alive);
  return handle_result(HANDLE_DOCUMENT);
}

NtsWebHandleResult nts_web_document_body(NtsWebRealm *realm,
                                          NtsWebHandle document) {
  assert(realm->alive);
  assert(document.slot == HANDLE_DOCUMENT);
  return handle_result(HANDLE_BODY);
}

NtsWebHandleResult nts_web_document_create_element(
    NtsWebRealm *realm,
    NtsWebHandle document,
    NtsUtf8View local_name) {
  assert(realm->alive);
  assert(document.slot == HANDLE_DOCUMENT);
  if (local_name.length == 2 && memcmp(local_name.data, "h1", 2) == 0) {
    return handle_result(HANDLE_HEADING);
  }
  assert(local_name.length == 6);
  assert(memcmp(local_name.data, "button", 6) == 0);
  return handle_result(HANDLE_BUTTON);
}

NtsWebVoidResult nts_web_node_set_text_content(NtsWebRealm *realm,
                                                NtsWebHandle node,
                                                NtsUtf8View text) {
  assert(realm->alive);
  if (node.slot == HANDLE_BUTTON) {
    assert(text.length < sizeof button_text);
    memcpy(button_text, text.data, text.length);
    button_text[text.length] = '\0';
  }
  return void_result();
}

NtsWebVoidResult nts_web_node_append_child(NtsWebRealm *realm,
                                            NtsWebHandle parent,
                                            NtsWebHandle child) {
  assert(realm->alive);
  assert(parent.slot == HANDLE_BODY);
  assert(child.slot == HANDLE_HEADING || child.slot == HANDLE_BUTTON);
  return void_result();
}

NtsWebSubscriptionResult nts_web_event_target_add_event_listener(
    NtsWebRealm *realm,
    NtsWebHandle target,
    NtsUtf8View event_type,
    NtsWebCallbackToken callback) {
  assert(realm->alive);
  assert(target.slot == HANDLE_BUTTON);
  assert(event_type.length == 5);
  assert(memcmp(event_type.data, "click", 5) == 0);
  captured_callback = callback;

  NtsWebSubscriptionResult result = {0};
  result.status = NTS_WEB_OK;
  result.value.slot = 1;
  result.value.generation = 1;
  result.exception.status = NTS_WEB_OK;
  return result;
}

NtsWebStatus nts_web_subscription_dispose(NtsWebRealm *realm,
                                           NtsWebSubscription subscription) {
  assert(realm->alive);
  assert(subscription.slot == 1);
  assert(subscription.generation == 1);
  disposed_subscriptions += 1;
  return NTS_WEB_OK;
}

NtsWebStatus nts_web_handle_release(NtsWebRealm *realm, NtsWebHandle value) {
  assert(realm->alive);
  assert(value.generation == 1);
  released_handles += 1;
  return NTS_WEB_OK;
}

int main(void) {
  NtsWebRealm realm = {.alive = true};

  assert(nts_counter_start(&realm));
  assert(strcmp(button_text, "Count: 0") == 0);
  assert(captured_callback.generation != 0);

  /* Start released document/body/heading; the button remains captured by the
   * long-lived callback state. */
  assert(released_handles == 3);
  assert(disposed_subscriptions == 0);

  nts_counter_dispatch_event(&realm, captured_callback, NULL);
  assert(!nts_counter_failed());
  assert(strcmp(button_text, "Count: 1") == 0);

  nts_counter_dispatch_event(&realm, captured_callback, NULL);
  assert(strcmp(button_text, "Count: 2") == 0);

  nts_counter_stop();
  assert(disposed_subscriptions == 1);
  assert(released_handles == 4);

  return 0;
}
