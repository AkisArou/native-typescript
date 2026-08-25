#include "third_party/blink/renderer/native_typescript/nts_blink_benchmark_host.h"

#include <array>
#include <cstdio>
#include <cstdint>
#include <vector>

#include "base/check.h"
#include "base/containers/span.h"
#include "base/memory/raw_ptr.h"
#include "base/rand_util.h"
#include "base/time/time.h"
#include "third_party/blink/renderer/core/dom/character_data.h"
#include "third_party/blink/renderer/core/dom/document.h"
#include "third_party/blink/renderer/core/dom/element.h"
#include "third_party/blink/renderer/core/dom/events/event.h"
#include "third_party/blink/renderer/core/dom/events/event_target.h"
#include "third_party/blink/renderer/core/dom/events/native_event_listener.h"
#include "third_party/blink/renderer/core/dom/node.h"
#include "third_party/blink/renderer/core/dom/text.h"
#include "third_party/blink/renderer/core/html/html_element.h"
#include "third_party/blink/renderer/native_typescript/generated/nts_webidl_capsules.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_managed_registry.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_realm.h"
#include "third_party/blink/renderer/platform/bindings/exception_state.h"
#include "third_party/blink/renderer/platform/heap/garbage_collected.h"
#include "third_party/blink/renderer/platform/heap/persistent.h"
#include "third_party/blink/renderer/platform/heap/visitor.h"
#include "third_party/blink/renderer/platform/weborigin/kurl.h"
#include "third_party/blink/renderer/platform/wtf/casting.h"
#include "third_party/blink/renderer/platform/wtf/text/atomic_string.h"
#include "third_party/blink/renderer/platform/wtf/text/string_builder.h"

extern "C" void nts_chromium_scriptc_c_init(void);
extern "C" void nts_chromium_scriptc_llvm_init(void);

using ScriptCPanicSink = void (*)(void *context,
                                  const uint8_t *message,
                                  size_t message_length,
                                  uint64_t address);
extern "C" void nts_chromium_scriptc_c_set_panic_sink(ScriptCPanicSink sink,
                                                        void *context);
extern "C" void nts_chromium_scriptc_llvm_set_panic_sink(
    ScriptCPanicSink sink,
    void *context);
extern "C" int nts_chromium_scriptc_c_callbacks_configure(
    void (*wake)(void *),
    void *context);
extern "C" void nts_chromium_scriptc_c_callbacks_stop_accepting(void);
extern "C" size_t nts_chromium_scriptc_c_callbacks_discard(void);
extern "C" int nts_chromium_scriptc_c_callbacks_destroy(void);
extern "C" int nts_chromium_scriptc_llvm_callbacks_configure(
    void (*wake)(void *),
    void *context);
extern "C" void nts_chromium_scriptc_llvm_callbacks_stop_accepting(void);
extern "C" size_t nts_chromium_scriptc_llvm_callbacks_discard(void);
extern "C" int nts_chromium_scriptc_llvm_callbacks_destroy(void);

#define NTS_CHROMIUM_BENCHMARK_WORKLOAD(                                       \
    id, cpp_function, symbol_stem, cpp_per_call_iterations,                    \
    cpp_per_call_warmup_iterations, cpp_compiled_loop_iterations,              \
    cpp_compiled_loop_warmup_iterations, c_per_call_iterations,                \
    c_per_call_warmup_iterations, c_compiled_loop_iterations,                  \
    c_compiled_loop_warmup_iterations, llvm_per_call_iterations,               \
    llvm_per_call_warmup_iterations, llvm_compiled_loop_iterations,            \
    llvm_compiled_loop_warmup_iterations)                                      \
  extern "C" double nts_chromium_scriptc_c_##symbol_stem(double);              \
  extern "C" double nts_chromium_scriptc_llvm_##symbol_stem(double);
#include "third_party/blink/renderer/native_typescript/generated/nts_benchmark_workloads.inc"
#undef NTS_CHROMIUM_BENCHMARK_WORKLOAD

extern "C" void nts_chromium_scriptc_random_bytes(void *output, size_t length) {
  if (length == 0) {
    return;
  }
  CHECK(output);
  base::RandBytes(
      UNSAFE_BUFFERS(base::span(static_cast<uint8_t *>(output), length)));
}

