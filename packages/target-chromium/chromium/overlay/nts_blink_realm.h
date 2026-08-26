#ifndef NTS_BLINK_REALM_H
#define NTS_BLINK_REALM_H

#include <cstddef>
#include <cstdint>

#include "base/compiler_specific.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/sequence_checker.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_managed_registry.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_node_registry.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_subscription_registry.h"
#include "third_party/blink/renderer/native_typescript/nts_web.h"
#include "third_party/blink/renderer/platform/heap/persistent.h"
#include "third_party/blink/renderer/platform/wtf/hash_map.h"
#include "third_party/blink/renderer/platform/wtf/text/atomic_string.h"
#include "third_party/blink/renderer/platform/wtf/text/atomic_string_hash.h"
#include "third_party/blink/renderer/platform/wtf/text/string_hash.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"

namespace blink {
class Document;
class ExecutionContext;
}  // namespace blink

namespace nts::blink_bridge {
class BlinkRealmLifecycleObserver;
using NativeEventDispatch = void (*)(NtsWebRealm*,
                                     NtsWebCallbackToken,
                                     void* context);
using ScriptCHostedJob = void (*)(void* job);
using ScriptCHostedEnqueue = bool (*)(void* context,
                                      ScriptCHostedJob run,
                                      void* job);
using ScriptCHostedConfigure = int32_t (*)(ScriptCHostedEnqueue enqueue,
                                           void* context);
using ScriptCHostedStop = void (*)();
}  // namespace nts::blink_bridge

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

  ALWAYS_INLINE bool IsCurrent() const {
    return sequence_checker_.CalledOnValidSequence();
  }
  ALWAYS_INLINE bool IsAlive() const {
    return IsCurrent() && alive_ && document_.Get() != nullptr;
  }
  base::WeakPtr<NtsWebRealm> GetWeakPtr();
  bool ConfigureScriptCHostedScheduler(
      nts::blink_bridge::ScriptCHostedConfigure configure,
      nts::blink_bridge::ScriptCHostedStop stop);
  void StopScriptCHostedScheduler();
  void Invalidate();

  /* Normal V8 scheduling observes CppHeap allocation pressure when JavaScript
   * returns to the event loop. A native application may instead execute a long
   * synchronous allocation batch. Reached [NewObject] capsules account those
   * allocations here so the realm periodically gives the unified heap an
   * explicit conservative-stack checkpoint. */
  ALWAYS_INLINE void AccountNewObjectAllocation() {
    if (--new_object_allocation_credit_ != 0) {
      return;
    }
    new_object_allocation_credit_ =
        CollectGarbageAtNativeAllocationCheckpoint()
            ? kNewObjectAllocationBudget
            : 1;
  }

  blink::Document* Document() const;
  blink::String DecodeUtf8(const uint8_t* data,
                           size_t length,
                           size_t static_identity);
  blink::AtomicString DecodeUtf8Atomic(const uint8_t* data,
                                       size_t length,
                                       size_t static_identity);
  nts::blink_bridge::BlinkNodeRegistry& Nodes() { return nodes_; }
  nts::blink_bridge::BlinkSubscriptionRegistry& Subscriptions() {
    return subscriptions_;
  }
  nts::blink_bridge::BlinkManagedRegistry& Managed() { return managed_; }

  void DispatchNativeEvent(NtsWebCallbackToken token,
                           blink::ExecutionContext* context);

 private:
  static constexpr size_t kNewObjectAllocationBudget = 65536;

  bool CollectGarbageAtNativeAllocationCheckpoint();
  base::SequenceChecker sequence_checker_;
  uint64_t realm_id_;
  bool alive_ = true;
  size_t new_object_allocation_credit_ = kNewObjectAllocationBudget;
  blink::Persistent<blink::Document> document_;
  blink::Persistent<nts::blink_bridge::BlinkRealmLifecycleObserver>
      lifecycle_observer_;
  nts::blink_bridge::BlinkNodeRegistry nodes_;
  nts::blink_bridge::BlinkSubscriptionRegistry subscriptions_;
  nts::blink_bridge::BlinkManagedRegistry managed_;
  /* The key is an opaque ScriptC process-lifetime string identity, never a
   * pointer we dereference. Dynamic strings use zero and bypass both maps. */
  blink::HashMap<size_t, blink::String> static_utf8_strings_;
  blink::HashMap<size_t, blink::AtomicString> static_utf8_atomic_strings_;
  nts::blink_bridge::NativeEventDispatch event_dispatch_ = nullptr;
  raw_ptr<void> event_context_ = nullptr;
  nts::blink_bridge::ScriptCHostedStop hosted_scheduler_stop_ = nullptr;
  base::WeakPtrFactory<NtsWebRealm> weak_factory_{this};
};

namespace nts::blink_bridge {

class ScopedCurrentWebRealm final {
 public:
  explicit ScopedCurrentWebRealm(NtsWebRealm* realm);
  ScopedCurrentWebRealm(const ScopedCurrentWebRealm&) = delete;
  ScopedCurrentWebRealm& operator=(const ScopedCurrentWebRealm&) = delete;
  ~ScopedCurrentWebRealm();

 private:
  raw_ptr<NtsWebRealm> previous_;
};

NtsWebRealm* CurrentWebRealm();

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
