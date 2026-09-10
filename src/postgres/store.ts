import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { LedgerError } from "../errors.ts";
import {
  parse,
  accountId as parseAccountId,
  eventId as parseEventId,
} from "../primitives.ts";
import { clone, decode, encode, fingerprint } from "../serialization.ts";
import {
  assertIdempotent,
  parseRecord,
  parseVector,
  validateCommit,
} from "../storage-validation.ts";
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
  Revision,
} from "../store.ts";

type Executor = Pick<PostgresJsDatabase, "execute">;
const revisionText = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .transform((value) => BigInt(value));
const headRows = z.array(
  z.object({ revision: revisionText, balances: z.string().nullable() }),
);
const recordRows = z.array(
  z.object({
    event_id: z.string(),
    account_id: z.string(),
    revision: revisionText,
    fingerprint: z.string(),
    record: z.string(),
  }),
);
const foldedRows = z.array(
  z.object({
    name: z.string().min(1),
    commodity: z.string().min(1),
    atomic: z
      .string()
      .regex(/^-?(0|[1-9]\d*)$/)
      .transform((value) => BigInt(value)),
  }),
);
const revisionSchema = z.bigint().nonnegative();
const rangeSchema = z.strictObject({
  after: revisionSchema.optional(),
  through: revisionSchema.optional(),
});
const pageSize = 128;

/**
 * Persists ledger history and rebuildable projections in PostgreSQL.
 * Run migrate() explicitly before use; construction performs no database I/O.
 * The caller owns the supplied Drizzle database and underlying postgres.js
 * client, including shutdown after in-flight operations finish.
 *
 * Adapter transactions enforce the LedgerStore contract. Schema constraints
 * and triggers guard ordinary history mutations, not arbitrary raw-SQL inserts
 * or privileged database administration; restrict direct write access.
 */
export class PostgresLedgerStore implements LedgerStore {
  constructor(private readonly database: PostgresJsDatabase) {}

  /**
   * Returns the indexed head without replaying history. A missing projection
   * has null balances; an unknown account has revision zero and {}.
   */
  async load(accountId: AccountId): Promise<Head> {
    parseAccountId(accountId);
    return this.readHead(this.database, accountId);
  }

  /**
   * Returns a decoded record by global event ID, checking its indexed identity
   * against its content, or null when absent.
   */
  async findEvent(id: EventId): Promise<JournalRecord | null> {
    parseEventId(id);
    return this.readEvent(this.database, id);
  }

