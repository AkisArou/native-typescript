#ifndef NTS_BLINK_BENCHMARK_HOST_H
#define NTS_BLINK_BENCHMARK_HOST_H

namespace blink {
class Document;
}

namespace nts::blink_bridge {

bool RunDocumentCreateElementBenchmark(blink::Document* document);

}  // namespace nts::blink_bridge

#endif
