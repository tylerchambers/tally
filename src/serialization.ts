import { createHash } from "node:crypto";
import { z } from "zod";
import { LedgerError } from "./errors.ts";
import type { StoredEnvelope } from "./store.ts";

type Encoded =
  | readonly ["null"]
  | readonly ["boolean", boolean]
  | readonly ["string", string]
  | readonly ["number" | "bigint" | "date", string]
  | readonly ["array", readonly Encoded[]]
  | readonly ["object", readonly (readonly [string, Encoded])[]];

const nodeSchema: z.ZodType<Encoded> = z.lazy(() =>
  z.union([
    z.tuple([z.literal("null")]),
    z.tuple([z.literal("boolean"), z.boolean()]),
    z.tuple([z.literal("string"), z.string()]),
    z.tuple([z.literal("number"), z.string()]),
    z.tuple([z.literal("bigint"), z.string().regex(/^(0|-?[1-9]\d*)$/)]),
    z.tuple([z.literal("date"), z.iso.datetime({ precision: 3 })]),
    z.tuple([z.literal("array"), z.array(nodeSchema)]),
    z.tuple([z.literal("object"), z.array(z.tuple([z.string(), nodeSchema]))]),
  ]),
);

/**
 * Encodes data canonically so equal content has stable persistence and hashes.
 * Tagged tuples prevent user objects from colliding with codec markers; sorted
 * object keys remove insertion-order differences, while bigint, Date, and -0
 * retain their value distinctions.
 *
 * Supports null, booleans, strings, finite numbers, bigint, valid dates, dense
 * arrays, and plain objects with enumerable data properties. Throws VALIDATION
 * for unsupported values, cycles, sparse arrays, unsupported properties, or
 * nesting beyond depth 128. Undefined, functions, symbols, nonfinite numbers,
 * invalid dates, and non-Date class instances are not persistable.
 */
export function encode(value: unknown): string {
  return JSON.stringify(toEncoded(value, new WeakSet(), 0));
}

function toEncoded(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): Encoded {
  if (depth > 128)
    throw new LedgerError(
      "VALIDATION",
      "Value exceeds maximum serialization depth",
    );
  if (value === null) return ["null"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (typeof value === "number" && Number.isFinite(value)) {
    return ["number", Object.is(value, -0) ? "-0" : value.toString()];
  }
  if (value instanceof Date && Number.isFinite(value.getTime()))
    return ["date", value.toISOString()];
  if (typeof value !== "object" || value === null) {
    throw new LedgerError(
      "VALIDATION",
      "Only finite numbers, bigint, dates, and JSON values can be persisted",
    );
  }
  if (ancestors.has(value))
    throw new LedgerError("VALIDATION", "Cyclic values cannot be persisted");
  ancestors.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new LedgerError(
        "VALIDATION",
        "Symbol properties cannot be persisted",
      );
    }
    if (Array.isArray(value)) {
      const items: Encoded[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index))
          throw new LedgerError(
            "VALIDATION",
            "Sparse arrays cannot be persisted",
          );
        items.push(toEncoded(value[index], ancestors, depth + 1));
      }
      if (Object.keys(value).length !== value.length)
        throw new LedgerError(
          "VALIDATION",
          "Array properties cannot be persisted",
        );
      return ["array", items];
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new LedgerError(
        "VALIDATION",
        "Only plain data objects can be persisted",
      );
    }
    const fields: [string, Encoded][] = [];
    for (const key of Object.getOwnPropertyNames(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new LedgerError(
          "VALIDATION",
          "Only enumerable data properties can be persisted",
        );
      }
      fields.push([key, toEncoded(descriptor.value, ancestors, depth + 1)]);
    }
    return ["object", fields];
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Decodes canonical codec output, not arbitrary JSON.
 * Throws VALIDATION for invalid or noncanonical text, including alternative
 * key ordering or whitespace, so persisted representations stay unambiguous.
 */
export function decode(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    const result = fromEncoded(nodeSchema.parse(parsed));
    if (encode(result) !== text)
      throw new LedgerError("VALIDATION", "Non-canonical persisted encoding");
    return result;
  } catch (cause) {
    if (cause instanceof LedgerError) throw cause;
    throw new LedgerError("VALIDATION", "Invalid persisted encoding", {
      cause,
    });
  }
}

function fromEncoded(node: Encoded): unknown {
  switch (node[0]) {
    case "null":
      return null;
    case "boolean":
    case "string":
      return node[1];
    case "bigint":
      return BigInt(node[1]);
    case "date":
      return new Date(node[1]);
    case "number": {
      const value = Number(node[1]);
      if (!Number.isFinite(value))
        throw new LedgerError("VALIDATION", "Invalid encoded number");
      return value;
    }
    case "array":
      return node[1].map(fromEncoded);
    case "object": {
      const entries: [string, unknown][] = [];
      const names = new Set<string>();
      for (const [key, value] of node[1]) {
        if (names.has(key))
          throw new LedgerError("VALIDATION", "Duplicate encoded object key");
        names.add(key);
        entries.push([key, fromEncoded(value)]);
      }
      return Object.fromEntries(entries);
    }
  }
}

/**
 * Returns a detached codec round-trip without freezing the result.
 * Preserves encoded values, not object identity or null prototypes. Dates retain
 * only timestamps and arrays only indexed values; rejected inputs throw VALIDATION.
 */
export function clone<T>(value: T): T {
  // The generic assertion is confined to the codec's supported value contract.
  return decode(encode(value)) as T;
}

/**
 * Returns the canonical envelope's SHA-256 hex digest for idempotency.
 * Includes IDs, event, metadata, and effectiveAt; excludes revision, entries,
 * recordedAt, and projection totals so retries can reuse their original result.
 * This is content identity, not an authenticity signature.
 */
export function fingerprint(envelope: StoredEnvelope): string {
  const content: StoredEnvelope = {
    id: envelope.id,
    accountId: envelope.accountId,
    event: envelope.event,
    ...(envelope.effectiveAt === undefined
      ? {}
      : { effectiveAt: envelope.effectiveAt }),
    ...(envelope.metadata === undefined ? {} : { metadata: envelope.metadata }),
  };
  return createHash("sha256").update(encode(content)).digest("hex");
}
