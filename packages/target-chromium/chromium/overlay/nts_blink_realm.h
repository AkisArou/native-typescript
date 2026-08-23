#ifndef NTS_BLINK_REALM_H
#define NTS_BLINK_REALM_H

#include "base/sequence_checker.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_node_registry.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_subscription_registry.h"
#include "third_party/blink/renderer/native_typescript/nts_web.h"
#include "third_party/blink/renderer/platform/heap/persistent.h"

namespace blink {
class Document;
class ExecutionContext;
}

namespace nts::blink_bridge {
class BlinkRealmLifecycleObserver;
using NativeEventDispatch =
    void (*)(NtsWebRealm*, NtsWebCallbackToken, void* context);
}

/* C sees only the opaque forward declaration from nts_web.h. The Chromium
 * adapter sees this owner-sequence-confined definition. It is deliberately an
 * off-heap object: its Persistent<Document>, object roots and subscription
 * roots are the explicit Oilpan edges associated with the Native TypeScript
 * realm. */
struct NtsWebRealm final {
 public:
  NtsWebRealm(blink::Document* document,
              nts::blink_bridge::NativeEventDispatch event_dispatch,
              void* event_context);
  NtsWebRealm(const NtsWebRealm&) = delete;
  NtsWebRealm& operator=(const NtsWebRealm&) = delete;
  ~NtsWebRealm();

  bool IsCurrent() const;
  bool IsAlive() const;
  void Invalidate();

  blink::Document* Document() const;
  nts::blink_bridge::BlinkNodeRegistry& Nodes() { return nodes_; }
  nts::blink_bridge::BlinkSubscriptionRegistry& Subscriptions() {
    return subscriptions_;
  }

  void DispatchNativeEvent(NtsWebCallbackToken token,
                           blink::ExecutionContext* context);

 private:
  base::SequenceChecker sequence_checker_;
  bool alive_ = true;
  blink::Persistent<blink::Document> document_;
  blink::Persistent<nts::blink_bridge::BlinkRealmLifecycleObserver>
      lifecycle_observer_;
  nts::blink_bridge::BlinkNodeRegistry nodes_;
  nts::blink_bridge::BlinkSubscriptionRegistry subscriptions_;
  nts::blink_bridge::NativeEventDispatch event_dispatch_ = nullptr;
  void* event_context_ = nullptr;
};

namespace nts::blink_bridge {

/* Host-facing construction seam. The embedder creates one realm for the
 * document/execution context whose renderer sequence is currently executing.
 * The event dispatcher is the future ScriptC retained-callback entry; the
 * plain-C counter supplies a C function with the same token-shaped contract. */
NtsWebRealm* CreateWebRealm(blink::Document* document,
                            NativeEventDispatch event_dispatch = nullptr,
                            void* event_context = nullptr);
void DestroyWebRealm(NtsWebRealm* realm);
void InvalidateWebRealm(NtsWebRealm* realm);

}  // namespace nts::blink_bridge

#endif
