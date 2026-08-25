#include "third_party/blink/renderer/native_typescript/nts_blink_benchmark_host.h"

#include <array>
#include <cstdint>

#include "base/check.h"
#include "base/containers/span.h"
#include "base/rand_util.h"
#include "base/time/time.h"
#include "third_party/blink/renderer/core/dom/document.h"
#include "third_party/blink/renderer/core/dom/element.h"
#include "third_party/blink/renderer/core/html/html_element.h"
#include "third_party/blink/renderer/native_typescript/generated/nts_webidl_capsules.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_realm.h"
#include "third_party/blink/renderer/platform/bindings/exception_state.h"
#include "third_party/blink/renderer/platform/wtf/text/atomic_string.h"
#include "third_party/blink/renderer/platform/wtf/text/string_builder.h"

extern "C" void nts_chromium_scriptc_c_init(void);
extern "C" double nts_chromium_scriptc_c_create_elements(double iterations);
extern "C" void nts_chromium_scriptc_llvm_init(void);
extern "C" double nts_chromium_scriptc_llvm_create_elements(double iterations);

extern "C" void nts_chromium_scriptc_random_bytes(void* output, size_t length) {
  if (length == 0) {
    return;
  }
  CHECK(output);
  base::RandBytes(
      UNSAFE_BUFFERS(base::span(static_cast<uint8_t*>(output), length)));
}

namespace {

constexpr int kIterations = 100000;
constexpr int kSampleCount = 30;
constexpr int kWarmupIterations = 20000;

using LaneFunction = double (*)(double iterations);
using Samples = std::array<double, kSampleCount>;

thread_local NtsWebRealm* current_benchmark_realm = nullptr;

uint32_t CreateElementOnce(blink::Document* document) {
  if (!document) {
    return 0;
  }
  blink::DummyExceptionStateForTesting exception_state;
  blink::Element* element = nts::blink_bridge::generated::DocumentCreateElement(
      *document, blink::AtomicString("div"), exception_state);
  return element != nullptr && !exception_state.HadException() ? 1u : 0u;
}

double CreateElementsCpp(double iterations) {
  double checksum = 0;
  for (int index = 0; index < static_cast<int>(iterations); ++index) {
    checksum += CreateElementOnce(current_benchmark_realm->Document());
  }
  return checksum;
}

struct WorkloadSamples {
  Samples primitive;
  Samples boundary_heavy;
  uint64_t checksum = 0;
};

WorkloadSamples MeasureLane(LaneFunction function) {
  WorkloadSamples result;
  for (int iteration = 0; iteration < kWarmupIterations; ++iteration) {
    result.checksum += static_cast<uint64_t>(function(1));
  }
  for (int sample = 0; sample < kSampleCount; ++sample) {
    const base::TimeTicks start = base::TimeTicks::Now();
    for (int iteration = 0; iteration < kIterations; ++iteration) {
      result.checksum += static_cast<uint64_t>(function(1));
    }
    result.primitive[sample] =
        static_cast<double>((base::TimeTicks::Now() - start).InNanoseconds()) /
        kIterations;
  }
  result.checksum += static_cast<uint64_t>(function(kWarmupIterations));
  for (int sample = 0; sample < kSampleCount; ++sample) {
    const base::TimeTicks start = base::TimeTicks::Now();
    result.checksum += static_cast<uint64_t>(function(kIterations));
    result.boundary_heavy[sample] =
        static_cast<double>((base::TimeTicks::Now() - start).InNanoseconds()) /
        kIterations;
  }
  return result;
}

void AppendSamples(blink::StringBuilder& builder, const Samples& samples) {
  builder.Append('[');
  for (int index = 0; index < kSampleCount; ++index) {
    if (index != 0) {
      builder.Append(',');
    }
    builder.AppendNumber(samples[index], 12);
  }
  builder.Append(']');
}

blink::String SerializeResult(const blink::String& lane,
                              const WorkloadSamples& samples) {
  blink::StringBuilder builder;
  builder.Append("{\"lane\":\"");
  builder.Append(lane);
  builder.Append("\",\"iterations\":");
  builder.AppendNumber(kIterations);
  builder.Append(",\"sampleCount\":");
  builder.AppendNumber(kSampleCount);
  builder.Append(",\"warmupIterations\":");
  builder.AppendNumber(kWarmupIterations);
  builder.Append(",\"checksum\":");
  builder.AppendNumber(samples.checksum);
  builder.Append(",\"primitive\":");
  AppendSamples(builder, samples.primitive);
  builder.Append(",\"boundaryHeavy\":");
  AppendSamples(builder, samples.boundary_heavy);
  builder.Append('}');
  return builder.ToString();
}

}  // namespace

extern "C" uint32_t nts_chromium_benchmark_create_element_once(void) {
  if (!current_benchmark_realm || !current_benchmark_realm->IsAlive()) {
    return 0;
  }
  return CreateElementOnce(current_benchmark_realm->Document());
}

namespace nts::blink_bridge {

bool RunDocumentCreateElementBenchmark(blink::Document* document) {
  if (!document || !document->GetExecutionContext() || !document->body()) {
    return false;
  }
  blink::HTMLElement* body = document->body();
  const blink::AtomicString lane_attribute("data-nts-benchmark-lane");
  const blink::String lane = body->getAttribute(lane_attribute);
  if (lane == "v8") {
    return true;
  }

  LaneFunction function = nullptr;
  if (lane == "cpp") {
    function = &CreateElementsCpp;
  } else if (lane == "scriptc-c") {
    nts_chromium_scriptc_c_init();
    function = &nts_chromium_scriptc_c_create_elements;
  } else if (lane == "scriptc-llvm") {
    nts_chromium_scriptc_llvm_init();
    function = &nts_chromium_scriptc_llvm_create_elements;
  } else {
    return false;
  }

  NtsWebRealm* realm = CreateWebRealm(document);
  if (!realm) {
    return false;
  }
  CHECK(!current_benchmark_realm);
  current_benchmark_realm = realm;
  const WorkloadSamples samples = MeasureLane(function);
  current_benchmark_realm = nullptr;
  DestroyWebRealm(realm);

  body->setAttribute(blink::AtomicString("data-nts-benchmark-result"),
                     blink::AtomicString(SerializeResult(lane, samples)));
  body->setAttribute(blink::AtomicString("data-nts-benchmark-ready"),
                     blink::AtomicString("true"));
  return true;
}

}  // namespace nts::blink_bridge
