#include "third_party/blink/renderer/native_typescript/nts_blink_managed_registry.h"

#include <cstddef>
#include <cstdint>
#include <new>

#include "base/check.h"
#include "third_party/blink/renderer/core/dom/character_data.h"
#include "third_party/blink/renderer/core/dom/document.h"
#include "third_party/blink/renderer/core/dom/element.h"
#include "third_party/blink/renderer/core/dom/events/event.h"
#include "third_party/blink/renderer/core/dom/events/event_target.h"
#include "third_party/blink/renderer/core/dom/events/native_event_listener.h"
#include "third_party/blink/renderer/core/dom/node.h"
#include "third_party/blink/renderer/core/dom/text.h"
#include "third_party/blink/renderer/core/execution_context/execution_context.h"
#include "third_party/blink/renderer/core/html/html_element.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_realm.h"
#include "third_party/blink/renderer/platform/heap/garbage_collected.h"
#include "third_party/blink/renderer/platform/heap/persistent.h"
#include "third_party/blink/renderer/platform/heap/visitor.h"
#include "third_party/blink/renderer/platform/wtf/casting.h"
#include "third_party/blink/renderer/platform/wtf/text/atomic_string.h"

namespace nts::blink_bridge {
class BlinkManagedRegistry;
}

struct NtsWebNode final {
  raw_ptr<nts::blink_bridge::BlinkManagedRegistry> registry;
  raw_ptr<NtsWebNode> next = nullptr;
  blink::Persistent<blink::Node> node;
  size_t claims = 1;
};

namespace nts::blink_bridge {
namespace {

NtsWebNode* EncodeManagedPeer(NtsWebNode* peer) {
  CHECK(peer);
  const uintptr_t address = reinterpret_cast<uintptr_t>(peer);
  CHECK_EQ(address & kManagedWebNodeHandleTag, 0u);
  return reinterpret_cast<NtsWebNode*>(address | kManagedWebNodeHandleTag);
}

NtsWebNode* DecodeManagedPeer(NtsWebNode* handle) {
  CHECK(IsManagedWebNodeHandle(handle));
  return reinterpret_cast<NtsWebNode*>(reinterpret_cast<uintptr_t>(handle) &
                                       ~kManagedWebNodeHandleTag);
}

class BlinkManagedEventListener final : public blink::NativeEventListener {
 public:
  BlinkManagedEventListener(NtsWebRealm* realm,
                            void (*callback)(void*),
                            void* context)
      : realm_(realm), callback_(callback), context_(context) {
    CHECK(realm_);
    CHECK(callback_);
  }

  ~BlinkManagedEventListener() override = default;

  void Invoke(blink::ExecutionContext* context, blink::Event* event) override {
    if (!realm_ || !callback_ || !context || !event || !realm_->IsAlive() ||
        !realm_->Document() ||
        realm_->Document()->GetExecutionContext() != context) {
      return;
    }
    ScopedCurrentWebRealm active_realm(realm_);
    callback_(context_);
  }

  void Trace(blink::Visitor* visitor) const override {
    blink::NativeEventListener::Trace(visitor);
  }

  void Detach() {
    realm_ = nullptr;
    callback_ = nullptr;
    context_ = nullptr;
  }

 private:
  raw_ptr<NtsWebRealm> realm_;
  void (*callback_)(void*) = nullptr;
  raw_ptr<void> context_ = nullptr;
};

bool Accepts(const blink::Node& node, ManagedWebType expected) {
  switch (expected) {
    case ManagedWebType::kEventTarget:
    case ManagedWebType::kNode:
      return true;
    case ManagedWebType::kElement:
      return blink::IsA<blink::Element>(node);
    case ManagedWebType::kHTMLElement:
      return blink::IsA<blink::HTMLElement>(node);
    case ManagedWebType::kCharacterData:
      return blink::IsA<blink::CharacterData>(node);
    case ManagedWebType::kText:
      return blink::IsA<blink::Text>(node);
    case ManagedWebType::kDocument:
      return blink::IsA<blink::Document>(node);
  }
}

}  // namespace
}  // namespace nts::blink_bridge

struct NtsWebManagedSubscription final {
  raw_ptr<nts::blink_bridge::BlinkManagedRegistry> registry;
  raw_ptr<NtsWebManagedSubscription> next = nullptr;
  blink::Persistent<blink::EventTarget> target;
  blink::Persistent<nts::blink_bridge::BlinkManagedEventListener> listener;
  blink::AtomicString event_type;
  size_t claims = 1;
  bool active = false;

  void Cancel() {
    if (active && target.Get() && listener.Get()) {
      target->removeEventListener(event_type, listener.Get(), false);
    }
    active = false;
    if (listener.Get()) {
      listener->Detach();
    }
    listener = nullptr;
    target = nullptr;
  }
};

namespace nts::blink_bridge {

BlinkManagedRegistry::BlinkManagedRegistry(NtsWebRealm* realm) : realm_(realm) {
  CHECK(realm_);
}

BlinkManagedRegistry::~BlinkManagedRegistry() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  Invalidate();
  while (subscriptions_) {
    NtsWebManagedSubscription* subscription = subscriptions_;
    subscriptions_ = subscription->next;
    subscription->registry = nullptr;
    subscription->next = nullptr;
  }
  while (nodes_) {
    NtsWebNode* peer = nodes_;
    nodes_ = peer->next;
    peer->registry = nullptr;
    peer->next = nullptr;
  }
  realm_ = nullptr;
}

