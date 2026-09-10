import assert from "node:assert/strict";
import {
  accountId,
  amount,
  amountSchema,
  balance,
  createLedger,
  defineBalances,
  defineEvents,
  entry,
  event,
  eventId,
  eventVersion,
  LedgerError,
} from "typed-operational-ledger";
import { MemoryLedgerStore } from "typed-operational-ledger/memory";
import { PostgresLedgerStore } from "typed-operational-ledger/postgres";
import { decode, encode } from "typed-operational-ledger/storage";
import { z } from "zod";

const balances = defineBalances({
  clearing: balance("USD"),
  available: balance("USD"),
});
const events = defineEvents({
  deposit: event({
    v1: eventVersion({
      balances,
      schema: z.strictObject({ amount: amountSchema("USD") }),
      apply: (payload) => [
        entry(balances.clearing, balances.available, payload.amount),
      ],
    }),
  }),
});
const store = new MemoryLedgerStore();
const ledger = createLedger({
  balances,
  events,
  store,
  clock: () => new Date("2026-01-01T00:00:00.000Z"),
});
const account = accountId("node-consumer");
const envelope = {
  id: eventId("node-deposit"),
  accountId: account,
  event: events.deposit.v1({ amount: amount("USD", 123n) }),
};
const original = await ledger.recordEvent(envelope);
assert.equal(original.revision, 1n);
assert.deepEqual(await ledger.recordEvent(envelope), original);
assert.equal((await ledger.getBalances(account)).available.atomic, 123n);
assert.equal(
  (await ledger.getBalances(account, { at: { revision: 0n } })).available
    .atomic,
  0n,
);
await assert.rejects(
  ledger.recordEvent({
    ...envelope,
    event: events.deposit.v1({ amount: amount("USD", 1n) }),
  }),
  LedgerError,
);
await store.deleteProjection(account);
await assert.rejects(ledger.getBalances(account), LedgerError);
assert.equal((await ledger.rebuild(account)).available.atomic, 123n);
assert.equal((await ledger.verify(account)).revision, 1n);
assert.deepEqual(decode(encode(original)), original);
assert.equal(typeof PostgresLedgerStore, "function");
process.stdout.write(
  "Node ESM package: record, idempotency, history, rebuild, verify, codec, and subpath imports passed\n",
);
