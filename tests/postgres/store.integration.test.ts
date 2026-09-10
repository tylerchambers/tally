import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { LedgerError } from "../../src/errors.ts";
import { migrate, PostgresLedgerStore } from "../../src/postgres/index.ts";
import { accountId, eventId } from "../../src/primitives.ts";
import { fingerprint } from "../../src/serialization.ts";
import type {
  AccountId,
  Commit,
  JournalRecord,
  StoredEnvelope,
} from "../../src/store.ts";
import { storeConformance } from "../../src/testing/conformance.ts";
import { createPostgresFixture } from "./fixture.ts";

storeConformance("PostgreSQL", createPostgresFixture);

function posting(
  account: AccountId,
  id: string,
  revision = 1n,
  total = 7n,
): Commit {
  const envelope: StoredEnvelope = {
    id: eventId(id),
    accountId: account,
    event: {
      type: "transferred",
      version: 1,
      payload: { quantity: 7n, at: new Date("2026-01-02T03:04:05.006Z") },
    },
    effectiveAt: new Date("2025-12-31T23:59:59.999Z"),
    metadata: { source: "integration", sequence: 9007199254740993n },
  };
  return {
    record: {
      ...envelope,
      revision,
      recordedAt: new Date("2026-01-03T00:00:00.000Z"),
      fingerprint: fingerprint(envelope),
      entries: [
        {
          debit: { name: "available", commodity: "USD" },
          credit: { name: "reserved", commodity: "USD" },
          amount: { commodity: "USD", atomic: 7n },
        },
      ],
    },
    balances: {
      available: { commodity: "USD", atomic: -total },
      reserved: { commodity: "USD", atomic: total },
    },
  };
}

