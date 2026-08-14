import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

export type ArtifactKind =
  | "source"
  | "source-tree"
  | "sdk"
  | "declaration"
  | "generated-source"
  | "native-object"
  | "executable";

export interface SourceArtifactOrigin {
  readonly kind: "source";
  readonly digest: string;
  readonly fileName: string;
  readonly logicalPath: string;
}

export interface ActionArtifactOrigin {
  readonly kind: "action";
  readonly action: string;
  readonly fileName: string;
}

export interface ArtifactDefinition {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly entryType: "file" | "directory";
  readonly mediaType: string;
  readonly target: string;
  readonly domain: "host" | "target";
  readonly cache: "none" | "local" | "exportable";
  readonly origin: SourceArtifactOrigin | ActionArtifactOrigin;
}

export type ArtifactActionArgument =
  | { readonly kind: "literal"; readonly value: string }
  | {
      readonly kind: "input-path";
      readonly artifact: string;
      readonly path?: string;
    }
  | { readonly kind: "output-path"; readonly artifact: string };

export interface ArtifactActionEnvironment {
  readonly name: string;
  readonly value: string;
}

export interface ArtifactActionDefinition {
  readonly id: string;
  readonly implementation: {
    readonly id: string;
    readonly version: string;
  };
  readonly tool: {
    readonly id: string;
    readonly version: string;
    readonly digest: string;
  };
  readonly arguments: readonly ArtifactActionArgument[];
  readonly environment: readonly ArtifactActionEnvironment[];
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly workingDirectory: "isolated";
  readonly network: "denied";
  readonly executionPlatform: string;
  readonly target: string;
  readonly deterministic: boolean;
  readonly cacheable: boolean;
}

export interface ArtifactGraph {
  readonly schema: "native-typescript.artifact-graph";
  readonly schemaVersion: 1;
  readonly artifacts: readonly ArtifactDefinition[];
  readonly actions: readonly ArtifactActionDefinition[];
}

export type ArtifactGraphDiagnosticCode =
  | "NTS2001"
  | "NTS2002"
  | "NTS2003"
  | "NTS2004"
  | "NTS2005"
  | "NTS2006"
  | "NTS2007"
  | "NTS2008";

export interface ArtifactGraphDiagnostic {
  readonly code: ArtifactGraphDiagnosticCode;
  readonly severity: "error";
  readonly path: string;
  readonly message: string;
}

export class ArtifactGraphPlanningError extends Error {
  override readonly name = "ArtifactGraphPlanningError";
  readonly diagnostics: readonly ArtifactGraphDiagnostic[];

