"use strict";

let retainedAttachedText = null;

function createElements(count) {
  let checksum = 0;
  for (let index = 0; index < count; index += 1) {
    document.createElement("div");
    checksum += 1;
  }
  return checksum;
}

function createDetachedCounterTrees(count) {
  let checksum = 0;
  for (let index = 0; index < count; index += 1) {
    const button = document.createElement("button");
    const label = document.createTextNode("Count: 0");
    button.appendChild(label);
    label.data = "Count: 1";
    checksum += 1;
  }
  return checksum;
}

function updateRetainedAttachedText(count) {
  if (retainedAttachedText === null) {
    const output = document.createElement("output");
    retainedAttachedText = document.createTextNode("Count: 0");
    output.appendChild(retainedAttachedText);
    document.body.appendChild(output);
  }
  let checksum = 0;
  for (let index = 0; index < count; index += 1) {
    retainedAttachedText.data = index % 2 === 0 ? "Count: 1" : "Count: 2";
    checksum += 1;
  }
  return checksum;
}

function createEightRowComponentLists(count) {
  let checksum = 0;
  for (let index = 0; index < count; index += 1) {
    const list = document.createElement("ul");
    list.setAttribute("class", "results");
    for (let rowIndex = 0; rowIndex < 8; rowIndex += 1) {
      const row = document.createElement("li");
      row.setAttribute("class", "result-row");
      row.setAttribute("data-state", rowIndex % 2 === 0 ? "active" : "idle");
      const label = document.createElement("span");
      label.appendChild(document.createTextNode("Native TypeScript result"));
      row.appendChild(label);
      list.appendChild(row);
    }
    checksum += 1;
  }
  return checksum;
}

function runSelectorDrivenUpdates(count) {
  const component = document.createElement("section");
  const status = document.createElement("span");
  status.setAttribute("data-role", "status");
  status.setAttribute("data-state", "idle");
  component.appendChild(status);
  let checksum = 0;
  for (let index = 0; index < count; index += 1) {
    const selected = component.querySelector("[data-role=status]");
    if (selected !== null) {
      selected.setAttribute(
        "data-state",
        index % 2 === 0 ? "active" : "idle",
      );
      checksum += 1;
    }
  }
  return checksum;
}

function runSynchronousEventRoundTrips(count) {
  const button = document.body;
  let checksum = 0;
  const listener = () => {
    checksum += 1;
  };
  button.addEventListener("click", listener);
  for (let index = 0; index < count; index += 1) {
    button.click();
  }
  button.removeEventListener("click", listener);
  return checksum;
}

function mountAttachedComponents(count) {
  let checksum = 0;
  for (let index = 0; index < count; index += 1) {
    const card = document.createElement("article");
    card.setAttribute("class", "benchmark-card");
    const title = document.createElement("h2");
    title.appendChild(document.createTextNode("Result"));
    const value = document.createElement("output");
    value.appendChild(document.createTextNode("Count: 1"));
    card.appendChild(title);
    card.appendChild(value);
    document.body.appendChild(card);
    document.body.removeChild(card);
    checksum += 1;
  }
  return checksum;
}

const functions = Object.freeze({
  createElements,
  createDetachedCounterTrees,
  updateRetainedAttachedText,
  createEightRowComponentLists,
  runSelectorDrivenUpdates,
  runSynchronousEventRoundTrips,
  mountAttachedComponents,
});

function measure(function_, iterations, warmupIterations) {
  const perCall = [];
  let checksum = 0;
  for (let index = 0; index < warmupIterations; index += 1) {
    checksum += function_(1);
  }
  for (let sample = 0; sample < ntsBenchmarkContract.sampleCount; sample += 1) {
    const start = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      checksum += function_(1);
    }
    perCall.push((performance.now() - start) * 1_000_000 / iterations);
  }

  const compiledLoop = [];
  checksum += function_(warmupIterations);
  for (let sample = 0; sample < ntsBenchmarkContract.sampleCount; sample += 1) {
    const start = performance.now();
    checksum += function_(iterations);
    compiledLoop.push((performance.now() - start) * 1_000_000 / iterations);
  }
  return { checksum, perCall, compiledLoop };
}

const selectedWorkload = decodeURIComponent(location.hash.slice(1));
const selectedDefinitions = ntsBenchmarkContract.workloads.filter(
  (definition) => definition.id === selectedWorkload,
);
if (selectedDefinitions.length !== 1) {
  throw new Error(`Unknown V8 benchmark workload: ${selectedWorkload}`);
}

const workloads = selectedDefinitions.map((definition) => {
  const function_ = functions[definition.function];
  if (typeof function_ !== "function") {
    throw new Error(`Missing V8 benchmark function: ${definition.function}`);
  }
  return {
    id: definition.id,
    iterations: definition.iterations,
    warmupIterations: definition.warmupIterations,
    interop: null,
    ...measure(
      function_,
      definition.iterations,
      definition.warmupIterations,
    ),
  };
});

document.body.setAttribute("data-nts-benchmark-result", JSON.stringify({
  lane: "v8",
  sampleCount: ntsBenchmarkContract.sampleCount,
  workloads,
}));
document.body.setAttribute("data-nts-benchmark-ready", "true");
