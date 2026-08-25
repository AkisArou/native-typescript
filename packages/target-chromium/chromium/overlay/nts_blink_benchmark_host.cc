#include "third_party/blink/renderer/native_typescript/nts_blink_benchmark_host.h"

#include <array>
#include <cstdint>

#include "base/check.h"
#include "base/containers/span.h"
#include "base/rand_util.h"
#include "base/time/time.h"
#include "third_party/blink/renderer/core/dom/character_data.h"
#include "third_party/blink/renderer/core/dom/document.h"
#include "third_party/blink/renderer/core/dom/element.h"
#include "third_party/blink/renderer/core/dom/node.h"
#include "third_party/blink/renderer/core/dom/text.h"
#include "third_party/blink/renderer/core/html/html_element.h"
#include "third_party/blink/renderer/native_typescript/generated/nts_webidl_capsules.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_realm.h"
#include "third_party/blink/renderer/platform/bindings/exception_state.h"
#include "third_party/blink/renderer/platform/wtf/text/atomic_string.h"
#include "third_party/blink/renderer/platform/wtf/text/string_builder.h"

extern "C" void nts_chromium_scriptc_c_init(void);
extern "C" double nts_chromium_scriptc_c_create_elements(double iterations);
extern "C" double nts_chromium_scriptc_c_create_detached_counter_trees(
    double iterations);
extern "C" void nts_chromium_scriptc_llvm_init(void);
extern "C" double nts_chromium_scriptc_llvm_create_elements(double iterations);
extern "C" double nts_chromium_scriptc_llvm_create_detached_counter_trees(
    double iterations);

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

uint32_t CreateDetachedCounterTreeOnce(blink::Document* document) {
  if (!document) {
    return 0;
  }
  blink::DummyExceptionStateForTesting exception_state;
  blink::Element* button = nts::blink_bridge::generated::DocumentCreateElement(
      *document, blink::AtomicString("button"), exception_state);
  if (!button || exception_state.HadException()) {
    return 0;
  }
  blink::Text* label = nts::blink_bridge::generated::DocumentCreateTextNode(
      *document, "Count: 0");
  if (!label) {
    return 0;
  }
  blink::Node* appended = nts::blink_bridge::generated::NodeAppendChild(
      *button, *label, exception_state);
  if (appended != label || exception_state.HadException()) {
    return 0;
  }
  nts::blink_bridge::generated::CharacterDataSetData(*label, "Count: 1");
  return 1;
}

double CreateDetachedCounterTreesCpp(double iterations) {
  double checksum = 0;
  for (int index = 0; index < static_cast<int>(iterations); ++index) {
    checksum +=
        CreateDetachedCounterTreeOnce(current_benchmark_realm->Document());
  }
  return checksum;
}

struct KernelSamples {
  Samples per_call;
  Samples compiled_loop;
  uint64_t checksum = 0;
};

struct WorkloadSamples {
  Samples create_element_per_call;
  Samples create_element_compiled_loop;
  Samples detached_counter_tree_per_call;
  Samples detached_counter_tree_compiled_loop;
  uint64_t checksum = 0;
};

KernelSamples MeasureKernel(LaneFunction function) {
  KernelSamples result;
  for (int iteration = 0; iteration < kWarmupIterations; ++iteration) {
    result.checksum += static_cast<uint64_t>(function(1));
  }
  for (int sample = 0; sample < kSampleCount; ++sample) {
    const base::TimeTicks start = base::TimeTicks::Now();
    for (int iteration = 0; iteration < kIterations; ++iteration) {
      result.checksum += static_cast<uint64_t>(function(1));
    }
    result.per_call[sample] =
        static_cast<double>((base::TimeTicks::Now() - start).InNanoseconds()) /
        kIterations;
  }
  result.checksum += static_cast<uint64_t>(function(kWarmupIterations));
  for (int sample = 0; sample < kSampleCount; ++sample) {
    const base::TimeTicks start = base::TimeTicks::Now();
    result.checksum += static_cast<uint64_t>(function(kIterations));
    result.compiled_loop[sample] =
        static_cast<double>((base::TimeTicks::Now() - start).InNanoseconds()) /
        kIterations;
  }
  return result;
}

WorkloadSamples MeasureLane(LaneFunction create_elements,
                            LaneFunction create_detached_counter_trees) {
  const KernelSamples create = MeasureKernel(create_elements);
  const KernelSamples mixed = MeasureKernel(create_detached_counter_trees);
  return WorkloadSamples{
      .create_element_per_call = create.per_call,
      .create_element_compiled_loop = create.compiled_loop,
      .detached_counter_tree_per_call = mixed.per_call,
      .detached_counter_tree_compiled_loop = mixed.compiled_loop,
      .checksum = create.checksum + mixed.checksum,
  };
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
  builder.Append(",\"createElementPerCall\":");
  AppendSamples(builder, samples.create_element_per_call);
  builder.Append(",\"createElementCompiledLoop\":");
  AppendSamples(builder, samples.create_element_compiled_loop);
  builder.Append(",\"detachedCounterTreePerCall\":");
  AppendSamples(builder, samples.detached_counter_tree_per_call);
  builder.Append(",\"detachedCounterTreeCompiledLoop\":");
  AppendSamples(builder, samples.detached_counter_tree_compiled_loop);
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

  LaneFunction create_elements = nullptr;
  LaneFunction create_detached_counter_trees = nullptr;
  if (lane == "cpp") {
    create_elements = &CreateElementsCpp;
    create_detached_counter_trees = &CreateDetachedCounterTreesCpp;
  } else if (lane == "scriptc-c") {
    nts_chromium_scriptc_c_init();
    create_elements = &nts_chromium_scriptc_c_create_elements;
    create_detached_counter_trees =
        &nts_chromium_scriptc_c_create_detached_counter_trees;
  } else if (lane == "scriptc-llvm") {
    nts_chromium_scriptc_llvm_init();
    create_elements = &nts_chromium_scriptc_llvm_create_elements;
    create_detached_counter_trees =
        &nts_chromium_scriptc_llvm_create_detached_counter_trees;
  } else {
    return false;
  }

  NtsWebRealm* realm = CreateWebRealm(document);
  if (!realm) {
    return false;
  }
  CHECK(!current_benchmark_realm);
  current_benchmark_realm = realm;
  WorkloadSamples samples;
  {
    ScopedCurrentWebRealm active_realm(realm);
    samples = MeasureLane(create_elements, create_detached_counter_trees);
  }
  current_benchmark_realm = nullptr;
  DestroyWebRealm(realm);

  body->setAttribute(blink::AtomicString("data-nts-benchmark-result"),
                     blink::AtomicString(SerializeResult(lane, samples)));
  body->setAttribute(blink::AtomicString("data-nts-benchmark-ready"),
                     blink::AtomicString("true"));
  return true;
}

}  // namespace nts::blink_bridge
