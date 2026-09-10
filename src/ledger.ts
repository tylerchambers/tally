import { z } from "zod";
import { LedgerError } from "./errors.ts";
import { type EventCatalog, type EventsOf, resolveVersion } from "./events.ts";
import {
  accountId,
  amount,
  type BalanceDefinitions,
  type Balances,
  defineBalances,
  eventId,
  parse,
  parseBalances,
  parseEntry,
} from "./primitives.ts";
import { clone, encode, fingerprint } from "./serialization.ts";
import {
  assertIdempotent,
  foldEntries,
  parseRecord,
  parseVector,
} from "./storage-validation.ts";
import type {
  AccountId,
  Head,
  JournalRange,
  JournalRecord,
  LedgerStore,
  StoredEntry,
  StoredEnvelope,
} from "./store.ts";

/**
 * Couples a catalog-typed event with its account and store-wide idempotency key.
 * Effective time and metadata are part of the request's identity.
 */
export type EventEnvelope<E extends EventCatalog> = Omit<
  StoredEnvelope,
  "event"
> &
  Readonly<{ event: EventsOf<E> }>;
/**
 * Represents a committed event with its durable entries and account revision.
 * Payloads retain schema-input form rather than rule-output form.
 */
export type LedgerRecord<E extends EventCatalog> = Omit<
  JournalRecord,
  "event"
> &
  Readonly<{ event: EventsOf<E> }>;
/**
 * Accepts a candidate vector only by returning true; false or a thrown error
 * rejects it with INVARIANT. Must be synchronous and pure for retries and verify.
 */
export type Invariant<B extends BalanceDefinitions> = (
  balances: Balances<B>,
) => boolean;
/**
 * Supplies catalogs, persistence, and policy explicitly at the composition root.
 */
export type LedgerOptions<
  B extends BalanceDefinitions,
  E extends EventCatalog,
> = Readonly<{
  /**
   * Defines the exact buckets and commodities shared by every account.
   */
  balances: B;
  /**
   * Supplies constructors and rules, including every version retained in history.
   */
  events: E;
  /**
   * Owns atomic persistence and the global event-ID namespace; lifecycle stays
   * with the caller, not the ledger.
   */
  store: LedgerStore;
  /**
   * Supplies recordedAt for each new commit attempt; defaults to the system clock.
   * Effective time is caller-supplied and does not determine revision order.
   */
  clock?: () => Date;
  /**
   * Bounds record and rebuild attempts, including the first; 1–1000, default 8.
   * Only optimistic conflicts retry automatically, not arbitrary store failures.
   */
  maxAttempts?: number;
  /**
   * Checks the complete post-event vector and each replayed vector during verify.
   * Historical reads and rebuild do not run these callbacks.
   */
  invariants?: readonly Invariant<B>[];
}>;
/**
 * Selects an inclusive account revision, with zero representing all-zero balances.
 */
export type HistoricalOptions = Readonly<{
  at: Readonly<{ revision: bigint }>;
}>;
/**
 * Reports the captured revision whose rules, journal, and projection agree;
 * later concurrent commits are outside this verification result.
 */
export type Verification<B extends BalanceDefinitions> = Readonly<{
  revision: bigint;
  balances: Balances<B>;
}>;
type Dependencies<
  B extends BalanceDefinitions,
  E extends EventCatalog,
> = LedgerOptions<B, E> & Readonly<{ clock: () => Date; maxAttempts: number }>;

