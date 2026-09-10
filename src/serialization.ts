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

/** Tagged tuples avoid collisions between user objects and codec markers. */
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

export function clone<T>(value: T): T {
  // The codec preserves every supported value's runtime representation; unsupported values fail.
  return decode(encode(value)) as T;
}

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
