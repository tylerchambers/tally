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

// A simulated customer wallet: deposit $100, reserve $25, and issue 12 tokens.
// Run with `bun examples/basic.ts`. No real money moves or database is needed.
//
// USD amounts here are integer cents: 10_000n means $100.00. The `n` suffix is
// JavaScript bigint notation. TOKENS use whole units; Tally does not set precision.
const USD = commodity("USD");
const TOKENS = commodity("TOKENS");
const balances = defineBalances({
  // The outside-money counterpart, not customer debt: a $100 deposit makes this
  // -$100 while adding $100 to availableCash. USD balances still sum to zero.
  externalCash: balance(USD),
  availableCash: balance(USD),
  heldCash: balance(USD),
  // Issuing 12 tokens makes tokenIssuer -12 and tokens +12. Tokens balance
  // independently of USD; the two commodities are never added together.
  tokenIssuer: balance(TOKENS),
  tokens: balance(TOKENS),
});
const cashPayload = z.strictObject({ quantity: amountSchema(USD) });

// Rules translate business facts into balanced movements. entry(from, to, amount)
// subtracts from the first balance and adds to the second. `v1` identifies the
// rule version, not the event's position in the journal.
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

// This store lasts only for this process; each run starts with an empty wallet.
const store = new MemoryLedgerStore();
const ledger = createLedger({
  balances,
  events,
  store,
  // Reject any event that would leave spendable or reserved cash negative.
  invariants: [
    (current) =>
      current.availableCash.atomic >= 0n && current.heldCash.atomic >= 0n,
  ],
});

// 1. Record a $100 deposit: availableCash = $100, heldCash = $0.
// Keep the event ID stable when retrying the same bank transfer.
const account = accountId("customer-42");
const deposit = {
  id: eventId("deposit-001"),
  accountId: account,
  event: events.deposit.v1({ quantity: amount(USD, 10_000n) }),
  metadata: { reference: "bank-transfer-001" },
};
const original = await ledger.recordEvent(deposit);

// 2. Reserve $25: availableCash = $75, heldCash = $25. No money leaves the wallet.
await ledger.recordEvent({
  id: eventId("reserve-001"),
  accountId: account,
  event: events.reserve.v1({ quantity: amount(USD, 2_500n) }),
});

// 3. Issue 12 tokens without changing either cash balance.
await ledger.recordEvent({
  id: eventId("mint-001"),
  accountId: account,
  event: events.mint.v1({ quantity: amount(TOKENS, 12n) }),
});

// 4. Retry the original deposit. It returns the original commit rather than
// crediting another $100; the journal still contains only three events.
const retry = await ledger.recordEvent(deposit);
if (retry.revision !== original.revision)
  throw new Error("Idempotency did not return the original commit");

// Expected: $75 available, $25 held, 12 tokens, and their negative counterparts.
// The output calls integer quantities "atomic": 7500n USD means $75.00 here.
process.stdout.write(
  `${format("Current balances:", await ledger.getBalances(account))}\n`,
);

// Look back at revision 1, immediately after the deposit: $100 available,
// nothing held, and no tokens. This historical read does not change current state.
process.stdout.write(
  `${format(
    "After deposit:",
    await ledger.getBalances(account, { at: { revision: 1n } }),
  )}\n`,
);

// Simulate losing cached balances (the "projection"), not transaction history.
// Rebuild replays the journal and restores the same $75 / $25 / 12-token state.
await store.deleteProjection(account);
process.stdout.write(
  `${format("Rebuilt projection:", await ledger.rebuild(account))}\n`,
);

// Verify that the journal, versioned rules, invariants, and current balances
// agree. The result should report revision 3 and the same rebuilt balances.
process.stdout.write(`${format("Verified:", await ledger.verify(account))}\n`);

// Journal columns are: revision, event type, rule version.
// For example, "Journal: 2n reserve 1" is the second event, using reserve.v1.
for await (const record of ledger.readJournal(account))
  process.stdout.write(
    `${format(
      "Journal:",
      record.revision,
      record.event.type,
      record.event.version,
    )}\n`,
  );
