import { describe, expect, it } from "bun:test";
import { accountId, eventId } from "../primitives.ts";
import { fingerprint } from "../serialization.ts";
import type {
  AccountId,
  BalanceVector,
  Commit,
  JournalRecord,
  LedgerStore,
  StoredEnvelope,
} from "../store.ts";

/**
 * Couples a fresh, empty store with cleanup for resources owned by that case.
 * Disposal must also release external clients or isolated database state.
 */
export type StoreConformanceFixture = {
  store: LedgerStore;
  /**
   * Releases the fixture after its case, including when assertions fail.
   */
  dispose(): Promise<void>;
};

/**
 * Creates an isolated fixture per case; shared prior history invalidates the
 * suite's expectations. The factory owns cleanup if creation itself rejects.
 */
export type StoreConformanceFactory = () => Promise<StoreConformanceFixture>;

function balances(total: bigint): BalanceVector {
  return {
    source: { commodity: "USD", atomic: -total },
    destination: { commodity: "USD", atomic: total },
  };
}

function posting(
  account: AccountId,
  id: string,
  revision: bigint,
  quantity: bigint,
  total: bigint,
): Commit {
  const envelope: StoredEnvelope = {
    id: eventId(id),
    accountId: account,
    event: {
      type: "transfer",
      version: 1,
      payload: { quantity, details: { reference: "original" } },
    },
    effectiveAt: new Date("2026-01-02T03:04:05.000Z"),
    metadata: { origin: { name: "conformance" } },
  };
  return {
    record: {
      ...envelope,
      revision,
      entries: [
        {
          debit: { name: "source", commodity: "USD" },
          credit: { name: "destination", commodity: "USD" },
          amount: { commodity: "USD", atomic: quantity },
        },
      ],
      recordedAt: new Date("2026-01-03T04:05:06.000Z"),
      fingerprint: fingerprint(envelope),
    },
    balances: balances(total),
  };
}

async function collect(
  records: AsyncIterable<JournalRecord>,
): Promise<JournalRecord[]> {
  const result: JournalRecord[] = [];
  for await (const record of records) {
    result.push(record);
  }
  return result;
}

function fold(records: readonly JournalRecord[]): BalanceVector {
  const result: Record<string, { commodity: string; atomic: bigint }> = {};
  for (const record of records) {
    for (const entry of record.entries) {
      for (const [balance, delta] of [
        [entry.debit, -entry.amount.atomic],
        [entry.credit, entry.amount.atomic],
      ] as const) {
        result[balance.name] = {
          commodity: balance.commodity,
          atomic: (result[balance.name]?.atomic ?? 0n) + delta,
        };
      }
    }
  }
  return result;
}

function mutateObject(value: unknown, key: string, replacement: unknown): void {
  if (typeof value === "object" && value !== null) {
    Reflect.set(value, key, replacement);
  }
}

function mutateRecord(record: JournalRecord): void {
  record.recordedAt.setUTCFullYear(2000);
  record.effectiveAt?.setUTCFullYear(2000);
  mutateObject(record.event.payload, "quantity", 999n);
  if (
    typeof record.event.payload === "object" &&
    record.event.payload !== null
  ) {
    mutateObject(
      Reflect.get(record.event.payload, "details"),
      "reference",
      "changed",
    );
  }
  mutateObject(record.metadata?.origin, "name", "changed");
  for (const entry of record.entries) {
    mutateObject(entry.amount, "atomic", 999n);
    mutateObject(entry.debit, "name", "changed");
  }
  mutateObject(record, "revision", 999n);
  mutateObject(record.entries, "0", null);
}

/**
 * Registers Bun tests for atomicity, retries, projections, and detached reads.
 * Each case requests a fresh, empty store and awaits disposal in finally.
 * Passing complements, but does not replace, adapter-specific database tests.
 */
