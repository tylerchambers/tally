import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  accountId,
  amount,
  amountSchema,
  balance,
  commodity,
  createLedger,
  defineBalances,
  defineEvents,
  entry,
  event,
  eventId,
  eventVersion,
} from "../../src/index.ts";
import { MemoryLedgerStore } from "../../src/memory.ts";
import { fingerprint } from "../../src/serialization.ts";
import type {
  AccountId,
  BalanceVector,
  Commit,
  CommitResult,
  Head,
  JournalRange,
  JournalRecord,
} from "../../src/store.ts";

const USD = commodity("USD");
const balances = defineBalances({
  external: balance(USD),
  available: balance(USD),
  held: balance(USD),
});
const quantity = z.strictObject({ quantity: amountSchema(USD) });
const account = accountId("account-a");
const instant = new Date("2026-01-01T00:00:00.000Z");

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

function setup(store = new MemoryLedgerStore()) {
  const events = defineEvents(balances, {
    deposit: event({
      v1: eventVersion({
        schema: quantity,
        balances,
        apply: (payload) => [
          entry(balances.external, balances.available, payload.quantity),
        ],
      }),
    }),
    reserve: event({
      v1: eventVersion({
        schema: quantity,
        balances,
        apply: (payload, current) => {
          if (payload.quantity.atomic > current.available.atomic)
            throw new Error("Insufficient available funds");
          return [entry(balances.available, balances.held, payload.quantity)];
        },
      }),
    }),
  });
  const ledger = createLedger({
    balances,
    events,
    store,
    clock: () => instant,
    maxAttempts: 32,
  });
  return { ledger, events, store };
}

class FaultStore extends MemoryLedgerStore {
  transform: ((record: JournalRecord) => readonly JournalRecord[]) | undefined;
  projection: BalanceVector | undefined;
  onJournal: (() => Promise<void>) | undefined;
  onLoad: (() => Promise<void>) | undefined;
  conflicts = false;

  override async load(id: AccountId): Promise<Head> {
    const hook = this.onLoad;
    this.onLoad = undefined;
    await hook?.();
    const head = await super.load(id);
    return this.projection
      ? { revision: head.revision, balances: this.projection }
      : head;
  }

  override async commit(
    id: AccountId,
    expected: bigint,
    commit: Commit,
  ): Promise<CommitResult> {
    return this.conflicts
      ? { status: "conflict" }
      : super.commit(id, expected, commit);
  }

  override async *journal(
    id: AccountId,
    range?: JournalRange,
  ): AsyncIterable<JournalRecord> {
    const hook = this.onJournal;
    this.onJournal = undefined;
    await hook?.();
    for await (const record of super.journal(id, range)) {
      for (const item of this.transform ? this.transform(record) : [record])
        yield item;
    }
  }
}

