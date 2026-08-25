import {
  currentDocument,
  type EventSubscription,
  type Text,
} from "@native-typescript/web-chromium";

let clickSubscription: EventSubscription | null = null;
let countLabel: Text | null = null;
let count = 0;

function updateLabel(): void {
  const label = countLabel;
  if (label !== null) label.data = `Count: ${count}`;
}

export function start(): number {
  if (clickSubscription !== null) return 0;

  const document = currentDocument();
  if (document === null) return 0;
  const body = document.body;
  if (body === null) return 0;

  const heading = document.createElement("h1");
  heading.appendChild(document.createTextNode("Native TypeScript"));

  const button = document.createElement("button");
  const label = document.createTextNode("Count: 0");
  button.appendChild(label);
  const subscription = button.listen("click", (): void => {
    count += 1;
    updateLabel();
  });

  body.appendChild(heading);
  body.appendChild(button);
  count = 0;
  countLabel = label;
  clickSubscription = subscription;
  return 1;
}

export function stop(): number {
  const subscription = clickSubscription;
  clickSubscription = null;
  countLabel = null;
  count = 0;
  if (subscription !== null) subscription.dispose();
  return 1;
}
