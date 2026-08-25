// Generated typed Blink capsules; do not edit.
#ifndef NTS_WEBIDL_CAPSULES_H
#define NTS_WEBIDL_CAPSULES_H

#include <stddef.h>
#include <stdint.h>

namespace blink {
class AtomicString;
class CharacterData;
class Document;
class Element;
class ExceptionState;
class HTMLElement;
class Node;
class String;
class Text;
}  // namespace blink

namespace nts::blink_bridge::generated {
blink::HTMLElement* DocumentBody(blink::Document& receiver);
blink::Element* DocumentCreateElement(blink::Document& receiver,
                                      const blink::AtomicString& local_name,
                                      blink::ExceptionState& exception_state);
blink::Text* DocumentCreateTextNode(blink::Document& receiver,
                                    const blink::String& data);
blink::Node* NodeAppendChild(blink::Node& receiver,
                             blink::Node& node,
                             blink::ExceptionState& exception_state);
blink::Node* NodeRemoveChild(blink::Node& receiver,
                             blink::Node& child,
                             blink::ExceptionState& exception_state);
void ElementSetAttribute(blink::Element& receiver,
                         const blink::AtomicString& name,
                         const blink::AtomicString& value,
                         blink::ExceptionState& exception_state);
blink::Element* ElementQuerySelector(
    blink::Element& receiver,
    const blink::AtomicString& selectors,
    blink::ExceptionState& exception_state);
void HTMLElementClick(blink::HTMLElement& receiver);
void CharacterDataSetData(blink::CharacterData& receiver,
                          const blink::String& data);
}  // namespace nts::blink_bridge::generated

struct NtsWebNode;
struct NtsWebManagedSubscription;
struct NtsWebError;
using NtsWebEventCallback = void (*)(void* context);

extern "C" NtsWebNode* nts_web_current_document();
extern "C" NtsWebNode* nts_web_current_document_frame();
extern "C" NtsWebNode* nts_web_document_body_managed(NtsWebNode* document);
extern "C" NtsWebNode* nts_web_document_body_frame(NtsWebNode* document);
extern "C" NtsWebNode* nts_web_document_create_element_managed(
    NtsWebNode* document,
    const uint8_t* local_name_data,
    size_t local_name_length,
    NtsWebError** error);
extern "C" NtsWebNode* nts_web_document_create_element_frame(
    NtsWebNode* document,
    const uint8_t* local_name_data,
    size_t local_name_length,
    NtsWebError** error);
extern "C" NtsWebNode* nts_web_document_create_text_node_managed(
    NtsWebNode* document, const uint8_t* data, size_t data_length);
extern "C" NtsWebNode* nts_web_document_create_text_node_frame(
    NtsWebNode* document, const uint8_t* data, size_t data_length);
extern "C" NtsWebNode* nts_web_node_append_child_managed(
    NtsWebNode* parent, NtsWebNode* node, NtsWebError** error);
extern "C" NtsWebNode* nts_web_node_append_child_frame(
    NtsWebNode* parent, NtsWebNode* node, NtsWebError** error);
extern "C" NtsWebNode* nts_web_node_remove_child_managed(
    NtsWebNode* parent, NtsWebNode* child, NtsWebError** error);
extern "C" NtsWebNode* nts_web_node_remove_child_frame(
    NtsWebNode* parent, NtsWebNode* child, NtsWebError** error);
extern "C" void nts_web_element_set_attribute(
    NtsWebNode* element,
    const uint8_t* name_data,
    size_t name_length,
    const uint8_t* value_data,
    size_t value_length,
    NtsWebError** error);
extern "C" NtsWebNode* nts_web_element_query_selector_managed(
    NtsWebNode* element,
    const uint8_t* selectors_data,
    size_t selectors_length,
    NtsWebError** error);
extern "C" NtsWebNode* nts_web_element_query_selector_frame(
    NtsWebNode* element,
    const uint8_t* selectors_data,
    size_t selectors_length,
    NtsWebError** error);
extern "C" void nts_web_html_element_click(NtsWebNode* element);
extern "C" void nts_web_character_data_set_data_managed(
    NtsWebNode* character_data, const uint8_t* data, size_t data_length);
extern "C" NtsWebManagedSubscription* nts_web_event_target_listen(
    NtsWebNode* target,
    const uint8_t* type_data,
    size_t type_length,
    NtsWebEventCallback callback,
    void* context);
extern "C" void nts_web_node_release(NtsWebNode* node);
extern "C" void nts_web_node_release_frame(NtsWebNode* node);
extern "C" void nts_web_subscription_release(
    NtsWebManagedSubscription* subscription);
extern "C" const uint8_t* nts_web_error_message(NtsWebError* error);
extern "C" void nts_web_error_release(NtsWebError* error);

#endif
