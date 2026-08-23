#include "third_party/blink/renderer/native_typescript/nts_blink_event_listener.h"

#include "base/check.h"
#include "third_party/blink/renderer/core/dom/events/event.h"
#include "third_party/blink/renderer/core/execution_context/execution_context.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_realm.h"
#include "third_party/blink/renderer/platform/heap/visitor.h"

namespace nts::blink_bridge {

BlinkNativeEventListener::BlinkNativeEventListener(
    NtsWebRealm* realm,
    NtsWebCallbackToken token)
    : realm_(realm), token_(token) {
  CHECK(realm_);
  CHECK_NE(token_.generation, 0u);
}

void BlinkNativeEventListener::Invoke(blink::ExecutionContext* context,
                                      blink::Event* event) {
  if (!realm_ || !context || !event) return;
  realm_->DispatchNativeEvent(token_, context);
}

void BlinkNativeEventListener::Trace(blink::Visitor* visitor) const {
  blink::NativeEventListener::Trace(visitor);
}

}  // namespace nts::blink_bridge
