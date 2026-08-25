#include "third_party/blink/renderer/native_typescript/nts_blink_counter_host.h"

#include <new>

#include "base/check.h"
#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/task/sequenced_task_runner.h"
#include "third_party/blink/public/web/web_local_frame.h"
#include "third_party/blink/renderer/core/dom/document.h"
#include "third_party/blink/renderer/core/frame/local_frame.h"
#include "third_party/blink/renderer/core/frame/web_local_frame_impl.h"
#include "third_party/blink/renderer/native_typescript/counter/app.h"
#include "third_party/blink/renderer/native_typescript/create-element/app.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_benchmark_host.h"
#include "third_party/blink/renderer/native_typescript/nts_blink_realm.h"
#include "third_party/blink/renderer/platform/bindings/exception_code.h"
#if __has_include( \
    "third_party/blink/renderer/platform/bindings/exception_state_capture.h")
#include "third_party/blink/renderer/platform/bindings/exception_state_capture.h"
#else
#include "third_party/blink/renderer/platform/bindings/exception_state.h"
#endif

namespace nts::blink_bridge {

namespace {

enum class CounterLane {
  kOracleC,
  kScriptCC,
  kScriptCLlvm,
};

CounterLane SelectedCounterLane() {
  const std::string lane =
      base::CommandLine::ForCurrentProcess()->GetSwitchValueASCII(
          "native-typescript-counter");
  if (lane == "oracle-c") {
    return CounterLane::kOracleC;
  }
  if (lane == "scriptc-llvm") {
    return CounterLane::kScriptCLlvm;
  }
  return CounterLane::kScriptCC;
}

const char* CounterLaneName(CounterLane lane) {
  switch (lane) {
    case CounterLane::kOracleC:
      return "oracle-c";
    case CounterLane::kScriptCC:
      return "scriptc-c";
    case CounterLane::kScriptCLlvm:
      return "scriptc-llvm";
  }
}

}  // namespace

extern "C" void nts_chromium_counter_scriptc_c_init(void);
extern "C" void nts_chromium_counter_scriptc_c_collect(void);
extern "C" double nts_chromium_counter_scriptc_c_start(void);
extern "C" double nts_chromium_counter_scriptc_c_stop(void);
extern "C" int nts_chromium_counter_scriptc_c_callbacks_configure(
    void (*wake)(void*),
    void* context);
extern "C" int nts_chromium_counter_scriptc_c_callbacks_dispatch(void);
extern "C" void nts_chromium_counter_scriptc_c_callbacks_stop_accepting(void);
extern "C" size_t nts_chromium_counter_scriptc_c_callbacks_discard(void);
extern "C" int nts_chromium_counter_scriptc_c_callbacks_destroy(void);
extern "C" void nts_chromium_counter_scriptc_llvm_init(void);
extern "C" void nts_chromium_counter_scriptc_llvm_collect(void);
extern "C" double nts_chromium_counter_scriptc_llvm_start(void);
extern "C" double nts_chromium_counter_scriptc_llvm_stop(void);
extern "C" int nts_chromium_counter_scriptc_llvm_callbacks_configure(
    void (*wake)(void*),
    void* context);
extern "C" int nts_chromium_counter_scriptc_llvm_callbacks_dispatch(void);
extern "C" void nts_chromium_counter_scriptc_llvm_callbacks_stop_accepting(
    void);
extern "C" size_t nts_chromium_counter_scriptc_llvm_callbacks_discard(void);
extern "C" int nts_chromium_counter_scriptc_llvm_callbacks_destroy(void);

bool VerifyBindingNeutralSecurityErrorCapture() {
#if defined(NTS_BLINK_HAS_EXCEPTION_STATE_CAPTURE)
  blink::ExceptionStateCapture capture;
  blink::ExceptionState& exception_state = capture.GetExceptionState();
  exception_state.ThrowSecurityError("safe message", "privileged detail");
  return exception_state.HadException() &&
         capture.Code() ==
             blink::ToExceptionCode(blink::DOMExceptionCode::kSecurityError) &&
         capture.SanitizedMessage() == "safe message" &&
         capture.UnsanitizedMessage() == "privileged detail";
#else
  return true;
#endif
}

class BlinkCounterHost final {
 public:
  explicit BlinkCounterHost(blink::Document* document)
      : lane_(SelectedCounterLane()),
        task_runner_(base::SequencedTaskRunner::GetCurrentDefault()) {
    realm_ = CreateWebRealm(document, &nts_counter_dispatch_event, nullptr);
    if (!realm_) {
      return;
    }
#if defined(NTS_BLINK_HAS_EXCEPTION_STATE_CAPTURE)
    if (!VerifyBindingNeutralSecurityErrorCapture()) {
      ResetRealm();
      return;
    }
    LOG(INFO) << "Native TypeScript security-message capture: passed";
#endif
    if (!nts_create_element_exception_probe(realm_)) {
      ResetRealm();
      return;
    }
    LOG(INFO) << "Native TypeScript DOMException probe: passed";
    {
      ScopedCurrentWebRealm active_realm(realm_);
      if (lane_ == CounterLane::kOracleC) {
        if (!nts_counter_start(realm_)) {
          started_ = false;
        } else {
          started_ = true;
        }
      } else {
        InitializeScriptCRuntime();
        if (ConfigureScriptCCallbacks()) {
          callbacks_configured_ = true;
          scriptc_start_called_ = true;
          started_ = StartScriptCProgram() == 1.0;
        }
      }
    }
    if (!started_) {
      if (lane_ != CounterLane::kOracleC) {
        ScopedCurrentWebRealm active_realm(realm_);
        ShutdownScriptCRuntime();
      }
      ResetRealm();
      return;
    }
    LOG(INFO) << "Native TypeScript counter host: started ("
              << CounterLaneName(lane_) << ")";
  }

