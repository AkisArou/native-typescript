#ifndef NTS_BLINK_MANAGED_REGISTRY_H
#define NTS_BLINK_MANAGED_REGISTRY_H

#include <cstddef>
#include <cstdint>

#include "base/memory/raw_ptr.h"
#include "base/sequence_checker.h"
#include "third_party/blink/renderer/platform/graphics/dom_node_id.h"
#include "third_party/blink/renderer/platform/wtf/hash_map.h"

struct NtsWebManagedSubscription;
struct NtsWebNode;
struct NtsWebRealm;

namespace blink {
class AtomicString;
class EventTarget;
class Node;
} // namespace blink

namespace nts::blink_bridge {

class BlinkFrameEventListener;

/* Managed peers are tagged so generated frame-bounded values can remain raw
 * Blink Node pointers. The latter are deliberately visible to Oilpan's
 * conservative stack scan and require no registry allocation. */
inline constexpr uintptr_t kManagedWebNodeHandleTag = 1;

inline bool IsManagedWebNodeHandle(const NtsWebNode *handle) {
  return (reinterpret_cast<uintptr_t>(handle) & kManagedWebNodeHandleTag) != 0;
}

enum class ManagedWebType {
  kEventTarget,
  kNode,
  kElement,
  kHTMLElement,
  kCharacterData,
  kText,
  kDocument,
};

struct BlinkManagedDiagnostics {
  size_t node_peers = 0;
  size_t node_claims = 0;
  size_t subscriptions = 0;
};

/* Canonical pointer peers for ScriptC-managed handles. The registry owns no
 * claim: every AcquireNode() result is a +1 reference transferred to the
 * runtime, and ReleaseManagedNode() gives exactly one such claim back. */
class BlinkManagedRegistry final {
public:
  explicit BlinkManagedRegistry(NtsWebRealm *realm);
  BlinkManagedRegistry(const BlinkManagedRegistry &) = delete;
  BlinkManagedRegistry &operator=(const BlinkManagedRegistry &) = delete;
  ~BlinkManagedRegistry();

  NtsWebNode *AcquireNode(blink::Node *node);
  blink::Node *ResolveNode(NtsWebNode *peer, ManagedWebType expected) const;
  void ReleaseNode(NtsWebNode *peer);

  NtsWebManagedSubscription *Listen(blink::EventTarget *target,
                                    const blink::AtomicString &event_type,
                                    void (*callback)(void *), void *context,
                                    void (*context_release)(void *));
  /* A compiler-proven synchronous registration needs no off-heap subscription
   * or Persistent roots: EventTarget owns the Oilpan listener and the returned
   * opaque pointer remains on the active native stack until release. */
  NtsWebManagedSubscription *ListenFrame(blink::EventTarget *target,
                                         const blink::AtomicString &event_type,
                                         void (*callback)(void *),
                                         void *context,
                                         void (*context_release)(void *));
  void ReleaseSubscription(NtsWebManagedSubscription *subscription);

  void Invalidate();
  bool IsInvalidated() const { return invalidated_; }
  BlinkManagedDiagnostics Diagnostics() const;

private:
  friend class BlinkFrameEventListener;

  void RemoveNode(NtsWebNode *peer);
  void RemoveSubscription(NtsWebManagedSubscription *subscription);
  void RemoveFrameSubscription(BlinkFrameEventListener *subscription);

  raw_ptr<NtsWebRealm> realm_;
  raw_ptr<NtsWebNode> nodes_ = nullptr;
  /* Non-owning identity index. Each entry's peer owns a Persistent<Node>, so
   * the DOMNodeId cannot be recycled while the entry is present. */
  blink::HashMap<blink::DOMNodeId, NtsWebNode *> nodes_by_dom_id_;
  raw_ptr<NtsWebManagedSubscription> subscriptions_ = nullptr;
  /* Non-owning. Each active listener is strongly held by its EventTarget; the
   * intrusive list exists only so realm invalidation can close admission. */
  BlinkFrameEventListener *frame_subscriptions_ = nullptr;
  bool invalidated_ = false;
  SEQUENCE_CHECKER(sequence_checker_);
};

void ReleaseManagedNode(NtsWebNode *peer);
void ReleaseManagedSubscription(NtsWebManagedSubscription *subscription);
void ReleaseFrameSubscription(NtsWebManagedSubscription *subscription);

} // namespace nts::blink_bridge

#endif
