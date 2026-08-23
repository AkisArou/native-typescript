#include "third_party/blink/renderer/native_typescript/nts_blink_subscription_registry.h"

#include <new>

#include "base/check.h"
#include "third_party/blink/renderer/core/dom/events/event_target.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_event_listener.h"
#include "third_party/blink/renderer/platform/heap/persistent.h"
#include "third_party/blink/renderer/platform/wtf/text/atomic_string.h"

namespace nts::blink_bridge {
namespace {

constexpr uint32_t kSubscriptionType = 0x40c43cb8U;

class BlinkSubscriptionRoot final {
 public:
  BlinkSubscriptionRoot(blink::EventTarget* target,
                        const blink::AtomicString& event_type,
                        BlinkNativeEventListener* listener)
      : target_(target), listener_(listener), event_type_(event_type) {
    CHECK(target);
    CHECK(listener);
  }

  BlinkSubscriptionRoot(const BlinkSubscriptionRoot&) = delete;
  BlinkSubscriptionRoot& operator=(const BlinkSubscriptionRoot&) = delete;

  ~BlinkSubscriptionRoot() { Cancel(); }

  void Activate() { active_ = true; }

  void Cancel() {
    if (!active_) return;
    active_ = false;
    if (target_.Get() && listener_.Get()) {
      target_->removeEventListener(event_type_, listener_.Get(), false);
      listener_->Detach();
    }
  }

 private:
  blink::Persistent<blink::EventTarget> target_;
  blink::Persistent<BlinkNativeEventListener> listener_;
  blink::AtomicString event_type_;
  bool active_ = false;
};

NtsWebHandle AsHandle(NtsWebSubscription subscription) {
  return NtsWebHandle{
      .slot = subscription.slot,
      .generation = subscription.generation,
  };
}

NtsWebSubscription AsSubscription(NtsWebHandle handle) {
  return NtsWebSubscription{
      .slot = handle.slot,
      .generation = handle.generation,
  };
}

}  // namespace

BlinkSubscriptionRegistry::BlinkSubscriptionRegistry() {
  NtsHandleTableHooks hooks = {
      .destroy_token = &BlinkSubscriptionRegistry::DestroyToken,
      .type_accepts = nullptr,
      .context = this,
  };
  nts_handle_table_init(&table_, hooks);
}

BlinkSubscriptionRegistry::~BlinkSubscriptionRegistry() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  nts_handle_table_destroy(&table_);
}

NtsWebStatus BlinkSubscriptionRegistry::Create(
    blink::EventTarget* target,
    const blink::AtomicString& event_type,
    BlinkNativeEventListener* listener,
    NtsWebSubscription* out_subscription) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (!target || !listener || !out_subscription) {
    return NTS_WEB_INVALID_ARGUMENT;
  }
  if (table_.invalidated) return NTS_WEB_CONTEXT_DESTROYED;

  auto* root = new (std::nothrow)
      BlinkSubscriptionRoot(target, event_type, listener);
  if (!root) return NTS_WEB_OUT_OF_MEMORY;

  if (!target->addEventListener(event_type, listener, false)) {
    delete root;
    return NTS_WEB_OPERATION_DISABLED;
  }
  root->Activate();

  NtsWebHandle handle{};
  NtsWebStatus status =
      nts_handle_table_insert(&table_, kSubscriptionType, root, &handle);
  if (status != NTS_WEB_OK) {
    delete root;
    return status;
  }

  *out_subscription = AsSubscription(handle);
  return NTS_WEB_OK;
}

NtsWebStatus BlinkSubscriptionRegistry::Dispose(
    NtsWebSubscription subscription) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  return nts_handle_table_release(&table_, AsHandle(subscription));
}

void BlinkSubscriptionRegistry::Invalidate() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  nts_handle_table_invalidate(&table_);
}

size_t BlinkSubscriptionRegistry::LiveCount() const {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  return nts_handle_table_live_count(&table_);
}

void BlinkSubscriptionRegistry::DestroyToken(void* context, void* token) {
  auto* registry = static_cast<BlinkSubscriptionRegistry*>(context);
  DCHECK_CALLED_ON_VALID_SEQUENCE(registry->sequence_checker_);
  delete static_cast<BlinkSubscriptionRoot*>(token);
}

}  // namespace nts::blink_bridge
