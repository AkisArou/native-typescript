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

function measurePrimitive() {
  const samples = [];
  let checksum = 0;
  for (let index = 0; index < warmupIterations; index += 1) {
    checksum += createElements(1);
  }
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const start = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      checksum += createElements(1);
    }
    samples.push((performance.now() - start) * 1_000_000 / iterations);
  }
  return { checksum, samples };
}

function measureBoundaryHeavy() {
  const samples = [];
  let checksum = createElements(warmupIterations);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const start = performance.now();
    checksum += createElements(iterations);
    samples.push((performance.now() - start) * 1_000_000 / iterations);
  }
  return { checksum, samples };
}

const primitive = measurePrimitive();
const boundaryHeavy = measureBoundaryHeavy();
document.body.setAttribute("data-nts-benchmark-result", JSON.stringify({
  lane: "v8",
  iterations,
  sampleCount,
  warmupIterations,
  checksum: primitive.checksum + boundaryHeavy.checksum,
  primitive: primitive.samples,
  boundaryHeavy: boundaryHeavy.samples,
}));
document.body.setAttribute("data-nts-benchmark-ready", "true");