  constructor(diagnostics: readonly ArtifactGraphDiagnostic[]) {
    super(
      `Artifact graph planning failed with ${diagnostics.length} error(s)\n` +
        diagnostics
          .map(
            ({ code, path, message }) => `${code} ${path}: ${message}`,
          )
          .join("\n"),
    );
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@#+-]*$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const environmentPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const portableFileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const executorEnvironmentNames = new Set(["TMPDIR"]);
const artifactKinds = new Set<string>([
  "source",
  "source-tree",
  "sdk",
  "declaration",
  "generated-source",
  "native-object",
  "executable",
]);

function diagnostic(
  code: ArtifactGraphDiagnosticCode,
  path: string,
  message: string,
): ArtifactGraphDiagnostic {
  return Object.freeze({ code, severity: "error", path, message });
}

function validateIdentity(
  value: string,
  path: string,
  diagnostics: ArtifactGraphDiagnostic[],
): void {
  if (!identityPattern.test(value)) {
    diagnostics.push(
      diagnostic(
        "NTS2001",
        path,
        "Identity must use stable non-whitespace ASCII identifier characters",
      ),
    );
  }
}

function validateFileName(
  value: string,
  path: string,
  diagnostics: ArtifactGraphDiagnostic[],
): void {
  if (
    value.length === 0 ||
    value !== basename(value) ||
    value === "." ||
    value === ".." ||
    !portableFileNamePattern.test(value) ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    diagnostics.push(
      diagnostic(
        "NTS2005",
        path,
        "Artifact fileName must be one portable basename",
      ),
    );
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function findDuplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort(compareText);
}

function freezeArtifact(artifact: ArtifactDefinition): ArtifactDefinition {
  const origin = artifact.origin.kind === "source"
    ? Object.freeze({
        kind: artifact.origin.kind,
        digest: artifact.origin.digest,
        fileName: artifact.origin.fileName,
        logicalPath: artifact.origin.logicalPath,
      })
    : Object.freeze({
        kind: artifact.origin.kind,
        action: artifact.origin.action,
        fileName: artifact.origin.fileName,
      });
  return Object.freeze({
    id: artifact.id,
    kind: artifact.kind,
    entryType: artifact.entryType,
    mediaType: artifact.mediaType,
    target: artifact.target,
    domain: artifact.domain,
    cache: artifact.cache,
    origin,
  });
}

function freezeAction(
  action: ArtifactActionDefinition,
): ArtifactActionDefinition {
  return Object.freeze({
    id: action.id,
    implementation: Object.freeze({
      id: action.implementation.id,
      version: action.implementation.version,
    }),
    tool: Object.freeze({
      id: action.tool.id,
      version: action.tool.version,
      digest: action.tool.digest,
    }),
    arguments: Object.freeze(
      action.arguments.map((argument) => argument.kind === "literal"
        ? Object.freeze({ kind: argument.kind, value: argument.value })
        : argument.kind === "input-path" && argument.path !== undefined
          ? Object.freeze({
              kind: argument.kind,
              artifact: argument.artifact,
              path: argument.path,
            })
          : Object.freeze({
            kind: argument.kind,
            artifact: argument.artifact,
          })),
    ),
    environment: Object.freeze(
      [...action.environment]
        .sort((left, right) => compareText(left.name, right.name))
        .map((entry) => Object.freeze({
          name: entry.name,
          value: entry.value,
        })),
    ),
    inputs: Object.freeze([...action.inputs].sort(compareText)),
    outputs: Object.freeze([...action.outputs].sort(compareText)),
    workingDirectory: action.workingDirectory,
    network: action.network,
    executionPlatform: action.executionPlatform,
    target: action.target,
    deterministic: action.deterministic,
    cacheable: action.cacheable,
  });
}

function validateArtifactGraph(
  artifacts: readonly ArtifactDefinition[],
  actions: readonly ArtifactActionDefinition[],
): readonly ArtifactGraphDiagnostic[] {
  const diagnostics: ArtifactGraphDiagnostic[] = [];
  const artifactsById = new Map<string, ArtifactDefinition>();
  const actionsById = new Map<string, ArtifactActionDefinition>();
  const toolIdentities = new Map<string, string>();

  for (const duplicate of findDuplicates(artifacts.map(({ id }) => id))) {
    diagnostics.push(
      diagnostic("NTS2002", "artifacts", `Duplicate artifact ID: ${duplicate}`),
    );
  }
  for (const duplicate of findDuplicates(actions.map(({ id }) => id))) {
    diagnostics.push(
      diagnostic("NTS2002", "actions", `Duplicate action ID: ${duplicate}`),
    );
  }

  for (const [index, artifact] of artifacts.entries()) {
    const path = `artifacts[${index}]`;
    validateIdentity(artifact.id, `${path}.id`, diagnostics);
    validateIdentity(artifact.target, `${path}.target`, diagnostics);
    validateFileName(artifact.origin.fileName, `${path}.origin.fileName`, diagnostics);
    if (!artifactKinds.has(artifact.kind)) {
      diagnostics.push(
        diagnostic("NTS2001", `${path}.kind`, `Unknown artifact kind: ${artifact.kind}`),
      );
    }
    if (artifact.entryType !== "file" && artifact.entryType !== "directory") {
      diagnostics.push(
        diagnostic("NTS2001", `${path}.entryType`, "Unknown artifact entry type"),
      );
    }
    if (artifact.mediaType.length === 0 || artifact.mediaType.trim() !== artifact.mediaType) {
      diagnostics.push(
        diagnostic("NTS2001", `${path}.mediaType`, "Media type must be non-empty and trimmed"),
      );
    }
    if (artifact.origin.kind === "source") {
      if (!digestPattern.test(artifact.origin.digest)) {
        diagnostics.push(
          diagnostic("NTS2001", `${path}.origin.digest`, "Source digest must be canonical sha256"),
        );
      }
      if (
        artifact.origin.logicalPath.length === 0 ||
        isAbsolute(artifact.origin.logicalPath) ||
        /^[A-Za-z]:[\\/]/u.test(artifact.origin.logicalPath) ||
        artifact.origin.logicalPath.split(/[\\/]/u).includes("..")
      ) {
        diagnostics.push(
          diagnostic(
            "NTS2005",
            `${path}.origin.logicalPath`,
            "Source logicalPath must be workspace-relative and cannot traverse parents",
          ),
        );
      }
      if (
        (artifact.entryType === "directory") !==
        (artifact.kind === "source-tree" || artifact.kind === "sdk")
      ) {
        diagnostics.push(
          diagnostic(
            "NTS2005",
            `${path}.entryType`,
            "Directory sources require source-tree or sdk artifacts, and those kinds require directories",
          ),
        );
      }
    } else {
      validateIdentity(artifact.origin.action, `${path}.origin.action`, diagnostics);
    }
    if (!artifactsById.has(artifact.id)) artifactsById.set(artifact.id, artifact);
  }

  for (const [index, action] of actions.entries()) {
    const path = `actions[${index}]`;
    validateIdentity(action.id, `${path}.id`, diagnostics);
    validateIdentity(action.implementation.id, `${path}.implementation.id`, diagnostics);
    validateIdentity(action.implementation.version, `${path}.implementation.version`, diagnostics);
    validateIdentity(action.tool.id, `${path}.tool.id`, diagnostics);
    validateIdentity(action.tool.version, `${path}.tool.version`, diagnostics);
    if (!digestPattern.test(action.tool.digest)) {
      diagnostics.push(
        diagnostic("NTS2001", `${path}.tool.digest`, "Tool digest must be canonical sha256"),
      );
    }
    const toolIdentity = `${action.tool.version}\0${action.tool.digest}`;
    const previousToolIdentity = toolIdentities.get(action.tool.id);
    if (previousToolIdentity !== undefined && previousToolIdentity !== toolIdentity) {
      diagnostics.push(
        diagnostic(
          "NTS2002",
          `${path}.tool`,
          `Tool ${action.tool.id} has conflicting version or content identities`,
        ),
      );
    } else {
      toolIdentities.set(action.tool.id, toolIdentity);
    }
    validateIdentity(action.executionPlatform, `${path}.executionPlatform`, diagnostics);
    validateIdentity(action.target, `${path}.target`, diagnostics);
    if (
      action.workingDirectory !== "isolated" ||
      action.network !== "denied" ||
      (action.cacheable && !action.deterministic)
    ) {
      diagnostics.push(
        diagnostic(
          "NTS2007",
          path,
          "Actions require isolated working directories, denied network, and deterministic cache entries",
        ),
      );
    }
    for (const duplicate of findDuplicates(action.inputs)) {
      diagnostics.push(
        diagnostic("NTS2002", `${path}.inputs`, `Duplicate input artifact: ${duplicate}`),
      );
    }
    for (const duplicate of findDuplicates(action.outputs)) {
      diagnostics.push(
        diagnostic("NTS2002", `${path}.outputs`, `Duplicate output artifact: ${duplicate}`),
      );
    }
    for (const [environmentIndex, entry] of action.environment.entries()) {
      if (
        !environmentPattern.test(entry.name) ||
        entry.value.includes("\0") ||
        executorEnvironmentNames.has(entry.name)
      ) {
        diagnostics.push(
          diagnostic(
            "NTS2001",
            `${path}.environment[${environmentIndex}]`,
            "Environment entries require a portable, non-reserved name and a NUL-free value",
          ),
        );
      }
    }
    for (const duplicate of findDuplicates(action.environment.map(({ name }) => name))) {
      diagnostics.push(
        diagnostic("NTS2002", `${path}.environment`, `Duplicate environment name: ${duplicate}`),
      );
    }
    for (const [argumentIndex, argument] of action.arguments.entries()) {
      if (argument.kind === "literal") {
        if (argument.value.includes("\0")) {
          diagnostics.push(
            diagnostic("NTS2001", `${path}.arguments[${argumentIndex}]`, "Arguments cannot contain NUL"),
          );
        }
      } else {
        const expected = argument.kind === "input-path" ? action.inputs : action.outputs;
        if (!expected.includes(argument.artifact)) {
          diagnostics.push(
            diagnostic(
              "NTS2008",
              `${path}.arguments[${argumentIndex}]`,
              `${argument.artifact} is not a declared ${argument.kind === "input-path" ? "input" : "output"}`,
            ),
          );
        }
        if (argument.kind === "input-path" && argument.path !== undefined) {
          const artifact = artifactsById.get(argument.artifact);
          const segments = argument.path.split("/");
          if (
            artifact !== undefined &&
            (artifact.entryType !== "directory" ||
              argument.path.length === 0 ||
              isAbsolute(argument.path) ||
              argument.path.includes("\\") ||
              segments.some((segment) =>
                segment.length === 0 ||
                segment === "." ||
                segment === ".." ||
                !portableFileNamePattern.test(segment)
              ))
          ) {
            diagnostics.push(
              diagnostic(
                "NTS2008",
                `${path}.arguments[${argumentIndex}].path`,
                "Input subpaths require a declared directory artifact and portable relative segments",
              ),
            );
          }
        }
      }
    }
    for (const input of action.inputs) {
      if (!artifactsById.has(input)) {
        diagnostics.push(
          diagnostic("NTS2003", `${path}.inputs`, `Unknown input artifact: ${input}`),
        );
      }
    }
    for (const output of action.outputs) {
      const artifact = artifactsById.get(output);
      if (artifact === undefined) {
        diagnostics.push(
          diagnostic("NTS2003", `${path}.outputs`, `Unknown output artifact: ${output}`),
        );
      } else if (artifact.origin.kind !== "action" || artifact.origin.action !== action.id) {
        diagnostics.push(
          diagnostic(
            "NTS2004",
            `${path}.outputs`,
            `Artifact ${output} does not name ${action.id} as its producer`,
          ),
        );
      }
      if (artifact !== undefined && artifact.target !== action.target) {
        diagnostics.push(
          diagnostic(
            "NTS2004",
            `${path}.outputs`,
            `Artifact ${output} targets ${artifact.target}, but its producer targets ${action.target}`,
          ),
        );
      }
      if (!action.arguments.some(
        (argument) => argument.kind === "output-path" && argument.artifact === output,
      )) {
        diagnostics.push(
          diagnostic("NTS2008", `${path}.outputs`, `Output ${output} has no output-path argument`),
        );
      }
    }
    if (!actionsById.has(action.id)) actionsById.set(action.id, action);
  }

  for (const [index, artifact] of artifacts.entries()) {
    if (artifact.origin.kind !== "action") continue;
    const producer = actionsById.get(artifact.origin.action);
    if (producer === undefined) {
      diagnostics.push(
        diagnostic(
          "NTS2003",
          `artifacts[${index}].origin.action`,
          `Unknown producer action: ${artifact.origin.action}`,
        ),
      );
    } else if (!producer.outputs.includes(artifact.id)) {
      diagnostics.push(
        diagnostic(
          "NTS2004",
          `artifacts[${index}].origin.action`,
          `Producer ${producer.id} does not declare output ${artifact.id}`,
        ),
      );
    }
  }

  const dependencies = new Map<string, Set<string>>();
  for (const action of actions) {
    const actionDependencies = new Set<string>();
    for (const input of action.inputs) {
      const artifact = artifactsById.get(input);
      if (artifact?.origin.kind === "action") {
        actionDependencies.add(artifact.origin.action);
      }
    }
    dependencies.set(action.id, actionDependencies);
  }
  const remaining = new Set(actions.map(({ id }) => id));
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) =>
      [...(dependencies.get(id) ?? [])].every((dependency) => !remaining.has(dependency)),
    );
    if (ready.length === 0) {
      diagnostics.push(
        diagnostic(
          "NTS2006",
          "actions",
          `Action dependency cycle: ${[...remaining].sort(compareText).join(", ")}`,
        ),
      );
      break;
    }
    for (const id of ready) remaining.delete(id);
  }

