#include <string>

#include "base/containers/span.h"
#include "third_party/blink/renderer/core/dom/character_data.h"
#include "third_party/blink/renderer/core/dom/document.h"
#include "third_party/blink/renderer/core/dom/element.h"
#include "third_party/blink/renderer/core/dom/node.h"
#include "third_party/blink/renderer/core/dom/text.h"
#include "third_party/blink/renderer/core/html/html_element.h"
#include "third_party/blink/renderer/native_typescript/generated/nts_webidl_capsules.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_managed_registry.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_realm.h"
#if __has_include( \
    "third_party/blink/renderer/platform/bindings/exception_state_capture.h")
#include "third_party/blink/renderer/platform/bindings/exception_state_capture.h"
#else
#include "third_party/blink/renderer/platform/bindings/exception_state.h"
#endif
#include "third_party/blink/renderer/platform/wtf/casting.h"
#include "third_party/blink/renderer/platform/wtf/text/atomic_string.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"

struct NtsWebError final {
  std::string message;
};

namespace {

#if defined(NTS_BLINK_HAS_EXCEPTION_STATE_CAPTURE)
using BindingNeutralExceptionCapture = blink::ExceptionStateCapture;

blink::ExceptionState& ExceptionState(BindingNeutralExceptionCapture& capture) {
  return capture.GetExceptionState();
}

const blink::String& ExceptionMessage(
    const BindingNeutralExceptionCapture& capture) {
  return capture.SanitizedMessage();
}
#else
using BindingNeutralExceptionCapture = blink::DummyExceptionStateForTesting;

blink::ExceptionState& ExceptionState(BindingNeutralExceptionCapture& capture) {
  return capture;
}

const blink::String& ExceptionMessage(
    const BindingNeutralExceptionCapture& capture) {
  return capture.Message();
}
#endif

NtsWebRealm* ActiveRealm() {
  NtsWebRealm* realm = nts::blink_bridge::CurrentWebRealm();
  return realm && realm->IsCurrent() && realm->IsAlive() ? realm : nullptr;
}

blink::String DecodeUtf8(const uint8_t* data, size_t length) {
  if (!data && length != 0) {
    return blink::String();
  }
  return blink::String::FromUtf8(UNSAFE_BUFFERS(base::span(data, length)));
}

void SetError(NtsWebError** out_error, const blink::String& message) {
  if (!out_error) {
    return;
  }
  *out_error = new NtsWebError{message.Utf8()};
}

void SetError(NtsWebError** out_error, const char* message) {
  if (!out_error) {
    return;
  }
  *out_error = new NtsWebError{message};
}

blink::Node* Resolve(NtsWebRealm* realm,
                     NtsWebNode* peer,
                     nts::blink_bridge::ManagedWebType expected) {
  return realm ? realm->Managed().ResolveNode(peer, expected) : nullptr;
}

}  // namespace

extern "C" NtsWebNode* nts_web_current_document() {
  NtsWebRealm* realm = ActiveRealm();
  return realm ? realm->Managed().AcquireNode(realm->Document()) : nullptr;
}

extern "C" NtsWebNode* nts_web_document_body_managed(NtsWebNode* document) {
  NtsWebRealm* realm = ActiveRealm();
  auto* resolved = blink::DynamicTo<blink::Document>(
      Resolve(realm, document, nts::blink_bridge::ManagedWebType::kDocument));
  if (!resolved) {
    return nullptr;
  }
  return realm->Managed().AcquireNode(
      nts::blink_bridge::generated::DocumentBody(*resolved));
}

extern "C" NtsWebNode* nts_web_document_create_element_managed(
    NtsWebNode* document,
    const uint8_t* local_name_data,
    size_t local_name_length,
    NtsWebError** error) {
  if (error) {
    *error = nullptr;
  }
  NtsWebRealm* realm = ActiveRealm();
  auto* resolved = blink::DynamicTo<blink::Document>(
      Resolve(realm, document, nts::blink_bridge::ManagedWebType::kDocument));
  if (!resolved) {
    SetError(error, "Document.createElement receiver is unavailable");
    return nullptr;
  }
  const blink::String local_name =
      DecodeUtf8(local_name_data, local_name_length);
  if (local_name.IsNull() && local_name_length != 0) {
    SetError(error, "Document.createElement received invalid UTF-8");
    return nullptr;
  }
  BindingNeutralExceptionCapture capture;
  blink::ExceptionState& exception_state = ExceptionState(capture);
  blink::Element* element = nts::blink_bridge::generated::DocumentCreateElement(
      *resolved, blink::AtomicString(local_name), exception_state);
  if (exception_state.HadException()) {
    SetError(error, ExceptionMessage(capture));
    return nullptr;
  }
  if (!element) {
    SetError(error, "Document.createElement returned no Element");
    return nullptr;
  }
  return realm->Managed().AcquireNode(element);
}

