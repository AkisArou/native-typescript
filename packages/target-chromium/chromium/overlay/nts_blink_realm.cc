#include "third_party/blink/renderer/native_typescript/nts_blink_realm.h"

#include <atomic>
#include <new>

#include "base/check.h"
#include "third_party/blink/renderer/core/dom/document.h"
#include "third_party/blink/renderer/core/execution_context/execution_context.h"
#include "third_party/blink/renderer/core/execution_context/execution_context_lifecycle_observer.h"
#include "third_party/blink/renderer/platform/heap/garbage_collected.h"
#include "third_party/blink/renderer/platform/heap/visitor.h"

namespace nts::blink_bridge {

namespace {

uint64_t NextRealmId() {
  static std::atomic<uint64_t> next_realm{1};
  const uint64_t realm = next_realm.fetch_add(1, std::memory_order_relaxed);
  CHECK_NE(realm, 0u) << "Native TypeScript realm identity exhausted";
  return realm;
}

}  // namespace

/* Oilpan-owned observer, explicitly rooted by the off-heap realm. The raw
 * pointer points out of Oilpan on purpose: Detach() clears it before the
 * off-heap owner is destroyed, while ContextDestroyed() runs on the owner
 * sequence and invalidates the realm before Blink drops the execution context.
 */
class BlinkRealmLifecycleObserver final
    : public blink::GarbageCollected<BlinkRealmLifecycleObserver>,
      public blink::ExecutionContextLifecycleObserver {
 public:
  BlinkRealmLifecycleObserver(blink::ExecutionContext* context,
                              NtsWebRealm* realm)
      : blink::ExecutionContextLifecycleObserver(context), realm_(realm) {
    CHECK(context);
    CHECK(realm_);
  }

  void Detach() {
    realm_ = nullptr;
    SetExecutionContext(nullptr);
  }

  void Trace(blink::Visitor* visitor) const override {
    blink::ExecutionContextLifecycleObserver::Trace(visitor);
  }

 private:
  void ContextDestroyed() override {
    if (!realm_) {
      return;
    }
    realm_->Invalidate();
    realm_ = nullptr;
  }

  raw_ptr<NtsWebRealm> realm_;
};

}  // namespace nts::blink_bridge

NtsWebRealm::NtsWebRealm(blink::Document* document,
                         nts::blink_bridge::NativeEventDispatch event_dispatch,
                         void* event_context)
    : realm_id_(nts::blink_bridge::NextRealmId()),
      document_(document),
      nodes_(realm_id_),
      subscriptions_(realm_id_),
      event_dispatch_(event_dispatch),
      event_context_(event_context) {
  CHECK(document);
  CHECK(document->GetExecutionContext());
  CHECK(IsCurrent());
  lifecycle_observer_ = blink::MakeGarbageCollected<
      nts::blink_bridge::BlinkRealmLifecycleObserver>(
      document->GetExecutionContext(), this);
}

NtsWebRealm::~NtsWebRealm() {
  CHECK(IsCurrent());
  if (lifecycle_observer_.Get()) {
    lifecycle_observer_->Detach();
    lifecycle_observer_ = nullptr;
  }
  Invalidate();
}

bool NtsWebRealm::IsCurrent() const {
  return sequence_checker_.CalledOnValidSequence();
}

bool NtsWebRealm::IsAlive() const {
  return IsCurrent() && alive_ && document_.Get() != nullptr;
}

void NtsWebRealm::Invalidate() {
  CHECK(IsCurrent());
  if (!alive_) {
    return;
  }
  alive_ = false;

  /* Listener cancellation comes first: listener roots contain raw pointers
   * back to this realm, so every registration is removed/detached before DOM
   * object roots or the document root are released. */
  subscriptions_.Invalidate();
  nodes_.Invalidate();
  document_ = nullptr;
  event_dispatch_ = nullptr;
  event_context_ = nullptr;
}

blink::Document* NtsWebRealm::Document() const {
  CHECK(IsCurrent());
  return alive_ ? document_.Get() : nullptr;
}

void NtsWebRealm::DispatchNativeEvent(NtsWebCallbackToken token,
                                      blink::ExecutionContext* context) {
  CHECK(IsCurrent());
  if (!alive_ || !event_dispatch_ || !context || !document_.Get()) {
    return;
  }
  if (context != document_->GetExecutionContext()) {
    return;
  }
  event_dispatch_(this, token, event_context_);
}

namespace nts::blink_bridge {

NtsWebRealm* CreateWebRealm(blink::Document* document,
                            NativeEventDispatch event_dispatch,
                            void* event_context) {
  if (!document || !document->GetExecutionContext()) {
    return nullptr;
  }
  return new (std::nothrow)
      NtsWebRealm(document, event_dispatch, event_context);
}

void DestroyWebRealm(NtsWebRealm* realm) {
  if (!realm) {
    return;
  }
  CHECK(realm->IsCurrent());
  delete realm;
}

void InvalidateWebRealm(NtsWebRealm* realm) {
  if (!realm) {
    return;
  }
  CHECK(realm->IsCurrent());
  realm->Invalidate();
}

}  // namespace nts::blink_bridge

extern "C" bool nts_web_realm_is_current(const NtsWebRealm* realm) {
  return realm != nullptr && realm->IsCurrent();
}

extern "C" bool nts_web_realm_is_alive(const NtsWebRealm* realm) {
  return realm != nullptr && realm->IsAlive();
}

extern "C" NtsWebStatus nts_web_handle_retain(NtsWebRealm* realm,
                                              NtsWebHandle handle) {
  if (!realm) {
    return NTS_WEB_INVALID_ARGUMENT;
  }
  if (!realm->IsCurrent()) {
    return NTS_WEB_WRONG_SEQUENCE;
  }
  if (!realm->IsAlive()) {
    return NTS_WEB_CONTEXT_DESTROYED;
  }
  return realm->Nodes().Retain(handle);
}

extern "C" NtsWebStatus nts_web_handle_release(NtsWebRealm* realm,
                                               NtsWebHandle handle) {
  if (!realm) {
    return NTS_WEB_INVALID_ARGUMENT;
  }
  if (!realm->IsCurrent()) {
    return NTS_WEB_WRONG_SEQUENCE;
  }
  if (!realm->IsAlive()) {
    return NTS_WEB_CONTEXT_DESTROYED;
  }
  return realm->Nodes().Release(handle);
}

extern "C" NtsWebStatus nts_web_subscription_dispose(
    NtsWebRealm* realm,
    NtsWebSubscription subscription) {
  if (!realm) {
    return NTS_WEB_INVALID_ARGUMENT;
  }
  if (!realm->IsCurrent()) {
    return NTS_WEB_WRONG_SEQUENCE;
  }
  if (!realm->IsAlive()) {
    return NTS_WEB_CONTEXT_DESTROYED;
  }
  return realm->Subscriptions().Dispose(subscription);
}
