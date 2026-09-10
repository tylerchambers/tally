import { z } from "zod";
import { LedgerError } from "./errors.ts";
import {
  parse,
  accountId as parseAccountId,
  eventId as parseEventId,
} from "./primitives.ts";
import { clone, encode } from "./serialization.ts";
import {
  assertIdempotent,
  foldEntries,
  parseRecord,
  parseVector,
  validateCommit,
} from "./storage-validation.ts";
import type {
  AccountId,
  BalanceVector,
  Commit,
  CommitResult,
  EventId,
  Head,
  JournalRange,
  JournalRecord,
  LedgerStore,
} from "./store.ts";

type Account = {
  revision: bigint;
  balances: BalanceVector | null;
  records: JournalRecord[];
};
const rangeSchema = z.strictObject({
  after: z.bigint().nonnegative().optional(),
  through: z.bigint().nonnegative().optional(),
});

/**
 * Provides the LedgerStore reference implementation for tests and local use.
 * Each instance owns isolated, process-local history with no persistence or
 * external resources to dispose. Returned values are detached, not frozen;
 * retain the instance for as long as its history is needed.
 */
export class MemoryLedgerStore implements LedgerStore {
  readonly #accounts = new Map<AccountId, Account>();
  readonly #events = new Map<EventId, JournalRecord>();

  /**
   * Returns a detached head, distinguishing an unknown account from a deleted
   * projection without replaying history.
   */
  async load(accountId: AccountId): Promise<Head> {
    parseAccountId(accountId);
    const account = this.#accounts.get(accountId);
    return account
      ? clone({ revision: account.revision, balances: account.balances })
      : { revision: 0n, balances: {} };
  }

  /**
   * Returns a detached record by globally scoped event ID, or null when absent.
   */
  async findEvent(id: EventId): Promise<JournalRecord | null> {
    parseEventId(id);
    const existing = this.#events.get(id);
    return existing ? clone(existing) : null;
  }

  /**
   * Resolves identical retries before revision checks, then validates and
   * publishes a new record and projection without suspending.
   */
  async commit(
    accountId: AccountId,
    expectedRevision: bigint,
    commit: Commit,
  ): Promise<CommitResult> {
    parseAccountId(accountId);
    const record = parseRecord(commit.record);
    const existing = this.#events.get(record.id);
    if (existing) {
      assertIdempotent(existing, record.fingerprint);
      return { status: "idempotent", record: clone(existing) };
    }
    parse(z.bigint().nonnegative(), expectedRevision);
    const account = this.#accounts.get(accountId);
    const current = account ?? { revision: 0n, balances: {}, records: [] };
    if (current.revision !== expectedRevision) return { status: "conflict" };
    const validated = validateCommit(
      accountId,
      expectedRevision,
      { record, balances: commit.balances },
      current,
    );
    // No suspension between validation and publication: one atomic operation in this process.
    current.records.push(validated.record);
    current.revision = validated.record.revision;
    current.balances = validated.balances;
    this.#accounts.set(accountId, current);
    this.#events.set(record.id, validated.record);
    return { status: "committed", record: clone(validated.record) };
  }

  /**
   * Yields detached records in the exclusive-inclusive range, capped at the
   * head when iteration starts so later appends do not extend enumeration.
   */
  async *journal(
    accountId: AccountId,
    range: JournalRange = {},
  ): AsyncIterable<JournalRecord> {
    parseAccountId(accountId);
    const parsed = rangeSchema.safeParse(range);
    if (!parsed.success)
      throw new LedgerError("VALIDATION", "Invalid journal range", {
        cause: parsed.error,
      });
    const account = this.#accounts.get(accountId);
    if (!account) return;
    const through =
      parsed.data.through === undefined ||
      parsed.data.through > account.revision
        ? account.revision
        : parsed.data.through;
    const after = parsed.data.after ?? 0n;
    if (after >= through) return;
    // Revisions cannot exceed array capacity in this adapter; comparisons precede conversion.
    for (let index = Number(after); index < Number(through); index++) {
      const record = account.records[index];
      if (!record)
        throw new LedgerError("CORRUPT_HISTORY", "Missing journal revision");
      yield clone(record);
    }
  }

  /**
   * Verifies proposed totals against history before replacing the projection.
   * Returns false on a stale revision and throws VALIDATION for a mismatched
   * fold; permits extra zero balances without advancing the revision.
   */
  async replaceProjection(
    accountId: AccountId,
    expectedRevision: bigint,
    balances: BalanceVector,
  ): Promise<boolean> {
    parseAccountId(accountId);
    parse(z.bigint().nonnegative(), expectedRevision);
    const proposed = parseVector(balances);
    const account = this.#accounts.get(accountId);
    if ((account?.revision ?? 0n) !== expectedRevision) return false;
    let replayed: BalanceVector = Object.fromEntries(
      Object.entries(proposed).map(([name, value]) => [
        name,
        { commodity: value.commodity, atomic: 0n },
      ]),
    );
    for (const record of account?.records ?? [])
      replayed = foldEntries(replayed, record.entries);
    if (encode(replayed) !== encode(proposed))
      throw new LedgerError(
        "VALIDATION",
        "Replacement projection does not match journal",
      );
    if (account) account.balances = proposed;
    else
      this.#accounts.set(accountId, {
        revision: 0n,
        balances: proposed,
        records: [],
      });
    return true;
  }

  /**
   * Administratively drops only the projection, requiring repair before new
   * commits. Leaves unknown accounts absent and existing history intact.
   */
  async deleteProjection(accountId: AccountId): Promise<void> {
    parseAccountId(accountId);
    const account = this.#accounts.get(accountId);
    if (account) account.balances = null;
  }
}
