import { canonicalizeJson } from "@native-typescript/scabi";
import type { Sha256Digest } from "@native-typescript/scabi";

export const CHROMIUM_WEBIDL_INPUT_SCHEMA_VERSION = 1 as const;

export interface ChromiumWebIdlInput {
  readonly schemaVersion: typeof CHROMIUM_WEBIDL_INPUT_SCHEMA_VERSION;
  readonly chromiumRevision: string;
  readonly webIdlDatabaseDigest: Sha256Digest;
  readonly typescriptLibraryDigest: Sha256Digest;
}

const chromiumRevisionPattern = /^[0-9a-f]{40}$/u;
const sha256DigestPattern = /^sha256:[0-9a-f]{64}$/u;
const chromiumWebIdlInputKeys = Object.freeze([
  "chromiumRevision",
  "schemaVersion",
  "typescriptLibraryDigest",
  "webIdlDatabaseDigest",
]);

function assertSha256Digest(value: string, path: string): asserts value is Sha256Digest {
  if (!sha256DigestPattern.test(value)) {
    throw new TypeError(`${path} must be a lowercase sha256 digest`);
  }
}

/**
 * Captures the two semantic authorities a WebIDL projection was generated
 * from. This is bindgen input/provenance, not a second compiler-facing native
 * vocabulary: generated declarations and SCABI remain the ScriptC boundary.
 */
export function defineChromiumWebIdlInput(
  input: ChromiumWebIdlInput,
): ChromiumWebIdlInput {
  const keys = Object.keys(input).sort();
  if (
    keys.length !== chromiumWebIdlInputKeys.length ||
    keys.some((key, index) => key !== chromiumWebIdlInputKeys[index])
  ) {
    throw new TypeError(
      `Chromium WebIDL input fields must be exactly: ${chromiumWebIdlInputKeys.join(", ")}`,
    );
  }
  if (input.schemaVersion !== CHROMIUM_WEBIDL_INPUT_SCHEMA_VERSION) {
    throw new TypeError(
      `Unsupported Chromium WebIDL input schema: ${input.schemaVersion}`,
    );
  }
  if (!chromiumRevisionPattern.test(input.chromiumRevision)) {
    throw new TypeError("chromiumRevision must be a lowercase 40-character commit");
  }
  assertSha256Digest(input.webIdlDatabaseDigest, "webIdlDatabaseDigest");
  assertSha256Digest(input.typescriptLibraryDigest, "typescriptLibraryDigest");

  return Object.freeze({
    schemaVersion: input.schemaVersion,
    chromiumRevision: input.chromiumRevision,
    webIdlDatabaseDigest: input.webIdlDatabaseDigest,
    typescriptLibraryDigest: input.typescriptLibraryDigest,
  });
}

export function serializeChromiumWebIdlInput(
  input: ChromiumWebIdlInput,
): string {
  return `${canonicalizeJson(defineChromiumWebIdlInput(input))}\n`;
}
