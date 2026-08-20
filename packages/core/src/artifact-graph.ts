import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
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
import {
  computeActionCacheKey,
  prepareArtifactCache,
  publishActionToCache,
  restoreActionFromCache,
  type ArtifactCacheBinding,
  type PreparedArtifactCache,
} from "./artifact-cache.ts";
import { ArtifactExecutionError, digestArtifactPath } from "./artifact-io.ts";

export { ArtifactExecutionError, digestArtifactPath } from "./artifact-io.ts";
import type { UndeclaredDependency } from "./artifact-cache.ts";
export type { ArtifactCacheBinding } from "./artifact-cache.ts";

export type ArtifactKind =
  | "source"
  | "source-tree"
  | "sdk"
  | "metadata"
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

export type ArtifactActionInputArgument =
  | { readonly kind: "literal"; readonly value: string }
  | {
      readonly kind: "input-path";
      readonly artifact: string;
      readonly path?: string;
    };

export type ArtifactActionArgument =
  | ArtifactActionInputArgument
  | { readonly kind: "output-path"; readonly artifact: string }
  /**
   * Where the tool writes the list of files it actually read.
   *
   * An action's declared inputs say what the graph knows about; a compiler
   * also reads system headers nobody declared. Recording them is what lets a
   * cached result be trusted: the entry is only reused when every file the
   * tool read is still exactly what it was.
   */
  | { readonly kind: "dependency-path" };

export interface ArtifactActionEnvironment {
  readonly name: string;
  readonly value: string;
}

export type ArtifactActionStandardOutput =
  | { readonly kind: "report" }
  | { readonly kind: "artifact"; readonly artifact: string };

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
  readonly standardOutput: ArtifactActionStandardOutput;
  readonly workingDirectory: "isolated";
  readonly network: "denied";
  readonly executionPlatform: string;
  readonly target: string;
  readonly deterministic: boolean;
  readonly cacheable: boolean;
  /**
   * Whether this action writes a Make-style dependency list to its
   * `dependency-path` argument. Required for a cacheable action that reads
   * undeclared files, and meaningless without one.
   */
  readonly recordsDependencies?: boolean;
}

