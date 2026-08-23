import assert from "node:assert/strict";
import test from "node:test";
import {
  CHROMIUM_WEBIDL_INPUT_SCHEMA_VERSION,
  defineChromiumWebIdlInput,
  serializeChromiumWebIdlInput,
} from "@native-typescript/bindgen-webidl";

const zeroDigest = `sha256:${"0".repeat(64)}` as const;
const oneDigest = `sha256:${"1".repeat(64)}` as const;

test("Chromium WebIDL input pins both implementation and source authorities", () => {
  const input = defineChromiumWebIdlInput({
    schemaVersion: CHROMIUM_WEBIDL_INPUT_SCHEMA_VERSION,
    chromiumRevision: "96324a4012fe62f48b9463a67486eeb645bc5c78",
    webIdlDatabaseDigest: zeroDigest,
    typescriptLibraryDigest: oneDigest,
  });

  assert.equal(Object.isFrozen(input), true);
  assert.equal(
    serializeChromiumWebIdlInput(input),
    `{"chromiumRevision":"96324a4012fe62f48b9463a67486eeb645bc5c78","schemaVersion":1,"typescriptLibraryDigest":"${oneDigest}","webIdlDatabaseDigest":"${zeroDigest}"}\n`,
  );
});

test("Chromium WebIDL provenance rejects ambiguous identities", () => {
  assert.throws(
    () =>
      defineChromiumWebIdlInput({
        schemaVersion: CHROMIUM_WEBIDL_INPUT_SCHEMA_VERSION,
        chromiumRevision: "main",
        webIdlDatabaseDigest: zeroDigest,
        typescriptLibraryDigest: oneDigest,
      }),
    /lowercase 40-character commit/u,
  );
  assert.throws(
    () =>
      defineChromiumWebIdlInput({
        schemaVersion: CHROMIUM_WEBIDL_INPUT_SCHEMA_VERSION,
        chromiumRevision: "96324a4012fe62f48b9463a67486eeb645bc5c78",
        webIdlDatabaseDigest: "sha256:not-a-digest" as never,
        typescriptLibraryDigest: oneDigest,
      }),
    /lowercase sha256 digest/u,
  );
  assert.throws(
    () =>
      defineChromiumWebIdlInput({
        schemaVersion: CHROMIUM_WEBIDL_INPUT_SCHEMA_VERSION,
        chromiumRevision: "96324a4012fe62f48b9463a67486eeb645bc5c78",
        webIdlDatabaseDigest: zeroDigest,
        typescriptLibraryDigest: oneDigest,
        unversionedInput: true,
      } as never),
    /fields must be exactly/u,
  );
});