const revisionSchema = z.bigint().nonnegative();
const envelopeSchema = z.strictObject({
  id: z.string(),
  accountId: z.string(),
  event: z.strictObject({
    type: z.string().min(1),
    version: z.number().int().positive(),
    payload: z.unknown(),
  }),
  effectiveAt: z.date().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Coordinates typed accounting policy with an explicitly supplied store.
 * Reuse with stable catalogs and pure rules; keep historical versions available.
 * The caller owns store startup and disposal. Use createLedger for defaults.
 */
export class Ledger<B extends BalanceDefinitions, E extends EventCatalog> {
  readonly #balances: B;
  readonly #events: E;
  readonly #store: LedgerStore;
  readonly #clock: () => Date;
  readonly #maxAttempts: number;
  readonly #invariants: readonly Invariant<B>[];
  readonly #zero: Balances<B>;

  /**
   * Captures configuration with an explicit clock and bounded attempt count.
   * Validates the balance catalog without reading or initializing storage.
   */
  constructor(options: Dependencies<B, E>) {
    this.#balances = clone(options.balances);
    defineBalances(this.#balances);
    this.#events = options.events;
    this.#store = options.store;
    this.#clock = options.clock;
    this.#maxAttempts = parse(
      z.number().int().min(1).max(1000),
      options.maxAttempts,
    );
    this.#invariants = Object.freeze([...(options.invariants ?? [])]);
    const zero: Record<
      string,
      Readonly<{ commodity: string; atomic: bigint }>
    > = {};
    for (const [name, definition] of Object.entries(this.#balances)) {
      if (definition.name !== name)
        throw new LedgerError(
          "VALIDATION",
          "Balance names must match their catalog keys",
        );
      zero[name] = amount(definition.commodity, 0n);
    }
    if (Object.keys(zero).length === 0)
      throw new LedgerError("VALIDATION", "At least one balance is required");
    this.#zero = parseBalances(this.#balances, zero);
  }

  /**
   * Returns the current projection, or folds stored entries through a revision.
   * Current reads require a projection; historical reads scan journal history
   * without rerunning rules and reject revisions beyond the durable head.
   */
  async getBalances(
    id: AccountId,
    options?: HistoricalOptions,
  ): Promise<Balances<B>> {
    accountId(id);
    const head = this.#head(await this.#store.load(id));
    if (!options) return this.#projection(head);
    const revision = parse(revisionSchema, options.at.revision);
    if (revision > head.revision)
      throw new LedgerError(
        "REVISION_OUT_OF_RANGE",
        "Requested revision exceeds durable history",
      );
    return this.#replay(id, revision);
  }

  /**
   * Commits entries and projection atomically, returning the original record for
   * an identical store-wide event ID and rejecting different content under it.
   * Conflicts rerun rules against fresh balances within maxAttempts. Concurrent
   * same-ID calls may both run rules; winner lookup also handles rule rejection
   * after an identical request has committed. Rule execution is not exactly once.
   */
  async recordEvent(input: EventEnvelope<E>): Promise<LedgerRecord<E>> {
    const parsed = parse(envelopeSchema, clone(input));
    const envelope: StoredEnvelope = {
      id: eventId(parsed.id),
      accountId: accountId(parsed.accountId),
      event: parsed.event,
      ...(parsed.effectiveAt === undefined
        ? {}
        : { effectiveAt: parsed.effectiveAt }),
      ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
    };
    const requestedFingerprint = fingerprint(envelope);
    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      const existing = await this.#store.findEvent(envelope.id);
      if (existing) {
        assertIdempotent(existing, requestedFingerprint);
        return this.#record(existing);
      }
      const version = resolveVersion(this.#events, envelope.event);
      const head = this.#head(await this.#store.load(envelope.accountId));
      const current = this.#projection(head);
      let entries: readonly StoredEntry[];
      let next: Balances<B>;
      try {
        entries = this.#entries(version.run(envelope.event.payload, current));
        next = parseBalances(this.#balances, foldEntries(current, entries));
        this.#checkInvariants(next);
      } catch (cause) {
        // A concurrent identical commit may have changed the state before rules ran.
        const winner = await this.#store.findEvent(envelope.id);
        if (winner) {
          assertIdempotent(winner, requestedFingerprint);
          return this.#record(winner);
        }
        throw cause;
      }
      const recordedAt = parse(z.date(), this.#clock());
      const result = await this.#store.commit(
        envelope.accountId,
        head.revision,
        {
          record: {
            ...envelope,
            entries,
            recordedAt,
            revision: head.revision + 1n,
            fingerprint: requestedFingerprint,
          },
          balances: next,
        },
      );
      if (result.status !== "conflict") {
        assertIdempotent(result.record, requestedFingerprint);
        return this.#record(result.record);
      }
    }
    // A winner may have committed this event during the final conflicting attempt.
    const existing = await this.#store.findEvent(envelope.id);
    if (existing) {
      assertIdempotent(existing, requestedFingerprint);
      return this.#record(existing);
    }
    throw new LedgerError("CONCURRENCY", "Ledger commit retry limit exceeded");
  }

  /**
   * Streams validated records after an exclusive bound through an inclusive one.
   * Defaults the upper bound to the durable head captured when iteration begins,
   * excluding later commits. Validates history without rerunning accounting rules.
   */
  async *readJournal(
    id: AccountId,
    range: JournalRange = {},
  ): AsyncIterable<LedgerRecord<E>> {
    accountId(id);
    const after = parse(revisionSchema, range.after ?? 0n);
    const head = this.#head(await this.#store.load(id));
    const through = parse(revisionSchema, range.through ?? head.revision);
    if (through > head.revision)
      throw new LedgerError(
        "REVISION_OUT_OF_RANGE",
        "Requested revision exceeds durable history",
      );
    if (after > through)
      throw new LedgerError("VALIDATION", "Journal range is reversed");
    yield* this.#records(id, through, after);
  }

  /**
   * Rebuilds only the projection by folding stored entries, without rerunning
   * rules or invariants. Retries if the durable head advances, up to maxAttempts.
   * Use verify separately to detect rule drift or invariant violations.
   */
  async rebuild(id: AccountId): Promise<Balances<B>> {
    accountId(id);
    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      const head = this.#head(await this.#store.load(id));
      const balances = await this.#replay(id, head.revision);
      if (await this.#store.replaceProjection(id, head.revision, balances))
        return balances;
    }
    throw new LedgerError(
      "CONCURRENCY",
      "Projection rebuild retry limit exceeded",
    );
  }

  /**
   * Verifies a captured history by rerunning rules, checking each post-event
   * invariant, and comparing the journal fold with its captured projection.
   * Does not repair data; a missing projection requires rebuild first.
   */
  async verify(id: AccountId): Promise<Verification<B>> {
    accountId(id);
    const captured = this.#head(await this.#store.load(id));
    const balances = await this.#replay(
      id,
      captured.revision,
      (record, previous, next) => {
        const version = resolveVersion(this.#events, record.event);
        const expected = this.#entries(
          version.run(record.event.payload, previous),
        );
        if (encode(expected) !== encode(record.entries))
          throw new LedgerError(
            "CORRUPT_HISTORY",
            `Rule drift at revision ${record.revision}`,
          );
        this.#checkInvariants(next);
      },
    );
    if (captured.balances === null)
      throw new LedgerError(
        "PROJECTION_MISSING",
        "Projection is absent; rebuild is required",
      );
    if (encode(this.#projection(captured)) !== encode(balances))
      throw new LedgerError(
        "CORRUPT_HISTORY",
        "Projection differs from journal history",
      );
    return Object.freeze({ revision: captured.revision, balances });
  }

  #head(value: Head): Head {
    return {
      revision: parse(revisionSchema, value.revision),
      balances: value.balances === null ? null : parseVector(value.balances),
    };
  }

  #projection(head: Head): Balances<B> {
    if (head.balances === null)
      throw new LedgerError(
        "PROJECTION_MISSING",
        "Projection is absent; rebuild is required",
      );
    if (head.revision === 0n && Object.keys(head.balances).length === 0)
      return clone(this.#zero);
    return parseBalances(this.#balances, head.balances);
  }

  #entries(values: readonly StoredEntry[]): readonly StoredEntry[] {
    if (!Array.isArray(values) || values.length === 0)
      throw new LedgerError(
        "VALIDATION",
        "Rules must return at least one entry",
      );
    return Object.freeze(
      values.map((value: StoredEntry) => {
        const validated = parseEntry(value);
        for (const reference of [validated.debit, validated.credit]) {
          const definition = Object.hasOwn(this.#balances, reference.name)
            ? this.#balances[reference.name]
            : undefined;
          if (!definition || definition.commodity !== reference.commodity)
            throw new LedgerError(
              "VALIDATION",
              `Unknown balance or mismatched commodity: ${reference.name}`,
            );
        }
        return validated;
      }),
    );
  }

  #checkInvariants(balances: Balances<B>): void {
    for (const invariant of this.#invariants) {
      try {
        if (invariant(clone(balances)) !== true)
          throw new LedgerError(
            "INVARIANT",
            "Balance invariant rejected the event",
          );
      } catch (cause) {
        if (cause instanceof LedgerError && cause.code === "INVARIANT")
          throw cause;
        throw new LedgerError(
          "INVARIANT",
          "Balance invariant rejected the event",
          { cause },
        );
      }
    }
  }

  #record(value: JournalRecord): LedgerRecord<E> {
    try {
      const record = parseRecord(value);
      resolveVersion(this.#events, record.event);
      this.#entries(record.entries);
      if (fingerprint(record) !== record.fingerprint)
        throw new LedgerError(
          "CORRUPT_HISTORY",
          "Journal fingerprint does not match its envelope",
        );
      // Catalog lookup and the matching version's schema establish the event union.
      return clone(record) as LedgerRecord<E>;
    } catch (cause) {
      if (cause instanceof LedgerError && cause.code === "VALIDATION")
        throw new LedgerError(
          "CORRUPT_HISTORY",
          "Invalid persisted journal record",
          { cause },
        );
      throw cause;
    }
  }

  async *#records(
    id: AccountId,
    through: bigint,
    after = 0n,
  ): AsyncIterable<LedgerRecord<E>> {
    let expected = after + 1n;
    const seen = new Set<string>();
    for await (const value of this.#store.journal(id, { after, through })) {
      const record = this.#record(value);
      if (
        record.accountId !== id ||
        record.revision !== expected ||
        record.revision > through ||
        seen.has(record.id)
      )
        throw new LedgerError(
          "CORRUPT_HISTORY",
          "Journal must have unique events and contiguous account revisions",
        );
      expected++;
      seen.add(record.id);
      yield record;
    }
    if (expected !== through + 1n)
      throw new LedgerError(
        "CORRUPT_HISTORY",
        "Journal ended before its durable revision",
      );
  }

  async #replay(
    id: AccountId,
    through: bigint,
    visit?: (
      record: LedgerRecord<E>,
      previous: Balances<B>,
      next: Balances<B>,
    ) => void,
  ): Promise<Balances<B>> {
    let balances = clone(this.#zero);
    for await (const record of this.#records(id, through)) {
      const next = parseBalances(
        this.#balances,
        foldEntries(balances, record.entries),
      );
      visit?.(record, balances, next);
      balances = next;
    }
    return balances;
  }
}

/**
 * Composes a ledger without opening storage, defaulting to system time and eight
 * attempts. Inject the clock for reproducible recorded timestamps.
 */
export function createLedger<
  const B extends BalanceDefinitions,
  const E extends EventCatalog,
>(options: LedgerOptions<B, E>): Ledger<B, E> {
  return new Ledger({
    ...options,
    clock: options.clock ?? (() => new Date()),
    maxAttempts: options.maxAttempts ?? 8,
  });
}
