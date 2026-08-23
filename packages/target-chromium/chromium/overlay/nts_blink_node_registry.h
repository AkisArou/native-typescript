#ifndef NTS_BLINK_NODE_REGISTRY_H
#define NTS_BLINK_NODE_REGISTRY_H

#include <cstdint>

#include "base/sequence_checker.h"
#include "third_party/blink/renderer/native_typescript/nts_web.h"
#include "third_party/blink/renderer/native_typescript/runtime/nts_handle_table.h"
#include "third_party/blink/renderer/platform/heap/persistent.h"

namespace blink {
class Node;
}

namespace nts::blink_bridge {

/* Stable manifest identities for the first DOM inheritance chain. The final
 * WebIDL generator emits these constants and rejects collisions. These values
 * are FNV-1a/32 over the canonical WebIDL interface name. */
enum class WebTypeId : uint32_t {
  kNode = 0x3468032dU,
  kDocument = 0xf843faf4U,
  kElement = 0x7d376697U,
  kHTMLElement = 0x88f8d4b8U,
  kHTMLBodyElement = 0xaf0e6ca4U,
};

class BlinkNodeRoot final {
 public:
  explicit BlinkNodeRoot(blink::Node* node);
  BlinkNodeRoot(const BlinkNodeRoot&) = delete;
  BlinkNodeRoot& operator=(const BlinkNodeRoot&) = delete;
  ~BlinkNodeRoot();

  blink::Node* Get() const { return node_.Get(); }

 private:
  blink::Persistent<blink::Node> node_;
};

/* Off-heap, realm-owned registry. Every operation is owner-sequence confined.
 * The C table owns only slot/generation/refcount/type state. Each live token is
 * a BlinkNodeRoot whose Persistent<Node> is the corresponding Oilpan edge. */
class BlinkNodeRegistry final {
 public:
  BlinkNodeRegistry();
  BlinkNodeRegistry(const BlinkNodeRegistry&) = delete;
  BlinkNodeRegistry& operator=(const BlinkNodeRegistry&) = delete;
  ~BlinkNodeRegistry();

  NtsWebStatus Intern(blink::Node* node, NtsWebHandle* out_handle);
  NtsWebStatus Resolve(NtsWebHandle handle,
                       WebTypeId expected_type,
                       blink::Node** out_node);
  NtsWebStatus Retain(NtsWebHandle handle);
  NtsWebStatus Release(NtsWebHandle handle);

  void Invalidate();
  bool IsInvalidated() const { return table_.invalidated; }
  size_t LiveCount() const;

  static WebTypeId TypeOf(const blink::Node& node);
  static bool TypeAccepts(WebTypeId actual, WebTypeId expected);

 private:
  static void DestroyToken(void* context, void* token);
  static bool TypeAcceptsHook(void* context,
                              uint32_t actual_type,
                              uint32_t expected_type);

  BlinkNodeRoot* FindRoot(blink::Node* node, uint32_t* out_slot) const;

  NtsHandleTable table_{};
  SEQUENCE_CHECKER(sequence_checker_);
};

}  // namespace nts::blink_bridge

#endif
