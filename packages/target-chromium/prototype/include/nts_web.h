#ifndef NTS_WEB_H
#define NTS_WEB_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct NtsWebRealm NtsWebRealm;

/* Borrowed UTF-8 input. The callee may read it only for the dynamic extent of
 * the call unless a specific generated binding declares and performs a copy. */
typedef struct {
  const uint8_t *data;
  size_t length;
} NtsUtf8View;

/* Owned UTF-8 output used by exception payloads. `data == NULL` represents an
 * empty/not-present allocation. Dispose through nts_web_exception_dispose();
 * generated code must not free these buffers with an assumed allocator. */
typedef struct {
  uint8_t *data;
  size_t length;
} NtsOwnedUtf8;

typedef struct {
  uint32_t slot;
  uint32_t generation;
} NtsWebHandle;

typedef struct {
  uint32_t slot;
  uint32_t generation;
} NtsWebCallbackToken;

/* Event registrations are resources in their own domain. They deliberately do
 * not alias DOM object handles: disposing one removes the exact native Blink
 * listener associated with that registration. */
typedef struct {
  uint32_t slot;
  uint32_t generation;
} NtsWebSubscription;

typedef enum {
  NTS_WEB_OK = 0,
  NTS_WEB_INVALID_ARGUMENT,
  NTS_WEB_INVALID_HANDLE,
  NTS_WEB_WRONG_REALM,
  NTS_WEB_WRONG_SEQUENCE,
  NTS_WEB_CONTEXT_DESTROYED,
  NTS_WEB_TYPE_ERROR,
  NTS_WEB_RANGE_ERROR,
  NTS_WEB_SYNTAX_ERROR,
  NTS_WEB_DOM_EXCEPTION,
  NTS_WEB_OPERATION_DISABLED,
  NTS_WEB_OUT_OF_MEMORY
} NtsWebStatus;

typedef struct {
  NtsWebStatus status;
  uint16_t legacy_code;
  NtsOwnedUtf8 name;
  NtsOwnedUtf8 message;
} NtsWebException;

typedef struct {
  NtsWebStatus status;
  NtsWebHandle value;
  NtsWebException exception;
} NtsWebHandleResult;

typedef struct {
  NtsWebStatus status;
  NtsWebSubscription value;
  NtsWebException exception;
} NtsWebSubscriptionResult;

typedef struct {
  NtsWebStatus status;
  NtsWebException exception;
} NtsWebVoidResult;

/* Releases all storage owned by an exception payload and resets it to the
 * success/empty state. It is valid to call this on a zero-initialized or
 * already-disposed exception. */
void nts_web_exception_dispose(NtsWebException *exception);

/* Realm lifecycle. A realm is bound to one Blink ExecutionContext and one
 * renderer owner sequence. The Blink adapter constructs/destroys it. */
bool nts_web_realm_is_current(const NtsWebRealm *realm);
bool nts_web_realm_is_alive(const NtsWebRealm *realm);

/* Root objects. A successful nullable interface result uses the zero handle
 * (`slot == 0 && generation == 0`) for WebIDL null. */
NtsWebHandleResult nts_web_document(NtsWebRealm *realm);
NtsWebHandleResult nts_web_document_body(NtsWebRealm *realm,
                                          NtsWebHandle document);

/* First deliberately narrow DOM surface. These are statically identified
 * operations, not a generic property/method dispatch facility. */
NtsWebHandleResult nts_web_document_create_element(
    NtsWebRealm *realm,
    NtsWebHandle document,
    NtsUtf8View local_name);

NtsWebVoidResult nts_web_node_append_child(
    NtsWebRealm *realm,
    NtsWebHandle parent,
    NtsWebHandle child);

NtsWebVoidResult nts_web_node_set_text_content(
    NtsWebRealm *realm,
    NtsWebHandle node,
    NtsUtf8View text);

/* The callback token belongs to the compiled/runtime side. Blink stores only
 * that opaque token; it never owns or reads a ScriptC closure. The first
 * counter fixture reaches the payload-free listener shape, so no Event handle
 * is materialized yet. */
NtsWebSubscriptionResult nts_web_event_target_add_event_listener(
    NtsWebRealm *realm,
    NtsWebHandle target,
    NtsUtf8View event_type,
    NtsWebCallbackToken callback);

NtsWebStatus nts_web_subscription_dispose(
    NtsWebRealm *realm,
    NtsWebSubscription subscription);

/* Handle lifetime. Releasing the final Native TypeScript edge allows the
 * realm registry to release its corresponding Oilpan strong edge. */
NtsWebStatus nts_web_handle_retain(NtsWebRealm *realm, NtsWebHandle handle);
NtsWebStatus nts_web_handle_release(NtsWebRealm *realm, NtsWebHandle handle);

#ifdef __cplusplus
}
#endif

#endif
