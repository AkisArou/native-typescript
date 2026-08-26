#include "third_party/blink/renderer/native_typescript/nts_blink_managed_registry.h"

#include <cstddef>
#include <cstdint>
#include <new>

#include "base/check.h"
#include "base/compiler_specific.h"
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
#include "third_party/blink/renderer/platform/heap/member.h"
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
  blink::DOMNodeId dom_node_id = blink::kInvalidDOMNodeId;
  size_t claims = 1;
};

namespace nts::blink_bridge {
namespace {

DISABLE_CFI_ICALL void InvokeScriptCCallback(void (*callback)(void *),
                                             void *context) {
  callback(context);
}

DISABLE_CFI_ICALL void
ReleaseScriptCCallbackContext(void (*context_release)(void *), void *context) {
  if (context_release) {
    context_release(context);
  }
}

NtsWebNode *EncodeManagedPeer(NtsWebNode *peer) {
  CHECK(peer);
  const uintptr_t address = reinterpret_cast<uintptr_t>(peer);
  CHECK_EQ(address & kManagedWebNodeHandleTag, 0u);
  return reinterpret_cast<NtsWebNode *>(address | kManagedWebNodeHandleTag);
}

NtsWebNode *DecodeManagedPeer(NtsWebNode *handle) {
  CHECK(IsManagedWebNodeHandle(handle));
  return reinterpret_cast<NtsWebNode *>(reinterpret_cast<uintptr_t>(handle) &
                                        ~kManagedWebNodeHandleTag);
}

class BlinkManagedEventListener final : public blink::NativeEventListener {
public:
  BlinkManagedEventListener(NtsWebRealm *realm, void (*callback)(void *),
                            void *context)
      : realm_(realm), callback_(callback), context_(context) {
    CHECK(realm_);
    CHECK(callback_);
  }

  ~BlinkManagedEventListener() override = default;

  void Invoke(blink::ExecutionContext *context, blink::Event *event) override {
    if (!realm_ || !callback_ || !context || !event || !realm_->IsAlive() ||
        !realm_->Document() ||
        realm_->Document()->GetExecutionContext() != context) {
      return;
    }
    ScopedCurrentWebRealm active_realm(realm_);
    InvokeScriptCCallback(callback_, context_);
  }

  void Trace(blink::Visitor *visitor) const override {
    blink::NativeEventListener::Trace(visitor);
  }

  void Detach() {
    realm_ = nullptr;
    callback_ = nullptr;
    context_ = nullptr;
  }

private:
  raw_ptr<NtsWebRealm> realm_;
  void (*callback_)(void *) = nullptr;
  raw_ptr<void> context_ = nullptr;
};

bool Accepts(const blink::Node &node, ManagedWebType expected) {
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

} // namespace
} // namespace nts::blink_bridge

struct NtsWebManagedSubscription final {
  raw_ptr<nts::blink_bridge::BlinkManagedRegistry> registry;
  raw_ptr<NtsWebManagedSubscription> next = nullptr;
  blink::Persistent<blink::EventTarget> target;
  blink::Persistent<nts::blink_bridge::BlinkManagedEventListener> listener;
  blink::AtomicString event_type;
  raw_ptr<void> callback_context = nullptr;
  void (*context_release)(void *) = nullptr;
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
    /* Detach closes callback admission before the context's final closure
     * retain is released. Clear the hook first so reentrant or repeated
     * cancellation cannot release it twice. */
    void *context = callback_context.get();
    auto *release = context_release;
    callback_context = nullptr;
    context_release = nullptr;
    nts::blink_bridge::ReleaseScriptCCallbackContext(release, context);
  }
};

namespace nts::blink_bridge {

/* The result is exposed through the same opaque C type as the stable
 * subscription but is never dereferenced as that type. Its dedicated release
 * entry casts it back to this Oilpan object. EventTarget supplies the strong
 * edge while compiled synchronous code keeps the returned raw pointer on the
 * conservatively scanned active native stack. */
class BlinkFrameEventListener final : public blink::NativeEventListener {
public:
  BlinkFrameEventListener(BlinkManagedRegistry *registry, NtsWebRealm *realm,
                          blink::EventTarget *target,
                          const blink::AtomicString &event_type,
                          void (*callback)(void *), void *context,
                          void (*context_release)(void *))
      : registry_(registry), realm_(realm), target_(target),
        event_type_(event_type), callback_(callback), context_(context),
        context_release_(context_release) {
    CHECK(registry_);
    CHECK(realm_);
    CHECK(target_);
    CHECK(callback_);
  }

  ~BlinkFrameEventListener() override = default;

  void Invoke(blink::ExecutionContext *context, blink::Event *event) override {
    if (closed_ || !realm_ || !callback_ || !context || !event ||
        !realm_->IsAlive() || !realm_->Document() ||
        realm_->Document()->GetExecutionContext() != context) {
      return;
    }
    ScopedCurrentWebRealm active_realm(realm_);
    InvokeScriptCCallback(callback_, context_);
  }

