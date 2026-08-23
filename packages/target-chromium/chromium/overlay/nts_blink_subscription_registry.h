#ifndef NTS_BLINK_SUBSCRIPTION_REGISTRY_H
#define NTS_BLINK_SUBSCRIPTION_REGISTRY_H

#include "base/sequence_checker.h"
#include "third_party/blink/renderer/native_typescript/nts_web.h"
#include "third_party/blink/renderer/native_typescript/runtime/nts_handle_table.h"

namespace blink {
class AtomicString;
class EventTarget;
}

namespace nts::blink_bridge {

class BlinkNativeEventListener;

/* Realm-owned event registrations. The C token has its own slot/generation
 * domain, separate from DOM object handles. Destroying a token removes the
 * exact listener instance from Blink before its Oilpan roots are dropped. */
class BlinkSubscriptionRegistry final {
 public:
  BlinkSubscriptionRegistry();
  BlinkSubscriptionRegistry(const BlinkSubscriptionRegistry&) = delete;
  BlinkSubscriptionRegistry& operator=(const BlinkSubscriptionRegistry&) =
      delete;
  ~BlinkSubscriptionRegistry();

  NtsWebStatus Create(blink::EventTarget* target,
                      const blink::AtomicString& event_type,
                      BlinkNativeEventListener* listener,
                      NtsWebSubscription* out_subscription);
  NtsWebStatus Dispose(NtsWebSubscription subscription);

  void Invalidate();
  bool IsInvalidated() const { return table_.invalidated; }
  size_t LiveCount() const;

 private:
  static void DestroyToken(void* context, void* token);

  NtsHandleTable table_{};
  SEQUENCE_CHECKER(sequence_checker_);
};

}  // namespace nts::blink_bridge

#endif
