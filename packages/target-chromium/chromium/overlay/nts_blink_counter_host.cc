#include "third_party/blink/renderer/native_typescript/nts_blink_counter_host.h"

#include <new>

#include "base/logging.h"
#include "base/memory/raw_ptr.h"
#include "third_party/blink/public/web/web_local_frame.h"
#include "third_party/blink/renderer/core/dom/document.h"
#include "third_party/blink/renderer/core/frame/local_frame.h"
#include "third_party/blink/renderer/core/frame/web_local_frame_impl.h"
#include "third_party/blink/renderer/native_typescript/counter/app.h"
#include "third_party/blink/renderer/native_typescript/create-element/app.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_benchmark_host.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_realm.h"
#include "third_party/blink/renderer/platform/bindings/exception_code.h"
#if __has_include( \
    "third_party/blink/renderer/platform/bindings/exception_state_capture.h")
#include "third_party/blink/renderer/platform/bindings/exception_state_capture.h"
#else
#include "third_party/blink/renderer/platform/bindings/exception_state.h"
#endif

namespace nts::blink_bridge {

bool VerifyBindingNeutralSecurityErrorCapture() {
#if defined(NTS_BLINK_HAS_EXCEPTION_STATE_CAPTURE)
  blink::ExceptionStateCapture capture;
  blink::ExceptionState& exception_state = capture.GetExceptionState();
  exception_state.ThrowSecurityError("safe message", "privileged detail");
  return exception_state.HadException() &&
         capture.Code() ==
             blink::ToExceptionCode(blink::DOMExceptionCode::kSecurityError) &&
         capture.SanitizedMessage() == "safe message" &&
         capture.UnsanitizedMessage() == "privileged detail";
#else
  return true;
#endif
}

class BlinkCounterHost final {
 public:
  explicit BlinkCounterHost(blink::Document* document) {
    realm_ = CreateWebRealm(document, &nts_counter_dispatch_event, nullptr);
    if (!realm_) {
      return;
    }
#if defined(NTS_BLINK_HAS_EXCEPTION_STATE_CAPTURE)
    if (!VerifyBindingNeutralSecurityErrorCapture()) {
      ResetRealm();
      return;
    }
    LOG(INFO) << "Native TypeScript security-message capture: passed";
#endif
    if (!nts_create_element_exception_probe(realm_)) {
      ResetRealm();
      return;
    }
    LOG(INFO) << "Native TypeScript DOMException probe: passed";
    if (!nts_counter_start(realm_)) {
      ResetRealm();
      return;
    }
    LOG(INFO) << "Native TypeScript counter host: started";
  }

  BlinkCounterHost(const BlinkCounterHost&) = delete;
  BlinkCounterHost& operator=(const BlinkCounterHost&) = delete;

  ~BlinkCounterHost() {
    if (!realm_) {
      return;
    }
    nts_counter_stop();
    ResetRealm();
    LOG(INFO) << "Native TypeScript counter host: stopped";
  }

  bool IsStarted() const { return realm_ != nullptr; }

 private:
  void ResetRealm() {
    NtsWebRealm* realm = realm_.get();
    realm_ = nullptr;
    DestroyWebRealm(realm);
  }

  raw_ptr<NtsWebRealm> realm_ = nullptr;
};

BlinkCounterHost* StartCounterHost(blink::WebLocalFrame* web_frame) {
  if (!web_frame) {
    return nullptr;
  }

  /* This cast is intentionally confined to the Blink-owned adapter. The
   * content embedder passes only WebLocalFrame*, while the target owns the
   * knowledge that Chromium's local-frame implementation is WebLocalFrameImpl.
   */
  auto* web_frame_impl = static_cast<blink::WebLocalFrameImpl*>(web_frame);
  blink::LocalFrame* frame = web_frame_impl->GetFrame();
  if (!frame) {
    return nullptr;
  }

  blink::Document* document = frame->GetDocument();
  if (!document || !document->GetExecutionContext()) {
    return nullptr;
  }

  auto* host = new (std::nothrow) BlinkCounterHost(document);
  if (!host) {
    return nullptr;
  }
  if (!host->IsStarted()) {
    delete host;
    return nullptr;
  }
  return host;
}

void DestroyCounterHost(BlinkCounterHost* host) {
  delete host;
}

bool RunBenchmarkHost(blink::WebLocalFrame* web_frame) {
  if (!web_frame) {
    return false;
  }
  auto* web_frame_impl = static_cast<blink::WebLocalFrameImpl*>(web_frame);
  blink::LocalFrame* frame = web_frame_impl->GetFrame();
  if (!frame) {
    return false;
  }
  return RunDocumentCreateElementBenchmark(frame->GetDocument());
}

}  // namespace nts::blink_bridge
