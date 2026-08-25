"use strict";

const iterations = 100_000;
const sampleCount = 30;
const warmupIterations = 20_000;

function createElements(count) {
  let checksum = 0;
  for (let index = 0; index < count; index += 1) {
    checksum += document.createElement("div") !== null ? 1 : 0;
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

function measurePerCall(function_) {
  const samples = [];
  let checksum = 0;
  for (let index = 0; index < warmupIterations; index += 1) {
    checksum += function_(1);
  }
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const start = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      checksum += function_(1);
    }
    samples.push((performance.now() - start) * 1_000_000 / iterations);
  }
  return { checksum, samples };
}

function measureCompiledLoop(function_) {
  const samples = [];
  let checksum = function_(warmupIterations);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const start = performance.now();
    checksum += function_(iterations);
    samples.push((performance.now() - start) * 1_000_000 / iterations);
  }
  return { checksum, samples };
}

const createElementPerCall = measurePerCall(createElements);
const createElementCompiledLoop = measureCompiledLoop(createElements);
const detachedCounterTreePerCall = measurePerCall(createDetachedCounterTrees);
const detachedCounterTreeCompiledLoop = measureCompiledLoop(
  createDetachedCounterTrees,
);
document.body.setAttribute("data-nts-benchmark-result", JSON.stringify({
  lane: "v8",
  iterations,
  sampleCount,
  warmupIterations,
  checksum:
    createElementPerCall.checksum +
    createElementCompiledLoop.checksum +
    detachedCounterTreePerCall.checksum +
    detachedCounterTreeCompiledLoop.checksum,
  createElementPerCall: createElementPerCall.samples,
  createElementCompiledLoop: createElementCompiledLoop.samples,
  detachedCounterTreePerCall: detachedCounterTreePerCall.samples,
  detachedCounterTreeCompiledLoop: detachedCounterTreeCompiledLoop.samples,
}));
document.body.setAttribute("data-nts-benchmark-ready", "true");