  void Trace(blink::Visitor *visitor) const override {
    visitor->Trace(target_);
    visitor->Trace(next_);
    blink::NativeEventListener::Trace(visitor);
  }

  void Activate(BlinkFrameEventListener *next) {
    CHECK(!closed_);
    CHECK(!active_);
    CHECK(!linked_);
    next_ = next;
    linked_ = true;
    active_ = true;
  }

  void Cancel() {
    if (closed_) {
      return;
    }
    closed_ = true;
    if (active_ && target_) {
      target_->removeEventListener(event_type_, this, false);
    }
    active_ = false;
    if (linked_) {
      CHECK(registry_);
      registry_->RemoveFrameSubscription(this);
      linked_ = false;
    }
    target_ = nullptr;
    next_ = nullptr;
    registry_ = nullptr;
    realm_ = nullptr;
    callback_ = nullptr;

    /* Close admission and clear the hook before releasing the transferred
     * context so repeated or reentrant cancellation cannot release it twice. */
    void *context = context_.get();
    auto *release = context_release_;
    context_ = nullptr;
    context_release_ = nullptr;
    ReleaseScriptCCallbackContext(release, context);
  }

  BlinkFrameEventListener *Next() const { return next_.Get(); }
  void SetNext(BlinkFrameEventListener *next) { next_ = next; }

private:
  raw_ptr<BlinkManagedRegistry> registry_;
  raw_ptr<NtsWebRealm> realm_;
  blink::Member<blink::EventTarget> target_;
  blink::Member<BlinkFrameEventListener> next_;
  blink::AtomicString event_type_;
  void (*callback_)(void *) = nullptr;
  raw_ptr<void> context_ = nullptr;
  void (*context_release_)(void *) = nullptr;
  bool active_ = false;
  bool linked_ = false;
  bool closed_ = false;
};

BlinkManagedRegistry::BlinkManagedRegistry(NtsWebRealm *realm) : realm_(realm) {
  CHECK(realm_);
}

BlinkManagedRegistry::~BlinkManagedRegistry() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  Invalidate();
  CHECK(!frame_subscriptions_);
  while (subscriptions_) {
    NtsWebManagedSubscription *subscription = subscriptions_;
    subscriptions_ = subscription->next;
    subscription->registry = nullptr;
    subscription->next = nullptr;
  }
  while (nodes_) {
    NtsWebNode *peer = nodes_;
    nodes_ = peer->next;
    peer->registry = nullptr;
    peer->next = nullptr;
  }
  realm_ = nullptr;
}

NtsWebNode *BlinkManagedRegistry::AcquireNode(blink::Node *node) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (invalidated_ || !node) {
    return nullptr;
  }
  const blink::DOMNodeId dom_node_id = node->GetDomNodeId();
  auto existing = nodes_by_dom_id_.find(dom_node_id);
  if (existing != nodes_by_dom_id_.end()) {
    NtsWebNode *peer = existing->value;
    CHECK_EQ(peer->node.Get(), node);
    CHECK_GT(peer->claims, 0u);
    ++peer->claims;
    return EncodeManagedPeer(peer);
  }
  auto *peer = new (std::nothrow) NtsWebNode{
      .registry = this,
      .next = nodes_,
      .node = node,
      .dom_node_id = dom_node_id,
      .claims = 1,
  };
  if (!peer) {
    return nullptr;
  }
  nodes_ = peer;
  CHECK(nodes_by_dom_id_.insert(dom_node_id, peer).is_new_entry);
  return EncodeManagedPeer(peer);
}

blink::Node *BlinkManagedRegistry::ResolveNode(NtsWebNode *handle,
                                               ManagedWebType expected) const {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (invalidated_ || !handle) {
    return nullptr;
  }
  if (!IsManagedWebNodeHandle(handle)) {
    auto *node = reinterpret_cast<blink::Node *>(handle);
    if (!realm_ || !realm_->Document() ||
        &node->GetDocument() != realm_->Document() ||
        !Accepts(*node, expected)) {
      return nullptr;
    }
    return node;
  }
  NtsWebNode *peer = DecodeManagedPeer(handle);
  if (peer->registry != this || !peer->node.Get() ||
      !Accepts(*peer->node.Get(), expected)) {
    return nullptr;
  }
  return peer->node.Get();
}