  return diagnostics;
}

export function defineArtifactGraph(input: {
  readonly artifacts: readonly ArtifactDefinition[];
  readonly actions: readonly ArtifactActionDefinition[];
}): ArtifactGraph {
  const artifacts = [...input.artifacts]
    .sort((left, right) => compareText(left.id, right.id))
    .map(freezeArtifact);
  const actions = [...input.actions]
    .sort((left, right) => compareText(left.id, right.id))
    .map(freezeAction);
  const diagnostics = validateArtifactGraph(artifacts, actions);
  if (diagnostics.length > 0) throw new ArtifactGraphPlanningError(diagnostics);
  return Object.freeze({
    schema: "native-typescript.artifact-graph",
    schemaVersion: 1,
    artifacts: Object.freeze(artifacts),
    actions: Object.freeze(actions),
  });
}

export interface ArtifactToolBinding {
  readonly path: string;
}

export interface ArtifactExecutionOptions {
  readonly buildRoot: string;
  readonly sourcePaths: Readonly<Record<string, string>>;
  readonly tools: Readonly<Record<string, ArtifactToolBinding>>;
  readonly sandbox: ArtifactSandboxBinding;
  readonly maxConcurrency?: number;
}

export interface ArtifactSandboxBinding {
  readonly kind: "bubblewrap";
  readonly path: string;
}

