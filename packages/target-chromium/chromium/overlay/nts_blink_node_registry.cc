#include "third_party/blink/renderer/native_typescript/nts_blink_node_registry.h"

#include <new>

#include "base/check.h"
#include "third_party/blink/renderer/core/dom/document.h"
#include "third_party/blink/renderer/core/dom/element.h"
#include "third_party/blink/renderer/core/dom/node.h"
#include "third_party/blink/renderer/core/html/html_body_element.h"
#include "third_party/blink/renderer/core/html/html_element.h"
#include "third_party/blink/renderer/platform/wtf/casting.h"

namespace nts::blink_bridge {

BlinkNodeRoot::BlinkNodeRoot(blink::Node* node) : node_(node) {
  CHECK(node);
}

BlinkNodeRoot::~BlinkNodeRoot() = default;

BlinkNodeRegistry::BlinkNodeRegistry() {
  NtsHandleTableHooks hooks = {
      .destroy_token = &BlinkNodeRegistry::DestroyToken,
      .type_accepts = &BlinkNodeRegistry::TypeAcceptsHook,
      .context = this,
  };
  nts_handle_table_init(&table_, hooks);
}

BlinkNodeRegistry::~BlinkNodeRegistry() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  nts_handle_table_destroy(&table_);
}

NtsWebStatus BlinkNodeRegistry::Intern(blink::Node* node,
                                       NtsWebHandle* out_handle) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (!node || !out_handle) return NTS_WEB_INVALID_ARGUMENT;
  if (table_.invalidated) return NTS_WEB_CONTEXT_DESTROYED;

  uint32_t existing_slot = NTS_HANDLE_NO_SLOT;
  if (BlinkNodeRoot* existing = FindRoot(node, &existing_slot)) {
    (void)existing;
    NtsWebHandle handle = {
        .slot = existing_slot,
        .generation = table_.slots[existing_slot].generation,
    };
    NtsWebStatus status = nts_handle_table_retain(&table_, handle);
    if (status == NTS_WEB_OK) *out_handle = handle;
    return status;
  }

  auto* root = new (std::nothrow) BlinkNodeRoot(node);
  if (!root) return NTS_WEB_OUT_OF_MEMORY;

  NtsWebStatus status = nts_handle_table_insert(
      &table_, static_cast<uint32_t>(TypeOf(*node)), root, out_handle);
  if (status != NTS_WEB_OK) delete root;
  return status;
}

NtsWebStatus BlinkNodeRegistry::Resolve(NtsWebHandle handle,
                                        WebTypeId expected_type,
                                        blink::Node** out_node) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (!out_node) return NTS_WEB_INVALID_ARGUMENT;

  void* token = nullptr;
  NtsWebStatus status = nts_handle_table_resolve(
      &table_, handle, static_cast<uint32_t>(expected_type), &token, nullptr);
  if (status != NTS_WEB_OK) return status;

  auto* root = static_cast<BlinkNodeRoot*>(token);
  blink::Node* node = root->Get();
  if (!node) return NTS_WEB_INVALID_HANDLE;
  *out_node = node;
  return NTS_WEB_OK;
}

NtsWebStatus BlinkNodeRegistry::Retain(NtsWebHandle handle) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  return nts_handle_table_retain(&table_, handle);
}

NtsWebStatus BlinkNodeRegistry::Release(NtsWebHandle handle) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  return nts_handle_table_release(&table_, handle);
}

void BlinkNodeRegistry::Invalidate() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  nts_handle_table_invalidate(&table_);
}

size_t BlinkNodeRegistry::LiveCount() const {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  return nts_handle_table_live_count(&table_);
}

WebTypeId BlinkNodeRegistry::TypeOf(const blink::Node& node) {
  if (blink::IsA<blink::HTMLBodyElement>(node)) {
    return WebTypeId::kHTMLBodyElement;
  }
  if (blink::IsA<blink::HTMLElement>(node)) return WebTypeId::kHTMLElement;
  if (blink::IsA<blink::Element>(node)) return WebTypeId::kElement;
  if (blink::IsA<blink::Document>(node)) return WebTypeId::kDocument;
  return WebTypeId::kNode;
}

bool BlinkNodeRegistry::TypeAccepts(WebTypeId actual, WebTypeId expected) {
  if (actual == expected) return true;

  switch (actual) {
    case WebTypeId::kHTMLBodyElement:
      return expected == WebTypeId::kHTMLElement ||
             expected == WebTypeId::kElement || expected == WebTypeId::kNode;
    case WebTypeId::kHTMLElement:
      return expected == WebTypeId::kElement || expected == WebTypeId::kNode;
    case WebTypeId::kElement:
    case WebTypeId::kDocument:
      return expected == WebTypeId::kNode;
    case WebTypeId::kNode:
      return false;
  }
  return false;
}

void BlinkNodeRegistry::DestroyToken(void* context, void* token) {
  auto* registry = static_cast<BlinkNodeRegistry*>(context);
  DCHECK_CALLED_ON_VALID_SEQUENCE(registry->sequence_checker_);
  delete static_cast<BlinkNodeRoot*>(token);
}

bool BlinkNodeRegistry::TypeAcceptsHook(void* context,
                                        uint32_t actual_type,
                                        uint32_t expected_type) {
  auto* registry = static_cast<BlinkNodeRegistry*>(context);
  DCHECK_CALLED_ON_VALID_SEQUENCE(registry->sequence_checker_);
  return TypeAccepts(static_cast<WebTypeId>(actual_type),
                     static_cast<WebTypeId>(expected_type));
}

BlinkNodeRoot* BlinkNodeRegistry::FindRoot(blink::Node* node,
                                           uint32_t* out_slot) const {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  for (size_t index = 0; index < table_.slot_count; ++index) {
    const NtsHandleSlot& slot = table_.slots[index];
    if (!slot.occupied) continue;
    auto* root = static_cast<BlinkNodeRoot*>(slot.token);
    if (root->Get() != node) continue;
    if (out_slot) *out_slot = static_cast<uint32_t>(index);
    return root;
  }
  return nullptr;
}

}  // namespace nts::blink_bridge
