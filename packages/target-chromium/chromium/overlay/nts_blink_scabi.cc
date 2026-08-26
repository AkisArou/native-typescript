#include <cstdint>
#include <string>

#include "base/check.h"
#include "base/compiler_specific.h"
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
#if __has_include(                                                             \
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

DISABLE_CFI_ICALL void ReleaseScriptCContext(NtsWebContextRelease release,
                                             void *context) {
  if (release) {
    release(context);
  }
}

#if defined(NTS_BLINK_HAS_EXCEPTION_STATE_CAPTURE)
using BindingNeutralExceptionCapture = blink::ExceptionStateCapture;

blink::ExceptionState &ExceptionState(BindingNeutralExceptionCapture &capture) {
  return capture.GetExceptionState();
}

const blink::String &
ExceptionMessage(const BindingNeutralExceptionCapture &capture) {
  return capture.SanitizedMessage();
}
#else
using BindingNeutralExceptionCapture = blink::DummyExceptionStateForTesting;

blink::ExceptionState &ExceptionState(BindingNeutralExceptionCapture &capture) {
  return capture;
}

const blink::String &
ExceptionMessage(const BindingNeutralExceptionCapture &capture) {
  return capture.Message();
}
#endif

NtsWebRealm *ActiveRealm() {
  NtsWebRealm *realm = nts::blink_bridge::CurrentWebRealm();
  // ScopedCurrentWebRealm can install a realm only on its checked owner
  // sequence, so the thread-local lookup already establishes IsCurrent().
  return realm && realm->IsAlive() ? realm : nullptr;
}

blink::String DecodeUtf8(NtsWebRealm *realm, const uint8_t *data, size_t length,
                         size_t static_identity) {
  if (NtsWebRealm *active = realm ? realm : ActiveRealm()) {
    return active->DecodeUtf8(data, length, static_identity);
  }
  if (!data && length != 0) {
    return blink::String();
  }
  // The generated SCABI caller establishes the pointer/length extent. Use
  // Chromium's explicit unchecked-span form so PartitionAlloc does not
  // repeat an allocator-bounds query for every string argument.
  return blink::String::FromUtf8(
      UNSAFE_BUFFERS(base::span(base::unchecked, data, length)));
}

blink::AtomicString DecodeUtf8Atomic(NtsWebRealm *realm, const uint8_t *data,
                                     size_t length, size_t static_identity) {
  if (NtsWebRealm *active = realm ? realm : ActiveRealm()) {
    return active->DecodeUtf8Atomic(data, length, static_identity);
  }
  if (!data && length != 0) {
    return blink::AtomicString();
  }
  return blink::AtomicString::FromUtf8(
      UNSAFE_BUFFERS(base::span(base::unchecked, data, length)));
}

void SetError(NtsWebError **out_error, const blink::String &message) {
  if (!out_error) {
    return;
  }
  *out_error = new NtsWebError{message.Utf8()};
}

void SetError(NtsWebError **out_error, const char *message) {
  if (!out_error) {
    return;
  }
  *out_error = new NtsWebError{message};
}

blink::Node *Resolve(NtsWebRealm *realm, NtsWebNode *peer,
                     nts::blink_bridge::ManagedWebType expected) {
  return realm ? realm->Managed().ResolveNode(peer, expected) : nullptr;
}

enum class ResultLifetime { kManaged, kFrameBounded };

NtsWebRealm *EnsureActiveRealm(NtsWebRealm *&realm) {
  if (!realm) {
    realm = ActiveRealm();
  }
  return realm;
}

blink::Node *ResolveInput(NtsWebNode *handle,
                          nts::blink_bridge::ManagedWebType expected,
                          NtsWebRealm *&realm) {
  if (!handle) {
    return nullptr;
  }
  if (!nts::blink_bridge::IsManagedWebNodeHandle(handle)) {
    // Raw handles are emitted only for compiler-proven synchronous frame
    // values. Their static ScriptC type already establishes the binding type;
    // retaining the untagged pointer also lets Oilpan find it on the stack.
    return reinterpret_cast<blink::Node *>(handle);
  }
  return Resolve(EnsureActiveRealm(realm), handle, expected);
}