export interface MaterializedArtifact {
  readonly id: string;
  readonly path: string;
  readonly entryType: "file" | "directory";
  readonly digest: string;
  readonly size: number;
}

export interface ArtifactActionReport {
  readonly id: string;
  readonly status: "executed";
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputs: readonly MaterializedArtifact[];
}

export interface ArtifactExecutionReport {
  readonly buildRoot: string;
  readonly artifacts: readonly MaterializedArtifact[];
  readonly actions: readonly ArtifactActionReport[];
}

async function verifyToolBindings(
  graph: ArtifactGraph,
  tools: Readonly<Record<string, ArtifactToolBinding>>,
): Promise<void> {
  const verified = new Set<string>();
  for (const action of graph.actions) {
    if (verified.has(action.tool.id)) continue;
    const tool = tools[action.tool.id];
    if (tool === undefined) {
      throw new ArtifactExecutionError(`No tool binding was supplied for ${action.tool.id}`);
    }
    if (!isAbsolute(tool.path)) {
      throw new ArtifactExecutionError(
        `Tool ${action.tool.id} requires an absolute executable path`,
      );
    }
    let file;
    try {
      file = await stat(tool.path);
    } catch {
      throw new ArtifactExecutionError(`Tool ${action.tool.id} does not exist at ${tool.path}`);
    }
    if (!file.isFile()) {
      throw new ArtifactExecutionError(`Tool ${action.tool.id} is not a regular file`);
    }
    const content = await digestFile(tool.path);
    if (content.digest !== action.tool.digest) {
      throw new ArtifactExecutionError(
        `Tool ${action.tool.id} digest mismatch: expected ${action.tool.digest}, received ${content.digest}`,
      );
    }
    verified.add(action.tool.id);
  }
}

