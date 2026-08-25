#ifndef NTS_BLINK_MANAGED_REGISTRY_H
#define NTS_BLINK_MANAGED_REGISTRY_H

#include "base/memory/raw_ptr.h"
#include "base/sequence_checker.h"

struct NtsWebManagedSubscription;
struct NtsWebNode;
struct NtsWebRealm;

namespace blink {
class AtomicString;
class EventTarget;
class Node;
}  // namespace blink

namespace nts::blink_bridge {

enum class ManagedWebType {
  kEventTarget,
  kNode,
  kElement,
  kHTMLElement,
  kCharacterData,
  kText,
  kDocument,
};

/* Canonical pointer peers for ScriptC-managed handles. The registry owns no
 * claim: every AcquireNode() result is a +1 reference transferred to the
 * runtime, and ReleaseManagedNode() gives exactly one such claim back. */
class BlinkManagedRegistry final {
 public:
  explicit BlinkManagedRegistry(NtsWebRealm* realm);
  BlinkManagedRegistry(const BlinkManagedRegistry&) = delete;
  BlinkManagedRegistry& operator=(const BlinkManagedRegistry&) = delete;
  ~BlinkManagedRegistry();

  NtsWebNode* AcquireNode(blink::Node* node);
  blink::Node* ResolveNode(NtsWebNode* peer, ManagedWebType expected) const;
  void ReleaseNode(NtsWebNode* peer);

  NtsWebManagedSubscription* Listen(blink::EventTarget* target,
                                    const blink::AtomicString& event_type,
                                    void (*callback)(void*),
                                    void* context);
  void ReleaseSubscription(NtsWebManagedSubscription* subscription);

  void Invalidate();
  bool IsInvalidated() const { return invalidated_; }

 private:
  void RemoveNode(NtsWebNode* peer);
  void RemoveSubscription(NtsWebManagedSubscription* subscription);

  raw_ptr<NtsWebRealm> realm_;
  raw_ptr<NtsWebNode> nodes_ = nullptr;
  raw_ptr<NtsWebManagedSubscription> subscriptions_ = nullptr;
  bool invalidated_ = false;
  SEQUENCE_CHECKER(sequence_checker_);
};

void ReleaseManagedNode(NtsWebNode* peer);
void ReleaseManagedSubscription(NtsWebManagedSubscription* subscription);

}  // namespace nts::blink_bridge

#endif