template <typename T>
T *ResolveInputAs(NtsWebNode *handle,
                  nts::blink_bridge::ManagedWebType expected,
                  NtsWebRealm *&realm) {
  blink::Node *node = ResolveInput(handle, expected, realm);
  if (!node) {
    return nullptr;
  }
  // ResolveNode has already checked managed peers against `expected`; raw
  // frame handles carry the corresponding compiler-established static type.
  return static_cast<T *>(node);
}

NtsWebNode *ExposeNode(NtsWebRealm *&realm, blink::Node *node,
                       ResultLifetime lifetime) {
  if (!node) {
    return nullptr;
  }
  if (lifetime == ResultLifetime::kManaged) {
    NtsWebRealm *active_realm = EnsureActiveRealm(realm);
    return active_realm ? active_realm->Managed().AcquireNode(node) : nullptr;
  }
  const uintptr_t address = reinterpret_cast<uintptr_t>(node);
  CHECK_EQ(address & nts::blink_bridge::kManagedWebNodeHandleTag, 0u);
  return reinterpret_cast<NtsWebNode *>(address);
}

NtsWebNode *CurrentDocument(ResultLifetime lifetime) {
  // Document() is the single owner-sequence/aliveness gate needed here and
  // returns null after navigation invalidates the realm.
  NtsWebRealm *realm = nts::blink_bridge::CurrentWebRealm();
  return ExposeNode(realm, realm ? realm->Document() : nullptr, lifetime);
}

NtsWebNode *DocumentBody(NtsWebNode *document, ResultLifetime lifetime) {
  NtsWebRealm *realm = nullptr;
  auto *resolved = ResolveInputAs<blink::Document>(
      document, nts::blink_bridge::ManagedWebType::kDocument, realm);
  if (!resolved) {
    return nullptr;
  }
  return ExposeNode(
      realm, nts::blink_bridge::generated::DocumentBody(*resolved), lifetime);
}

NtsWebNode *DocumentCreateElement(NtsWebNode *document,
                                  const uint8_t *local_name_data,
                                  size_t local_name_length,
                                  size_t local_name_static_identity,
                                  NtsWebError **error,
                                  ResultLifetime lifetime) {
  if (error) {
    *error = nullptr;
  }
  NtsWebRealm *realm = nullptr;
  auto *resolved = ResolveInputAs<blink::Document>(
      document, nts::blink_bridge::ManagedWebType::kDocument, realm);
  if (!resolved) {
    SetError(error, "Document.createElement receiver is unavailable");
    return nullptr;
  }
  const blink::AtomicString local_name = DecodeUtf8Atomic(
      realm, local_name_data, local_name_length, local_name_static_identity);
  if (local_name.IsNull() && local_name_length != 0) {
    SetError(error, "Document.createElement received invalid UTF-8");
    return nullptr;
  }
  BindingNeutralExceptionCapture capture;
  blink::ExceptionState &exception_state = ExceptionState(capture);
  blink::Element *element = nts::blink_bridge::generated::DocumentCreateElement(
      *resolved, local_name, exception_state);
  if (exception_state.HadException()) {
    SetError(error, ExceptionMessage(capture));
    return nullptr;
  }
  if (!element) {
    SetError(error, "Document.createElement returned no Element");
    return nullptr;
  }
  return ExposeNode(realm, element, lifetime);
}

NtsWebNode *DocumentCreateTextNode(NtsWebNode *document, const uint8_t *data,
                                   size_t data_length,
                                   size_t data_static_identity,
                                   ResultLifetime lifetime) {
  NtsWebRealm *realm = nullptr;
  auto *resolved = ResolveInputAs<blink::Document>(
      document, nts::blink_bridge::ManagedWebType::kDocument, realm);
  if (!resolved) {
    return nullptr;
  }
  const blink::String text =
      DecodeUtf8(realm, data, data_length, data_static_identity);
  if (text.IsNull() && data_length != 0) {
    return nullptr;
  }
  return ExposeNode(
      realm,
      nts::blink_bridge::generated::DocumentCreateTextNode(*resolved, text),
      lifetime);
}