export interface ArtifactGraph {
  readonly schema: "native-typescript.artifact-graph";
  readonly schemaVersion: 2;
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
  "metadata",
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
        : argument.kind === "dependency-path"
        ? Object.freeze({ kind: argument.kind })
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
    standardOutput: action.standardOutput.kind === "report"
      ? Object.freeze({ kind: "report" })
      : Object.freeze({
          kind: "artifact",
          artifact: action.standardOutput.artifact,
        }),
    workingDirectory: action.workingDirectory,
    network: action.network,
    executionPlatform: action.executionPlatform,
    target: action.target,
    deterministic: action.deterministic,
    cacheable: action.cacheable,
    ...(action.recordsDependencies === true
      ? { recordsDependencies: true as const }
      : {}),
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
    const capturedStandardOutput = action.standardOutput.kind === "artifact"
      ? action.standardOutput.artifact
      : null;
    if (
      capturedStandardOutput !== null &&
      !action.outputs.includes(capturedStandardOutput)
    ) {
      diagnostics.push(
        diagnostic(
          "NTS2008",
          `${path}.standardOutput.artifact`,
          `${capturedStandardOutput} is not a declared output artifact`,
        ),
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
      } else if (argument.kind === "dependency-path") {
        if (action.recordsDependencies !== true) {
          diagnostics.push(diagnostic(
            "NTS2008",
            `${path}.arguments[${argumentIndex}]`,
            "A dependency-path argument requires recordsDependencies",
          ));
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
      if (action.cacheable && artifact?.cache === "none") {
        diagnostics.push(
          diagnostic(
            "NTS2007",
            `${path}.outputs`,
            `Cacheable action output ${output} must opt into local or exportable storage`,
          ),
        );
      }
      const hasOutputPath = action.arguments.some(
        (argument) => argument.kind === "output-path" && argument.artifact === output,
      );
      if (capturedStandardOutput === output) {
        if (artifact !== undefined && artifact.entryType !== "file") {
          diagnostics.push(
            diagnostic(
              "NTS2008",
              `${path}.standardOutput.artifact`,
              "Captured standard output requires a file artifact",
            ),
          );
        }
        if (hasOutputPath) {
          diagnostics.push(
            diagnostic(
              "NTS2008",
              `${path}.standardOutput.artifact`,
              `Captured standard output ${output} cannot also be a command output-path`,
            ),
          );
        }
      } else if (!hasOutputPath) {
        diagnostics.push(
          diagnostic(
            "NTS2008",
            `${path}.outputs`,
            `Output ${output} has neither an output-path argument nor standard-output capture`,
          ),
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
    schemaVersion: 2,
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
  readonly cache?: ArtifactCacheBinding;
  readonly maxConcurrency?: number;
  /**
   * How long one action may run before it is killed, in milliseconds.
   *
   * Execution policy rather than action definition, deliberately. A timeout
   * does not change what an action PRODUCES, so putting it in the definition
   * would make two builds of the same artifact disagree about its identity
   * for a reason that has nothing to do with its content.
   *
   * Omitted means no deadline, which is what a build under a human's
   * attention wants and what an unattended one must not have: a wedged
   * compiler otherwise blocks its executor forever, and the graph reports
   * nothing at all rather than one failed action.
   */
  readonly actionTimeoutMs?: number;
  /**
   * How many bytes of an action's captured stdout and stderr are kept, each.
   *
   * A build process holding a tool's whole output in a string is one noisy
   * action away from exhausting its own heap, and the diagnostic value of a
   * hundred megabytes of repeated warnings is nil. Beyond the bound the
   * capture is truncated and SAYS it was, because output that silently stops
   * is worse than output that stops and admits it.
   *
   * Defaults to 8 MiB per stream. Standard output redirected to an artifact
   * is unaffected: it streams to disk and is bounded by the filesystem.
   */
  readonly maximumCapturedBytes?: number;
  /** Cancels the whole execution. Actions already running are killed. */
  readonly signal?: AbortSignal;
}

/** Kept per stream, per action. Generous enough that no honest tool reaches
 * it, small enough that a runaway one cannot exhaust the build process. */
const DEFAULT_MAXIMUM_CAPTURED_BYTES = 8 * 1024 * 1024;

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
  readonly status: "executed" | "cached";
  readonly cacheKey: string | null;
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

async function verifyToolBinding(
  action: ArtifactActionDefinition,
  tools: Readonly<Record<string, ArtifactToolBinding>>,
): Promise<ArtifactToolBinding> {
  const tool = tools[action.tool.id];
  if (tool === undefined) {
    throw new ArtifactExecutionError(`No tool binding was supplied for ${action.tool.id}`, {
      actionId: action.id,
    });
  }
  if (!isAbsolute(tool.path)) {
    throw new ArtifactExecutionError(
      `Tool ${action.tool.id} requires an absolute executable path`,
      { actionId: action.id },
    );
  }
  let file;
  try {
    file = await stat(tool.path);
  } catch {
    throw new ArtifactExecutionError(
      `Tool ${action.tool.id} does not exist at ${tool.path}`,
      { actionId: action.id },
    );
  }
  if (!file.isFile()) {
    throw new ArtifactExecutionError(`Tool ${action.tool.id} is not a regular file`, {
      actionId: action.id,
    });
  }
  const content = await digestArtifactPath(tool.path, "file");
  if (content.digest !== action.tool.digest) {
    throw new ArtifactExecutionError(
      `Tool ${action.tool.id} digest mismatch: expected ${action.tool.digest}, received ${content.digest}`,
      { actionId: action.id },
    );
  }
  return tool;
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
  readonly standardOutputPath: string | null;
  readonly timeoutMs: number | undefined;
  readonly maximumCapturedBytes: number;
  readonly signal: AbortSignal | undefined;
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
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let processComplete = false;
    let standardOutputComplete = options.standardOutputPath === null;
    let settled = false;
    /* Killing bwrap ends the tree: --die-with-parent sets PR_SET_PDEATHSIG on
     * the process it supervises, and --new-session keeps that tree out of
     * this process's session. */
    const stopWaiting = (): void => {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", cancel);
    };
    const succeedIfComplete = (): void => {
      if (!settled && processComplete && standardOutputComplete) {
        settled = true;
        stopWaiting();
        resolve({ stdout, stderr });
      }
    };
    const fail = (error: ArtifactExecutionError): void => {
      if (settled) return;
      settled = true;
      stopWaiting();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      reject(error);
    };
    const cancel = (): void => {
      fail(
        new ArtifactExecutionError(
          `Action ${options.actionId} was cancelled`,
          { actionId: options.actionId, stdout, stderr },
        ),
      );
    };
    const deadline = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          fail(
            new ArtifactExecutionError(
              `Action ${options.actionId} exceeded its ${options.timeoutMs}ms deadline`,
              { actionId: options.actionId, stdout, stderr },
            ),
          );
        }, options.timeoutMs);
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        cancel();
        return;
      }
      options.signal.addEventListener("abort", cancel, { once: true });
    }
    /* Truncation announces itself. Output that silently stops is worse than
     * output that stops and says why, because the reader spends the
     * difference looking for a cause that is not in the log. */
    const capture = (
      current: string,
      chunk: string,
      truncated: boolean,
    ): { text: string; truncated: boolean } => {
      if (truncated) return { text: current, truncated };
      const room = options.maximumCapturedBytes - Buffer.byteLength(current, "utf8");
      if (Buffer.byteLength(chunk, "utf8") <= room) {
        return { text: current + chunk, truncated: false };
      }
      return {
        text: `${current}${chunk.slice(0, Math.max(0, room))}\n` +
          `[truncated at ${options.maximumCapturedBytes} bytes]\n`,
        truncated: true,
      };
    };

    if (options.standardOutputPath === null) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        const next = capture(stdout, chunk, stdoutTruncated);
        stdout = next.text;
        stdoutTruncated = next.truncated;
      });
    } else {
      const standardOutput = createWriteStream(options.standardOutputPath, {
        flags: "wx",
      });
      child.stdout.pipe(standardOutput);
      standardOutput.on("close", () => {
        standardOutputComplete = true;
        succeedIfComplete();
      });
      standardOutput.on("error", (error) => {
        child.kill();
        fail(
          new ArtifactExecutionError(
            `Action ${options.actionId} could not capture standard output: ${error.message}`,
            { actionId: options.actionId, stdout, stderr },
          ),
        );
      });
    }
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const next = capture(stderr, chunk, stderrTruncated);
      stderr = next.text;
      stderrTruncated = next.truncated;
    });
    child.on("error", (error) => {
      fail(
        new ArtifactExecutionError(
          `Action ${options.actionId} could not start sandbox ${options.sandbox.path}: ${error.message}`,
          { actionId: options.actionId, stdout, stderr },
        ),
      );
    });
    child.on("close", (code, signal) => {
      if (code === 0 && signal === null) {
        processComplete = true;
        succeedIfComplete();
      } else {
        fail(
          new ArtifactExecutionError(
            `Action ${options.actionId} failed with ${signal === null ? `exit code ${code}` : `signal ${signal}`}`,
            { actionId: options.actionId, stdout, stderr },
          ),
        );
      }
    });
  });
}

