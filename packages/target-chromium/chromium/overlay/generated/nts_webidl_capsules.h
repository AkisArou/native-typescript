// Generated typed Blink capsule; do not edit.
#ifndef NTS_WEBIDL_CAPSULES_H
#define NTS_WEBIDL_CAPSULES_H

#include <stddef.h>
#include <stdint.h>

#include "third_party/blink/renderer/native_typescript/nts_web.h"

namespace blink {
class AtomicString;
class Document;
class Element;
class ExceptionState;
}  // namespace blink

namespace nts::blink_bridge::generated {
blink::Element* DocumentCreateElement(blink::Document& receiver,
                                      const blink::AtomicString& local_name,
                                      blink::ExceptionState& exception_state);
}

extern "C" NtsWebScabiHandleResult nts_web_document_create_element_scabi(
    NtsWebRealm* realm,
    NtsWebHandle document,
    const uint8_t* local_name,
    size_t local_name_length);

#endif
