#ifndef NTS_BLINK_EVENT_LISTENER_H
#define NTS_BLINK_EVENT_LISTENER_H

#include "third_party/blink/renderer/native_typescript/nts_web.h"
#include "third_party/blink/renderer/core/dom/events/native_event_listener.h"

struct NtsWebRealm;

namespace blink {
class Event;
class ExecutionContext;
class Visitor;
}

namespace nts::blink_bridge {

/* Blink already has a native event-listener path. This adapter deliberately
 * subclasses it rather than manufacturing a V8 EventListener wrapper. The raw
 * realm pointer is safe by contract: every live registration belongs to the
 * realm subscription registry, and invalidation removes/detaches registrations
 * before the off-heap realm can be destroyed. */
class BlinkNativeEventListener final : public blink::NativeEventListener {
 public:
  BlinkNativeEventListener(NtsWebRealm* realm, NtsWebCallbackToken token);
  ~BlinkNativeEventListener() override = default;

  void Invoke(blink::ExecutionContext* context, blink::Event* event) override;
  void Trace(blink::Visitor* visitor) const override;

  void Detach() { realm_ = nullptr; }

 private:
  NtsWebRealm* realm_;
  NtsWebCallbackToken token_;
};

}  // namespace nts::blink_bridge

#endif
