// Generated typed Blink capsules; do not edit.
#include "third_party/blink/renderer/native_typescript/generated/nts_webidl_capsules.h"

#include "third_party/blink/renderer/core/dom/character_data.h"
#include "third_party/blink/renderer/core/dom/document.h"
#include "third_party/blink/renderer/core/dom/node.h"
#include "third_party/blink/renderer/core/dom/text.h"
#include "third_party/blink/renderer/core/dom/element.h"
#include "third_party/blink/renderer/core/html/html_element.h"
#include "third_party/blink/renderer/platform/bindings/exception_state.h"
#include "third_party/blink/renderer/platform/wtf/text/atomic_string.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"

namespace nts::blink_bridge::generated {
blink::HTMLElement* DocumentBody(blink::Document& receiver) {
  return receiver.body();
}

blink::Element* DocumentCreateElement(blink::Document& receiver,
                                      const blink::AtomicString& local_name,
                                      blink::ExceptionState& exception_state) {
  return receiver.CreateElementForBinding(
      local_name, exception_state);
}

blink::Text* DocumentCreateTextNode(blink::Document& receiver,
                                    const blink::String& data) {
  return receiver.createTextNode(data);
}

blink::Node* NodeAppendChild(blink::Node& receiver,
                             blink::Node& node,
                             blink::ExceptionState& exception_state) {
  return receiver.appendChild(&node, exception_state);
}

void CharacterDataSetData(blink::CharacterData& receiver,
                          const blink::String& data) {
  receiver.setData(data);
}
}  // namespace nts::blink_bridge::generated