describe("PostgreSQL durability and constraints", () => {
  it("rolls back the journal, head, projection and entries when an entry trigger fails", async () => {
    const fixture = await createPostgresFixture();
    try {
      await fixture.database.execute(sql`CREATE FUNCTION typed_ledger.fail_entry() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM typed_ledger.journal WHERE event_id = NEW.event_id) THEN
            RAISE EXCEPTION 'injected failure after journal insertion' USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END $$`);
      await fixture.database.execute(sql`CREATE CONSTRAINT TRIGGER fail_entry AFTER INSERT ON typed_ledger.entries
        DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION typed_ledger.fail_entry()`);
      const account = accountId("rollback");
      const commit = posting(account, "rollback-event");
      await expect(fixture.store.commit(account, 0n, commit)).rejects.toThrow();
      expect(await fixture.store.findEvent(commit.record.id)).toBeNull();
      expect(await fixture.store.load(account)).toEqual({
        revision: 0n,
        balances: {},
      });
      const counts = await fixture.database.execute(sql`SELECT
        (SELECT count(*)::text FROM typed_ledger.entries) AS entries,
        (SELECT count(*)::text FROM typed_ledger.accounts) AS accounts,
        (SELECT count(*)::text FROM typed_ledger.projections) AS projections,
        (SELECT count(*)::text FROM typed_ledger.journal) AS journal`);
      expect(Array.from(counts)).toEqual([
        { entries: "0", accounts: "0", projections: "0", journal: "0" },
      ]);
      await fixture.database.execute(
        sql`DROP TRIGGER fail_entry ON typed_ledger.entries`,
      );
      expect((await fixture.store.commit(account, 0n, commit)).status).toBe(
        "committed",
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("protects committed journal and entry rows against SQL updates and deletes", async () => {
    const fixture = await createPostgresFixture();
    try {
      const account = accountId("immutable");
      const commit = posting(account, "immutable-event");
      await fixture.store.commit(account, 0n, commit);
      await expect(
        Promise.resolve(
          fixture.database.execute(
            sql`UPDATE typed_ledger.journal SET record = 'changed'`,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        Promise.resolve(
          fixture.database.execute(sql`DELETE FROM typed_ledger.journal`),
        ),
      ).rejects.toThrow();
      await expect(
        Promise.resolve(
          fixture.database.execute(
            sql`UPDATE typed_ledger.entries SET quantity = 9`,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        Promise.resolve(
          fixture.database.execute(sql`DELETE FROM typed_ledger.entries`),
        ),
      ).rejects.toThrow();
      expect(await fixture.store.findEvent(commit.record.id)).toEqual(
        commit.record,
      );
      await fixture.store.deleteProjection(account);
      expect(
        await fixture.store.replaceProjection(account, 1n, commit.balances),
      ).toBe(true);
      expect(await fixture.store.load(account)).toEqual({
        revision: 1n,
        balances: commit.balances,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects later entries and truncation that would change committed accounting history", async () => {
    const fixture = await createPostgresFixture();
    try {
      const commit = posting(accountId("sealed-history"), "sealed-event");
      await fixture.store.commit(commit.record.accountId, 0n, commit);
      await expect(
        Promise.resolve(
          fixture.database.execute(sql`INSERT INTO typed_ledger.entries
        (event_id, ordinal, debit_name, debit_commodity, credit_name, credit_commodity, commodity, quantity)
        VALUES (${commit.record.id}, 1, 'available', 'USD', 'reserved', 'USD', 'USD', 1)`),
        ),
      ).rejects.toThrow();
      await expect(
        Promise.resolve(
          fixture.database.execute(sql`TRUNCATE typed_ledger.entries`),
        ),
      ).rejects.toThrow();
      await expect(
        Promise.resolve(
          fixture.database.execute(sql`TRUNCATE typed_ledger.journal CASCADE`),
        ),
      ).rejects.toThrow();
      expect(await fixture.store.findEvent(commit.record.id)).toEqual(
        commit.record,
      );
      await fixture.store.deleteProjection(commit.record.accountId);
      expect(
        await fixture.store.replaceProjection(
          commit.record.accountId,
          1n,
          commit.balances,
        ),
      ).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it("enforces positive quantities and matching commodities even for direct SQL writers", async () => {
    const fixture = await createPostgresFixture();
    try {
      const commit = posting(accountId("constraints"), "constraint-event");
      await fixture.store.commit(commit.record.accountId, 0n, commit);
      for (const invalid of [
        { quantity: 0, credit: "USD", constraint: "entries_quantity_check" },
        { quantity: 1, credit: "EUR", constraint: "entries_same_commodity" },
      ]) {
        await expect(
          fixture.database.transaction(async (transaction) => {
            await transaction.execute(sql`INSERT INTO typed_ledger.journal
            (event_id, account_id, revision, fingerprint, record)
            VALUES ('invalid-entry-event', ${commit.record.accountId}, 2, 'constraint-probe', 'constraint-probe')`);
            await transaction.execute(sql`INSERT INTO typed_ledger.entries
            (event_id, ordinal, debit_name, debit_commodity, credit_name, credit_commodity, commodity, quantity)
            VALUES ('invalid-entry-event', 0, 'available', 'USD', 'reserved', ${invalid.credit}, 'USD', ${invalid.quantity})`);
          }),
        ).rejects.toMatchObject({
          cause: { code: "23514", constraint_name: invalid.constraint },
        });
      }
      await fixture.store.deleteProjection(commit.record.accountId);
      expect(
        await fixture.store.replaceProjection(
          commit.record.accountId,
          1n,
          commit.balances,
        ),
      ).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it("resolves cross-account global identity races without account/event lock inversion", async () => {
    const fixture = await createPostgresFixture();
    try {
      const first = posting(accountId("first"), "global-event");
      const second = posting(accountId("second"), "global-event");
      const results = await Promise.allSettled([
        fixture.store.commit(first.record.accountId, 0n, first),
        fixture.store.commit(second.record.accountId, 0n, second),
      ]);
      const successes = results.filter(
        (result) => result.status === "fulfilled",
      );
      const failures = results.filter((result) => result.status === "rejected");
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      for (const failure of failures) {
        expect(failure.reason).toBeInstanceOf(LedgerError);
        expect(failure.reason).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      }
      const winner = await fixture.store.findEvent(first.record.id);
      expect(winner).not.toBeNull();
      if (winner === null)
        throw new Error("Concurrent commit did not persist a winner");
      const winningCommit =
        winner.accountId === first.record.accountId ? first : second;
      const losingCommit =
        winner.accountId === first.record.accountId ? second : first;
      expect(await fixture.store.load(losingCommit.record.accountId)).toEqual({
        revision: 0n,
        balances: {},
      });
      expect(
        await fixture.store.commit(winner.accountId, 0n, winningCommit),
      ).toEqual({ status: "idempotent", record: winner });
    } finally {
      await fixture.dispose();
    }
  }, 15000);

  it("preserves exact records and durable revisions across client reopen and projection loss", async () => {
    const fixture = await createPostgresFixture();
    try {
      const commit = posting(accountId("reopened"), "durable-event");
      await fixture.store.commit(commit.record.accountId, 0n, commit);
      await fixture.store.deleteProjection(commit.record.accountId);
      await fixture.client.end();
      const client = postgres(fixture.url);
      try {
        const store = new PostgresLedgerStore(drizzle(client));
        expect(await store.findEvent(commit.record.id)).toEqual(commit.record);
        expect(await store.load(commit.record.accountId)).toEqual({
          revision: 1n,
          balances: null,
        });
        expect(
          await store.replaceProjection(
            commit.record.accountId,
            1n,
            commit.balances,
          ),
        ).toBe(true);
        const next = posting(commit.record.accountId, "durable-next", 2n, 14n);
        expect(
          (await store.commit(commit.record.accountId, 1n, next)).status,
        ).toBe("committed");
        expect(await store.load(commit.record.accountId)).toEqual({
          revision: 2n,
          balances: next.balances,
        });
      } finally {
        await client.end();
      }
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps a bounded upper revision across multiple keyset pages", async () => {
    const fixture = await createPostgresFixture();
    try {
      const account = accountId("paged");
      for (let revision = 1n; revision <= 130n; revision += 1n) {
        await fixture.store.commit(
          account,
          revision - 1n,
          posting(account, `paged-${revision}`, revision, revision * 7n),
        );
      }
      const iterator = fixture.store.journal(account)[Symbol.asyncIterator]();
      const first = await iterator.next();
      const records: JournalRecord[] = [];
      if (!first.done) records.push(first.value);
      await fixture.store.commit(
        account,
        130n,
        posting(account, "paged-131", 131n, 917n),
      );
      for (
        let result = await iterator.next();
        !result.done;
        result = await iterator.next()
      )
        records.push(result.value);
      expect(records.map((record) => record.revision)).toEqual(
        Array.from({ length: 130 }, (_, index) => BigInt(index + 1)),
      );
    } finally {
      await fixture.dispose();
    }
  }, 20000);

  it("applies migrations idempotently and rejects a mismatched recorded migration checksum", async () => {
    const fixture = await createPostgresFixture();
    try {
      const commit = posting(accountId("migration"), "migration-event");
      await fixture.store.commit(commit.record.accountId, 0n, commit);
      await Promise.all([migrate(fixture.database), migrate(fixture.database)]);
      expect(await fixture.store.findEvent(commit.record.id)).toEqual(
        commit.record,
      );
      await fixture.database.execute(
        sql`UPDATE typed_ledger.migrations SET checksum = 'tampered' WHERE version = 1`,
      );
      await expect(migrate(fixture.database)).rejects.toMatchObject({
        code: "VALIDATION",
      });
      expect(await fixture.store.load(commit.record.accountId)).toEqual({
        revision: 1n,
        balances: commit.balances,
      });
    } finally {
      await fixture.dispose();
    }
  });
});