  BlinkCounterHost(const BlinkCounterHost&) = delete;
  BlinkCounterHost& operator=(const BlinkCounterHost&) = delete;

  ~BlinkCounterHost() {
    if (!realm_) {
      return;
    }
    weak_factory_.InvalidateWeakPtrs();
    {
      ScopedCurrentWebRealm active_realm(realm_);
      if (lane_ == CounterLane::kOracleC) {
        nts_counter_stop();
      } else {
        ShutdownScriptCRuntime();
      }
    }
    started_ = false;
    ResetRealm();
    LOG(INFO) << "Native TypeScript counter host: stopped ("
              << CounterLaneName(lane_) << ")";
  }

  bool IsStarted() const { return started_; }

 private:
  static void WakeScriptCCallbacks(void* context) {
    auto* host = static_cast<BlinkCounterHost*>(context);
    if (host) {
      host->ScheduleScriptCCallbackDrain();
    }
  }

  void ScheduleScriptCCallbackDrain() {
    CHECK(task_runner_->RunsTasksInCurrentSequence());
    task_runner_->PostTask(
        FROM_HERE, base::BindOnce(&BlinkCounterHost::DrainScriptCCallback,
                                  weak_factory_.GetWeakPtr()));
  }

  void DrainScriptCCallback() {
    if (!started_ || !callbacks_configured_ || !realm_ || !realm_->IsAlive()) {
      return;
    }
    ScopedCurrentWebRealm active_realm(realm_);
    const int result =
        lane_ == CounterLane::kScriptCC
            ? nts_chromium_counter_scriptc_c_callbacks_dispatch()
            : nts_chromium_counter_scriptc_llvm_callbacks_dispatch();
    if (result == 2) {
      LOG(ERROR) << "Native TypeScript retained callback raised an exception ("
                 << CounterLaneName(lane_) << ")";
    }
  }

  void InitializeScriptCRuntime() {
    if (lane_ == CounterLane::kScriptCC) {
      nts_chromium_counter_scriptc_c_init();
    } else {
      nts_chromium_counter_scriptc_llvm_init();
    }
    scriptc_initialized_ = true;
  }

  bool ConfigureScriptCCallbacks() {
    return lane_ == CounterLane::kScriptCC
               ? nts_chromium_counter_scriptc_c_callbacks_configure(
                     &WakeScriptCCallbacks, this) != 0
               : nts_chromium_counter_scriptc_llvm_callbacks_configure(
                     &WakeScriptCCallbacks, this) != 0;
  }