export function storeConformance(
  name: string,
  factory: StoreConformanceFactory,
): void {
  describe(name, () => {
    function scenario(
      title: string,
      run: (store: LedgerStore) => Promise<void>,
    ): void {
      it(title, async () => {
        const fixture = await factory();
        try {
          await run(fixture.store);
        } finally {
          await fixture.dispose();
        }
      });
    }

    scenario(
      "failed commits leave no journal, projection, or event reservation",
      async (store) => {
        const account = accountId("atomicity");
        const first = posting(account, "atomicity-first", 1n, 3n, 3n);
        expect(await store.commit(account, 0n, first)).toEqual({
          status: "committed",
          record: first.record,
        });
        const second = posting(account, "atomicity-second", 2n, 5n, 8n);
        await expect(
          store.commit(account, 1n, { ...second, balances: balances(99n) }),
        ).rejects.toMatchObject({
          name: "LedgerError",
          code: "VALIDATION",
        });
        expect(await store.load(account)).toEqual({
          revision: 1n,
          balances: first.balances,
        });
        expect(await store.findEvent(second.record.id)).toBeNull();
        expect(await collect(store.journal(account))).toEqual([first.record]);
        expect(await store.commit(account, 1n, second)).toEqual({
          status: "committed",
          record: second.record,
        });
        expect(await store.load(account)).toEqual({
          revision: 2n,
          balances: second.balances,
        });
      },
    );

    scenario(
      "conflicting genesis operations leave the account uninitialized",
      async (store) => {
        const account = accountId("uninitialized");
        const candidate = posting(account, "uninitialized-event", 2n, 3n, 3n);
        expect(await store.commit(account, 1n, candidate)).toEqual({
          status: "conflict",
        });
        expect(await store.replaceProjection(account, 1n, balances(0n))).toBe(
          false,
        );
        await store.deleteProjection(account);
        expect(await store.load(account)).toEqual({
          revision: 0n,
          balances: {},
        });
        expect(await store.findEvent(candidate.record.id)).toBeNull();
        expect(await collect(store.journal(account))).toEqual([]);
      },
    );

    scenario(
      "concurrent writers at the same revision have exactly one winner",
      async (store) => {
        const account = accountId("concurrent");
        const left = posting(account, "concurrent-left", 1n, 3n, 3n);
        const right = posting(account, "concurrent-right", 1n, 7n, 7n);
        const waiting: (() => void)[] = [];
        const submit = async (commit: Commit) => {
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
          });
          return store.commit(account, 0n, commit);
        };
        const leftResult = submit(left);
        const rightResult = submit(right);
        for (const release of waiting) {
          release();
        }
        const [a, b] = await Promise.all([leftResult, rightResult]);
        const winner = a.status === "committed" ? left : right;
        const loser = a.status === "committed" ? right : left;
        expect([a.status, b.status].sort()).toEqual(["committed", "conflict"]);
        expect(a.status === "committed" ? a : b).toEqual({
          status: "committed",
          record: winner.record,
        });
        expect(a.status === "conflict" ? a : b).toEqual({ status: "conflict" });
        expect(await store.load(account)).toEqual({
          revision: 1n,
          balances: winner.balances,
        });
        expect(await collect(store.journal(account))).toEqual([winner.record]);
        expect(await store.findEvent(winner.record.id)).toEqual(winner.record);
        expect(await store.findEvent(loser.record.id)).toBeNull();
      },
    );

    scenario(
      "identical retries return the original record before stale revision or derived result checks",
      async (store) => {
        const account = accountId("retry");
        const first = posting(account, "retry-first", 1n, 3n, 3n);
        const second = posting(account, "retry-second", 2n, 5n, 8n);
        await store.commit(account, 0n, first);
        await store.commit(account, 1n, second);
        const differentDerivation = posting(
          account,
          "retry-first",
          9n,
          100n,
          100n,
        );
        const retry: Commit = {
          record: {
            ...first.record,
            revision: differentDerivation.record.revision,
            entries: differentDerivation.record.entries,
            recordedAt: new Date("2026-02-03T04:05:06.000Z"),
          },
          balances: differentDerivation.balances,
        };
        expect(await store.commit(account, 0n, retry)).toEqual({
          status: "idempotent",
          record: first.record,
        });
        expect(await store.load(account)).toEqual({
          revision: 2n,
          balances: second.balances,
        });
        expect(await collect(store.journal(account))).toEqual([
          first.record,
          second.record,
        ]);
      },
    );

    scenario(
      "an event ID cannot be reused for another envelope or account",
      async (store) => {
        const account = accountId("idempotency");
        const other = accountId("idempotency-other");
        const first = posting(account, "global-event", 1n, 3n, 3n);
        await store.commit(account, 0n, first);
        for (const changed of [
          posting(account, "global-event", 1n, 4n, 4n),
          posting(other, "global-event", 1n, 3n, 3n),
        ]) {
          await expect(
            store.commit(changed.record.accountId, 0n, changed),
          ).rejects.toMatchObject({
            name: "LedgerError",
            code: "IDEMPOTENCY_CONFLICT",
          });
        }
        expect(await store.findEvent(first.record.id)).toEqual(first.record);
        expect(await store.load(account)).toEqual({
          revision: 1n,
          balances: first.balances,
        });
        expect(await store.load(other)).toEqual({ revision: 0n, balances: {} });
        expect(await collect(store.journal(other))).toEqual([]);
      },
    );

    scenario(
      "revisions are contiguous, stable, and independent per account",
      async (store) => {
        const account = accountId("revisions");
        const other = accountId("revisions-other");
        expect(await store.load(account)).toEqual({
          revision: 0n,
          balances: {},
        });
        const first = posting(account, "revisions-one", 1n, 2n, 2n);
        const foreign = posting(other, "revisions-foreign", 1n, 11n, 11n);
        const second = posting(account, "revisions-two", 2n, 5n, 7n);
        await store.commit(account, 0n, first);
        await store.commit(other, 0n, foreign);
        const stale = posting(account, "revisions-stale", 1n, 19n, 19n);
        expect(await store.commit(account, 0n, stale)).toEqual({
          status: "conflict",
        });
        expect(await store.findEvent(stale.record.id)).toBeNull();
        const gap = posting(account, "revisions-gap", 9n, 5n, 7n);
        await expect(store.commit(account, 1n, gap)).rejects.toMatchObject({
          name: "LedgerError",
          code: "VALIDATION",
        });
        expect(await store.findEvent(gap.record.id)).toBeNull();
        expect(await store.load(account)).toEqual({
          revision: 1n,
          balances: first.balances,
        });
        expect(await store.commit(account, 1n, second)).toEqual({
          status: "committed",
          record: second.record,
        });
        expect(await collect(store.journal(account))).toEqual([
          first.record,
          second.record,
        ]);
        expect(await collect(store.journal(other))).toEqual([foreign.record]);
        expect(await store.load(account)).toEqual({
          revision: 2n,
          balances: balances(7n),
        });
        expect(await store.load(other)).toEqual({
          revision: 1n,
          balances: balances(11n),
        });
        expect(await store.findEvent(first.record.id)).toEqual(first.record);
      },
    );

    scenario(
      "the current projection equals a fold of all journal entries",
      async (store) => {
        const account = accountId("fold");
        const first = posting(account, "fold-one", 1n, 13n, 13n);
        const second = posting(account, "fold-two", 2n, 7n, 20n);
        const third = posting(account, "fold-three", 3n, 5n, 25n);
        for (const commit of [first, second, third]) {
          await store.commit(account, commit.record.revision - 1n, commit);
          const records = await collect(store.journal(account));
          expect(await store.load(account)).toEqual({
            revision: commit.record.revision,
            balances: fold(records),
          });
        }
        expect(await store.load(account)).toEqual({
          revision: 3n,
          balances: balances(25n),
        });
      },
    );

    scenario(
      "projection deletion and repair preserve history and reject stale or incorrect repairs",
      async (store) => {
        const account = accountId("repair");
        const first = posting(account, "repair-one", 1n, 3n, 3n);
        const second = posting(account, "repair-two", 2n, 7n, 10n);
        await store.commit(account, 0n, first);
        await store.deleteProjection(account);
        expect(await store.load(account)).toEqual({
          revision: 1n,
          balances: null,
        });
        expect(await store.findEvent(first.record.id)).toEqual(first.record);
        expect(await collect(store.journal(account))).toEqual([first.record]);
        await expect(
          store.replaceProjection(account, 1n, balances(999n)),
        ).rejects.toMatchObject({
          name: "LedgerError",
          code: "VALIDATION",
        });
        expect(await store.load(account)).toEqual({
          revision: 1n,
          balances: null,
        });
        expect(
          await store.replaceProjection(
            account,
            1n,
            fold(await collect(store.journal(account))),
          ),
        ).toBe(true);
        expect(await store.load(account)).toEqual({
          revision: 1n,
          balances: first.balances,
        });
        await store.commit(account, 1n, second);
        expect(await store.replaceProjection(account, 1n, first.balances)).toBe(
          false,
        );
        expect(await store.load(account)).toEqual({
          revision: 2n,
          balances: second.balances,
        });
        expect(await collect(store.journal(account))).toEqual([
          first.record,
          second.record,
        ]);
        await store.deleteProjection(account);
        expect(await store.replaceProjection(account, 1n, first.balances)).toBe(
          false,
        );
        expect(await store.load(account)).toEqual({
          revision: 2n,
          balances: null,
        });
        const replacement = balances(10n);
        expect(await store.replaceProjection(account, 2n, replacement)).toBe(
          true,
        );
        mutateObject(replacement.destination, "atomic", 999n);
        expect(await store.load(account)).toEqual({
          revision: 2n,
          balances: balances(10n),
        });
      },
    );

    scenario(
      "caller mutation cannot alter stored records or projections and each read is detached",
      async (store) => {
        const account = accountId("detachment");
        const input = posting(account, "detachment-one", 1n, 3n, 3n);
        const expected = posting(account, "detachment-one", 1n, 3n, 3n);
        const committed = await store.commit(account, 0n, input);
        mutateRecord(input.record);
        mutateObject(input.balances.destination, "atomic", 999n);
        if (committed.status !== "committed") {
          throw new Error("Initial commit did not succeed");
        }
        expect(committed.record).toEqual(expected.record);
        mutateRecord(committed.record);
        const found = await store.findEvent(expected.record.id);
        expect(found).toEqual(expected.record);
        if (found === null) {
          throw new Error("Committed event was not found");
        }
        mutateRecord(found);
        const journal = await collect(store.journal(account));
        expect(journal).toEqual([expected.record]);
        for (const record of journal) {
          mutateRecord(record);
        }
        const head = await store.load(account);
        expect(head).toEqual({ revision: 1n, balances: expected.balances });
        mutateObject(head.balances?.destination, "atomic", 999n);
        mutateObject(head, "revision", 999n);
        expect(await store.load(account)).toEqual({
          revision: 1n,
          balances: expected.balances,
        });
        const retry = await store.commit(account, 0n, expected);
        expect(retry).toEqual({
          status: "idempotent",
          record: expected.record,
        });
        if (retry.status !== "idempotent") {
          throw new Error("Committed event was not returned idempotently");
        }
        mutateRecord(retry.record);
        expect(await store.findEvent(expected.record.id)).toEqual(
          expected.record,
        );
        expect(await collect(store.journal(account))).toEqual([
          expected.record,
        ]);
      },
    );

    scenario(
      "serialization preserves large bigint quantities, payloads, and dates exactly",
      async (store) => {
        const account = accountId("serialization");
        const quantity = 900719925474099312345678901234567890n;
        const first = posting(
          account,
          "serialization-one",
          1n,
          quantity,
          quantity,
        );
        const second = posting(
          account,
          "serialization-two",
          2n,
          1n,
          quantity + 1n,
        );
        expect(await store.commit(account, 0n, first)).toEqual({
          status: "committed",
          record: first.record,
        });
        expect(await store.commit(account, 1n, second)).toEqual({
          status: "committed",
          record: second.record,
        });
        expect(await store.findEvent(first.record.id)).toEqual(first.record);
        expect(await collect(store.journal(account))).toEqual([
          first.record,
          second.record,
        ]);
        expect(await store.load(account)).toEqual({
          revision: 2n,
          balances: balances(quantity + 1n),
        });
      },
    );

    scenario(
      "nonpositive and mixed-commodity entries are rejected without any durable effects",
      async (store) => {
        const account = accountId("invalid-entries");
        const valid = posting(account, "invalid-entries-event", 1n, 3n, 3n);
        const mixed: Commit = {
          ...valid,
          record: {
            ...valid.record,
            entries: [
              {
                debit: { name: "source", commodity: "USD" },
                credit: { name: "destination", commodity: "EUR" },
                amount: { commodity: "USD", atomic: 3n },
              },
            ],
          },
          balances: {
            source: { commodity: "USD", atomic: -3n },
            destination: { commodity: "EUR", atomic: 3n },
          },
        };
        for (const invalid of [
          {
            ...valid,
            record: { ...valid.record, entries: [] },
            balances: balances(0n),
          },
          posting(account, "invalid-entries-event", 1n, 0n, 0n),
          posting(account, "invalid-entries-event", 1n, -3n, -3n),
          mixed,
          { ...valid, record: { ...valid.record, fingerprint: "forged" } },
        ]) {
          await expect(
            store.commit(account, 0n, invalid),
          ).rejects.toMatchObject({ name: "LedgerError", code: "VALIDATION" });
          expect(await store.load(account)).toEqual({
            revision: 0n,
            balances: {},
          });
          expect(await store.findEvent(valid.record.id)).toBeNull();
          expect(await collect(store.journal(account))).toEqual([]);
        }
        expect(await store.commit(account, 0n, valid)).toEqual({
          status: "committed",
          record: valid.record,
        });
      },
    );

    scenario(
      "journal ranges are exclusive-inclusive and enumeration excludes later appends",
      async (store) => {
        const account = accountId("journal-range");
        const first = posting(account, "journal-range-one", 1n, 1n, 1n);
        const second = posting(account, "journal-range-two", 2n, 2n, 3n);
        const third = posting(account, "journal-range-three", 3n, 3n, 6n);
        const fourth = posting(account, "journal-range-four", 4n, 4n, 10n);
        for (const commit of [first, second, third]) {
          await store.commit(account, commit.record.revision - 1n, commit);
        }
        const iterator = store.journal(account)[Symbol.asyncIterator]();
        try {
          expect(await iterator.next()).toEqual({
            done: false,
            value: first.record,
          });
          await store.commit(account, 3n, fourth);
          expect(await iterator.next()).toEqual({
            done: false,
            value: second.record,
          });
          expect(await iterator.next()).toEqual({
            done: false,
            value: third.record,
          });
          expect((await iterator.next()).done).toBe(true);
        } finally {
          await iterator.return?.();
        }
        expect(
          await collect(store.journal(account, { after: 1n, through: 3n })),
        ).toEqual([second.record, third.record]);
        expect(
          await collect(store.journal(account, { after: 2n, through: 2n })),
        ).toEqual([]);
        expect(await collect(store.journal(account, { after: 3n }))).toEqual([
          fourth.record,
        ]);
        expect(await collect(store.journal(account, { through: 1n }))).toEqual([
          first.record,
        ]);
      },
    );
  });
}