interface ArtifactActionLayout {
  readonly actionRoot: string;
  readonly inputRoot: string;
  readonly outputRoot: string;
  readonly temporaryRoot: string;
  readonly outputPaths: ReadonlyMap<string, string>;
}

function artifactActionLayout(options: {
  readonly action: ArtifactActionDefinition;
  readonly artifactsById: ReadonlyMap<string, ArtifactDefinition>;
  readonly buildRoot: string;
}): ArtifactActionLayout {
  const actionRoot = join(
    options.buildRoot,
    "actions",
    physicalName(options.action.id, "action"),
  );
  const outputRoot = join(actionRoot, "outputs");
  const outputPaths = new Map<string, string>();
  for (const outputId of options.action.outputs) {
    const definition = options.artifactsById.get(outputId);
    if (definition === undefined) {
      throw new ArtifactExecutionError(
        `Action ${options.action.id} lost output ${outputId}`,
        { actionId: options.action.id },
      );
    }
    outputPaths.set(
      outputId,
      join(outputRoot, physicalName(outputId, definition.origin.fileName)),
    );
  }
  return Object.freeze({
    actionRoot,
    inputRoot: join(actionRoot, "inputs"),
    outputRoot,
    temporaryRoot: join(actionRoot, "temporary"),
    outputPaths,
  });
}