  double StartScriptCProgram() {
    return lane_ == CounterLane::kScriptCC
               ? nts_chromium_counter_scriptc_c_start()
               : nts_chromium_counter_scriptc_llvm_start();
  }

  void StopScriptCProgram() {
    if (lane_ == CounterLane::kScriptCC) {
      nts_chromium_counter_scriptc_c_stop();
    } else {
      nts_chromium_counter_scriptc_llvm_stop();
    }
  }

  void ShutdownScriptCCallbacks() {
    if (lane_ == CounterLane::kScriptCC) {
      nts_chromium_counter_scriptc_c_callbacks_stop_accepting();
      (void)nts_chromium_counter_scriptc_c_callbacks_discard();
      if (!nts_chromium_counter_scriptc_c_callbacks_destroy()) {
        LOG(ERROR) << "Native TypeScript C callback service did not quiesce";
      }
    } else {
      nts_chromium_counter_scriptc_llvm_callbacks_stop_accepting();
      (void)nts_chromium_counter_scriptc_llvm_callbacks_discard();
      if (!nts_chromium_counter_scriptc_llvm_callbacks_destroy()) {
        LOG(ERROR) << "Native TypeScript LLVM callback service did not quiesce";
      }
    }
    callbacks_configured_ = false;
  }

  void CollectScriptCRuntime() {
    if (lane_ == CounterLane::kScriptCC) {
      nts_chromium_counter_scriptc_c_collect();
    } else {
      nts_chromium_counter_scriptc_llvm_collect();
    }
  }

  void ShutdownScriptCRuntime() {
    if (!scriptc_initialized_) {
      return;
    }
    if (scriptc_start_called_) {
      StopScriptCProgram();
    }
    scriptc_start_called_ = false;
    if (callbacks_configured_) {
      ShutdownScriptCCallbacks();
    }
    CollectScriptCRuntime();
    scriptc_initialized_ = false;
  }

  void ResetRealm() {
    NtsWebRealm* realm = realm_.get();
    realm_ = nullptr;
    DestroyWebRealm(realm);
  }

  raw_ptr<NtsWebRealm> realm_ = nullptr;
  CounterLane lane_ = CounterLane::kScriptCC;
  scoped_refptr<base::SequencedTaskRunner> task_runner_;
  bool started_ = false;
  bool scriptc_initialized_ = false;
  bool scriptc_start_called_ = false;
  bool callbacks_configured_ = false;
  base::WeakPtrFactory<BlinkCounterHost> weak_factory_{this};
};

BlinkCounterHost* StartCounterHost(blink::WebLocalFrame* web_frame) {
  if (!web_frame) {
    return nullptr;
  }

  /* This cast is intentionally confined to the Blink-owned adapter. The
   * content embedder passes only WebLocalFrame*, while the target owns the
   * knowledge that Chromium's local-frame implementation is WebLocalFrameImpl.
   */
  auto* web_frame_impl = static_cast<blink::WebLocalFrameImpl*>(web_frame);
  blink::LocalFrame* frame = web_frame_impl->GetFrame();
  if (!frame) {
    return nullptr;
  }

  blink::Document* document = frame->GetDocument();
  if (!document || !document->GetExecutionContext()) {
    return nullptr;
  }

  auto* host = new (std::nothrow) BlinkCounterHost(document);
  if (!host) {
    return nullptr;
  }
  if (!host->IsStarted()) {
    delete host;
    return nullptr;
  }
  return host;
}

void DestroyCounterHost(BlinkCounterHost* host) {
  delete host;
}

bool RunBenchmarkHost(blink::WebLocalFrame* web_frame) {
  if (!web_frame) {
    return false;
  }
  auto* web_frame_impl = static_cast<blink::WebLocalFrameImpl*>(web_frame);
  blink::LocalFrame* frame = web_frame_impl->GetFrame();
  if (!frame) {
    return false;
  }
  return RunDocumentCreateElementBenchmark(frame->GetDocument());
}

}  // namespace nts::blink_bridge
