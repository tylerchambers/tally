import { z } from "zod";
import { LedgerError } from "./errors.ts";
import {
  accountId,
  commoditySchema as commodity,
  eventId,
  nameSchema as identifier,
  entrySchema as posting,
} from "./primitives.ts";
import { clone, encode, fingerprint } from "./serialization.ts";
import type {
  AccountId,
  BalanceVector,
  Commit,
  Head,
  JournalRecord,
  StoredAmount,
  StoredEntry,
} from "./store.ts";

const amount = z.strictObject({ commodity, atomic: z.bigint() });
const vector = z.record(identifier, amount);
const record = z.strictObject({
  id: z.string().transform(eventId),
  accountId: z.string().transform(accountId),
  event: z.strictObject({
    type: identifier,
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    payload: z.unknown(),
  }),
  effectiveAt: z.date().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  revision: z.bigint().positive(),
  entries: z.array(posting).min(1),
  recordedAt: z.date(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

/**
 * Returns a detached, structurally valid record with a verified envelope hash.
 * Throws VALIDATION for malformed or unpersistable data; does not replay rules
 * or verify the record's position within an account's history.
 */
export function parseRecord(value: unknown): JournalRecord {
  try {
    const parsed = record.parse(clone(value));
    if (!Object.hasOwn(parsed.event, "payload"))
      throw new LedgerError("VALIDATION", "Event payload is required");
    const result: JournalRecord = {
      id: parsed.id,
      accountId: parsed.accountId,
      event: parsed.event,
      revision: parsed.revision,
      entries: parsed.entries,
      recordedAt: parsed.recordedAt,
      fingerprint: parsed.fingerprint,
      ...(parsed.effectiveAt === undefined
        ? {}
        : { effectiveAt: parsed.effectiveAt }),
      ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
    };
    if (fingerprint(result) !== result.fingerprint)
      throw new LedgerError(
        "VALIDATION",
        "Event fingerprint does not match content",
      );
    return result;
  } catch (cause) {
    if (cause instanceof LedgerError) throw cause;
    throw new LedgerError("VALIDATION", "Invalid journal record", { cause });
  }
}

/**
 * Returns a detached projection with valid balance names and exact amounts.
 * Throws VALIDATION for malformed data; does not prove agreement with history.
 */
export function parseVector(value: unknown): BalanceVector {
  try {
    return vector.parse(clone(value));
  } catch (cause) {
    if (cause instanceof LedgerError) throw cause;
    throw new LedgerError("VALIDATION", "Invalid balance projection", {
      cause,
    });
  }
}

/**
 * Returns new totals by subtracting debits and adding credits in entry order.
 * Throws VALIDATION for invalid entries or a balance's commodity changing;
 * negative totals remain valid because limits belong to ledger rules.
 */
export function foldEntries(
  balances: BalanceVector,
  entries: readonly StoredEntry[],
): BalanceVector {
  const result: Record<string, StoredAmount> = { ...parseVector(balances) };
  let validated: StoredEntry[];
  try {
    validated = z.array(posting).parse(entries);
  } catch (cause) {
    throw new LedgerError("VALIDATION", "Invalid accounting entries", {
      cause,
    });
  }
  for (const entry of validated) {
    for (const [definition, delta] of [
      [entry.debit, -entry.amount.atomic],
      [entry.credit, entry.amount.atomic],
    ] as const) {
      const previous = Object.hasOwn(result, definition.name)
        ? result[definition.name]
        : undefined;
      if (previous && previous.commodity !== definition.commodity) {
        throw new LedgerError(
          "VALIDATION",
          `Commodity changed for balance ${definition.name}`,
        );
      }
      Object.defineProperty(result, definition.name, {
        value: {
          commodity: definition.commodity,
          atomic: (previous?.atomic ?? 0n) + delta,
        },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return result;
}

/**
 * Validates and detaches a new append against the current head and entry fold.
 * Adapters must first resolve idempotency, then call this under their atomic
 * revision guard; this helper neither acquires locks nor persists anything.
 * Allows new zero balances, but rejects missing projections with
 * PROJECTION_MISSING, stale heads with CONCURRENCY, and bad commits with VALIDATION.
 */
export function validateCommit(
  accountId: AccountId,
  expectedRevision: bigint,
  commit: Commit,
  current: Head,
): Commit {
  const candidate = parseRecord(commit.record);
  const proposed = parseVector(commit.balances);
  if (
    typeof expectedRevision !== "bigint" ||
    expectedRevision < 0n ||
    candidate.accountId !== accountId ||
    candidate.revision !== expectedRevision + 1n
  ) {
    throw new LedgerError(
      "VALIDATION",
      "Commit account or revision does not match its expectation",
    );
  }
  if (current.revision !== expectedRevision)
    throw new LedgerError("CONCURRENCY", "Account revision changed");
  if (current.balances === null)
    throw new LedgerError(
      "PROJECTION_MISSING",
      "Rebuild the missing projection before recording events",
    );
  const base: Record<string, StoredAmount> = {
    ...parseVector(current.balances),
  };
  for (const [name, value] of Object.entries(proposed)) {
    if (!Object.hasOwn(base, name)) {
      Object.defineProperty(base, name, {
        value: { commodity: value.commodity, atomic: 0n },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  if (encode(foldEntries(base, candidate.entries)) !== encode(proposed)) {
    throw new LedgerError(
      "VALIDATION",
      "Proposed balances do not equal the committed entry fold",
    );
  }
  return { record: candidate, balances: proposed };
}

/**
 * Throws IDEMPOTENCY_CONFLICT when a previously found event has different content.
 * Callers must look up the global event ID and compute the incoming fingerprint;
 * this comparison deliberately ignores revision and derived results.
 */
export function assertIdempotent(
  existing: JournalRecord,
  expectedFingerprint: string,
): void {
  if (existing.fingerprint !== expectedFingerprint) {
    throw new LedgerError(
      "IDEMPOTENCY_CONFLICT",
      `Event ID ${existing.id} has already been committed with different content`,
    );
  }
}