  /**
   * Resolves event identity before revision checks inside one transaction.
   * Captures input before suspension, then commits journal, entries, revision,
   * and projection together. Identical retries return the original record.
   */
  async commit(
    accountId: AccountId,
    expectedRevision: Revision,
    input: Commit,
  ): Promise<CommitResult> {
    parseAccountId(accountId);
    const commit = clone(input);
    const record = parseRecord(commit.record);
    const identity = fingerprint(record);
    return this.database.transaction(async (transaction) => {
      // Every writer locks its global event identity before touching an account.
      // In particular, cross-account retries never hold account locks while waiting for an event.
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${record.id}, 932761))`,
      );
      const existing = await this.readEvent(transaction, record.id);
      if (existing !== null) {
        assertIdempotent(existing, identity);
        return { status: "idempotent", record: existing };
      }
      this.validateRevision(expectedRevision);
      if (!(await this.lockAccount(transaction, accountId, expectedRevision))) {
        return { status: "conflict" };
      }
      const head = await this.readHead(transaction, accountId);
      if (head.revision !== expectedRevision) {
        return { status: "conflict" };
      }
      const validated = validateCommit(
        accountId,
        expectedRevision,
        commit,
        head,
      );
      await transaction.execute(sql`INSERT INTO typed_ledger.journal
        (event_id, account_id, revision, fingerprint, record)
        VALUES (${validated.record.id}, ${accountId}, ${validated.record.revision.toString()}::numeric,
          ${validated.record.fingerprint}, ${encode(validated.record)})`);
      for (
        let offset = 0;
        offset < validated.record.entries.length;
        offset += pageSize
      ) {
        const values = validated.record.entries
          .slice(offset, offset + pageSize)
          .map(
            (entry, index) =>
              sql`(${validated.record.id}, ${offset + index}, ${entry.debit.name}, ${entry.debit.commodity},
            ${entry.credit.name}, ${entry.credit.commodity}, ${entry.amount.commodity},
            ${entry.amount.atomic.toString()}::numeric)`,
          );
        await transaction.execute(sql`INSERT INTO typed_ledger.entries
          (event_id, ordinal, debit_name, debit_commodity, credit_name, credit_commodity, commodity, quantity)
          VALUES ${sql.join(values, sql`, `)}`);
      }
      await transaction.execute(sql`UPDATE typed_ledger.accounts SET revision = ${validated.record.revision.toString()}::numeric
        WHERE account_id = ${accountId}`);
      await this.writeProjection(transaction, accountId, validated.balances);
      return { status: "committed", record: clone(validated.record) };
    });
  }

  /**
   * Streams detached records in bounded, revision-ordered pages.
   * Captures an inclusive upper revision when iteration starts and excludes the
   * after bound. Append-only history keeps pages stable without a long-lived
   * read transaction; writes after the captured head are not included.
   */
  async *journal(
    accountId: AccountId,
    range: JournalRange = {},
  ): AsyncIterable<JournalRecord> {
    parseAccountId(accountId);
    const parsedRange = rangeSchema.safeParse(range);
    if (!parsedRange.success) {
      throw new LedgerError("VALIDATION", "Invalid journal range", {
        cause: parsedRange.error,
      });
    }
    let after = parsedRange.data.after ?? 0n;
    const head = await this.readHead(this.database, accountId);
    const requestedUpper = parsedRange.data.through ?? head.revision;
    const upper =
      requestedUpper < head.revision ? requestedUpper : head.revision;
    while (after < upper) {
      const rows =
        await this.database.execute(sql`SELECT event_id, account_id, revision::text, fingerprint, record
        FROM typed_ledger.journal WHERE account_id = ${accountId}
          AND revision > ${after.toString()}::numeric AND revision <= ${upper.toString()}::numeric
        ORDER BY typed_ledger.journal.revision LIMIT ${pageSize}`);
      const records = this.readRecords(rows);
      if (records.length === 0) {
        return;
      }
      for (const record of records) {
        after = record.revision;
        yield record;
      }
    }
  }

  /**
   * Repairs the projection under the same account lock used by writers.
   * Returns false on a stale revision; otherwise verifies totals against durable
   * entry rows, allowing extra zero balances, before replacing the projection.
   * Incorrect totals throw VALIDATION and never advance the durable revision.
   */
  async replaceProjection(
    accountId: AccountId,
    expectedRevision: Revision,
    input: BalanceVector,
  ): Promise<boolean> {
    parseAccountId(accountId);
    this.validateRevision(expectedRevision);
    const proposed = parseVector(clone(input));
    return this.database.transaction(async (transaction) => {
      if (!(await this.lockAccount(transaction, accountId, expectedRevision)))
        return false;
      const head = await this.readHead(transaction, accountId);
      if (head.revision !== expectedRevision) {
        return false;
      }
      // Aggregate the immutable entry rows, not the disposable projection or caller's totals.
      const totals = parse(
        foldedRows,
        await transaction.execute(sql`
        SELECT posting.name, posting.commodity, sum(posting.atomic)::text AS atomic
        FROM typed_ledger.entries AS entry
        JOIN typed_ledger.journal AS journal ON journal.event_id = entry.event_id
        CROSS JOIN LATERAL (VALUES
          (entry.debit_name, entry.commodity, -entry.quantity),
          (entry.credit_name, entry.commodity, entry.quantity)
        ) AS posting(name, commodity, atomic)
        WHERE journal.account_id = ${accountId}
        GROUP BY posting.name, posting.commodity
      `),
      );
      const durable = new Map<string, { commodity: string; atomic: bigint }>();
      for (const total of totals) {
        if (durable.has(total.name)) {
          throw new LedgerError(
            "CORRUPT_HISTORY",
            "Balance name has multiple journal commodities",
          );
        }
        durable.set(total.name, {
          commodity: total.commodity,
          atomic: total.atomic,
        });
      }
      for (const [name, amount] of Object.entries(proposed)) {
        const total = durable.get(name);
        if (
          total === undefined
            ? amount.atomic !== 0n
            : total.commodity !== amount.commodity ||
              total.atomic !== amount.atomic
        ) {
          throw new LedgerError(
            "VALIDATION",
            "Replacement projection does not match durable entries",
          );
        }
        durable.delete(name);
      }
      if (durable.size > 0) {
        throw new LedgerError(
          "VALIDATION",
          "Replacement projection omits durable balances",
        );
      }
      await this.writeProjection(transaction, accountId, proposed);
      return true;
    });
  }

  /**
   * Administratively deletes only the projection while serializing with commits
   * and repairs. Preserves the durable revision and requires repair before new
   * commits; does not perform caller authorization.
   */
  async deleteProjection(accountId: AccountId): Promise<void> {
    parseAccountId(accountId);
    await this.database.transaction(async (transaction) => {
      // The same account-row lock serializes deletion, rebuilding and commits.
      await transaction.execute(
        sql`SELECT account_id FROM typed_ledger.accounts WHERE account_id = ${accountId} FOR UPDATE`,
      );
      await transaction.execute(
        sql`DELETE FROM typed_ledger.projections WHERE account_id = ${accountId}`,
      );
    });
  }

  private async lockAccount(
    transaction: Executor,
    accountId: AccountId,
    expectedRevision: Revision,
  ): Promise<boolean> {
    // A stale nonzero expectation must not create durable state for an unknown account.
    if (expectedRevision === 0n) {
      await transaction.execute(sql`WITH created AS (
        INSERT INTO typed_ledger.accounts (account_id) VALUES (${accountId})
        ON CONFLICT DO NOTHING RETURNING account_id
      ) INSERT INTO typed_ledger.projections (account_id, balances)
        SELECT account_id, ${encode({})} FROM created`);
    }
    const locked = await transaction.execute(
      sql`SELECT account_id FROM typed_ledger.accounts WHERE account_id = ${accountId} FOR UPDATE`,
    );
    return (
      parse(z.array(z.object({ account_id: z.string() })), locked).length === 1
    );
  }

  private async readHead(
    executor: Executor,
    accountId: AccountId,
  ): Promise<Head> {
    const rows = parse(
      headRows,
      await executor.execute(sql`SELECT account.revision::text, projection.balances
      FROM typed_ledger.accounts AS account
      LEFT JOIN typed_ledger.projections AS projection USING (account_id)
      WHERE account.account_id = ${accountId}`),
    );
    const row = rows[0];
    if (row === undefined) {
      return { revision: 0n, balances: {} };
    }
    const balances =
      row.balances === null ? null : parseVector(decode(row.balances));
    return { revision: row.revision, balances };
  }

  private async readEvent(
    executor: Executor,
    id: EventId,
  ): Promise<JournalRecord | null> {
    const rows =
      await executor.execute(sql`SELECT event_id, account_id, revision::text, fingerprint, record
      FROM typed_ledger.journal WHERE event_id = ${id}`);
    return this.readRecords(rows)[0] ?? null;
  }

  private readRecords(value: unknown): JournalRecord[] {
    return parse(recordRows, value).map((row) => {
      const record = parseRecord(decode(row.record));
      if (
        record.id !== row.event_id ||
        record.accountId !== row.account_id ||
        record.revision !== row.revision ||
        record.fingerprint !== row.fingerprint
      ) {
        throw new LedgerError(
          "CORRUPT_HISTORY",
          "Journal content disagrees with its indexed identity",
        );
      }
      return record;
    });
  }

  private async writeProjection(
    executor: Executor,
    accountId: AccountId,
    balances: BalanceVector,
  ): Promise<void> {
    await executor.execute(sql`INSERT INTO typed_ledger.projections (account_id, balances)
      VALUES (${accountId}, ${encode(balances)})
      ON CONFLICT (account_id) DO UPDATE SET balances = EXCLUDED.balances`);
  }

  private validateRevision(revision: Revision): void {
    const parsed = revisionSchema.safeParse(revision);
    if (!parsed.success) {
      throw new LedgerError("VALIDATION", "Invalid expected revision", {
        cause: parsed.error,
      });
    }
  }
}