async function executeAction(options: {
  readonly action: ArtifactActionDefinition;
  readonly artifactsById: ReadonlyMap<string, ArtifactDefinition>;
  readonly materialized: ReadonlyMap<string, MaterializedArtifact>;
  readonly layout: ArtifactActionLayout;
  readonly tool: ArtifactToolBinding;
  readonly sandbox: ArtifactSandboxBinding;
  readonly cacheKey: string | null;
  readonly timeoutMs: number | undefined;
  readonly maximumCapturedBytes: number;
  readonly signal: AbortSignal | undefined;
}): Promise<ArtifactActionReport> {
  const { action } = options;
  await mkdir(options.layout.inputRoot, { recursive: true });
  await mkdir(options.layout.outputRoot, { recursive: true });
  await mkdir(options.layout.temporaryRoot, { recursive: true });

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
      options.layout.inputRoot,
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

  const dependencyPath = join(options.layout.temporaryRoot, "action.d");
  const commandArguments = action.arguments.map((argument) => {
    if (argument.kind === "literal") return argument.value;
    if (argument.kind === "dependency-path") return dependencyPath;
    const artifactPath = argument.kind === "input-path"
      ? inputPaths.get(argument.artifact)
      : options.layout.outputPaths.get(argument.artifact);
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
  const standardOutputPath = action.standardOutput.kind === "artifact"
    ? options.layout.outputPaths.get(action.standardOutput.artifact) ?? null
    : null;
  if (
    action.standardOutput.kind === "artifact" &&
    standardOutputPath === null
  ) {
    throw new ArtifactExecutionError(
      `Action ${action.id} could not resolve standard-output artifact ${action.standardOutput.artifact}`,
      { actionId: action.id },
    );
  }
  const started = process.hrtime.bigint();
  const command = await runCommand({
    executable: options.tool.path,
    arguments: commandArguments,
    cwd: options.layout.actionRoot,
    environment,
    actionId: action.id,
    sandbox: options.sandbox,
    standardOutputPath,
    timeoutMs: options.timeoutMs,
    maximumCapturedBytes: options.maximumCapturedBytes,
    signal: options.signal,
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;

  const expectedEntries = new Map(
    action.outputs.map((outputId) => {
      const definition = options.artifactsById.get(outputId)!;
      return [
        basename(options.layout.outputPaths.get(outputId)!),
        definition.entryType,
      ] as const;
    }),
  );
  const actualEntries = await readdir(options.layout.outputRoot, { withFileTypes: true });
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
    const path = options.layout.outputPaths.get(outputId)!;
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
    cacheKey: options.cacheKey,
    durationMs,
    ...command,
    outputs: Object.freeze(outputs),
  });
}

/**
 * The files a tool read that the graph never declared.
 *
 * A Make-style dependency list names everything the compiler opened. Paths
 * under the action's own root are its declared inputs, already keyed by digest
 * and gone once the action root is removed, so only what lies outside it is
 * recorded — in practice the system headers and the toolchain's own.
 */
async function undeclaredDependencies(
  dependencyPath: string,
  actionRoot: string,
): Promise<readonly UndeclaredDependency[] | null> {
  let text: string;
  try {
    text = await readFile(dependencyPath, "utf8");
  } catch {
    /* No list means nothing can be validated later, so the action must not be
     * published as reusable. */
    return null;
  }
  const paths = new Set<string>();
  for (const rule of text.replaceAll("\\\n", " ").split("\n")) {
    const body = rule.slice(rule.indexOf(":") + 1);
    if (!rule.includes(":")) continue;
    for (const token of body.split(/\s+/u)) {
      if (token.length === 0 || !isAbsolute(token)) continue;
      if (token === actionRoot || token.startsWith(`${actionRoot}/`)) continue;
      paths.add(token);
    }
  }
  const recorded: UndeclaredDependency[] = [];
  for (const path of [...paths].sort(compareText)) {
    try {
      const content = await digestArtifactPath(path, "file");
      recorded.push(Object.freeze({ path, digest: content.digest }));
    } catch {
      /* A file that cannot be digested cannot be revalidated. Refusing to
       * publish is the conservative direction: a miss costs time, a wrongly
       * reused entry costs correctness. */
      return null;
    }
  }
  return Object.freeze(recorded);
}

async function executeOrRestoreAction(options: {
  readonly action: ArtifactActionDefinition;
  readonly artifactsById: ReadonlyMap<string, ArtifactDefinition>;
  readonly materialized: ReadonlyMap<string, MaterializedArtifact>;
  readonly buildRoot: string;
  readonly cache: PreparedArtifactCache | null;
  readonly resolveTool: () => Promise<ArtifactToolBinding>;
  readonly sandbox: ArtifactSandboxBinding;
  readonly timeoutMs: number | undefined;
  readonly maximumCapturedBytes: number;
  readonly signal: AbortSignal | undefined;
}): Promise<ArtifactActionReport> {
  const context = {
    action: options.action,
    artifactsById: options.artifactsById,
    materialized: options.materialized,
  } as const;
  const cacheKey = options.action.cacheable
    ? computeActionCacheKey(context)
    : null;
  const layout = artifactActionLayout(options);
  if (options.cache !== null && cacheKey !== null) {
    const started = process.hrtime.bigint();
    const restored = await restoreActionFromCache({
      cache: options.cache,
      context,
      cacheKey,
      outputPaths: layout.outputPaths,
    });
    if (restored !== null) {
      return Object.freeze({
        id: options.action.id,
        status: "cached",
        cacheKey,
        durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
        stdout: restored.stdout,
        stderr: restored.stderr,
        outputs: restored.outputs,
      });
    }
  }

  const report = await executeAction({
    action: options.action,
    artifactsById: options.artifactsById,
    materialized: options.materialized,
    layout,
    tool: await options.resolveTool(),
    sandbox: options.sandbox,
    timeoutMs: options.timeoutMs,
    maximumCapturedBytes: options.maximumCapturedBytes,
    signal: options.signal,
    cacheKey,
  });
  if (options.cache !== null && cacheKey !== null) {
    const dependencies = options.action.recordsDependencies === true
      ? await undeclaredDependencies(
          join(layout.temporaryRoot, "action.d"),
          layout.actionRoot,
        )
      : Object.freeze([]);
    if (dependencies !== null) {
      await publishActionToCache({
        cache: options.cache,
        context,
        cacheKey,
        stdout: report.stdout,
        stderr: report.stderr,
        outputs: report.outputs,
        dependencies,
      });
    }
  }
  return report;
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
  /* Refused rather than clamped. A caller asking for a zero or fractional
   * deadline has a bug, and silently substituting a working value hides it
   * until the build behaves in a way the caller cannot explain. */
  if (
    options.actionTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.actionTimeoutMs) || options.actionTimeoutMs <= 0)
  ) {
    throw new ArtifactExecutionError(
      "actionTimeoutMs must be a positive safe integer of milliseconds",
    );
  }
  if (
    options.maximumCapturedBytes !== undefined &&
    (!Number.isSafeInteger(options.maximumCapturedBytes) ||
      options.maximumCapturedBytes <= 0)
  ) {
    throw new ArtifactExecutionError(
      "maximumCapturedBytes must be a positive safe integer",
    );
  }
  await mkdir(options.buildRoot, { recursive: false });
  const buildRoot = await realpath(options.buildRoot);
  const cache = options.cache === undefined
    ? null
    : await prepareArtifactCache(options.cache);
  const verifiedTools = new Map<string, Promise<ArtifactToolBinding>>();
  const resolveTool = (action: ArtifactActionDefinition): Promise<ArtifactToolBinding> => {
    const existing = verifiedTools.get(action.tool.id);
    if (existing !== undefined) return existing;
    const verification = verifyToolBinding(action, options.tools);
    verifiedTools.set(action.tool.id, verification);
    return verification;
  };

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
          return await executeOrRestoreAction({
            action,
            artifactsById,
            materialized,
            buildRoot,
            cache,
            resolveTool: async () => await resolveTool(action),
            sandbox: options.sandbox,
            timeoutMs: options.actionTimeoutMs,
            maximumCapturedBytes:
              options.maximumCapturedBytes ?? DEFAULT_MAXIMUM_CAPTURED_BYTES,
            signal: options.signal,
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
