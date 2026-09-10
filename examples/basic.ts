import { format } from "node:util";
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
} from "../src/index.ts";
import { MemoryLedgerStore } from "../src/memory.ts";

const USD = commodity("USD");
const TOKENS = commodity("TOKENS");
const balances = defineBalances({
  externalCash: balance(USD),
  availableCash: balance(USD),
  heldCash: balance(USD),
  tokenIssuer: balance(TOKENS),
  tokens: balance(TOKENS),
});
const cashPayload = z.strictObject({ quantity: amountSchema(USD) });
const events = defineEvents({
  deposit: event({
    v1: eventVersion({
      schema: cashPayload,
      balances,
      apply: (payload) => [
        entry(balances.externalCash, balances.availableCash, payload.quantity),
      ],
    }),
  }),
  reserve: event({
    v1: eventVersion({
      schema: cashPayload,
      balances,
      apply: (payload) => [
        entry(balances.availableCash, balances.heldCash, payload.quantity),
      ],
    }),
  }),
  mint: event({
    v1: eventVersion({
      schema: z.strictObject({ quantity: amountSchema(TOKENS) }),
      balances,
      apply: (payload) => [
        entry(balances.tokenIssuer, balances.tokens, payload.quantity),
      ],
    }),
  }),
});
const store = new MemoryLedgerStore();
const ledger = createLedger({
  balances,
  events,
  store,
  invariants: [
    (current) =>
      current.availableCash.atomic >= 0n && current.heldCash.atomic >= 0n,
  ],
});
const account = accountId("customer-42");
const deposit = {
  id: eventId("deposit-001"),
  accountId: account,
  event: events.deposit.v1({ quantity: amount(USD, 10_000n) }),
  metadata: { reference: "bank-transfer-001" },
};
const original = await ledger.recordEvent(deposit);
await ledger.recordEvent({
  id: eventId("reserve-001"),
  accountId: account,
  event: events.reserve.v1({ quantity: amount(USD, 2_500n) }),
});
await ledger.recordEvent({
  id: eventId("mint-001"),
  accountId: account,
  event: events.mint.v1({ quantity: amount(TOKENS, 12n) }),
});
const retry = await ledger.recordEvent(deposit);
if (retry.revision !== original.revision)
  throw new Error("Idempotency did not return the original commit");
process.stdout.write(
  `${format("Current balances:", await ledger.getBalances(account))}\n`,
);
process.stdout.write(
  `${format(
    "After deposit:",
    await ledger.getBalances(account, { at: { revision: 1n } }),
  )}\n`,
);
await store.deleteProjection(account);
process.stdout.write(
  `${format("Rebuilt projection:", await ledger.rebuild(account))}\n`,
);
process.stdout.write(`${format("Verified:", await ledger.verify(account))}\n`);
for await (const record of ledger.readJournal(account))
  process.stdout.write(
    `${format(
      "Journal:",
      record.revision,
      record.event.type,
      record.event.version,
    )}\n`,
  );
