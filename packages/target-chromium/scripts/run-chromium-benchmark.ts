#!/usr/bin/env node

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  defineChromiumPerformanceInput,
  type ChromiumBenchmarkLane,
  type ChromiumBenchmarkObservation,
} from "../src/performance.ts";
import { commandOutput, packageRoot, reportError, runCommand } from "./support.ts";

interface Options {
  readonly checkout: string;
  readonly outputDirectory: string;
  readonly result: string;
}

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
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
}

interface LaneResult {
  readonly lane: ChromiumBenchmarkLane;
  readonly iterations: number;
  readonly sampleCount: number;
  readonly warmupIterations: number;
  readonly checksum: number;
  readonly primitive: readonly number[];
  readonly boundaryHeavy: readonly number[];
}

const lanes = Object.freeze([
  "cpp",
  "scriptc-c",
  "scriptc-llvm",
  "v8",
] as const);
const benchmarkIterations = 100_000;
const benchmarkSampleCount = 30;
const benchmarkWarmupIterations = 20_000;
const benchmarkChecksum =
  2 * benchmarkWarmupIterations +
  2 * benchmarkSampleCount * benchmarkIterations;
const operationTimeoutMilliseconds = 60_000;

function usage(): string {
  return [
    "Usage: node scripts/run-chromium-benchmark.ts /path/to/chromium/src",
    "  --output chromium-benchmark-input.json [--out out/nts-benchmark]",
    "",
    "This command executes timed benchmark workloads.",
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
  let outputDirectory = "out/nts-benchmark";
  let result: string | undefined;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument !== "--out" && argument !== "--output") {
      throw new Error(`Unknown argument: ${argument}\n${usage()}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    if (argument === "--out") outputDirectory = value;
    else result = resolve(value);
    index += 1;
  }
  if (result === undefined) throw new Error(`--output is required\n${usage()}`);
  return Object.freeze({
    checkout: resolve(checkoutArgument),
    outputDirectory,
    result,
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
    await withTimeout(new Promise<void>((resolvePromise, rejectPromise) => {
      socket.addEventListener("open", () => resolvePromise(), { once: true });
      socket.addEventListener(
        "error",
        () => rejectPromise(new Error("Could not connect to DevTools")),
        { once: true },
      );
    }), "the DevTools WebSocket");
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
        pending.reject(new Error(
          `CDP ${message.error.code}: ${message.error.message}`,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!message.method) return;
    for (const waiter of this.#eventWaiters) {
      if (waiter.method === message.method && waiter.sessionId === message.sessionId) {
        this.#eventWaiters.delete(waiter);
        waiter.resolve(message.params);
      }
    }
  }
}

function waitForDevTools(child: ChildProcessWithoutNullStreams): Promise<string> {
  return withTimeout(new Promise<string>((resolvePromise, rejectPromise) => {
    let output = "";
    function accept(chunk: Buffer): void {
      output += chunk.toString("utf8");
      const match = /DevTools listening on (ws:\/\/\S+)/u.exec(output);
      if (match?.[1]) resolvePromise(match[1]);
    }
    child.stdout.on("data", accept);
    child.stderr.on("data", accept);
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      rejectPromise(new Error(
        `content_shell exited before DevTools started (${code})`,
      ));
    });
  }), "content_shell DevTools endpoint");
}

async function waitForPageTarget(client: CdpClient): Promise<TargetInfo> {
  const deadline = Date.now() + operationTimeoutMilliseconds;
  while (Date.now() < deadline) {
    const result = await client.send<{ readonly targetInfos: TargetInfo[] }>(
      "Target.getTargets",
    );
    const page = result.targetInfos.find((target) => target.type === "page");
    if (page) return page;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("Timed out waiting for the benchmark page target");
}

async function bodyAttributes(
  client: CdpClient,
  sessionId: string,
): Promise<ReadonlyMap<string, string>> {
  const document = await client.send<{
    readonly root: { readonly nodeId: number };
  }>("DOM.getDocument", { depth: 1 }, sessionId);
  const body = await client.send<{ readonly nodeId: number }>(
    "DOM.querySelector",
    { nodeId: document.root.nodeId, selector: "body" },
    sessionId,
  );
  if (body.nodeId === 0) return new Map();
  const result = await client.send<{ readonly attributes: readonly string[] }>(
    "DOM.getAttributes",
    { nodeId: body.nodeId },
    sessionId,
  );
  const attributes = new Map<string, string>();
  for (let index = 0; index < result.attributes.length; index += 2) {
    attributes.set(result.attributes[index]!, result.attributes[index + 1]!);
  }
  return attributes;
}

function isTransientDomReadFailure(error: unknown): boolean {
  return error instanceof Error &&
    /(?:Could not find|No) node with given id|Document is not available/u.test(
      error.message,
    );
}

function parseLaneResult(value: string, expectedLane: ChromiumBenchmarkLane): LaneResult {
  const parsed = JSON.parse(value) as Partial<LaneResult>;
  if (
    parsed.lane !== expectedLane ||
    parsed.iterations !== benchmarkIterations ||
    parsed.sampleCount !== benchmarkSampleCount ||
    parsed.warmupIterations !== benchmarkWarmupIterations ||
    parsed.checksum !== benchmarkChecksum ||
    !Array.isArray(parsed.primitive) ||
    !Array.isArray(parsed.boundaryHeavy) ||
    parsed.primitive.length !== benchmarkSampleCount ||
    parsed.boundaryHeavy.length !== benchmarkSampleCount ||
    [...parsed.primitive, ...parsed.boundaryHeavy].some(
      (sample) => typeof sample !== "number" || !Number.isFinite(sample) || sample <= 0,
    )
  ) {
    throw new Error(`Invalid or mismatched benchmark result for ${expectedLane}`);
  }
  return parsed as LaneResult;
}

async function waitForLaneResult(
  client: CdpClient,
  sessionId: string,
  lane: ChromiumBenchmarkLane,
): Promise<LaneResult> {
  const deadline = Date.now() + operationTimeoutMilliseconds;
  while (Date.now() < deadline) {
    let attributes: ReadonlyMap<string, string>;
    try {
      attributes = await bodyAttributes(client, sessionId);
    } catch (error) {
      if (!isTransientDomReadFailure(error)) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      continue;
    }
    if (attributes.get("data-nts-benchmark-lane") !== lane) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      continue;
    }
    if (attributes.get("data-nts-benchmark-ready") === "true") {
      const result = attributes.get("data-nts-benchmark-result");
      if (result === undefined) throw new Error(`${lane} published no result`);
      return parseLaneResult(result, lane);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for the ${lane} benchmark lane`);
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return withTimeout(new Promise<void>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGTERM") resolvePromise();
      else rejectPromise(new Error(`content_shell exited with code ${code}`));
    });
  }), "content_shell to exit");
}

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function fixtureDigest(): string {
  const files = [
    "chromium/overlay/generated/nts_webidl_capsules.cc",
    "chromium/overlay/nts_blink_benchmark_host.cc",
    "benchmark/pages/cpp.html",
    "benchmark/pages/scriptc-c.html",
    "benchmark/pages/scriptc-llvm.html",
    "benchmark/pages/v8.html",
    "benchmark/pages/v8.js",
  ];
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(resolve(packageRoot, file)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function capsuleStructure(): {
  readonly genericDispatch: boolean;
  readonly v8Values: boolean;
  readonly avoidableBoxing: boolean;
  readonly perCallHeapAllocation: boolean;
} {
  const source = readFileSync(resolve(
    packageRoot,
    "chromium/overlay/generated/nts_webidl_capsules.cc",
  ), "utf8");
  return Object.freeze({
    genericDispatch: /\bgeneric\b/iu.test(source),
    v8Values: /\bv8::/u.test(source),
    avoidableBoxing: /\bbox(?:ed|ing)?\b/iu.test(source),
    perCallHeapAllocation:
      /\b(?:calloc|malloc|realloc)\s*\(|\bnew\s/iu.test(source),
  });
}

function observations(results: readonly LaneResult[]): readonly ChromiumBenchmarkObservation[] {
  return Object.freeze(results.flatMap((result) => [
    Object.freeze({
      workload: "document-create-element-primitive",
      category: "primitive" as const,
      lane: result.lane,
      samplesNanoseconds: Object.freeze([...result.primitive]),
    }),
    Object.freeze({
      workload: "document-create-element-batch",
      category: "boundary-heavy" as const,
      lane: result.lane,
      samplesNanoseconds: Object.freeze([...result.boundaryHeavy]),
    }),
  ]));
}

async function runLane(
  executable: string,
  pageUrl: string,
  lane: ChromiumBenchmarkLane,
): Promise<LaneResult> {
  const profile = mkdtempSync(join(tmpdir(), "nts-chromium-benchmark-profile-"));
  const browserArguments = [
    "--native-typescript-benchmark",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--disable-gpu",
    "--no-first-run",
    pageUrl,
  ];
  const useXvfb = process.platform === "linux" && !process.env.DISPLAY;
  const command = useXvfb ? "xvfb-run" : executable;
  const commandArguments = useXvfb
    ? ["-a", executable, ...browserArguments]
    : browserArguments;
  const child = spawn(command, commandArguments, { stdio: "pipe" });
  let client: CdpClient | undefined;

  try {
    const endpoint = await waitForDevTools(child);
    client = await CdpClient.connect(endpoint);
    const target = await waitForPageTarget(client);
    const attached = await client.send<{ readonly sessionId: string }>(
      "Target.attachToTarget",
      { targetId: target.targetId, flatten: true },
    );
    const sessionId = attached.sessionId;
    await client.send("DOM.enable", {}, sessionId);
    const result = await waitForLaneResult(client, sessionId, lane);

    const exited = waitForExit(child);
    const closed = await client.send<{ readonly success: boolean }>(
      "Target.closeTarget",
      { targetId: target.targetId },
    );
    if (!closed.success) throw new Error(`Could not close the ${lane} target`);
    await exited;
    return result;
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

async function main(arguments_: readonly string[]): Promise<void> {
  const options = parseOptions(arguments_);
  if (options === null) return;
  const repositoryRoot = resolve(packageRoot, "../..");
  if (commandOutput("git", ["status", "--porcelain"], repositoryRoot) !== "") {
    throw new Error("Chromium benchmark evidence requires a clean Native TypeScript worktree");
  }
  const scriptCCheckout = resolve(repositoryRoot, "third_party/scriptc");
  if (commandOutput("git", ["status", "--porcelain"], scriptCCheckout) !== "") {
    throw new Error("Chromium benchmark evidence requires a clean ScriptC checkout");
  }
  const scriptCRevision = commandOutput(
    "git",
    ["rev-parse", "HEAD"],
    scriptCCheckout,
  );
  if (commandOutput(
    "git",
    ["rev-parse", "HEAD:third_party/scriptc"],
    repositoryRoot,
  ) !== scriptCRevision) {
    throw new Error("ScriptC checkout does not match the Native TypeScript gitlink");
  }
  const outputRoot = resolve(options.checkout, options.outputDirectory);
  const pinnedRevision = (JSON.parse(readFileSync(
    resolve(packageRoot, "chromium/revision.json"),
    "utf8",
  )) as { readonly revision: string }).revision;
  if (commandOutput("git", ["rev-parse", "HEAD"], options.checkout) !==
      pinnedRevision) {
    throw new Error("Chromium benchmark evidence requires the exact pinned revision");
  }
  const executable = resolve(
    outputRoot,
    process.platform === "win32" ? "content_shell.exe" : "content_shell",
  );
  const argsPath = resolve(outputRoot, "args.gn");
  const cArchive = resolve(
    outputRoot,
    "gen/native_typescript/benchmark/c/libscriptc-c.a",
  );
  const llvmArchive = resolve(
    outputRoot,
    "gen/native_typescript/benchmark/llvm/libscriptc-llvm.a",
  );
  for (const path of [executable, argsPath, cArchive, llvmArchive]) {
    if (!existsSync(path)) throw new Error(`Benchmark artifact is absent: ${path}`);
  }
  const gnArguments = readFileSync(argsPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (!gnArguments.includes("is_official_build = true") ||
      !gnArguments.includes("is_debug = false") ||
      !gnArguments.includes("is_component_build = false")) {
    throw new Error(
      "Chromium timings require an official, non-component release build",
    );
  }
  const clang = resolve(
    options.checkout,
    "third_party/llvm-build/Release+Asserts/bin/clang",
  );
  const clangVersion = commandOutput(clang, ["--version"], options.checkout)
    .split("\n")[0]!;
  if (!clangVersion.startsWith("clang version 24.0.0git ")) {
    throw new Error(`Unexpected pinned Chromium clang version: ${clangVersion}`);
  }
  runCommand(
    process.execPath,
    [resolve(import.meta.dirname, "check-no-v8-bridge.ts")],
    packageRoot,
  );

  const pagesRoot = resolve(packageRoot, "benchmark/pages");
  const pageUrls = new Map<ChromiumBenchmarkLane, string>(lanes.map((lane) => [
    lane,
    pathToFileURL(resolve(pagesRoot, `${lane}.html`)).href,
  ]));
  const results: LaneResult[] = [];
  for (const lane of lanes) {
    results.push(await runLane(executable, pageUrls.get(lane)!, lane));
  }

  const input = defineChromiumPerformanceInput({
    observations: observations(results),
    capsuleStructure: capsuleStructure(),
    provenance: {
      schemaVersion: 1,
      chromiumRevision: commandOutput(
        "git",
        ["rev-parse", "HEAD"],
        options.checkout,
      ),
      nativeTypescriptRevision: commandOutput(
        "git",
        ["rev-parse", "HEAD"],
        repositoryRoot,
      ),
      scriptCRevision,
      chromiumClangVersion: clangVersion,
      contentShellDigest: sha256(executable),
      scriptcCArchiveDigest: sha256(cArchive),
      scriptcLlvmArchiveDigest: sha256(llvmArchive),
      fixtureDigest: fixtureDigest(),
      buildArguments: gnArguments,
      recordedAt: new Date().toISOString(),
    },
  });
  mkdirSync(dirname(options.result), { recursive: true });
  writeFileSync(options.result, `${JSON.stringify(input, null, 2)}\n`);
  process.stdout.write(
    `Chromium benchmark raw input written to ${options.result}\n`,
  );
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  reportError(error);
}
