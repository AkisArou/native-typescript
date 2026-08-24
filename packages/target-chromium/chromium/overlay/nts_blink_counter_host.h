#ifndef NTS_BLINK_COUNTER_HOST_H
#define NTS_BLINK_COUNTER_HOST_H

namespace blink {
class WebLocalFrame;
}

namespace nts::blink_bridge {

class BlinkCounterHost;

/* Harness-only seam. content_shell passes a public WebLocalFrame; all knowledge
 * of WebLocalFrameImpl, LocalFrame, Document and NtsWebRealm stays inside the
 * Blink-owned target. */
BlinkCounterHost* StartCounterHost(blink::WebLocalFrame* web_frame);
void DestroyCounterHost(BlinkCounterHost* host);

/* Runs the selected handwritten-C++ or compiled-TypeScript benchmark lane and
 * publishes its raw samples as a body attribute. Ordinary JavaScript owns the
 * V8 lane; this function deliberately refuses that lane. */
bool RunBenchmarkHost(blink::WebLocalFrame* web_frame);

}  // namespace nts::blink_bridge

#endif
