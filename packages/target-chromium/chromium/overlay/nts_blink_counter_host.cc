#include "third_party/blink/renderer/native_typescript/nts_blink_counter_host.h"

#include <new>

#include "third_party/blink/public/web/web_local_frame.h"
#include "third_party/blink/renderer/core/dom/document.h"
#include "third_party/blink/renderer/core/frame/local_frame.h"
#include "third_party/blink/renderer/core/frame/web_local_frame_impl.h"
#include "third_party/blink/renderer/native_typescript/counter/app.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_realm.h"

namespace nts::blink_bridge {

class BlinkCounterHost final {
 public:
  explicit BlinkCounterHost(blink::Document* document) {
    realm_ = CreateWebRealm(document, &nts_counter_dispatch_event, nullptr);
    if (!realm_) return;
    if (!nts_counter_start(realm_)) {
      DestroyWebRealm(realm_);
      realm_ = nullptr;
    }
  }

  BlinkCounterHost(const BlinkCounterHost&) = delete;
  BlinkCounterHost& operator=(const BlinkCounterHost&) = delete;

  ~BlinkCounterHost() {
    if (!realm_) return;
    nts_counter_stop();
    DestroyWebRealm(realm_);
    realm_ = nullptr;
  }

  bool IsStarted() const { return realm_ != nullptr; }

 private:
  NtsWebRealm* realm_ = nullptr;
};

BlinkCounterHost* StartCounterHost(blink::WebLocalFrame* web_frame) {
  if (!web_frame) return nullptr;

  /* This cast is intentionally confined to the Blink-owned adapter. The
   * content embedder passes only WebLocalFrame*, while the target owns the
   * knowledge that Chromium's local-frame implementation is WebLocalFrameImpl. */
  auto* web_frame_impl = static_cast<blink::WebLocalFrameImpl*>(web_frame);
  blink::LocalFrame* frame = web_frame_impl->GetFrame();
  if (!frame) return nullptr;

  blink::Document* document = frame->GetDocument();
  if (!document || !document->GetExecutionContext()) return nullptr;

  auto* host = new (std::nothrow) BlinkCounterHost(document);
  if (!host) return nullptr;
  if (!host->IsStarted()) {
    delete host;
    return nullptr;
  }
  return host;
}

void DestroyCounterHost(BlinkCounterHost* host) {
  delete host;
}

}  // namespace nts::blink_bridge
