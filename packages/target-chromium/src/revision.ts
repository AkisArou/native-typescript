import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ChromiumRevision {
  readonly repository: string;
  readonly revision: string;
  readonly observedAt: string;
  readonly purpose: string;
}

export class ChromiumRevisionError extends Error {
  override readonly name = "ChromiumRevisionError";
}

const revisionPattern = /^[0-9a-f]{40}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const revisionKeys = Object.freeze([
  "observedAt",
  "purpose",
  "repository",
  "revision",
]);

function requiredString(
  value: Record<string, unknown>,
  key: keyof ChromiumRevision,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0 || field.trim() !== field) {
    throw new ChromiumRevisionError(`${key} must be a non-empty string`);
  }
  return field;
}

export function parseChromiumRevision(value: unknown): ChromiumRevision {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ChromiumRevisionError("Chromium revision must be an object");
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== revisionKeys.length ||
    keys.some((key, index) => key !== revisionKeys[index])
  ) {
    throw new ChromiumRevisionError(
      `Chromium revision fields must be exactly: ${revisionKeys.join(", ")}`,
    );
  }
  const repository = requiredString(record, "repository");
  const revision = requiredString(record, "revision");
  const observedAt = requiredString(record, "observedAt");
  const purpose = requiredString(record, "purpose");

  if (!URL.canParse(repository)) {
    throw new ChromiumRevisionError("repository must be an absolute URL");
  }
  if (!revisionPattern.test(revision)) {
    throw new ChromiumRevisionError(
      "revision must be a lowercase 40-character commit",
    );
  }
  if (!datePattern.test(observedAt)) {
    throw new ChromiumRevisionError("observedAt must use YYYY-MM-DD");
  }

  return Object.freeze({ repository, revision, observedAt, purpose });
}

export function readPinnedChromiumRevision(
  path = resolve(import.meta.dirname, "../chromium/revision.json"),
): ChromiumRevision {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new ChromiumRevisionError(
      `Could not read Chromium revision at ${path}: ${String(error)}`,
    );
  }
  return parseChromiumRevision(value);
}
