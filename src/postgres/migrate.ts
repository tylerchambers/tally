import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { LedgerError } from "../errors.ts";

// This is the sole schema definition: there is no parallel ORM schema to drift.
const initialMigration = [
  `CREATE TABLE typed_ledger.accounts (
    account_id text PRIMARY KEY CHECK (length(account_id) > 0),
    revision numeric NOT NULL DEFAULT 0 CHECK (revision >= 0 AND revision < 'Infinity'::numeric AND revision = trunc(revision))
  )`,
  `CREATE TABLE typed_ledger.projections (
    account_id text PRIMARY KEY REFERENCES typed_ledger.accounts(account_id),
    balances text NOT NULL
  )`,
  `CREATE TABLE typed_ledger.journal (
    event_id text PRIMARY KEY CHECK (length(event_id) > 0),
    account_id text NOT NULL REFERENCES typed_ledger.accounts(account_id),
    revision numeric NOT NULL CHECK (revision > 0 AND revision < 'Infinity'::numeric AND revision = trunc(revision)),
    fingerprint text NOT NULL CHECK (length(fingerprint) > 0),
    record text NOT NULL,
    writer_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
    UNIQUE (account_id, revision)
  )`,
  `CREATE TABLE typed_ledger.entries (
    event_id text NOT NULL REFERENCES typed_ledger.journal(event_id),
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    debit_name text NOT NULL CHECK (length(debit_name) > 0),
    debit_commodity text NOT NULL CHECK (length(debit_commodity) > 0),
    credit_name text NOT NULL CHECK (length(credit_name) > 0),
    credit_commodity text NOT NULL CHECK (length(credit_commodity) > 0),
    commodity text NOT NULL CHECK (length(commodity) > 0),
    quantity numeric NOT NULL CHECK (quantity > 0 AND quantity < 'Infinity'::numeric AND quantity = trunc(quantity)),
    PRIMARY KEY (event_id, ordinal),
    CONSTRAINT entries_same_commodity CHECK (
      debit_commodity = commodity AND credit_commodity = commodity
    ),
    CONSTRAINT entries_distinct_balances CHECK (debit_name <> credit_name)
  )`,
  `CREATE FUNCTION typed_ledger.reject_history_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'ledger history is append-only' USING ERRCODE = '23514';
    END $$`,
  `CREATE TRIGGER immutable_journal BEFORE UPDATE OR DELETE ON typed_ledger.journal
    FOR EACH ROW EXECUTE FUNCTION typed_ledger.reject_history_mutation()`,
  `CREATE TRIGGER immutable_entries BEFORE UPDATE OR DELETE ON typed_ledger.entries
    FOR EACH ROW EXECUTE FUNCTION typed_ledger.reject_history_mutation()`,
  `CREATE TRIGGER immutable_journal_truncate BEFORE TRUNCATE ON typed_ledger.journal
    FOR EACH STATEMENT EXECUTE FUNCTION typed_ledger.reject_history_mutation()`,
  `CREATE TRIGGER immutable_entries_truncate BEFORE TRUNCATE ON typed_ledger.entries
    FOR EACH STATEMENT EXECUTE FUNCTION typed_ledger.reject_history_mutation()`,
  `CREATE FUNCTION typed_ledger.require_entry_transaction() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM typed_ledger.journal
        WHERE event_id = NEW.event_id AND writer_xid = pg_current_xact_id()
      ) THEN
        RAISE EXCEPTION 'entries must be appended in the event transaction' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE TRIGGER entries_same_transaction BEFORE INSERT ON typed_ledger.entries
    FOR EACH ROW EXECUTE FUNCTION typed_ledger.require_entry_transaction()`,
] as const;

/** Apply the ledger schema explicitly. The caller owns database/client lifetime. */
export async function migrate(database: PostgresJsDatabase): Promise<void> {
  const checksum = createHash("sha256")
    .update(initialMigration.join(";\n"))
    .digest("hex");
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(184596217, 1)`);
    await transaction.execute(sql`CREATE SCHEMA IF NOT EXISTS typed_ledger`);
    await transaction.execute(sql`CREATE TABLE IF NOT EXISTS typed_ledger.migrations (
      version integer PRIMARY KEY,
      checksum text NOT NULL
    )`);
    const applied = z
      .array(z.object({ version: z.number(), checksum: z.string() }))
      .parse(
        await transaction.execute(
          sql`SELECT version, checksum FROM typed_ledger.migrations ORDER BY version`,
        ),
      );
    if (
      applied.length > 1 ||
      applied.some((row) => row.version !== 1 || row.checksum !== checksum)
    ) {
      throw new LedgerError(
        "VALIDATION",
        "Ledger migration history differs from this library version",
      );
    }
    if (applied.length === 1) {
      return;
    }
    for (const statement of initialMigration) {
      await transaction.execute(sql.raw(statement));
    }
    await transaction.execute(
      sql`INSERT INTO typed_ledger.migrations (version, checksum) VALUES (1, ${checksum})`,
    );
  });
}