namespace {

constexpr int kSampleCount = 30;

using LaneFunction = double (*)(double iterations);
using Samples = std::array<double, kSampleCount>;

thread_local NtsWebRealm *current_benchmark_realm = nullptr;
thread_local blink::Persistent<blink::Text> *retained_attached_text = nullptr;

void ReportScriptCPanic(void *,
                        const uint8_t *message,
                        size_t message_length,
                        uint64_t address) {
  UNSAFE_TODO(std::fputs("\n[Native TypeScript ScriptC panic] ", stderr));
  if (message && message_length != 0) {
    UNSAFE_TODO(
        std::fwrite(message, sizeof(uint8_t), message_length, stderr));
  }
  std::fprintf(stderr, " [trap address: 0x%llx]\n",
               static_cast<unsigned long long>(address));
  std::fflush(stderr);
}

bool ConfigureScriptCCallbacks(const blink::String &lane) {
  if (lane == "scriptc-c") {
    return nts_chromium_scriptc_c_callbacks_configure(nullptr, nullptr) != 0;
  }
  return nts_chromium_scriptc_llvm_callbacks_configure(nullptr, nullptr) != 0;
}

void ShutdownScriptCCallbacks(const blink::String &lane) {
  if (lane == "scriptc-c") {
    nts_chromium_scriptc_c_callbacks_stop_accepting();
    CHECK_EQ(nts_chromium_scriptc_c_callbacks_discard(), 0u);
    CHECK(nts_chromium_scriptc_c_callbacks_destroy());
    return;
  }
  nts_chromium_scriptc_llvm_callbacks_stop_accepting();
  CHECK_EQ(nts_chromium_scriptc_llvm_callbacks_discard(), 0u);
  CHECK(nts_chromium_scriptc_llvm_callbacks_destroy());
}

uint32_t CreateElementOnce(blink::Document *document) {
  if (!document) {
    return 0;
  }
  blink::DummyExceptionStateForTesting exception_state;
  blink::Element *element = nts::blink_bridge::generated::DocumentCreateElement(
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

uint32_t CreateDetachedCounterTreeOnce(blink::Document *document) {
  if (!document) {
    return 0;
  }
  blink::DummyExceptionStateForTesting exception_state;
  blink::Element *button = nts::blink_bridge::generated::DocumentCreateElement(
      *document, blink::AtomicString("button"), exception_state);
  if (!button || exception_state.HadException()) {
    return 0;
  }
  blink::Text *label = nts::blink_bridge::generated::DocumentCreateTextNode(
      *document, "Count: 0");
  if (!label) {
    return 0;
  }
  blink::Node *appended = nts::blink_bridge::generated::NodeAppendChild(
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

double UpdateRetainedAttachedTextCpp(double iterations) {
  blink::Document *document = current_benchmark_realm->Document();
  if (!document || !document->body()) {
    return 0;
  }
  blink::Text *label =
      retained_attached_text ? retained_attached_text->Get() : nullptr;
  if (!label) {
    blink::DummyExceptionStateForTesting exception_state;
    blink::Element *output =
        nts::blink_bridge::generated::DocumentCreateElement(
            *document, blink::AtomicString("output"), exception_state);
    label = nts::blink_bridge::generated::DocumentCreateTextNode(*document,
                                                                 "Count: 0");
    if (!output || !label || exception_state.HadException() ||
        nts::blink_bridge::generated::NodeAppendChild(
            *output, *label, exception_state) != label ||
        nts::blink_bridge::generated::NodeAppendChild(
            *document->body(), *output, exception_state) != output ||
        exception_state.HadException()) {
      return 0;
    }
    retained_attached_text = new blink::Persistent<blink::Text>(label);
  }
  double checksum = 0;
  for (int index = 0; index < static_cast<int>(iterations); ++index) {
    nts::blink_bridge::generated::CharacterDataSetData(
        *label,
        index % 2 == 0 ? blink::String("Count: 1") : blink::String("Count: 2"));
    checksum += 1;
  }
  return checksum;
}

double CreateEightRowComponentListsCpp(double iterations) {
  blink::Document *document = current_benchmark_realm->Document();
  if (!document) {
    return 0;
  }
  double checksum = 0;
  for (int index = 0; index < static_cast<int>(iterations); ++index) {
    blink::DummyExceptionStateForTesting exception_state;
    blink::Element *list = nts::blink_bridge::generated::DocumentCreateElement(
        *document, blink::AtomicString("ul"), exception_state);
    if (!list || exception_state.HadException()) {
      return checksum;
    }
    nts::blink_bridge::generated::ElementSetAttribute(
        *list, blink::AtomicString("class"), blink::AtomicString("results"),
        exception_state);
    for (int row_index = 0; row_index < 8; ++row_index) {
      blink::Element *row = nts::blink_bridge::generated::DocumentCreateElement(
          *document, blink::AtomicString("li"), exception_state);
      blink::Element *label =
          nts::blink_bridge::generated::DocumentCreateElement(
              *document, blink::AtomicString("span"), exception_state);
      blink::Text *text = nts::blink_bridge::generated::DocumentCreateTextNode(
          *document, "Native TypeScript result");
      if (!row || !label || !text || exception_state.HadException()) {
        return checksum;
      }
      nts::blink_bridge::generated::ElementSetAttribute(
          *row, blink::AtomicString("class"), blink::AtomicString("result-row"),
          exception_state);
      nts::blink_bridge::generated::ElementSetAttribute(
          *row, blink::AtomicString("data-state"),
          row_index % 2 == 0 ? blink::AtomicString("active")
                             : blink::AtomicString("idle"),
          exception_state);
      if (nts::blink_bridge::generated::NodeAppendChild(
              *label, *text, exception_state) != text ||
          nts::blink_bridge::generated::NodeAppendChild(
              *row, *label, exception_state) != label ||
          nts::blink_bridge::generated::NodeAppendChild(
              *list, *row, exception_state) != row ||
          exception_state.HadException()) {
        return checksum;
      }
    }
    checksum += 1;
  }
  return checksum;
}

double RunSelectorDrivenUpdatesCpp(double iterations) {
  blink::Document *document = current_benchmark_realm->Document();
  if (!document) {
    return 0;
  }
  blink::DummyExceptionStateForTesting exception_state;
  blink::Element *component =
      nts::blink_bridge::generated::DocumentCreateElement(
          *document, blink::AtomicString("section"), exception_state);
  blink::Element *status = nts::blink_bridge::generated::DocumentCreateElement(
      *document, blink::AtomicString("span"), exception_state);
  if (!component || !status || exception_state.HadException()) {
    return 0;
  }
  nts::blink_bridge::generated::ElementSetAttribute(
      *status, blink::AtomicString("data-role"), blink::AtomicString("status"),
      exception_state);
  nts::blink_bridge::generated::ElementSetAttribute(
      *status, blink::AtomicString("data-state"), blink::AtomicString("idle"),
      exception_state);
  if (nts::blink_bridge::generated::NodeAppendChild(
          *component, *status, exception_state) != status ||
      exception_state.HadException()) {
    return 0;
  }
  double checksum = 0;
  for (int index = 0; index < static_cast<int>(iterations); ++index) {
    blink::Element *selected =
        nts::blink_bridge::generated::ElementQuerySelector(
            *component, blink::AtomicString("[data-role=status]"),
            exception_state);
    if (!selected || exception_state.HadException()) {
      return checksum;
    }
    nts::blink_bridge::generated::ElementSetAttribute(
        *selected, blink::AtomicString("data-state"),
        index % 2 == 0 ? blink::AtomicString("active")
                       : blink::AtomicString("idle"),
        exception_state);
    if (exception_state.HadException()) {
      return checksum;
    }
    checksum += 1;
  }
  return checksum;
}

class CountingEventListener final : public blink::NativeEventListener {
public:
  explicit CountingEventListener(double *checksum) : checksum_(checksum) {
    CHECK(checksum_);
  }

  void Invoke(blink::ExecutionContext *, blink::Event *) override {
    *checksum_ += 1;
  }

  void Trace(blink::Visitor *visitor) const override {
    blink::NativeEventListener::Trace(visitor);
  }

private:
  raw_ptr<double> checksum_;
};

double RunSynchronousEventRoundTripsCpp(double iterations) {
  blink::Document *document = current_benchmark_realm->Document();
  if (!document || !document->body()) {
    return 0;
  }
  blink::HTMLElement *button = document->body();
  double checksum = 0;
  auto *listener =
      blink::MakeGarbageCollected<CountingEventListener>(&checksum);
  const blink::AtomicString event_type("click");
  if (!button->addEventListener(event_type, listener, false)) {
    return 0;
  }
  for (int index = 0; index < static_cast<int>(iterations); ++index) {
    nts::blink_bridge::generated::HTMLElementClick(*button);
  }
  button->removeEventListener(event_type, listener, false);
  return checksum;
}

double MountAttachedComponentsCpp(double iterations) {
  blink::Document *document = current_benchmark_realm->Document();
  if (!document || !document->body()) {
    return 0;
  }
  double checksum = 0;
  for (int index = 0; index < static_cast<int>(iterations); ++index) {
    blink::DummyExceptionStateForTesting exception_state;
    blink::Element *card = nts::blink_bridge::generated::DocumentCreateElement(
        *document, blink::AtomicString("article"), exception_state);
    blink::Element *title = nts::blink_bridge::generated::DocumentCreateElement(
        *document, blink::AtomicString("h2"), exception_state);
    blink::Element *value = nts::blink_bridge::generated::DocumentCreateElement(
        *document, blink::AtomicString("output"), exception_state);
    blink::Text *title_text =
        nts::blink_bridge::generated::DocumentCreateTextNode(*document,
                                                             "Result");
    blink::Text *value_text =
        nts::blink_bridge::generated::DocumentCreateTextNode(*document,
                                                             "Count: 1");
    if (!card || !title || !value || !title_text || !value_text ||
        exception_state.HadException()) {
      return checksum;
    }
    nts::blink_bridge::generated::ElementSetAttribute(
        *card, blink::AtomicString("class"),
        blink::AtomicString("benchmark-card"), exception_state);
    if (nts::blink_bridge::generated::NodeAppendChild(
            *title, *title_text, exception_state) != title_text ||
        nts::blink_bridge::generated::NodeAppendChild(
            *value, *value_text, exception_state) != value_text ||
        nts::blink_bridge::generated::NodeAppendChild(
            *card, *title, exception_state) != title ||
        nts::blink_bridge::generated::NodeAppendChild(
            *card, *value, exception_state) != value ||
        nts::blink_bridge::generated::NodeAppendChild(
            *document->body(), *card, exception_state) != card ||
        nts::blink_bridge::generated::NodeRemoveChild(
            *document->body(), *card, exception_state) != card ||
        exception_state.HadException()) {
      return checksum;
    }
    checksum += 1;
  }
  return checksum;
}

struct KernelSamples {
  Samples per_call;
  Samples compiled_loop;
  uint64_t checksum = 0;
};

struct WorkloadBudget {
  int per_call_iterations;
  int per_call_warmup_iterations;
  int compiled_loop_iterations;
  int compiled_loop_warmup_iterations;
};

struct WorkloadDefinition {
  const char *id;
  LaneFunction cpp;
  LaneFunction scriptc_c;
  LaneFunction scriptc_llvm;
  WorkloadBudget cpp_budget;
  WorkloadBudget scriptc_c_budget;
  WorkloadBudget scriptc_llvm_budget;
};

#define NTS_CHROMIUM_BENCHMARK_WORKLOAD(                                       \
    id, cpp_function, symbol_stem, cpp_per_call_iterations,                    \
    cpp_per_call_warmup_iterations, cpp_compiled_loop_iterations,              \
    cpp_compiled_loop_warmup_iterations, c_per_call_iterations,                \
    c_per_call_warmup_iterations, c_compiled_loop_iterations,                  \
    c_compiled_loop_warmup_iterations, llvm_per_call_iterations,               \
    llvm_per_call_warmup_iterations, llvm_compiled_loop_iterations,            \
    llvm_compiled_loop_warmup_iterations)                                      \
  {id,                                                                         \
   &cpp_function,                                                              \
   &nts_chromium_scriptc_c_##symbol_stem,                                      \
   &nts_chromium_scriptc_llvm_##symbol_stem,                                   \
   {cpp_per_call_iterations, cpp_per_call_warmup_iterations,                   \
    cpp_compiled_loop_iterations, cpp_compiled_loop_warmup_iterations},        \
   {c_per_call_iterations, c_per_call_warmup_iterations,                       \
    c_compiled_loop_iterations, c_compiled_loop_warmup_iterations},            \
   {llvm_per_call_iterations, llvm_per_call_warmup_iterations,                 \
    llvm_compiled_loop_iterations, llvm_compiled_loop_warmup_iterations}},
constexpr WorkloadDefinition kWorkloads[] = {
#include "third_party/blink/renderer/native_typescript/generated/nts_benchmark_workloads.inc"
};
#undef NTS_CHROMIUM_BENCHMARK_WORKLOAD

struct MeasuredWorkload {
  const WorkloadDefinition *definition;
  const WorkloadBudget *budget;
  KernelSamples samples;
  nts::blink_bridge::BlinkManagedDiagnostics interop;
};

KernelSamples MeasureKernel(LaneFunction function, int per_call_iterations,
                            int per_call_warmup_iterations,
                            int compiled_loop_iterations,
                            int compiled_loop_warmup_iterations) {
  KernelSamples result;
  for (int iteration = 0; iteration < per_call_warmup_iterations; ++iteration) {
    result.checksum += static_cast<uint64_t>(function(1));
  }
  for (int sample = 0; sample < kSampleCount; ++sample) {
    const base::TimeTicks start = base::TimeTicks::Now();
    for (int iteration = 0; iteration < per_call_iterations; ++iteration) {
      result.checksum += static_cast<uint64_t>(function(1));
    }
    result.per_call[sample] =
        static_cast<double>((base::TimeTicks::Now() - start).InNanoseconds()) /
        per_call_iterations;
  }
  result.checksum +=
      static_cast<uint64_t>(function(compiled_loop_warmup_iterations));
  for (int sample = 0; sample < kSampleCount; ++sample) {
    const base::TimeTicks start = base::TimeTicks::Now();
    result.checksum +=
        static_cast<uint64_t>(function(compiled_loop_iterations));
    result.compiled_loop[sample] =
        static_cast<double>((base::TimeTicks::Now() - start).InNanoseconds()) /
        compiled_loop_iterations;
  }
  return result;
}

LaneFunction FunctionForLane(const WorkloadDefinition &workload,
                             const blink::String &lane) {
  if (lane == "cpp") {
    return workload.cpp;
  }
  if (lane == "scriptc-c") {
    return workload.scriptc_c;
  }
  if (lane == "scriptc-llvm") {
    return workload.scriptc_llvm;
  }
  return nullptr;
}

const WorkloadBudget *BudgetForLane(const WorkloadDefinition &workload,
                                    const blink::String &lane) {
  if (lane == "cpp") {
    return &workload.cpp_budget;
  }
  if (lane == "scriptc-c") {
    return &workload.scriptc_c_budget;
  }
  if (lane == "scriptc-llvm") {
    return &workload.scriptc_llvm_budget;
  }
  return nullptr;
}

std::vector<MeasuredWorkload> MeasureLane(const blink::String &lane,
                                          const blink::String &workload_id) {
  std::vector<MeasuredWorkload> result;
  result.reserve(1);
  for (const WorkloadDefinition &workload : kWorkloads) {
    if (workload_id != workload.id) {
      continue;
    }
    LaneFunction function = FunctionForLane(workload, lane);
    const WorkloadBudget *budget = BudgetForLane(workload, lane);
    CHECK(function);
    CHECK(budget);
    result.push_back(MeasuredWorkload{
        .definition = &workload,
        .budget = budget,
        .samples = MeasureKernel(function, budget->per_call_iterations,
                                 budget->per_call_warmup_iterations,
                                 budget->compiled_loop_iterations,
                                 budget->compiled_loop_warmup_iterations),
        .interop = current_benchmark_realm->Managed().Diagnostics(),
    });
  }
  CHECK_EQ(result.size(), 1u);
  return result;
}

void AppendSamples(blink::StringBuilder &builder, const Samples &samples) {
  builder.Append('[');
  for (int index = 0; index < kSampleCount; ++index) {
    if (index != 0) {
      builder.Append(',');
    }
    builder.AppendNumber(samples[index], 12);
  }
  builder.Append(']');
}

blink::String SerializeResult(const blink::String &lane,
                              const std::vector<MeasuredWorkload> &workloads) {
  blink::StringBuilder builder;
  builder.Append("{\"lane\":\"");
  builder.Append(lane);
  builder.Append("\",\"sampleCount\":");
  builder.AppendNumber(kSampleCount);
  builder.Append(",\"workloads\":[");
  for (size_t index = 0; index < workloads.size(); ++index) {
    if (index != 0) {
      builder.Append(',');
    }
    const MeasuredWorkload &workload = workloads[index];
    builder.Append("{\"id\":\"");
    builder.Append(workload.definition->id);
    builder.Append("\",\"perCallIterations\":");
    builder.AppendNumber(workload.budget->per_call_iterations);
    builder.Append(",\"perCallWarmupIterations\":");
    builder.AppendNumber(workload.budget->per_call_warmup_iterations);
    builder.Append(",\"compiledLoopIterations\":");
    builder.AppendNumber(workload.budget->compiled_loop_iterations);
    builder.Append(",\"compiledLoopWarmupIterations\":");
    builder.AppendNumber(workload.budget->compiled_loop_warmup_iterations);
    builder.Append(",\"checksum\":");
    builder.AppendNumber(workload.samples.checksum);
    builder.Append(",\"perCall\":");
    AppendSamples(builder, workload.samples.per_call);
    builder.Append(",\"compiledLoop\":");
    AppendSamples(builder, workload.samples.compiled_loop);
    builder.Append(",\"interop\":");
    if (lane == "cpp") {
      builder.Append("null");
    } else {
      builder.Append("{\"managedNodePeers\":");
      builder.AppendNumber(workload.interop.node_peers);
      builder.Append(",\"managedNodeClaims\":");
      builder.AppendNumber(workload.interop.node_claims);
      builder.Append(",\"managedSubscriptions\":");
      builder.AppendNumber(workload.interop.subscriptions);
      builder.Append('}');
    }
    builder.Append('}');
  }
  builder.Append(']');
  builder.Append('}');
  return builder.ToString();
}

} // namespace

extern "C" uint32_t nts_chromium_benchmark_create_element_once(void) {
  if (!current_benchmark_realm || !current_benchmark_realm->IsAlive()) {
    return 0;
  }
  return CreateElementOnce(current_benchmark_realm->Document());
}

namespace nts::blink_bridge {

bool RunDocumentCreateElementBenchmark(blink::Document *document) {
  if (!document || !document->GetExecutionContext() || !document->body()) {
    return false;
  }
  blink::HTMLElement *body = document->body();
  const blink::AtomicString lane_attribute("data-nts-benchmark-lane");
  const blink::String lane = body->getAttribute(lane_attribute);
  const blink::String workload_id =
      document->Url().FragmentIdentifier().ToString();
  if (workload_id.empty()) {
    return false;
  }
  if (lane == "v8") {
    return true;
  }

  if (lane != "cpp" && lane != "scriptc-c" && lane != "scriptc-llvm") {
    return false;
  }

  NtsWebRealm *realm = CreateWebRealm(document);
  if (!realm) {
    return false;
  }
  CHECK(!current_benchmark_realm);
  current_benchmark_realm = realm;
  std::vector<MeasuredWorkload> samples;
  {
    ScopedCurrentWebRealm active_realm(realm);
    if (lane == "scriptc-c") {
      nts_chromium_scriptc_c_set_panic_sink(ReportScriptCPanic, nullptr);
      nts_chromium_scriptc_c_init();
      CHECK(ConfigureScriptCCallbacks(lane));
    } else if (lane == "scriptc-llvm") {
      nts_chromium_scriptc_llvm_set_panic_sink(ReportScriptCPanic, nullptr);
      nts_chromium_scriptc_llvm_init();
      CHECK(ConfigureScriptCCallbacks(lane));
    }
    samples = MeasureLane(lane, workload_id);
    if (lane != "cpp") {
      ShutdownScriptCCallbacks(lane);
    }
  }
  delete retained_attached_text;
  retained_attached_text = nullptr;
  current_benchmark_realm = nullptr;
  DestroyWebRealm(realm);

  body->setAttribute(blink::AtomicString("data-nts-benchmark-result"),
                     blink::AtomicString(SerializeResult(lane, samples)));
  body->setAttribute(blink::AtomicString("data-nts-benchmark-ready"),
                     blink::AtomicString("true"));
  return true;
}

} // namespace nts::blink_bridge
