// Generated typed Blink capsule; do not edit.
#include "third_party/blink/renderer/native_typescript/generated/nts_webidl_capsules.h"

#include "third_party/blink/renderer/core/dom/document.h"
#include "third_party/blink/renderer/core/dom/element.h"
#include "third_party/blink/renderer/platform/bindings/exception_state.h"
#include "third_party/blink/renderer/platform/wtf/text/atomic_string.h"

namespace nts::blink_bridge::generated {
blink::Element* DocumentCreateElement(blink::Document& receiver,
                                      const blink::AtomicString& local_name,
                                      blink::ExceptionState& exception_state) {
  return receiver.CreateElementForBinding(local_name, exception_state);
}
}  // namespace nts::blink_bridge::generated

extern "C" NtsWebScabiHandleResult nts_web_document_create_element_scabi(
    NtsWebRealm* realm,
    NtsWebHandle document,
    const uint8_t* local_name,
    size_t local_name_length) {
  const NtsUtf8View local_name_view = {local_name, local_name_length};
  NtsWebHandleResult source =
      nts_web_document_create_element(realm, document, local_name_view);
  const NtsWebScabiHandleResult result = {source.status, source.value};
  nts_web_exception_dispose(&source.exception);
  return result;
}