NtsWebNode *NodeAppendChild(NtsWebNode *parent, NtsWebNode *node,
                            NtsWebError **error, ResultLifetime lifetime) {
  if (error) {
    *error = nullptr;
  }
  NtsWebRealm *realm = nullptr;
  blink::Node *resolved_parent =
      ResolveInput(parent, nts::blink_bridge::ManagedWebType::kNode, realm);
  blink::Node *resolved_node =
      ResolveInput(node, nts::blink_bridge::ManagedWebType::kNode, realm);
  if (!resolved_parent || !resolved_node) {
    SetError(error, "Node.appendChild receiver or argument is unavailable");
    return nullptr;
  }
  BindingNeutralExceptionCapture capture;
  blink::ExceptionState &exception_state = ExceptionState(capture);
  blink::Node *result = nts::blink_bridge::generated::NodeAppendChild(
      *resolved_parent, *resolved_node, exception_state);
  if (exception_state.HadException()) {
    SetError(error, ExceptionMessage(capture));
    return nullptr;
  }
  if (!result) {
    SetError(error, "Node.appendChild returned no Node");
    return nullptr;
  }
  return ExposeNode(realm, result, lifetime);
}

NtsWebNode *NodeRemoveChild(NtsWebNode *parent, NtsWebNode *child,
                            NtsWebError **error, ResultLifetime lifetime) {
  if (error) {
    *error = nullptr;
  }
  NtsWebRealm *realm = nullptr;
  blink::Node *resolved_parent =
      ResolveInput(parent, nts::blink_bridge::ManagedWebType::kNode, realm);
  blink::Node *resolved_child =
      ResolveInput(child, nts::blink_bridge::ManagedWebType::kNode, realm);
  if (!resolved_parent || !resolved_child) {
    SetError(error, "Node.removeChild receiver or argument is unavailable");
    return nullptr;
  }
  BindingNeutralExceptionCapture capture;
  blink::ExceptionState &exception_state = ExceptionState(capture);
  blink::Node *result = nts::blink_bridge::generated::NodeRemoveChild(
      *resolved_parent, *resolved_child, exception_state);
  if (exception_state.HadException()) {
    SetError(error, ExceptionMessage(capture));
    return nullptr;
  }
  if (!result) {
    SetError(error, "Node.removeChild returned no Node");
    return nullptr;
  }
  return ExposeNode(realm, result, lifetime);
}

void ElementSetAttribute(NtsWebNode *element, const uint8_t *name_data,
                         size_t name_length, size_t name_static_identity,
                         const uint8_t *value_data, size_t value_length,
                         size_t value_static_identity, NtsWebError **error) {
  if (error) {
    *error = nullptr;
  }
  NtsWebRealm *realm = nullptr;
  auto *resolved = ResolveInputAs<blink::Element>(
      element, nts::blink_bridge::ManagedWebType::kElement, realm);
  if (!resolved) {
    SetError(error, "Element.setAttribute receiver is unavailable");
    return;
  }
  const blink::AtomicString name =
      DecodeUtf8Atomic(realm, name_data, name_length, name_static_identity);
  const blink::AtomicString value =
      DecodeUtf8Atomic(realm, value_data, value_length, value_static_identity);
  if ((name.IsNull() && name_length != 0) ||
      (value.IsNull() && value_length != 0)) {
    SetError(error, "Element.setAttribute received invalid UTF-8");
    return;
  }
  BindingNeutralExceptionCapture capture;
  blink::ExceptionState &exception_state = ExceptionState(capture);
  nts::blink_bridge::generated::ElementSetAttribute(*resolved, name, value,
                                                    exception_state);
  if (exception_state.HadException()) {
    SetError(error, ExceptionMessage(capture));
  }
}

NtsWebNode *ElementQuerySelector(NtsWebNode *element,
                                 const uint8_t *selectors_data,
                                 size_t selectors_length,
                                 size_t selectors_static_identity,
                                 NtsWebError **error, ResultLifetime lifetime) {
  if (error) {
    *error = nullptr;
  }
  NtsWebRealm *realm = nullptr;
  auto *resolved = ResolveInputAs<blink::Element>(
      element, nts::blink_bridge::ManagedWebType::kElement, realm);
  if (!resolved) {
    SetError(error, "Element.querySelector receiver is unavailable");
    return nullptr;
  }
  const blink::AtomicString selectors = DecodeUtf8Atomic(
      realm, selectors_data, selectors_length, selectors_static_identity);
  if (selectors.IsNull() && selectors_length != 0) {
    SetError(error, "Element.querySelector received invalid UTF-8");
    return nullptr;
  }
  BindingNeutralExceptionCapture capture;
  blink::ExceptionState &exception_state = ExceptionState(capture);
  blink::Element *result = nts::blink_bridge::generated::ElementQuerySelector(
      *resolved, selectors, exception_state);
  if (exception_state.HadException()) {
    SetError(error, ExceptionMessage(capture));
    return nullptr;
  }
  return ExposeNode(realm, result, lifetime);
}

} // namespace

