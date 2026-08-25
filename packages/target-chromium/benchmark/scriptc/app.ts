import { currentDocument } from "@native-typescript/web-chromium";

export function createElements(iterations: number): number {
  const document = currentDocument();
  if (document === null) return 0;
  let checksum = 0;
  for (let index = 0; index < iterations; index += 1) {
    document.createElement("div");
    checksum += 1;
  }
  return checksum;
}

export function createDetachedCounterTrees(iterations: number): number {
  const document = currentDocument();
  if (document === null) return 0;
  let checksum = 0;
  for (let index = 0; index < iterations; index += 1) {
    const button = document.createElement("button");
    const label = document.createTextNode("Count: 0");
    button.appendChild(label);
    label.data = "Count: 1";
    checksum += 1;
  }
  return checksum;
}
