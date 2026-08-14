import { createHash } from "node:crypto";
import type { ScabiManifest, Sha256Digest } from "./model.ts";

function validateUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Canonical JSON cannot contain an unpaired surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("Canonical JSON cannot contain an unpaired surrogate");
    }
  }
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new TypeError("Canonical JSON cannot contain a non-finite number");
      }
      return JSON.stringify(value);
    }
    case "string":
      validateUnicode(value);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`Canonical JSON cannot contain ${typeof value}`);
  }

  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON cannot contain a cycle");
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("Canonical JSON cannot contain a sparse array");
        }
        items.push(serialize(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON objects must have a plain prototype");
    }

    const record = value as Record<string, unknown>;
    const properties = Object.keys(record)
      .sort()
      .map((key) => {
        validateUnicode(key);
        return `${JSON.stringify(key)}:${serialize(record[key], ancestors)}`;
      });
    return `{${properties.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeJson(value: unknown): string {
  return serialize(value, new Set());
}

export function digestScabiManifest(manifest: ScabiManifest): Sha256Digest {
  const digest = createHash("sha256")
    .update(canonicalizeJson(manifest), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}
