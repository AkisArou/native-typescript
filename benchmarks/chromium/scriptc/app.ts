import { currentDocument, type Text } from "@native-typescript/web-chromium";

let retainedAttachedText: Text | null = null;

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

export function updateRetainedAttachedText(iterations: number): number {
  const document = currentDocument();
  if (document === null) return 0;
  let label = retainedAttachedText;
  if (label === null) {
    const body = document.body;
    if (body === null) return 0;
    const output = document.createElement("output");
    label = document.createTextNode("Count: 0");
    output.appendChild(label);
    body.appendChild(output);
    retainedAttachedText = label;
  }
  let checksum = 0;
  for (let index = 0; index < iterations; index += 1) {
    label.data = index % 2 === 0 ? "Count: 1" : "Count: 2";
    checksum += 1;
  }
  return checksum;
}

export function createEightRowComponentLists(iterations: number): number {
  const document = currentDocument();
  if (document === null) return 0;
  let checksum = 0;
  for (let index = 0; index < iterations; index += 1) {
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

export function runSelectorDrivenUpdates(iterations: number): number {
  const document = currentDocument();
  if (document === null) return 0;
  const component = document.createElement("section");
  const status = document.createElement("span");
  status.setAttribute("data-role", "status");
  status.setAttribute("data-state", "idle");
  component.appendChild(status);
  let checksum = 0;
  for (let index = 0; index < iterations; index += 1) {
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

export function runSynchronousEventRoundTrips(iterations: number): number {
  const document = currentDocument();
  if (document === null) return 0;
  const button = document.body;
  if (button === null) return 0;
  let checksum = 0;
  const subscription = button.listen("click", (): void => {
    checksum += 1;
  });
  for (let index = 0; index < iterations; index += 1) {
    button.click();
  }
  subscription.dispose();
  return checksum;
}

export function mountAttachedComponents(iterations: number): number {
  const document = currentDocument();
  if (document === null) return 0;
  const body = document.body;
  if (body === null) return 0;
  let checksum = 0;
  for (let index = 0; index < iterations; index += 1) {
    const card = document.createElement("article");
    card.setAttribute("class", "benchmark-card");
    const title = document.createElement("h2");
    title.appendChild(document.createTextNode("Result"));
    const value = document.createElement("output");
    value.appendChild(document.createTextNode("Count: 1"));
    card.appendChild(title);
    card.appendChild(value);
    body.appendChild(card);
    body.removeChild(card);
    checksum += 1;
  }
  return checksum;
}