extern "C" NtsWebNode *nts_web_current_document() {
  return CurrentDocument(ResultLifetime::kManaged);
}

extern "C" NtsWebNode *nts_web_current_document_frame() {
  return CurrentDocument(ResultLifetime::kFrameBounded);
}

extern "C" NtsWebNode *nts_web_document_body_managed(NtsWebNode *document) {
  return DocumentBody(document, ResultLifetime::kManaged);
}

extern "C" NtsWebNode *nts_web_document_body_frame(NtsWebNode *document) {
  return DocumentBody(document, ResultLifetime::kFrameBounded);
}

extern "C" NtsWebNode *nts_web_document_create_element_managed(
    NtsWebNode *document, const uint8_t *local_name_data,
    size_t local_name_length, size_t local_name_static_identity,
    NtsWebError **error) {
  return DocumentCreateElement(document, local_name_data, local_name_length,
                               local_name_static_identity, error,
                               ResultLifetime::kManaged);
}

extern "C" NtsWebNode *nts_web_document_create_element_frame(
    NtsWebNode *document, const uint8_t *local_name_data,
    size_t local_name_length, size_t local_name_static_identity,
    NtsWebError **error) {
  return DocumentCreateElement(document, local_name_data, local_name_length,
                               local_name_static_identity, error,
                               ResultLifetime::kFrameBounded);
}

extern "C" NtsWebNode *nts_web_document_create_text_node_managed(
    NtsWebNode *document, const uint8_t *data, size_t data_length,
    size_t data_static_identity) {
  return DocumentCreateTextNode(document, data, data_length,
                                data_static_identity, ResultLifetime::kManaged);
}

extern "C" NtsWebNode *
nts_web_document_create_text_node_frame(NtsWebNode *document,
                                        const uint8_t *data, size_t data_length,
                                        size_t data_static_identity) {
  return DocumentCreateTextNode(document, data, data_length,
                                data_static_identity,
                                ResultLifetime::kFrameBounded);
}

extern "C" NtsWebNode *nts_web_node_append_child_managed(NtsWebNode *parent,
                                                         NtsWebNode *node,
                                                         NtsWebError **error) {
  return NodeAppendChild(parent, node, error, ResultLifetime::kManaged);
}

extern "C" NtsWebNode *nts_web_node_append_child_frame(NtsWebNode *parent,
                                                       NtsWebNode *node,
                                                       NtsWebError **error) {
  return NodeAppendChild(parent, node, error, ResultLifetime::kFrameBounded);
}

extern "C" NtsWebNode *nts_web_node_remove_child_managed(NtsWebNode *parent,
                                                         NtsWebNode *child,
                                                         NtsWebError **error) {
  return NodeRemoveChild(parent, child, error, ResultLifetime::kManaged);
}

extern "C" NtsWebNode *nts_web_node_remove_child_frame(NtsWebNode *parent,
                                                       NtsWebNode *child,
                                                       NtsWebError **error) {
  return NodeRemoveChild(parent, child, error, ResultLifetime::kFrameBounded);
}

extern "C" void nts_web_element_set_attribute(
    NtsWebNode *element, const uint8_t *name_data, size_t name_length,
    size_t name_static_identity, const uint8_t *value_data, size_t value_length,
    size_t value_static_identity, NtsWebError **error) {
  ElementSetAttribute(element, name_data, name_length, name_static_identity,
                      value_data, value_length, value_static_identity, error);
}

extern "C" NtsWebNode *nts_web_element_query_selector_managed(
    NtsWebNode *element, const uint8_t *selectors_data, size_t selectors_length,
    size_t selectors_static_identity, NtsWebError **error) {
  return ElementQuerySelector(element, selectors_data, selectors_length,
                              selectors_static_identity, error,
                              ResultLifetime::kManaged);
}

extern "C" NtsWebNode *nts_web_element_query_selector_frame(
    NtsWebNode *element, const uint8_t *selectors_data, size_t selectors_length,
    size_t selectors_static_identity, NtsWebError **error) {
  return ElementQuerySelector(element, selectors_data, selectors_length,
                              selectors_static_identity, error,
                              ResultLifetime::kFrameBounded);
}

