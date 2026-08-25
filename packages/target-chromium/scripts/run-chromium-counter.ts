#!/usr/bin/env node

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot, reportError } from "./support.ts";

interface Options {
  readonly checkout: string;
  readonly output: string;
  readonly exceptionPath: "stock" | "product";
  readonly lane: "oracle-c" | "scriptc-c" | "scriptc-llvm";
}

interface CdpError {
  readonly code: number;
  readonly message: string;
}

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: CdpError;
  readonly sessionId?: string;
}

interface PendingCommand {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface EventWaiter {
  readonly method: string;
  readonly sessionId: string | undefined;
  readonly resolve: (params: unknown) => void;
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

interface TargetInfo {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
}

const startedMarker = "Native TypeScript counter host: started";
const stoppedMarker = "Native TypeScript counter host: stopped";
const exceptionMarker = "Native TypeScript DOMException probe: passed";
const securityCaptureMarker =
  "Native TypeScript security-message capture: passed";
const operationTimeoutMilliseconds = 30_000;

function usage(): string {
  return [
    "Usage: node scripts/run-chromium-counter.ts /path/to/chromium/src",
    "  [--out out/nts-counter] [--exception-path stock|product]",
    "  [--lane oracle-c|scriptc-c|scriptc-llvm]",
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

  let output = "out/nts-counter";
  let exceptionPath: "stock" | "product" = "product";
  let lane: "oracle-c" | "scriptc-c" | "scriptc-llvm" = "scriptc-c";
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (
      argument !== "--out" && argument !== "--exception-path" &&
      argument !== "--lane"
    ) {
      throw new Error(`Unknown argument: ${argument}\n${usage()}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    if (argument === "--out") output = value;
    else if (argument === "--exception-path" &&
      (value === "stock" || value === "product")) exceptionPath = value;
    else if (argument === "--lane" &&
      (value === "oracle-c" || value === "scriptc-c" || value === "scriptc-llvm")) {
      lane = value;
    } else {
      throw new Error(
        argument === "--exception-path"
          ? "--exception-path must be stock or product"
          : "--lane must be oracle-c, scriptc-c, or scriptc-llvm",
      );
    }
    index += 1;
  }
  return Object.freeze({
    checkout: resolve(checkoutArgument),
    output,
    exceptionPath,
    lane,
  });
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

class CdpClient {
  readonly #socket: CdpWebSocket;
  readonly #pending = new Map<number, PendingCommand>();
  readonly #eventWaiters = new Set<EventWaiter>();
  #nextId = 1;

  private constructor(socket: CdpWebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      this.#handleMessage(JSON.parse(messageText(event.data)) as CdpMessage);
    });
  }

  static async connect(url: string): Promise<CdpClient> {
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
      "the DevTools WebSocket",
    );
    return new CdpClient(socket);
  }

  send<T>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    sessionId?: string,
  ): Promise<T> {
    const id = this.#nextId;
    this.#nextId += 1;
    const response = new Promise<T>((resolvePromise, rejectPromise) => {
      this.#pending.set(id, {
        resolve: (result) => resolvePromise(result as T),
        reject: rejectPromise,
      });
    });
    this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    return withTimeout(response, method);
  }

  waitForEvent<T>(method: string, sessionId?: string): Promise<T> {
    const event = new Promise<T>((resolvePromise) => {
      this.#eventWaiters.add({
        method,
        sessionId,
        resolve: (params) => resolvePromise(params as T),
      });
    });
    return withTimeout(event, method);
  }

  close(): void {
    this.#socket.close();
  }

  #handleMessage(message: CdpMessage): void {
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `CDP ${message.error.code}: ${message.error.message}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (!message.method) return;
    for (const waiter of this.#eventWaiters) {
      if (
        waiter.method === message.method &&
        waiter.sessionId === message.sessionId
      ) {
        this.#eventWaiters.delete(waiter);
        waiter.resolve(message.params);
      }
    }
  }
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
    "content_shell DevTools endpoint",
  );
}

async function waitForPageTarget(client: CdpClient): Promise<TargetInfo> {
  const deadline = Date.now() + operationTimeoutMilliseconds;
  while (Date.now() < deadline) {
    const result = await client.send<{ readonly targetInfos: TargetInfo[] }>(
      "Target.getTargets",
    );
    const page = result.targetInfos.find((target) => target.type === "page");
    if (page) return page;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Timed out waiting for the counter page target");
}

async function querySelector(
  client: CdpClient,
  sessionId: string,
  selector: string,
): Promise<number | undefined> {
  const document = await client.send<{ readonly root: { readonly nodeId: number } }>(
    "DOM.getDocument",
    { depth: 1 },
    sessionId,
  );
  const result = await client.send<{ readonly nodeId: number }>(
    "DOM.querySelector",
    { nodeId: document.root.nodeId, selector },
    sessionId,
  );
  return result.nodeId === 0 ? undefined : result.nodeId;
}

async function outerHtml(
  client: CdpClient,
  sessionId: string,
  nodeId: number,
): Promise<string> {
  const result = await client.send<{ readonly outerHTML: string }>(
    "DOM.getOuterHTML",
    { nodeId },
    sessionId,
  );
  return result.outerHTML;
}

async function waitForDomText(
  client: CdpClient,
  sessionId: string,
  selector: string,
  expected: string,
): Promise<number> {
  const deadline = Date.now() + operationTimeoutMilliseconds;
  while (Date.now() < deadline) {
    const nodeId = await querySelector(client, sessionId, selector);
    if (
      nodeId !== undefined &&
      (await outerHtml(client, sessionId, nodeId)).includes(expected)
    ) {
      return nodeId;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Timed out waiting for ${selector} to contain ${expected}`);
}

async function clickNode(
  client: CdpClient,
  sessionId: string,
  nodeId: number,
): Promise<void> {
  const result = await client.send<{
    readonly model: { readonly content: readonly number[] };
  }>("DOM.getBoxModel", { nodeId }, sessionId);
  const points = result.model.content;
  if (points.length !== 8) throw new Error("Unexpected DOM box model");
  const x = (points[0]! + points[2]! + points[4]! + points[6]!) / 4;
  const y = (points[1]! + points[3]! + points[5]! + points[7]!) / 4;
  const common = { x, y, button: "left", clickCount: 1 };
  await client.send(
    "Input.dispatchMouseEvent",
    { ...common, type: "mousePressed" },
    sessionId,
  );
  await client.send(
    "Input.dispatchMouseEvent",
    { ...common, type: "mouseReleased" },
    sessionId,
  );
}

async function waitForOutput(
  readOutput: () => string,
  marker: string,
): Promise<void> {
  const deadline = Date.now() + operationTimeoutMilliseconds;
  while (Date.now() < deadline) {
    if (readOutput().includes(marker)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Timed out waiting for renderer evidence: ${marker}`);
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return withTimeout(
    new Promise<void>((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("exit", (code, signal) => {
        if (code === 0 || signal === "SIGTERM") resolvePromise();
        else rejectPromise(new Error(`content_shell exited with code ${code}`));
      });
    }),
    "content_shell to exit",
  );
}

async function main(arguments_: readonly string[]): Promise<void> {
  const options = parseOptions(arguments_);
  if (options === null) return;

  const htmlPath = resolve(
    packageRoot,
    "prototype/examples/counter/index.html",
  );
  const html = readFileSync(htmlPath, "utf8");
  if (/<script\b|javascript:/iu.test(html)) {
    throw new Error("Counter acceptance page must remain script-free");
  }
  const counterUrl = pathToFileURL(htmlPath).href;

  const executableName =
    process.platform === "win32" ? "content_shell.exe" : "content_shell";
  const executable = resolve(options.checkout, options.output, executableName);
  if (!existsSync(executable)) {
    throw new Error(`content_shell binary does not exist: ${executable}`);
  }

  const profile = mkdtempSync(join(tmpdir(), "nts-chromium-profile-"));
  const browserArguments = [
    `--native-typescript-counter=${options.lane}`,
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--enable-logging=stderr",
    "--disable-gpu",
    "--no-first-run",
    counterUrl,
  ];
  const useXvfb = process.platform === "linux" && !process.env.DISPLAY;
  const command = useXvfb ? "xvfb-run" : executable;
  const commandArguments = useXvfb
    ? ["-a", executable, ...browserArguments]
    : browserArguments;
  const child = spawn(command, commandArguments, { stdio: "pipe" });
  let output = "";
  let client: CdpClient | undefined;

  try {
    const endpoint = await waitForDevTools(child, (text) => {
      output += text;
      process.stdout.write(text);
    });
    client = await CdpClient.connect(endpoint);
    const target = await waitForPageTarget(client);
    const attached = await client.send<{ readonly sessionId: string }>(
      "Target.attachToTarget",
      { targetId: target.targetId, flatten: true },
    );
    const sessionId = attached.sessionId;
    await client.send("DOM.enable", {}, sessionId);
    await client.send("Page.enable", {}, sessionId);

    if (options.exceptionPath === "product") {
      await waitForOutput(() => output, securityCaptureMarker);
    }
    await waitForOutput(() => output, exceptionMarker);
    await waitForOutput(() => output, startedMarker);
    const button = await waitForDomText(
      client,
      sessionId,
      "button",
      "Count: 0",
    );
    await clickNode(client, sessionId, button);
    await waitForDomText(client, sessionId, "button", "Count: 1");

    await client.send(
      "Page.navigate",
      { url: `${counterUrl}?teardown` },
      sessionId,
    );
    await waitForOutput(() => output, stoppedMarker);

    process.stdout.write(
      [
        "",
        "Chromium direct-Blink acceptance passed:",
        `  lane: ${options.lane}`,
        "  script-free DOM: Count: 0",
        "  native click: Count: 1",
        "  DOMException conversion: observed",
        options.exceptionPath === "product"
          ? "  sanitized/privileged SecurityError messages: observed"
          : "  stock DummyExceptionStateForTesting path: observed",
        "  navigation teardown: observed",
        "",
      ].join("\n"),
    );

    const exited = waitForExit(child);
    const closed = await client.send<{ readonly success: boolean }>(
      "Target.closeTarget",
      { targetId: target.targetId },
    );
    if (!closed.success) throw new Error("Could not close the counter target");
    await exited;
  } finally {
    client?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = waitForExit(child);
      child.kill("SIGTERM");
      await exited.catch(() => undefined);
    }
    rmSync(profile, { recursive: true, force: true });
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  reportError(error);
}