export class ArtifactExecutionError extends Error {
  override readonly name = "ArtifactExecutionError";
  readonly actionId: string | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    message: string,
    options: {
      readonly actionId?: string;
      readonly stdout?: string;
      readonly stderr?: string;
    } = {},
  ) {
    super(message);
    this.actionId = options.actionId ?? null;
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
  }
}

async function digestFile(path: string): Promise<{ digest: string; size: number }> {
  const bytes = await readFile(path);
  return {
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size: bytes.byteLength,
  };
}

function updateLength(hash: ReturnType<typeof createHash>, value: number): void {
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(BigInt(value));
  hash.update(encoded);
}

async function digestDirectory(
  root: string,
): Promise<{ digest: string; size: number }> {
  const hash = createHash("sha256");
  hash.update("native-typescript.directory.v1\0");
  let size = 0;

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relativeDirectory.length === 0
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        const encodedPath = Buffer.from(relativePath, "utf8");
        hash.update("d");
        updateLength(hash, encodedPath.byteLength);
        hash.update(encodedPath);
        await visit(path, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new ArtifactExecutionError(
          `Directory artifact contains unsupported entry ${relativePath}`,
        );
      }
      const bytes = await readFile(path);
      const encodedPath = Buffer.from(relativePath, "utf8");
      hash.update("f");
      updateLength(hash, encodedPath.byteLength);
      hash.update(encodedPath);
      updateLength(hash, bytes.byteLength);
      hash.update(bytes);
      size += bytes.byteLength;
    }
  }

  await visit(root, "");
  return { digest: `sha256:${hash.digest("hex")}`, size };
}

