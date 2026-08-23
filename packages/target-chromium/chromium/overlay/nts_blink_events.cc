#include "third_party/blink/renderer/native_typescript/nts_web.h"

#include "base/containers/span.h"
#include "third_party/blink/renderer/core/dom/events/event_target.h"
#include "third_party/blink/renderer/core/dom/node.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_event_listener.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_realm.h"
#include "third_party/blink/renderer/platform/heap/garbage_collected.h"
#include "third_party/blink/renderer/platform/wtf/text/atomic_string.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"

namespace {

NtsWebSubscriptionResult Failure(NtsWebStatus status) {
  NtsWebSubscriptionResult result{};
  result.status = status;
  result.exception.status = status;
  return result;
}

NtsWebStatus CheckRealm(NtsWebRealm* realm) {
  if (!realm) return NTS_WEB_INVALID_ARGUMENT;
  if (!realm->IsCurrent()) return NTS_WEB_WRONG_SEQUENCE;
  if (!realm->IsAlive()) return NTS_WEB_CONTEXT_DESTROYED;
  return NTS_WEB_OK;
}

NtsWebStatus DecodeAtomicString(NtsUtf8View source,
                                blink::AtomicString* out) {
  if (!out || (!source.data && source.length != 0)) {
    return NTS_WEB_INVALID_ARGUMENT;
  }
  blink::String string =
      blink::String::FromUtf8(base::span(source.data, source.length));
  if (string.IsNull() && source.length != 0) {
    return NTS_WEB_INVALID_ARGUMENT;
  }
  *out = blink::AtomicString(string);
  return NTS_WEB_OK;
}

}  // namespace

extern "C" NtsWebSubscriptionResult nts_web_event_target_add_event_listener(
    NtsWebRealm* realm,
    NtsWebHandle target_handle,
    NtsUtf8View event_type_utf8,
    NtsWebCallbackToken callback) {
  const NtsWebStatus realm_status = CheckRealm(realm);
  if (realm_status != NTS_WEB_OK) return Failure(realm_status);
  if (callback.generation == 0) return Failure(NTS_WEB_INVALID_ARGUMENT);

  blink::Node* target_node = nullptr;
  NtsWebStatus status = realm->Nodes().Resolve(
      target_handle, nts::blink_bridge::WebTypeId::kNode, &target_node);
  if (status != NTS_WEB_OK) return Failure(status);

  blink::AtomicString event_type;
  status = DecodeAtomicString(event_type_utf8, &event_type);
  if (status != NTS_WEB_OK) return Failure(status);

  auto* listener = blink::MakeGarbageCollected<
      nts::blink_bridge::BlinkNativeEventListener>(realm, callback);

  NtsWebSubscriptionResult result{};
  result.status = realm->Subscriptions().Create(
      static_cast<blink::EventTarget*>(target_node), event_type, listener,
      &result.value);
  result.exception.status = result.status;
  return result;
}
