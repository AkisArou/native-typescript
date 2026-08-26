"use strict";

const hostedBody = document.body;
const hostedOrderAttribute = "data-nts-hosted-order";

function appendHostedMarker(marker) {
  hostedBody.setAttribute(
    hostedOrderAttribute,
    `${hostedBody.getAttribute(hostedOrderAttribute) ?? ""}${marker}`,
  );
}

/* This job predates both native continuations. The event handler is invoked
 * synchronously by native continuation A, but its own job is queued after
 * native continuation B. A single FIFO Blink/V8 queue must therefore yield
 * JAEBj; an inline resume or a separately batch-drained ScriptC queue cannot. */
queueMicrotask(() => appendHostedMarker("J"));
hostedBody.addEventListener("nts-scriptc-hosted-turn", () => {
  appendHostedMarker("E");
  queueMicrotask(() => appendHostedMarker("j"));
});