extern "C" NtsWebNode* nts_web_document_create_text_node_managed(
    NtsWebNode* document,
    const uint8_t* data,
    size_t data_length) {
  NtsWebRealm* realm = ActiveRealm();
  auto* resolved = blink::DynamicTo<blink::Document>(
      Resolve(realm, document, nts::blink_bridge::ManagedWebType::kDocument));
  if (!resolved) {
    return nullptr;
  }
  const blink::String text = DecodeUtf8(data, data_length);
  if (text.IsNull() && data_length != 0) {
    return nullptr;
  }
  return realm->Managed().AcquireNode(
      nts::blink_bridge::generated::DocumentCreateTextNode(*resolved, text));
}

extern "C" NtsWebNode* nts_web_node_append_child_managed(NtsWebNode* parent,
                                                         NtsWebNode* node,
                                                         NtsWebError** error) {
  if (error) {
    *error = nullptr;
  }
  NtsWebRealm* realm = ActiveRealm();
  blink::Node* resolved_parent =
      Resolve(realm, parent, nts::blink_bridge::ManagedWebType::kNode);
  blink::Node* resolved_node =
      Resolve(realm, node, nts::blink_bridge::ManagedWebType::kNode);
  if (!resolved_parent || !resolved_node) {
    SetError(error, "Node.appendChild receiver or argument is unavailable");
    return nullptr;
  }
  BindingNeutralExceptionCapture capture;
  blink::ExceptionState& exception_state = ExceptionState(capture);
  blink::Node* result = nts::blink_bridge::generated::NodeAppendChild(
      *resolved_parent, *resolved_node, exception_state);
  if (exception_state.HadException()) {
    SetError(error, ExceptionMessage(capture));
    return nullptr;
  }
  if (!result) {
    SetError(error, "Node.appendChild returned no Node");
    return nullptr;
  }
  return realm->Managed().AcquireNode(result);
}

extern "C" void nts_web_character_data_set_data_managed(
    NtsWebNode* character_data,
    const uint8_t* data,
    size_t data_length) {
  NtsWebRealm* realm = ActiveRealm();
  auto* resolved = blink::DynamicTo<blink::CharacterData>(
      Resolve(realm, character_data,
              nts::blink_bridge::ManagedWebType::kCharacterData));
  if (!resolved) {
    return;
  }
  const blink::String text = DecodeUtf8(data, data_length);
  if (text.IsNull() && data_length != 0) {
    return;
  }
  nts::blink_bridge::generated::CharacterDataSetData(*resolved, text);
}

extern "C" NtsWebManagedSubscription* nts_web_event_target_listen(
    NtsWebNode* target,
    const uint8_t* type_data,
    size_t type_length,
    NtsWebEventCallback callback,
    void* context) {
  NtsWebRealm* realm = ActiveRealm();
  blink::Node* resolved =
      Resolve(realm, target, nts::blink_bridge::ManagedWebType::kEventTarget);
  if (!resolved || !callback) {
    return nullptr;
  }
  const blink::String type = DecodeUtf8(type_data, type_length);
  if (type.IsNull() && type_length != 0) {
    return nullptr;
  }
  return realm->Managed().Listen(static_cast<blink::EventTarget*>(resolved),
                                 blink::AtomicString(type), callback, context);
}

extern "C" void nts_web_node_release(NtsWebNode* node) {
  nts::blink_bridge::ReleaseManagedNode(node);
}

extern "C" void nts_web_subscription_release(
    NtsWebManagedSubscription* subscription) {
  nts::blink_bridge::ReleaseManagedSubscription(subscription);
}

extern "C" const uint8_t* nts_web_error_message(NtsWebError* error) {
  static constexpr uint8_t kUnknown[] = "Unknown Blink binding failure";
  return error ? reinterpret_cast<const uint8_t*>(error->message.c_str())
               : kUnknown;
}

extern "C" void nts_web_error_release(NtsWebError* error) {
  delete error;
}
