#include "third_party/blink/renderer/native_typescript/nts_blink_realm.h"

#include <atomic>
#include <new>

#include "base/check.h"
#include "base/containers/span.h"
#include "base/compiler_specific.h"
#include "base/functional/bind.h"
#include "third_party/blink/renderer/core/dom/document.h"
#include "third_party/blink/renderer/core/execution_context/agent.h"
#include "third_party/blink/renderer/core/execution_context/execution_context.h"
#include "third_party/blink/renderer/core/execution_context/execution_context_lifecycle_observer.h"
#include "third_party/blink/renderer/platform/heap/garbage_collected.h"
#include "third_party/blink/renderer/platform/heap/visitor.h"
#include "third_party/blink/renderer/platform/scheduler/public/event_loop.h"
#include "third_party/blink/renderer/platform/wtf/text/atomic_string.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"

namespace nts::blink_bridge {

namespace {

thread_local NtsWebRealm* current_web_realm = nullptr;

uint64_t NextRealmId() {
  static std::atomic<uint64_t> next_realm{1};
  const uint64_t realm = next_realm.fetch_add(1, std::memory_order_relaxed);
  CHECK_NE(realm, 0u) << "Native TypeScript realm identity exhausted";
  return realm;
}

DISABLE_CFI_ICALL int32_t
ConfigureHostedScheduler(ScriptCHostedConfigure configure,
                         ScriptCHostedEnqueue enqueue,
                         void* context) {
  return configure(enqueue, context);
}

DISABLE_CFI_ICALL void StopHostedScheduler(ScriptCHostedStop stop) {
  stop();
}

DISABLE_CFI_ICALL void InvokeHostedJob(ScriptCHostedJob run, void* job) {
  run(job);
}

struct HostedJobPayload {
  base::WeakPtr<NtsWebRealm> realm;
  ScriptCHostedJob run;
  uintptr_t job_address;
};

void RunHostedJob(HostedJobPayload payload) {
  /* The runtime job owns its scheduler/frame payload and therefore must run
   * even after the realm has died: a stopped scheduler turns that invocation
   * into cancellation and releases the payload. Only an alive realm may be
   * installed for capsules reached by an accepted continuation. */
  void* job = reinterpret_cast<void*>(payload.job_address);
  if (!payload.realm || !payload.realm->IsAlive()) {
    InvokeHostedJob(payload.run, job);
    return;
  }
  ScopedCurrentWebRealm active_realm(payload.realm.get());
  InvokeHostedJob(payload.run, job);
}

bool EnqueueHostedMicrotask(void* context, ScriptCHostedJob run, void* job) {
  auto* realm = static_cast<NtsWebRealm*>(context);
  if (!realm || !run || !job || !realm->IsAlive()) {
    return false;
  }
  blink::Document* document = realm->Document();
  if (!document) {
    return false;
  }
  document->GetAgent().event_loop()->EnqueueMicrotask(
      base::BindOnce(&RunHostedJob,
                     HostedJobPayload{realm->GetWeakPtr(), run,
                                      reinterpret_cast<uintptr_t>(job)}));
  return true;
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
      managed_(this),
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

base::WeakPtr<NtsWebRealm> NtsWebRealm::GetWeakPtr() {
  CHECK(IsCurrent());
  return weak_factory_.GetWeakPtr();
}

bool NtsWebRealm::ConfigureScriptCHostedScheduler(
    nts::blink_bridge::ScriptCHostedConfigure configure,
    nts::blink_bridge::ScriptCHostedStop stop) {
  CHECK(IsCurrent());
  if (!IsAlive() || !configure || !stop || hosted_scheduler_stop_) {
    return false;
  }
  if (nts::blink_bridge::ConfigureHostedScheduler(
          configure, &nts::blink_bridge::EnqueueHostedMicrotask, this) != 0) {
    return false;
  }
  hosted_scheduler_stop_ = stop;
  return true;
}

void NtsWebRealm::StopScriptCHostedScheduler() {
  CHECK(IsCurrent());
  nts::blink_bridge::ScriptCHostedStop stop = hosted_scheduler_stop_;
  hosted_scheduler_stop_ = nullptr;
  if (stop) {
    nts::blink_bridge::StopHostedScheduler(stop);
  }
}

void NtsWebRealm::Invalidate() {
  CHECK(IsCurrent());
  if (!alive_) {
    return;
  }

  /* Close async admission and release pending continuation frames while all
   * ScriptC-to-Blink peers are still valid. Already-enqueued Blink microtasks
   * keep a runtime-owned cancellation job, never a raw realm lifetime. */
  {
    nts::blink_bridge::ScopedCurrentWebRealm active_realm(this);
    StopScriptCHostedScheduler();
  }
  alive_ = false;

  /* Listener cancellation comes first: listener roots contain raw pointers
   * back to this realm, so every registration is removed/detached before DOM
   * object roots or the document root are released. */
  subscriptions_.Invalidate();
  managed_.Invalidate();
  nodes_.Invalidate();
  static_utf8_atomic_strings_.clear();
  static_utf8_strings_.clear();
  document_ = nullptr;
  event_dispatch_ = nullptr;
  event_context_ = nullptr;
}

blink::Document* NtsWebRealm::Document() const {
  CHECK(IsCurrent());
  return alive_ ? document_.Get() : nullptr;
}

blink::String NtsWebRealm::DecodeUtf8(const uint8_t* data,
                                      size_t length,
                                      size_t static_identity) {
  CHECK(IsCurrent());
  if (!data && length != 0) {
    return blink::String();
  }
  if (static_identity != 0) {
    auto cached = static_utf8_strings_.find(static_identity);
    if (cached != static_utf8_strings_.end()) {
      return cached->value;
    }
  }
  blink::String decoded = blink::String::FromUtf8(
      UNSAFE_BUFFERS(base::span(base::unchecked, data, length)));
  if (static_identity == 0 || decoded.IsNull()) {
    return decoded;
  }
  return static_utf8_strings_.insert(static_identity, decoded)
      .stored_value->value;
}

blink::AtomicString NtsWebRealm::DecodeUtf8Atomic(
    const uint8_t* data,
    size_t length,
    size_t static_identity) {
  CHECK(IsCurrent());
  if (!data && length != 0) {
    return blink::AtomicString();
  }
  if (static_identity != 0) {
    auto cached = static_utf8_atomic_strings_.find(static_identity);
    if (cached != static_utf8_atomic_strings_.end()) {
      return cached->value;
    }
  }
  blink::AtomicString decoded = blink::AtomicString::FromUtf8(
      UNSAFE_BUFFERS(base::span(base::unchecked, data, length)));
  if (static_identity == 0 || decoded.IsNull()) {
    return decoded;
  }
  return static_utf8_atomic_strings_.insert(static_identity, decoded)
      .stored_value->value;
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

ScopedCurrentWebRealm::ScopedCurrentWebRealm(NtsWebRealm* realm)
    : previous_(current_web_realm) {
  CHECK(realm);
  CHECK(realm->IsCurrent());
  current_web_realm = realm;
}

ScopedCurrentWebRealm::~ScopedCurrentWebRealm() {
  current_web_realm = previous_;
}

NtsWebRealm* CurrentWebRealm() {
  return current_web_realm;
}

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