extern "C" void nts_web_html_element_click(NtsWebNode *element) {
  NtsWebRealm *realm = nullptr;
  auto *resolved = ResolveInputAs<blink::HTMLElement>(
      element, nts::blink_bridge::ManagedWebType::kHTMLElement, realm);
  if (resolved) {
    nts::blink_bridge::generated::HTMLElementClick(*resolved);
  }
}

extern "C" void
nts_web_character_data_set_data_managed(NtsWebNode *character_data,
                                        const uint8_t *data, size_t data_length,
                                        size_t data_static_identity) {
  NtsWebRealm *realm = nullptr;
  auto *resolved = ResolveInputAs<blink::CharacterData>(
      character_data, nts::blink_bridge::ManagedWebType::kCharacterData, realm);
  if (!resolved) {
    return;
  }
  const blink::String text =
      DecodeUtf8(realm, data, data_length, data_static_identity);
  if (text.IsNull() && data_length != 0) {
    return;
  }
  nts::blink_bridge::generated::CharacterDataSetData(*resolved, text);
}

NtsWebManagedSubscription *
EventTargetListen(NtsWebNode *target, const uint8_t *type_data,
                  size_t type_length, size_t type_static_identity,
                  NtsWebEventCallback callback, void *context,
                  NtsWebContextRelease context_release, bool frame_bounded) {
  NtsWebRealm *realm = nullptr;
  blink::Node *resolved = ResolveInput(
      target, nts::blink_bridge::ManagedWebType::kEventTarget, realm);
  if (!resolved || !callback) {
    ReleaseScriptCContext(context_release, context);
    return nullptr;
  }
  const blink::AtomicString type =
      DecodeUtf8Atomic(realm, type_data, type_length, type_static_identity);
  if (type.IsNull() && type_length != 0) {
    ReleaseScriptCContext(context_release, context);
    return nullptr;
  }
  NtsWebRealm *active_realm = EnsureActiveRealm(realm);
  if (!active_realm) {
    ReleaseScriptCContext(context_release, context);
    return nullptr;
  }
  /* Both representations take ownership of the optional release hook on every
   * return path. The proven frame form reuses its Oilpan listener as the opaque
   * cancellable result; an escaping registration keeps the stable peer. */
  return frame_bounded ? active_realm->Managed().ListenFrame(
                             static_cast<blink::EventTarget *>(resolved), type,
                             callback, context, context_release)
                       : active_realm->Managed().Listen(
                             static_cast<blink::EventTarget *>(resolved), type,
                             callback, context, context_release);
}

extern "C" NtsWebManagedSubscription *
nts_web_event_target_listen(NtsWebNode *target, const uint8_t *type_data,
                            size_t type_length, size_t type_static_identity,
                            NtsWebEventCallback callback, void *context,
                            NtsWebContextRelease context_release) {
  return EventTargetListen(target, type_data, type_length, type_static_identity,
                           callback, context, context_release, false);
}

extern "C" NtsWebManagedSubscription *nts_web_event_target_listen_frame(
    NtsWebNode *target, const uint8_t *type_data, size_t type_length,
    size_t type_static_identity, NtsWebEventCallback callback, void *context,
    NtsWebContextRelease context_release) {
  return EventTargetListen(target, type_data, type_length, type_static_identity,
                           callback, context, context_release, true);
}

extern "C" void nts_web_node_release(NtsWebNode *node) {
  nts::blink_bridge::ReleaseManagedNode(node);
}

extern "C" void nts_web_node_release_frame(NtsWebNode *) {}

extern "C" void
nts_web_subscription_release(NtsWebManagedSubscription *subscription) {
  nts::blink_bridge::ReleaseManagedSubscription(subscription);
}

extern "C" void
nts_web_subscription_release_frame(NtsWebManagedSubscription *subscription) {
  nts::blink_bridge::ReleaseFrameSubscription(subscription);
}

extern "C" const uint8_t *nts_web_error_message(NtsWebError *error) {
  static constexpr uint8_t kUnknown[] = "Unknown Blink binding failure";
  return error ? reinterpret_cast<const uint8_t *>(error->message.c_str())
               : kUnknown;
}

extern "C" void nts_web_error_release(NtsWebError *error) { delete error; }
