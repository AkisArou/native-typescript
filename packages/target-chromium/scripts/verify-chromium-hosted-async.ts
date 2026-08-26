#!/usr/bin/env node

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot, reportError } from "./support.ts";

type Lane = "scriptc-c" | "scriptc-llvm";
type Gate = "hosted-async" | "frame-callback";

interface Options {
  readonly checkout: string;
  readonly output: string;
}

interface PageTarget {
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

interface GateResult {
  readonly order: string | null;
  readonly ready: string | null;
  readonly result: string | null;
  readonly checksum: string | null;
  readonly subscriptions: string | null;
}

interface CdpWebSocket {
  addEventListener(
    type: string,
    listener: (event: { readonly data?: unknown }) => void,
    options?: { readonly once?: boolean },
  ): void;
  send(data: string): void;
  close(): void;
}

interface CdpWebSocketConstructor {
  new (url: string): CdpWebSocket;
}

const operationTimeoutMilliseconds = 30_000;
const expectedOrder = "JAEBj";
const expectedFrameCallbackChecksum = String(64 * 3);

function usage(): string {
  return [
    "Usage: node scripts/verify-chromium-hosted-async.ts /path/to/chromium/src",
    "  [--out out/nts-benchmark]",
    "",
    "Runs hosted-async and frame-callback correctness gates for C and LLVM; it does not time a benchmark.",
  ].join("\n");
}

function parseOptions(arguments_: readonly string[]): Options | null {
  if (arguments_.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const checkoutArgument = arguments_[0];
  if (checkoutArgument === undefined || checkoutArgument.startsWith("-")) {
    throw new Error(usage());
  }
  let output = "out/nts-benchmark";
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== "--out") {
      throw new Error(`Unknown argument: ${argument}\n${usage()}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error("--out requires a value");
    output = value;
    index += 1;
  }
  return Object.freeze({ checkout: resolve(checkoutArgument), output });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      rejectPromise(new Error(`Timed out waiting for ${label}`));
    }, operationTimeoutMilliseconds);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        rejectPromise(error);
      },
    );
  });
}

function messageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  throw new Error("DevTools sent an unsupported WebSocket message payload");
}

async function connectPage(url: string): Promise<CdpWebSocket> {
  const WebSocketConstructor = Reflect.get(
    globalThis,
    "WebSocket",
  ) as CdpWebSocketConstructor | undefined;
  if (!WebSocketConstructor) {
    throw new Error("This Node.js build does not expose WebSocket");
  }
  const socket = new WebSocketConstructor(url);
  await withTimeout(
    new Promise<void>((resolvePromise, rejectPromise) => {
      socket.addEventListener("open", () => resolvePromise(), { once: true });
      socket.addEventListener(
        "error",
        () => rejectPromise(new Error("Could not connect to DevTools")),
        { once: true },
      );
    }),
    "the page DevTools WebSocket",
  );
  return socket;
}

let nextCdpId = 1;

function evaluate(socket: CdpWebSocket, expression: string): Promise<unknown> {
  const id = nextCdpId;
  nextCdpId += 1;
  const response = new Promise<unknown>((resolvePromise, rejectPromise) => {
    const accept = (event: { readonly data?: unknown }): void => {
      try {
        const message = JSON.parse(messageText(event.data)) as {
          readonly id?: number;
          readonly result?: {
            readonly result?: { readonly value?: unknown };
          };
          readonly error?: { readonly code: number; readonly message: string };
        };
        if (message.id !== id) return;
        if (message.error) {
          rejectPromise(
            new Error(
              `CDP ${message.error.code}: ${message.error.message}`,
            ),
          );
          return;
        }
        resolvePromise(message.result?.result?.value);
      } catch (error) {
        rejectPromise(error);
      }
    };
    socket.addEventListener("message", accept);
    socket.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true },
    }));
  });
  return withTimeout(response, "Runtime.evaluate");
}

function waitForDevTools(
  child: ChildProcessWithoutNullStreams,
  appendOutput: (text: string) => void,
): Promise<string> {
  return withTimeout(
    new Promise<string>((resolvePromise, rejectPromise) => {
      let output = "";
      const accept = (chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        output += text;
        appendOutput(text);
        const match = /DevTools listening on (ws:\/\/\S+)/u.exec(output);
        if (match?.[1]) resolvePromise(match[1]);
      };
      child.stdout.on("data", accept);
      child.stderr.on("data", accept);
      child.once("error", rejectPromise);
      child.once("exit", (code) => {
        rejectPromise(
          new Error(`content_shell exited before DevTools started (${code})`),
        );
      });
    }),
    "the content_shell DevTools endpoint",
  );
}

async function waitForPage(port: string, pageUrl: string): Promise<PageTarget> {
  const deadline = Date.now() + operationTimeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json() as PageTarget[];
        const page = targets.find((target) =>
          target.type === "page" && target.url === pageUrl
        );
        if (page) return page;
      }
    } catch {
      // The endpoint may be announced a moment before its HTTP listener wins.
    }
    await delay(25);
  }
  throw new Error("Timed out waiting for the hosted-async page target");
}

async function waitForGate(
  socket: CdpWebSocket,
  gate: Gate,
): Promise<GateResult> {
  const deadline = Date.now() + operationTimeoutMilliseconds;
  const prefix = gate === "hosted-async" ? "hosted" : "frame-callback";
  const expression = [
    "document.body === null ? '' : JSON.stringify({",
    "order: document.body.getAttribute('data-nts-hosted-order'),",
    `ready: document.body.getAttribute('data-nts-${prefix}-ready'),`,
    `result: document.body.getAttribute('data-nts-${prefix}-result'),`,
    "checksum: document.body.getAttribute('data-nts-frame-callback-checksum'),",
    "subscriptions: document.body.getAttribute('data-nts-frame-callback-subscriptions')",
    "})",
  ].join("");
  while (Date.now() < deadline) {
    const serialized = await evaluate(socket, expression);
    if (typeof serialized !== "string" || serialized.length === 0) {
      await delay(25);
      continue;
    }
    const result = JSON.parse(serialized) as GateResult;
    if (result.ready === "true") return result;
    await delay(25);
  }
  throw new Error(`Timed out waiting for the ${gate} result marker`);
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return withTimeout(
    new Promise<void>((resolvePromise) => {
      child.once("exit", () => resolvePromise());
    }),
    "content_shell to exit",
  );
}

async function runLane(
  executable: string,
  pagesRoot: string,
  lane: Lane,
  gate: Gate,
): Promise<GateResult> {
  const profile = mkdtempSync(join(tmpdir(), `nts-${gate}-${lane}-`));
  const page = lane === "scriptc-c"
    ? "hosted-async-c.html"
    : "hosted-async-llvm.html";
  const fragment = gate === "hosted-async"
    ? "hosted-microtask-ordering"
    : "frame-callback-correctness";
  const pageUrl = `${pathToFileURL(resolve(pagesRoot, page)).href}#${fragment}`;
  const browserArguments = [
    "--native-typescript-benchmark",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--disable-gpu",
    "--no-first-run",
    pageUrl,
  ];
  const useXvfb = process.platform === "linux" && !process.env.DISPLAY;
  const child = spawn(
    useXvfb ? "xvfb-run" : executable,
    useXvfb ? ["-a", executable, ...browserArguments] : browserArguments,
    { stdio: "pipe" },
  );
  let outputTail = "";
  let socket: CdpWebSocket | undefined;
  try {
    const endpoint = await waitForDevTools(child, (text) => {
      outputTail = `${outputTail}${text}`.slice(-12_000);
    });
    const port = new URL(endpoint).port;
    const target = await waitForPage(port, pageUrl);
    socket = await connectPage(target.webSocketDebuggerUrl);
    const result = await waitForGate(socket, gate);
    const passed = gate === "hosted-async"
      ? result.order === expectedOrder && result.result === "pass"
      : result.result === "pass" &&
        result.checksum === expectedFrameCallbackChecksum &&
        result.subscriptions === "0";
    if (!passed) {
      throw new Error(
        `${lane} ${gate} gate failed: ${JSON.stringify(result)}`,
      );
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const output = outputTail.trim();
    throw new Error(output.length === 0
      ? message
      : `${message}\ncontent_shell output tail:\n${output}`);
  } finally {
    socket?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = waitForExit(child);
      child.kill("SIGTERM");
      await exited.catch(() => undefined);
    }
    rmSync(profile, { recursive: true, force: true });
  }
}

async function main(arguments_: readonly string[]): Promise<void> {
  const options = parseOptions(arguments_);
  if (options === null) return;
  const executable = resolve(
    options.checkout,
    options.output,
    process.platform === "win32" ? "content_shell.exe" : "content_shell",
  );
  if (!existsSync(executable)) {
    throw new Error(`content_shell binary does not exist: ${executable}`);
  }
  const pagesRoot = resolve(packageRoot, "../../benchmarks/chromium/pages");
  for (const page of ["hosted-async-c.html", "hosted-async-llvm.html"]) {
    if (!existsSync(resolve(pagesRoot, page))) {
      throw new Error(`Hosted-async gate page does not exist: ${page}`);
    }
  }

  const results: {
    readonly lane: Lane;
    readonly hosted: GateResult;
    readonly frame: GateResult;
  }[] = [];
  for (const lane of ["scriptc-c", "scriptc-llvm"] as const) {
    results.push({
      lane,
      hosted: await runLane(executable, pagesRoot, lane, "hosted-async"),
      frame: await runLane(executable, pagesRoot, lane, "frame-callback"),
    });
  }
  process.stdout.write([
    "Chromium renderer correctness gates passed (no benchmark was run):",
    ...results.map(({ lane, hosted, frame }) =>
      `  ${lane}: async ${hosted.order} + teardown cancellation; ` +
      `frame callback ${frame.checksum}, retained subscriptions ${frame.subscriptions}`),
    "",
  ].join("\n"));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  reportError(error);
}