export async function digestArtifactPath(
  path: string,
  entryType: "file" | "directory",
): Promise<{ digest: string; size: number }> {
  const entry = await stat(path);
  if (entryType === "file" && !entry.isFile()) {
    throw new ArtifactExecutionError(`Expected a regular file at ${path}`);
  }
  if (entryType === "directory" && !entry.isDirectory()) {
    throw new ArtifactExecutionError(`Expected a directory at ${path}`);
  }
  return entryType === "file" ? await digestFile(path) : await digestDirectory(path);
}

function physicalName(id: string, fileName: string): string {
  const prefix = createHash("sha256").update(id).digest("hex").slice(0, 16);
  return `${prefix}-${fileName}`;
}

async function runCommand(options: {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly actionId: string;
  readonly sandbox: ArtifactSandboxBinding;
}): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const sandboxArguments = [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--ro-bind",
      "/",
      "/",
      "--bind",
      options.cwd,
      options.cwd,
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--chdir",
      options.cwd,
      "--clearenv",
      "--setenv",
      "TMPDIR",
      join(options.cwd, "temporary"),
      ...Object.entries(options.environment).flatMap(([name, value]) => [
        "--setenv",
        name,
        value,
      ]),
      "--",
      options.executable,
      ...options.arguments,
    ];
    const child = spawn(options.sandbox.path, sandboxArguments, {
      cwd: options.cwd,
      env: {},
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(
        new ArtifactExecutionError(
          `Action ${options.actionId} could not start sandbox ${options.sandbox.path}: ${error.message}`,
          { actionId: options.actionId, stdout, stderr },
        ),
      );
    });
    child.on("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new ArtifactExecutionError(
            `Action ${options.actionId} failed with ${signal === null ? `exit code ${code}` : `signal ${signal}`}`,
            { actionId: options.actionId, stdout, stderr },
          ),
        );
      }
    });
  });
}