describe("ledger", () => {
  it("records double entries, reads revision zero and historical balances, and keeps effective time separate", async () => {
    const { ledger, events } = setup();
    const zero = {
      external: amount(USD, 0n),
      available: amount(USD, 0n),
      held: amount(USD, 0n),
    };
    expect(await ledger.getBalances(account)).toEqual(zero);
    const deposited = await ledger.recordEvent({
      id: eventId("deposit"),
      accountId: account,
      event: events.deposit.v1({ quantity: amount(USD, 100n) }),
      effectiveAt: new Date("2025-01-01"),
      metadata: { source: "cash" },
    });
    const reserved = await ledger.recordEvent({
      id: eventId("reserve"),
      accountId: account,
      event: events.reserve.v1({ quantity: amount(USD, 30n) }),
    });
    expect(deposited.revision).toBe(1n);
    expect(deposited.recordedAt).toEqual(instant);
    expect(reserved.revision).toBe(2n);
    expect(await ledger.getBalances(account)).toEqual({
      external: amount(USD, -100n),
      available: amount(USD, 70n),
      held: amount(USD, 30n),
    });
    expect(await ledger.getBalances(account, { at: { revision: 0n } })).toEqual(
      zero,
    );
    expect(
      (await ledger.getBalances(account, { at: { revision: 1n } })).available
        .atomic,
    ).toBe(100n);
    await expect(
      ledger.getBalances(account, { at: { revision: 3n } }),
    ).rejects.toMatchObject({ code: "REVISION_OUT_OF_RANGE" });
    expect(await collect(ledger.readJournal(account, { after: 1n }))).toEqual([
      reserved,
    ]);
    expect(await ledger.verify(account)).toEqual({
      revision: 2n,
      balances: await ledger.getBalances(account),
    });
  });

  it("returns a same-ID winner that commits between lookup and state-sensitive rule execution", async () => {
    const store = new FaultStore();
    const events = defineEvents(balances, {
      once: event({
        v1: eventVersion({
          schema: z.strictObject({}),
          balances,
          apply: (_payload, current) => {
            if (current.available.atomic !== 0n)
              throw new Error("Already initialized");
            return [
              entry(balances.external, balances.available, amount(USD, 1n)),
            ];
          },
        }),
      }),
    });
    const ledger = createLedger({ balances, events, store });
    const envelope = {
      id: eventId("racing-once"),
      accountId: account,
      event: events.once.v1({}),
    };
    let winner: JournalRecord | undefined;
    store.onLoad = async () => {
      winner = await ledger.recordEvent(envelope);
    };
    const retried = await ledger.recordEvent(envelope);
    if (!winner) throw new Error("The scheduled winner did not commit");
    expect<JournalRecord>(retried).toEqual(winner);
    expect(retried.revision).toBe(1n);
    expect((await ledger.getBalances(account)).available.atomic).toBe(1n);
  });

  it("retries projection repair when an append invalidates its captured revision", async () => {
    const store = new FaultStore();
    const { ledger, events } = setup(store);
    await ledger.recordEvent({
      id: eventId("before-rebuild"),
      accountId: account,
      event: events.deposit.v1({ quantity: amount(USD, 1n) }),
    });
    store.onJournal = async () => {
      await ledger.recordEvent({
        id: eventId("during-rebuild"),
        accountId: account,
        event: events.deposit.v1({ quantity: amount(USD, 2n) }),
      });
    };
    expect((await ledger.rebuild(account)).available.atomic).toBe(3n);
    expect((await ledger.verify(account)).revision).toBe(2n);
  });

  it("preserves exact bigint arithmetic beyond the floating-point integer range", async () => {
    const { ledger, events } = setup();
    const atomic = 9_007_199_254_740_993n;
    await ledger.recordEvent({
      id: eventId("large"),
      accountId: account,
      event: events.deposit.v1({ quantity: amount(USD, atomic) }),
    });
    expect((await ledger.getBalances(account)).available.atomic).toBe(atomic);
    expect((await ledger.verify(account)).balances.external.atomic).toBe(
      -atomic,
    );
  });

  it("returns the original commit before a now-inapplicable rule or invariant can run", async () => {
    const store = new MemoryLedgerStore();
    let accepted = true;
    const events = defineEvents(balances, {
      once: event({
        v1: eventVersion({
          schema: z.strictObject({}),
          balances,
          apply: (_payload, current) => {
            if (current.available.atomic !== 0n)
              throw new Error("Only the first event is allowed");
            return [
              entry(balances.external, balances.available, amount(USD, 1n)),
            ];
          },
        }),
      }),
    });
    const ledger = createLedger({
      balances,
      events,
      store,
      clock: () => instant,
      invariants: [() => accepted],
    });
    const envelope = {
      id: eventId("once"),
      accountId: account,
      event: events.once.v1({}),
    };
    const original = await ledger.recordEvent(envelope);
    accepted = false;
    await store.deleteProjection(account);
    expect(await ledger.recordEvent(envelope)).toEqual(original);
    await expect(
      ledger.recordEvent({ ...envelope, metadata: { changed: true } }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      ledger.recordEvent({ ...envelope, accountId: accountId("another") }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects failed invariants without consuming an event ID or writing history", async () => {
    const { events, store } = setup();
    const ledger = createLedger({
      balances,
      events,
      store,
      invariants: [(current) => current.available.atomic <= 10n],
    });
    const id = eventId("bounded");
    await expect(
      ledger.recordEvent({
        id,
        accountId: account,
        event: events.deposit.v1({ quantity: amount(USD, 11n) }),
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
    expect(await store.load(account)).toEqual({ revision: 0n, balances: {} });
    expect(await store.findEvent(id)).toBeNull();
    expect(
      (
        await ledger.recordEvent({
          id,
          accountId: account,
          event: events.deposit.v1({ quantity: amount(USD, 10n) }),
        })
      ).revision,
    ).toBe(1n);
  });

  it("reloads state across competing commits without lost updates and bounds permanent conflicts", async () => {
    const { ledger, events } = setup();
    const records = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        ledger.recordEvent({
          id: eventId(`concurrent-${index}`),
          accountId: account,
          event: events.deposit.v1({ quantity: amount(USD, 1n) }),
        }),
      ),
    );
    expect(new Set(records.map((record) => record.revision)).size).toBe(12);
    expect((await ledger.getBalances(account)).available.atomic).toBe(12n);
    const failingStore = new FaultStore();
    failingStore.conflicts = true;
    const failing = setup(failingStore);
    await expect(
      failing.ledger.recordEvent({
        id: eventId("conflicting"),
        accountId: account,
        event: failing.events.deposit.v1({ quantity: amount(USD, 1n) }),
      }),
    ).rejects.toMatchObject({ code: "CONCURRENCY" });
    expect(await failingStore.findEvent(eventId("conflicting"))).toBeNull();
  });

  it("replays recorded entries without requiring their event versions", async () => {
    const { ledger, events, store } = setup();
    await ledger.recordEvent({
      id: eventId("retired-version"),
      accountId: account,
      event: events.deposit.v1({ quantity: amount(USD, 10n) }),
    });
    const replacementEvents = defineEvents(balances, {
      replacement: event({
        v1: eventVersion({
          schema: quantity,
          balances,
          apply: (payload) => [
            entry(balances.external, balances.available, payload.quantity),
          ],
        }),
      }),
    });
    const replacement = createLedger({
      balances,
      events: replacementEvents,
      store,
    });

    expect(
      (await replacement.getBalances(account, { at: { revision: 1n } }))
        .available.atomic,
    ).toBe(10n);
    await store.deleteProjection(account);
    expect((await replacement.rebuild(account)).available.atomic).toBe(10n);
    await expect(replacement.verify(account)).rejects.toMatchObject({
      code: "UNKNOWN_EVENT",
    });
  });

  it("rebuilds recorded entries without rerunning changed rules, while verify detects rule drift", async () => {
    const { ledger, events, store } = setup();
    await ledger.recordEvent({
      id: eventId("original"),
      accountId: account,
      event: events.deposit.v1({ quantity: amount(USD, 10n) }),
    });
    const changedEvents = defineEvents(balances, {
      deposit: event({
        v1: eventVersion({
          schema: quantity,
          balances,
          apply: () => [
            entry(balances.external, balances.available, amount(USD, 99n)),
          ],
        }),
      }),
    });
    const changed = createLedger({ balances, events: changedEvents, store });
    await store.deleteProjection(account);
    await expect(ledger.getBalances(account)).rejects.toMatchObject({
      code: "PROJECTION_MISSING",
    });
    expect((await changed.rebuild(account)).available.atomic).toBe(10n);
    await expect(changed.verify(account)).rejects.toMatchObject({
      code: "CORRUPT_HISTORY",
    });
    expect((await ledger.verify(account)).revision).toBe(1n);
  });

  it("verifies against the captured projection even if a writer appends during enumeration", async () => {
    const store = new FaultStore();
    const { ledger, events } = setup(store);
    await ledger.recordEvent({
      id: eventId("first"),
      accountId: account,
      event: events.deposit.v1({ quantity: amount(USD, 1n) }),
    });
    store.onJournal = async () => {
      await ledger.recordEvent({
        id: eventId("later"),
        accountId: account,
        event: events.deposit.v1({ quantity: amount(USD, 2n) }),
      });
    };
    const verified = await ledger.verify(account);
    expect(verified.revision).toBe(1n);
    expect(verified.balances.available.atomic).toBe(1n);
    expect((await ledger.getBalances(account)).available.atomic).toBe(3n);
  });

  it("detects a structurally valid but incorrect projection", async () => {
    const store = new FaultStore();
    const { ledger, events } = setup(store);
    await ledger.recordEvent({
      id: eventId("projection"),
      accountId: account,
      event: events.deposit.v1({ quantity: amount(USD, 1n) }),
    });
    store.projection = {
      external: amount(USD, -2n),
      available: amount(USD, 2n),
      held: amount(USD, 0n),
    };
    await expect(ledger.verify(account)).rejects.toMatchObject({
      code: "CORRUPT_HISTORY",
    });
  });

  it("rejects revision gaps, duplicated events, foreign accounts, and malformed entries", async () => {
    const store = new FaultStore();
    const { ledger, events } = setup(store);
    await ledger.recordEvent({
      id: eventId("corrupt"),
      accountId: account,
      event: events.deposit.v1({ quantity: amount(USD, 1n) }),
    });
    const cases: readonly Readonly<{
      transform: (record: JournalRecord) => readonly JournalRecord[];
      code: string;
    }>[] = [
      { transform: () => [], code: "CORRUPT_HISTORY" },
      {
        transform: (record) => [{ ...record, revision: 2n }],
        code: "CORRUPT_HISTORY",
      },
      { transform: (record) => [record, record], code: "CORRUPT_HISTORY" },
      {
        transform: (record) => {
          const foreign = { ...record, accountId: accountId("foreign") };
          return [{ ...foreign, fingerprint: fingerprint(foreign) }];
        },
        code: "CORRUPT_HISTORY",
      },

      {
        transform: (record) => [
          {
            ...record,
            entries: [
              {
                debit: balances.external,
                credit: balances.available,
                amount: amount(USD, -1n),
              },
            ],
          },
        ],
        code: "CORRUPT_HISTORY",
      },
    ];
    for (const scenario of cases) {
      store.transform = scenario.transform;
      await expect(ledger.rebuild(account)).rejects.toMatchObject({
        code: scenario.code,
      });
    }
  });

  it("classifies invalid persisted payloads as corrupt history", async () => {
    const store = new FaultStore();
    const { ledger, events } = setup(store);
    await ledger.recordEvent({
      id: eventId("invalid-persisted-payload"),
      accountId: account,
      event: events.deposit.v1({ quantity: amount(USD, 1n) }),
    });
    store.transform = (record) => {
      const invalid = {
        ...record,
        event: { ...record.event, payload: { quantity: "not-an-amount" } },
      };
      return [{ ...invalid, fingerprint: fingerprint(invalid) }];
    };

    await expect(collect(ledger.readJournal(account))).rejects.toMatchObject({
      code: "CORRUPT_HISTORY",
    });
    await expect(ledger.verify(account)).rejects.toMatchObject({
      code: "CORRUPT_HISTORY",
    });
  });

  it("detaches envelopes, returned dates, metadata, and journal records", async () => {
    const { ledger, events, store } = setup();
    const metadata = { tags: ["original"] };
    const effectiveAt = new Date("2025-01-01");
    const envelope = {
      id: eventId("detached"),
      accountId: account,
      event: events.deposit.v1({ quantity: amount(USD, 5n) }),
      metadata,
      effectiveAt,
    };
    const record = await ledger.recordEvent(envelope);
    metadata.tags.push("later");
    effectiveAt.setUTCFullYear(1999);
    record.recordedAt.setUTCFullYear(1999);
    record.effectiveAt?.setUTCFullYear(1999);
    const again = await store.findEvent(envelope.id);
    expect(again?.metadata).toEqual({ tags: ["original"] });
    expect(again?.effectiveAt).toEqual(new Date("2025-01-01"));
    expect(again?.recordedAt).toEqual(instant);
    const journal = await collect(ledger.readJournal(account));
    journal[0]?.recordedAt.setUTCFullYear(1998);
    expect((await store.findEvent(envelope.id))?.recordedAt).toEqual(instant);
  });

  it("persists schema input and reapplies transforms only at the rule boundary", async () => {
    const schema = z.strictObject({
      atomic: z
        .string()
        .regex(/^[0-9]+$/u)
        .transform(BigInt),
    });
    const events = defineEvents(balances, {
      imported: event({
        v1: eventVersion({
          schema,
          balances,
          apply: (payload) => [
            entry(
              balances.external,
              balances.available,
              amount(USD, payload.atomic),
            ),
          ],
        }),
      }),
    });
    const ledger = createLedger({
      balances,
      events,
      store: new MemoryLedgerStore(),
    });
    const record = await ledger.recordEvent({
      id: eventId("transformed"),
      accountId: account,
      event: events.imported.v1({ atomic: "42" }),
    });
    expect(record.event.payload).toEqual({ atomic: "42" });
    expect((await ledger.verify(account)).balances.available.atomic).toBe(42n);
    expect((await ledger.rebuild(account)).available.atomic).toBe(42n);
  });

  it("isolates caller and rule mutations from persisted schema input", async () => {
    const events = defineEvents(balances, {
      tagged: event({
        v1: eventVersion({
          schema: z.strictObject({ tags: z.array(z.string()) }),
          balances,
          apply: (payload) => {
            payload.tags.push("rule-only");
            return [
              entry(
                balances.external,
                balances.available,
                amount(USD, BigInt(payload.tags.length)),
              ),
            ];
          },
        }),
      }),
    });
    const input = { tags: ["original"] };
    const constructed = events.tagged.v1(input);
    input.tags.push("caller-only");
    const ledger = createLedger({
      balances,
      events,
      store: new MemoryLedgerStore(),
    });
    const record = await ledger.recordEvent({
      id: eventId("mutating-rule"),
      accountId: account,
      event: constructed,
    });
    expect(record.event.payload.tags).toEqual(["original"]);
    expect((await ledger.verify(account)).balances.available.atomic).toBe(2n);
  });

  it("snapshots event definitions so later catalog edits cannot change committed semantics", async () => {
    const original = eventVersion({
      schema: quantity,
      balances,
      apply: (payload) => [
        entry(balances.external, balances.available, payload.quantity),
      ],
    });
    const changed = eventVersion({
      schema: quantity,
      balances,
      apply: () => [
        entry(balances.external, balances.available, amount(USD, 99n)),
      ],
    });
    const versions = { v1: original };
    const definitions = { deposit: event(versions) };
    const events = defineEvents(balances, definitions);
    versions.v1 = changed;
    definitions.deposit = event({ v1: changed });
    const ledger = createLedger({
      balances,
      events,
      store: new MemoryLedgerStore(),
    });
    await ledger.recordEvent({
      id: eventId("catalog-snapshot"),
      accountId: account,
      event: events.deposit.v1({ quantity: amount(USD, 3n) }),
    });
    expect((await ledger.verify(account)).balances.available.atomic).toBe(3n);
  });

  it("rejects event versions from a different balance catalog", () => {
    const otherBalances = defineBalances({
      source: balance(USD),
      destination: balance(USD),
    });
    const mixed = {
      valid: event({
        v1: eventVersion({
          schema: z.strictObject({}),
          balances,
          apply: () => [
            entry(balances.external, balances.available, amount(USD, 1n)),
          ],
        }),
      }),
      invalid: event({
        v2: eventVersion({
          schema: z.strictObject({}),
          balances: otherBalances,
          apply: () => [
            entry(
              otherBalances.source,
              otherBalances.destination,
              amount(USD, 1n),
            ),
          ],
        }),
      }),
    };

    expect(() => defineEvents(balances, mixed as never)).toThrow(
      "Every event version must use the catalog passed to defineEvents",
    );
  });

  it("rejects rule entries referencing unconfigured balances without writing a record", async () => {
    const events = defineEvents(balances, {
      invalid: event({
        v1: eventVersion({
          schema: z.strictObject({}),
          balances,
          // Deliberately cross the TypeScript boundary to exercise validation for
          // JavaScript callers and corrupted adapter values.
          apply: () =>
            [
              entry(
                balances.external,
                { name: "unconfigured", commodity: USD },
                amount(USD, 1n),
              ),
            ] as never,
        }),
      }),
    });
    const store = new MemoryLedgerStore();
    const ledger = createLedger({ balances, events, store });
    await expect(
      ledger.recordEvent({
        id: eventId("invalid-rule"),
        accountId: account,
        event: events.invalid.v1({}),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await store.load(account)).toEqual({ revision: 0n, balances: {} });
  });

  it("rejects same-balance and non-positive entries at the public boundary", () => {
    expect(() =>
      entry(balances.available, balances.available, amount(USD, 1n)),
    ).toThrow();
    expect(() =>
      entry(balances.external, balances.available, amount(USD, 0n)),
    ).toThrow();
  });
});