NtsWebNode* BlinkManagedRegistry::AcquireNode(blink::Node* node) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (invalidated_ || !node) {
    return nullptr;
  }
  for (NtsWebNode* peer = nodes_; peer; peer = peer->next) {
    if (peer->node.Get() == node) {
      CHECK_GT(peer->claims, 0u);
      ++peer->claims;
      return EncodeManagedPeer(peer);
    }
  }
  auto* peer = new (std::nothrow) NtsWebNode{
      .registry = this,
      .next = nodes_,
      .node = node,
      .claims = 1,
  };
  if (!peer) {
    return nullptr;
  }
  nodes_ = peer;
  return EncodeManagedPeer(peer);
}

blink::Node* BlinkManagedRegistry::ResolveNode(NtsWebNode* handle,
                                               ManagedWebType expected) const {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (invalidated_ || !handle) {
    return nullptr;
  }
  if (!IsManagedWebNodeHandle(handle)) {
    auto* node = reinterpret_cast<blink::Node*>(handle);
    if (!realm_ || !realm_->Document() ||
        &node->GetDocument() != realm_->Document() ||
        !Accepts(*node, expected)) {
      return nullptr;
    }
    return node;
  }
  NtsWebNode* peer = DecodeManagedPeer(handle);
  if (peer->registry != this || !peer->node.Get() ||
      !Accepts(*peer->node.Get(), expected)) {
    return nullptr;
  }
  return peer->node.Get();
}

void BlinkManagedRegistry::RemoveNode(NtsWebNode* peer) {
  raw_ptr<NtsWebNode>* link = &nodes_;
  while (*link && *link != peer) {
    link = &((*link)->next);
  }
  CHECK_EQ(*link, peer);
  *link = peer->next;
  peer->next = nullptr;
}

void BlinkManagedRegistry::ReleaseNode(NtsWebNode* peer) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  CHECK(peer);
  CHECK_EQ(peer->registry, this);
  CHECK_GT(peer->claims, 0u);
  --peer->claims;
  if (peer->claims != 0) {
    return;
  }
  RemoveNode(peer);
  peer->registry = nullptr;
  peer->node = nullptr;
  delete peer;
}

NtsWebManagedSubscription* BlinkManagedRegistry::Listen(
    blink::EventTarget* target,
    const blink::AtomicString& event_type,
    void (*callback)(void*),
    void* context) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (invalidated_ || !target || !callback || event_type.IsNull()) {
    return nullptr;
  }
  auto* listener = blink::MakeGarbageCollected<BlinkManagedEventListener>(
      realm_, callback, context);
  auto* subscription = new (std::nothrow) NtsWebManagedSubscription{
      .registry = this,
      .next = subscriptions_,
      .target = target,
      .listener = listener,
      .event_type = event_type,
      .claims = 1,
      .active = false,
  };
  if (!subscription) {
    listener->Detach();
    return nullptr;
  }
  if (!target->addEventListener(event_type, listener, false)) {
    subscription->Cancel();
    delete subscription;
    return nullptr;
  }
  subscription->active = true;
  subscriptions_ = subscription;
  return subscription;
}

void BlinkManagedRegistry::RemoveSubscription(
    NtsWebManagedSubscription* subscription) {
  raw_ptr<NtsWebManagedSubscription>* link = &subscriptions_;
  while (*link && *link != subscription) {
    link = &((*link)->next);
  }
  CHECK_EQ(*link, subscription);
  *link = subscription->next;
  subscription->next = nullptr;
}

void BlinkManagedRegistry::ReleaseSubscription(
    NtsWebManagedSubscription* subscription) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  CHECK(subscription);
  CHECK_EQ(subscription->registry, this);
  CHECK_GT(subscription->claims, 0u);
  --subscription->claims;
  if (subscription->claims != 0) {
    return;
  }
  RemoveSubscription(subscription);
  subscription->Cancel();
  subscription->registry = nullptr;
  delete subscription;
}

void BlinkManagedRegistry::Invalidate() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (invalidated_) {
    return;
  }
  invalidated_ = true;
  for (NtsWebManagedSubscription* subscription = subscriptions_; subscription;
       subscription = subscription->next) {
    subscription->Cancel();
  }
  for (NtsWebNode* peer = nodes_; peer; peer = peer->next) {
    peer->node = nullptr;
  }
}

void ReleaseManagedNode(NtsWebNode* handle) {
  if (!handle || !IsManagedWebNodeHandle(handle)) {
    return;
  }
  NtsWebNode* peer = DecodeManagedPeer(handle);
  if (peer->registry) {
    peer->registry->ReleaseNode(peer);
    return;
  }
  CHECK_GT(peer->claims, 0u);
  --peer->claims;
  if (peer->claims == 0) {
    delete peer;
  }
}

void ReleaseManagedSubscription(NtsWebManagedSubscription* subscription) {
  if (!subscription) {
    return;
  }
  if (subscription->registry) {
    subscription->registry->ReleaseSubscription(subscription);
    return;
  }
  CHECK_GT(subscription->claims, 0u);
  --subscription->claims;
  if (subscription->claims == 0) {
    delete subscription;
  }
}

}  // namespace nts::blink_bridge