void BlinkManagedRegistry::RemoveNode(NtsWebNode *peer) {
  raw_ptr<NtsWebNode> *link = &nodes_;
  while (*link && *link != peer) {
    link = &((*link)->next);
  }
  CHECK_EQ(*link, peer);
  *link = peer->next;
  peer->next = nullptr;
  auto indexed = nodes_by_dom_id_.find(peer->dom_node_id);
  if (peer->node.Get()) {
    CHECK_NE(indexed, nodes_by_dom_id_.end());
    CHECK_EQ(indexed->value, peer);
    nodes_by_dom_id_.erase(indexed);
  } else {
    CHECK(invalidated_);
    CHECK_EQ(indexed, nodes_by_dom_id_.end());
  }
}

void BlinkManagedRegistry::ReleaseNode(NtsWebNode *peer) {
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

NtsWebManagedSubscription *BlinkManagedRegistry::Listen(
    blink::EventTarget *target, const blink::AtomicString &event_type,
    void (*callback)(void *), void *context, void (*context_release)(void *)) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (invalidated_ || !target || !callback || event_type.IsNull()) {
    ReleaseScriptCCallbackContext(context_release, context);
    return nullptr;
  }
  auto *listener = blink::MakeGarbageCollected<BlinkManagedEventListener>(
      realm_, callback, context);
  auto *subscription = new (std::nothrow) NtsWebManagedSubscription{
      .registry = this,
      .next = subscriptions_,
      .target = target,
      .listener = listener,
      .event_type = event_type,
      .callback_context = context,
      .context_release = context_release,
      .claims = 1,
      .active = false,
  };
  if (!subscription) {
    listener->Detach();
    ReleaseScriptCCallbackContext(context_release, context);
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

NtsWebManagedSubscription *BlinkManagedRegistry::ListenFrame(
    blink::EventTarget *target, const blink::AtomicString &event_type,
    void (*callback)(void *), void *context, void (*context_release)(void *)) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (invalidated_ || !target || !callback || event_type.IsNull()) {
    ReleaseScriptCCallbackContext(context_release, context);
    return nullptr;
  }
  auto *listener = blink::MakeGarbageCollected<BlinkFrameEventListener>(
      this, realm_, target, event_type, callback, context, context_release);
  if (!target->addEventListener(event_type, listener, false)) {
    listener->Cancel();
    return nullptr;
  }
  listener->Activate(frame_subscriptions_);
  frame_subscriptions_ = listener;
  return reinterpret_cast<NtsWebManagedSubscription *>(listener);
}

void BlinkManagedRegistry::RemoveSubscription(
    NtsWebManagedSubscription *subscription) {
  raw_ptr<NtsWebManagedSubscription> *link = &subscriptions_;
  while (*link && *link != subscription) {
    link = &((*link)->next);
  }
  CHECK_EQ(*link, subscription);
  *link = subscription->next;
  subscription->next = nullptr;
}

void BlinkManagedRegistry::RemoveFrameSubscription(
    BlinkFrameEventListener *subscription) {
  BlinkFrameEventListener *previous = nullptr;
  BlinkFrameEventListener *current = frame_subscriptions_;
  while (current && current != subscription) {
    previous = current;
    current = current->Next();
  }
  CHECK_EQ(current, subscription);
  if (previous) {
    previous->SetNext(subscription->Next());
  } else {
    frame_subscriptions_ = subscription->Next();
  }
  subscription->SetNext(nullptr);
}

void BlinkManagedRegistry::ReleaseSubscription(
    NtsWebManagedSubscription *subscription) {
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
  nodes_by_dom_id_.clear();
  while (frame_subscriptions_) {
    frame_subscriptions_->Cancel();
  }
  for (NtsWebManagedSubscription *subscription = subscriptions_; subscription;
       subscription = subscription->next) {
    subscription->Cancel();
  }
  for (NtsWebNode *peer = nodes_; peer; peer = peer->next) {
    peer->node = nullptr;
  }
}

BlinkManagedDiagnostics BlinkManagedRegistry::Diagnostics() const {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  BlinkManagedDiagnostics result;
  for (NtsWebNode *peer = nodes_; peer; peer = peer->next) {
    ++result.node_peers;
    result.node_claims += peer->claims;
  }
  for (NtsWebManagedSubscription *subscription = subscriptions_; subscription;
       subscription = subscription->next) {
    ++result.subscriptions;
  }
  for (BlinkFrameEventListener *subscription = frame_subscriptions_;
       subscription; subscription = subscription->Next()) {
    ++result.subscriptions;
  }
  return result;
}

void ReleaseManagedNode(NtsWebNode *handle) {
  if (!handle || !IsManagedWebNodeHandle(handle)) {
    return;
  }
  NtsWebNode *peer = DecodeManagedPeer(handle);
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

void ReleaseManagedSubscription(NtsWebManagedSubscription *subscription) {
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

void ReleaseFrameSubscription(NtsWebManagedSubscription *subscription) {
  if (!subscription) {
    return;
  }
  reinterpret_cast<BlinkFrameEventListener *>(subscription)->Cancel();
}

} // namespace nts::blink_bridge