async function executeAction(options: {
  readonly action: ArtifactActionDefinition;
  readonly artifactsById: ReadonlyMap<string, ArtifactDefinition>;
  readonly materialized: ReadonlyMap<string, MaterializedArtifact>;
  readonly buildRoot: string;
  readonly tool: ArtifactToolBinding;
  readonly sandbox: ArtifactSandboxBinding;
}): Promise<ArtifactActionReport> {
  const { action } = options;
  const actionRoot = join(
    options.buildRoot,
    "actions",
    physicalName(action.id, "action"),
  );
  const inputRoot = join(actionRoot, "inputs");
  const outputRoot = join(actionRoot, "outputs");
  const temporaryRoot = join(actionRoot, "temporary");
  await mkdir(inputRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await mkdir(temporaryRoot, { recursive: true });

  const inputPaths = new Map<string, string>();
  for (const inputId of action.inputs) {
    const input = options.materialized.get(inputId);
    const definition = options.artifactsById.get(inputId);
    if (input === undefined || definition === undefined) {
      throw new ArtifactExecutionError(
        `Action ${action.id} has no materialized input ${inputId}`,
        { actionId: action.id },
      );
    }
    const inputPath = join(
      inputRoot,
      physicalName(inputId, definition.origin.fileName),
    );
    if (input.entryType === "file") {
      await copyFile(input.path, inputPath);
      await chmod(inputPath, 0o444);
    } else {
      await cp(input.path, inputPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
        dereference: false,
      });
    }
    const staged = await digestArtifactPath(inputPath, input.entryType);
    if (staged.digest !== input.digest) {
      throw new ArtifactExecutionError(
        `Action ${action.id} staged input ${inputId} with unexpected content`,
        { actionId: action.id },
      );
    }
    inputPaths.set(inputId, inputPath);
  }

  const outputPaths = new Map<string, string>();
  for (const outputId of action.outputs) {
    const definition = options.artifactsById.get(outputId);
    if (definition === undefined) {
      throw new ArtifactExecutionError(`Action ${action.id} lost output ${outputId}`, {
        actionId: action.id,
      });
    }
    outputPaths.set(
      outputId,
      join(outputRoot, physicalName(outputId, definition.origin.fileName)),
    );
  }

  const commandArguments = action.arguments.map((argument) => {
    if (argument.kind === "literal") return argument.value;
    const artifactPath = argument.kind === "input-path"
      ? inputPaths.get(argument.artifact)
      : outputPaths.get(argument.artifact);
    if (artifactPath === undefined) {
      throw new ArtifactExecutionError(
        `Action ${action.id} could not resolve ${argument.artifact}`,
        { actionId: action.id },
      );
    }
    return argument.kind === "input-path" && argument.path !== undefined
      ? join(artifactPath, argument.path)
      : artifactPath;
  });
  const environment = Object.fromEntries(
    action.environment.map(({ name, value }) => [name, value]),
  );
  const started = process.hrtime.bigint();
  const command = await runCommand({
    executable: options.tool.path,
    arguments: commandArguments,
    cwd: actionRoot,
    environment,
    actionId: action.id,
    sandbox: options.sandbox,
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;

  const expectedEntries = new Map(
    action.outputs.map((outputId) => {
      const definition = options.artifactsById.get(outputId)!;
      return [basename(outputPaths.get(outputId)!), definition.entryType] as const;
    }),
  );
  const actualEntries = await readdir(outputRoot, { withFileTypes: true });
  const unexpected = actualEntries
    .filter((entry) => {
      const expectedType = expectedEntries.get(entry.name);
      return expectedType === undefined ||
        (expectedType === "file" && !entry.isFile()) ||
        (expectedType === "directory" && !entry.isDirectory());
    })
    .map(({ name }) => name)
    .sort(compareText);
  if (unexpected.length > 0) {
    throw new ArtifactExecutionError(
      `Action ${action.id} created undeclared output(s): ${unexpected.join(", ")}`,
      { actionId: action.id, ...command },
    );
  }

  const outputs: MaterializedArtifact[] = [];
  for (const outputId of action.outputs) {
    const path = outputPaths.get(outputId)!;
    const definition = options.artifactsById.get(outputId)!;
    let file;
    try {
      file = await stat(path);
    } catch {
      throw new ArtifactExecutionError(
        `Action ${action.id} did not create declared output ${outputId}`,
        { actionId: action.id, ...command },
      );
    }
    if (
      (definition.entryType === "file" && !file.isFile()) ||
      (definition.entryType === "directory" && !file.isDirectory())
    ) {
      throw new ArtifactExecutionError(
        `Action ${action.id} output ${outputId} has the wrong entry type`,
        { actionId: action.id, ...command },
      );
    }
    const content = await digestArtifactPath(path, definition.entryType);
    outputs.push(Object.freeze({
      id: outputId,
      path,
      entryType: definition.entryType,
      ...content,
    }));
  }
  return Object.freeze({
    id: action.id,
    status: "executed",
    durationMs,
    ...command,
    outputs: Object.freeze(outputs),
  });
}

export async function executeArtifactGraph(
  graph: ArtifactGraph,
  options: ArtifactExecutionOptions,
): Promise<ArtifactExecutionReport> {
  const concurrency = options.maxConcurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new ArtifactExecutionError("maxConcurrency must be a positive safe integer");
  }
  if (options.sandbox.kind !== "bubblewrap" || !isAbsolute(options.sandbox.path)) {
    throw new ArtifactExecutionError(
      "The artifact executor requires an absolute Bubblewrap sandbox binding",
    );
  }
  await mkdir(options.buildRoot, { recursive: false });
  const buildRoot = await realpath(options.buildRoot);
  await verifyToolBindings(graph, options.tools);

  const artifactsById = new Map(graph.artifacts.map((artifact) => [artifact.id, artifact]));
  const materialized = new Map<string, MaterializedArtifact>();
  for (const artifact of graph.artifacts) {
    if (artifact.origin.kind !== "source") continue;
    const suppliedPath = options.sourcePaths[artifact.id];
    if (suppliedPath === undefined) {
      throw new ArtifactExecutionError(`No source path was supplied for ${artifact.id}`);
    }
    const path = await realpath(suppliedPath);
    const content = await digestArtifactPath(path, artifact.entryType);
    if (content.digest !== artifact.origin.digest) {
      throw new ArtifactExecutionError(
        `Source artifact ${artifact.id} digest mismatch: expected ${artifact.origin.digest}, received ${content.digest}`,
      );
    }
    materialized.set(
      artifact.id,
      Object.freeze({
        id: artifact.id,
        path,
        entryType: artifact.entryType,
        ...content,
      }),
    );
  }

  const dependencies = new Map<string, Set<string>>();
  for (const action of graph.actions) {
    dependencies.set(
      action.id,
      new Set(
        action.inputs.flatMap((inputId) => {
          const origin = artifactsById.get(inputId)?.origin;
          return origin?.kind === "action" ? [origin.action] : [];
        }),
      ),
    );
  }

  const remaining = new Map(graph.actions.map((action) => [action.id, action]));
  const completed = new Set<string>();
  const reports = new Map<string, ArtifactActionReport>();
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((action) =>
        [...(dependencies.get(action.id) ?? [])].every((dependency) => completed.has(dependency)),
      )
      .sort((left, right) => compareText(left.id, right.id));
    if (ready.length === 0) {
      throw new ArtifactExecutionError("Artifact graph lost its validated topological order");
    }
    for (let offset = 0; offset < ready.length; offset += concurrency) {
      const batch = ready.slice(offset, offset + concurrency);
      const batchReports = await Promise.all(
        batch.map(async (action) => {
          const tool = options.tools[action.tool.id];
          if (tool === undefined) {
            throw new ArtifactExecutionError(`No tool binding was supplied for ${action.tool.id}`, {
              actionId: action.id,
            });
          }
          return await executeAction({
            action,
            artifactsById,
            materialized,
            buildRoot,
            tool,
            sandbox: options.sandbox,
          });
        }),
      );
      for (const report of batchReports) {
        reports.set(report.id, report);
        for (const output of report.outputs) materialized.set(output.id, output);
        completed.add(report.id);
        remaining.delete(report.id);
      }
    }
  }

  return Object.freeze({
    buildRoot,
    artifacts: Object.freeze(
      graph.artifacts.map(({ id }) => {
        const artifact = materialized.get(id);
        if (artifact === undefined) {
          throw new ArtifactExecutionError(`Artifact ${id} was not materialized`);
        }
        return artifact;
      }),
    ),
    actions: Object.freeze(graph.actions.map(({ id }) => reports.get(id)!)),
  });
}
