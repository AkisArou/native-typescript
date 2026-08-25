#!/usr/bin/env node

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  defineChromiumBenchmarkContract,
  type ChromiumBenchmarkContract,
} from "../src/benchmark-contract.ts";
import {
  defineChromiumPerformanceInput,
  type ChromiumBenchmarkLane,
  type ChromiumBenchmarkObservation,
  type ChromiumProductShapeObservation,
  type ChromiumRendererSnapshot,
} from "../src/performance.ts";
import { commandOutput, packageRoot, reportError, runCommand } from "./support.ts";

interface Options {
  readonly checkout: string;
  readonly outputDirectory: string;
  readonly result: string;
  readonly repetitions: number;
  readonly rendererCpuSet: string | null;
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

interface LaneWorkloadResult {
  readonly id: string;
  readonly iterations: number;
  readonly warmupIterations: number;
  readonly checksum: number;
  readonly perCall: readonly number[];
  readonly compiledLoop: readonly number[];
  readonly interop: {
    readonly managedNodePeers: number;
    readonly managedNodeClaims: number;
    readonly managedSubscriptions: number;
  } | null;
}

interface LaneResult {
  readonly lane: ChromiumBenchmarkLane;
  readonly sampleCount: number;
  readonly workloads: readonly LaneWorkloadResult[];
}

interface LaneExecution {
  readonly result: LaneResult;
  readonly productShape: ChromiumProductShapeObservation;
}

interface RendererProcessInfo {
  readonly type: string;
  readonly id: number;
}

interface RendererMemory {
  readonly rssBytes: number;
  readonly pssBytes: number;
  readonly peakRssBytes: number;
}

interface RendererSnapshotCapture {
  readonly snapshot: ChromiumRendererSnapshot;
  readonly peakRssBytes: number;
}

const lanes = Object.freeze([
  "cpp",
  "scriptc-c",
  "scriptc-llvm",
  "v8",
] as const);
const operationTimeoutMilliseconds = 60_000;
const repositoryRoot = resolve(packageRoot, "../..");
const benchmarkRoot = resolve(repositoryRoot, "benchmarks/chromium");

function readBenchmarkContract(): ChromiumBenchmarkContract {
  return defineChromiumBenchmarkContract(JSON.parse(readFileSync(
    resolve(benchmarkRoot, "workloads.json"),
    "utf8",
  )));
}

const benchmarkContract = readBenchmarkContract();

function requireLinuxProductShapeMetrics(): void {
  if (process.platform !== "linux") {
    throw new Error(
      "Chromium product-shape measurements require Linux /proc metrics",
    );
  }
}

function usage(): string {
  return [
    "Usage: node scripts/run-chromium-benchmark.ts /path/to/chromium/src",
    "  --output chromium-benchmark-input.json [--out out/nts-benchmark]",
    "  [--repetitions 3] [--renderer-cpu-set 0-3]",
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
  let repetitions = 3;
  let rendererCpuSet: string | null = null;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (
      argument !== "--out" &&
      argument !== "--output" &&
      argument !== "--repetitions" &&
      argument !== "--renderer-cpu-set"
    ) {
      throw new Error(`Unknown argument: ${argument}\n${usage()}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    if (argument === "--out") outputDirectory = value;
    else if (argument === "--output") result = resolve(value);
    else if (argument === "--repetitions") {
      repetitions = Number(value);
      if (!Number.isSafeInteger(repetitions) || repetitions <= 0) {
        throw new Error("--repetitions must be a positive integer");
      }
    } else {
      if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u.test(value)) {
        throw new Error("--renderer-cpu-set must be a taskset CPU list");
      }
      rendererCpuSet = value;
    }
    index += 1;
  }
  if (result === undefined) throw new Error(`--output is required\n${usage()}`);
  return Object.freeze({
    checkout: resolve(checkoutArgument),
    outputDirectory,
    result,
    repetitions,
    rendererCpuSet,
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
    parsed.sampleCount !== benchmarkContract.sampleCount ||
    !Array.isArray(parsed.workloads) ||
    parsed.workloads.length !== benchmarkContract.workloads.length
  ) {
    throw new Error(`Invalid or mismatched benchmark result for ${expectedLane}`);
  }
  for (const [index, definition] of benchmarkContract.workloads.entries()) {
    const workload = parsed.workloads[index] as Partial<LaneWorkloadResult>;
    const expectedChecksum = 2 * definition.warmupIterations +
      2 * benchmarkContract.sampleCount * definition.iterations;
    const interop = workload?.interop;
    const retainedWorkloadIndex = benchmarkContract.workloads.findIndex(
      ({ id }) => id === "retained-attached-text-update",
    );
    const expectedManagedNodes = index >= retainedWorkloadIndex ? 1 : 0;
    const interopValid = expectedLane === "scriptc-c" ||
        expectedLane === "scriptc-llvm"
      ? interop !== null && typeof interop === "object" &&
        [
          interop.managedNodePeers,
          interop.managedNodeClaims,
          interop.managedSubscriptions,
        ].every((count) => Number.isSafeInteger(count) && count >= 0) &&
        interop.managedNodePeers === expectedManagedNodes &&
        interop.managedNodeClaims === expectedManagedNodes &&
        interop.managedSubscriptions === 0
      : interop === null;
    if (
      workload?.id !== definition.id ||
      workload.iterations !== definition.iterations ||
      workload.warmupIterations !== definition.warmupIterations ||
      workload.checksum !== expectedChecksum ||
      !interopValid ||
      !Array.isArray(workload.perCall) ||
      !Array.isArray(workload.compiledLoop) ||
      workload.perCall.length !== benchmarkContract.sampleCount ||
      workload.compiledLoop.length !== benchmarkContract.sampleCount ||
      [...workload.perCall, ...workload.compiledLoop].some(
        (sample) => typeof sample !== "number" ||
          !Number.isFinite(sample) || sample <= 0,
      )
    ) {
      throw new Error(
        `Invalid or mismatched benchmark workload for ${expectedLane}/${definition.id}`,
      );
    }
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
    resolve(benchmarkRoot, "workloads.json"),
    resolve(packageRoot, "chromium/overlay/generated/nts_benchmark_workloads.inc"),
    resolve(packageRoot, "chromium/overlay/generated/nts_webidl_capsules.cc"),
    resolve(packageRoot, "chromium/overlay/nts_blink_benchmark_host.cc"),
    resolve(packageRoot, "chromium/overlay/nts_blink_managed_registry.cc"),
    resolve(packageRoot, "chromium/overlay/nts_blink_scabi.cc"),
    resolve(packageRoot, "chromium/webidl/package.scabi.json"),
    resolve(benchmarkRoot, "scriptc/app.ts"),
    resolve(benchmarkRoot, "scriptc/profile-c.json"),
    resolve(benchmarkRoot, "scriptc/profile-llvm.json"),
    resolve(benchmarkRoot, "pages/cpp.html"),
    resolve(benchmarkRoot, "pages/scriptc-c.html"),
    resolve(benchmarkRoot, "pages/scriptc-llvm.html"),
    resolve(benchmarkRoot, "pages/v8.html"),
    resolve(benchmarkRoot, "pages/workloads.js"),
    resolve(benchmarkRoot, "pages/v8.js"),
  ];
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(repositoryRoot, path));
    hash.update("\0");
    hash.update(readFileSync(path));
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
  return Object.freeze(lanes.flatMap((lane) => {
    const repetitions = results.filter((result) => result.lane === lane);
    return benchmarkContract.workloads.flatMap((definition, index) => [
      Object.freeze({
        workload: `webidl-${definition.id}-per-call`,
        category: definition.perCallCategory,
        lane,
        samplesNanoseconds: Object.freeze(repetitions.flatMap((result) =>
          result.workloads[index]!.perCall
        )),
      }),
      Object.freeze({
        workload: `webidl-${definition.id}-compiled-loop`,
        category: definition.compiledLoopCategory,
        lane,
        samplesNanoseconds: Object.freeze(repetitions.flatMap((result) =>
          result.workloads[index]!.compiledLoop
        )),
      }),
    ]);
  }));
}

function procKilobytes(contents: string, field: string, path: string): number {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "mu").exec(contents);
  if (!match?.[1]) throw new Error(`${path} does not contain ${field}`);
  const kilobytes = Number(match[1]);
  if (!Number.isSafeInteger(kilobytes)) {
    throw new Error(`${path} contains an invalid ${field}`);
  }
  return kilobytes * 1024;
}

function rendererMemory(processId: number): RendererMemory {
  const processRoot = `/proc/${processId}`;
  const smapsPath = resolve(processRoot, "smaps_rollup");
  const statusPath = resolve(processRoot, "status");
  const smaps = readFileSync(smapsPath, "utf8");
  const status = readFileSync(statusPath, "utf8");
  return Object.freeze({
    rssBytes: procKilobytes(smaps, "Rss", smapsPath),
    pssBytes: procKilobytes(smaps, "Pss", smapsPath),
    peakRssBytes: procKilobytes(status, "VmHWM", statusPath),
  });
}

async function rendererProcess(
  client: CdpClient,
): Promise<RendererProcessInfo> {
  const processes = await client.send<{
    readonly processInfo: readonly RendererProcessInfo[];
  }>("SystemInfo.getProcessInfo");
  const renderers = processes.processInfo.filter(
    (process) => process.type === "renderer",
  );
  if (renderers.length !== 1) {
    throw new Error(
      `Expected one isolated renderer process, observed ${renderers.length}`,
    );
  }
  return renderers[0]!;
}

async function captureRendererSnapshot(
  client: CdpClient,
  sessionId: string,
): Promise<RendererSnapshotCapture> {
  await client.send("HeapProfiler.collectGarbage", {}, sessionId);
  const counters = await client.send<{
    readonly documents: number;
    readonly nodes: number;
    readonly jsEventListeners: number;
  }>("Memory.getDOMCounters", {}, sessionId);
  const renderer = await rendererProcess(client);
  const memory = rendererMemory(renderer.id);
  return Object.freeze({
    snapshot: Object.freeze({
      rssBytes: memory.rssBytes,
      pssBytes: memory.pssBytes,
      documents: counters.documents,
      nodes: counters.nodes,
      jsEventListeners: counters.jsEventListeners,
    }),
    peakRssBytes: memory.peakRssBytes,
  });
}

async function runLane(
  executable: string,
  pageUrl: string,
  lane: ChromiumBenchmarkLane,
  rendererCpuSet: string | null,
): Promise<LaneExecution> {
  const profile = mkdtempSync(join(tmpdir(), "nts-chromium-benchmark-profile-"));
  const browserArguments = [
    "--native-typescript-benchmark",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--disable-gpu",
    "--no-first-run",
    ...(rendererCpuSet === null
      ? []
      : [`--renderer-cmd-prefix=/usr/bin/taskset -c ${rendererCpuSet}`]),
    "about:blank",
  ];
  const useXvfb = process.platform === "linux" && !process.env.DISPLAY;
  const command = useXvfb ? "xvfb-run" : executable;
  const commandArguments = useXvfb
    ? ["-a", executable, ...browserArguments]
    : browserArguments;
  const startedAt = performance.now();
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
    await client.send("Page.enable", {}, sessionId);
    const startupMilliseconds = performance.now() - startedAt;
    const baseline = await captureRendererSnapshot(client, sessionId);
    const workloadStartedAt = performance.now();
    await client.send("Page.navigate", { url: pageUrl }, sessionId);
    const result = await waitForLaneResult(client, sessionId, lane);
    const workloadMilliseconds = performance.now() - workloadStartedAt;
    const postWorkload = await captureRendererSnapshot(client, sessionId);
    const blankLoaded = client.waitForEvent("Page.loadEventFired", sessionId);
    await client.send("Page.navigate", { url: "about:blank" }, sessionId);
    await blankLoaded;
    const postTeardown = await captureRendererSnapshot(client, sessionId);
    const wallClockMilliseconds = performance.now() - startedAt;
    const productShape = Object.freeze({
      lane,
      startupMilliseconds,
      workloadMilliseconds,
      wallClockMilliseconds,
      rendererPeakRssBytes: postWorkload.peakRssBytes,
      baseline: baseline.snapshot,
      postWorkload: postWorkload.snapshot,
      postTeardown: postTeardown.snapshot,
      finalInterop: result.workloads.at(-1)!.interop,
    });

    const exited = waitForExit(child);
    const closed = await client.send<{ readonly success: boolean }>(
      "Target.closeTarget",
      { targetId: target.targetId },
    );
    if (!closed.success) throw new Error(`Could not close the ${lane} target`);
    await exited;
    return Object.freeze({ result, productShape });
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
  requireLinuxProductShapeMetrics();
  if (options.rendererCpuSet !== null) {
    if (process.platform !== "linux") {
      throw new Error("--renderer-cpu-set is supported only on Linux");
    }
    if (!existsSync("/usr/bin/taskset")) {
      throw new Error("--renderer-cpu-set requires /usr/bin/taskset");
    }
  }
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

  const pagesRoot = resolve(benchmarkRoot, "pages");
  const pageUrls = new Map<ChromiumBenchmarkLane, string>(lanes.map((lane) => [
    lane,
    pathToFileURL(resolve(pagesRoot, `${lane}.html`)).href,
  ]));
  const executions: LaneExecution[] = [];
  for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
    for (const lane of lanes) {
      executions.push(await runLane(
        executable,
        pageUrls.get(lane)!,
        lane,
        options.rendererCpuSet,
      ));
    }
  }

  const input = defineChromiumPerformanceInput({
    observations: observations(executions.map(({ result }) => result)),
    productShape: executions.map(({ productShape }) => productShape),
    artifactShape: {
      sharedContentShellBytes: statSync(executable).size,
      scriptcCArchiveBytes: statSync(cArchive).size,
      scriptcLlvmArchiveBytes: statSync(llvmArchive).size,
    },
    capsuleStructure: capsuleStructure(),
    provenance: {
      schemaVersion: 3,
      benchmarkEnvironment: {
        workloads: benchmarkContract.workloads.map((workload) => ({
          id: workload.id,
          iterationsPerSample: workload.iterations,
          warmupIterations: workload.warmupIterations,
        })),
        samplesPerRepetition: benchmarkContract.sampleCount,
        repetitions: options.repetitions,
        laneIsolation: "fresh-renderer",
        rendererCpuSet: options.rendererCpuSet,
      },
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
