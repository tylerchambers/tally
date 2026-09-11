import { z } from "zod";
import type {
  AccountId,
  Amount,
  Entry,
  EventId,
  EventsOf,
} from "../../src/index.ts";
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

// Compiled by tsc, never called: deliberately invalid operations must not execute.
export async function inferenceContract(): Promise<void> {
  const USD = commodity("USD");
  const TOKEN = commodity("TOKEN");
  const balances = defineBalances({
    external: balance(USD),
    cash: balance(USD),
    issued: balance(TOKEN),
    token: balance(TOKEN),
  });
  const events = defineEvents(balances, {
    deposit: event({
      v1: eventVersion({
        schema: z.strictObject({ quantity: amountSchema(USD) }),
        balances,
        apply: (payload, current) => {
          const dollars: Amount<"USD"> = current.cash;
          const tokens: Amount<"TOKEN"> = current.token;
          const posting = entry(
            balances.external,
            balances.cash,
            payload.quantity,
          );
          const typedPosting: Entry<"USD"> = posting;
          // @ts-expect-error A dollar balance is not a token balance.
          const wrong: Amount<"TOKEN"> = dollars;
          // @ts-expect-error Current vector contains only the configured named balances.
          current.missing;
          void [tokens, typedPosting, wrong];
          return [posting];
        },
      }),
      v2: eventVersion({
        schema: z.strictObject({ cents: z.string().transform(BigInt) }),
        balances,
        apply: (payload) => [
          entry(balances.external, balances.cash, amount(USD, payload.cents)),
        ],
      }),
    }),
    mint: event({
      v1: eventVersion({
        schema: z.strictObject({ quantity: amountSchema(TOKEN) }),
        balances,
        apply: (payload) => [
          entry(balances.issued, balances.token, payload.quantity),
        ],
      }),
    }),
  });
  const unsafeEntries = [
    {
      debit: balances.external,
      credit: balances.token,
      amount: amount(USD, 1n),
    },
  ] as const;
  eventVersion({
    schema: z.strictObject({}),
    balances,
    // @ts-expect-error Rules may return only commodity-safe entries from this catalog.
    apply: () => unsafeEntries,
  });
  const unknownBalanceEntries = [
    {
      debit: balances.external,
      credit: { name: "unconfigured", commodity: USD },
      amount: amount(USD, 1n),
    },
  ] as const;
  eventVersion({
    schema: z.strictObject({}),
    balances,
    // @ts-expect-error Rules may reference only balances in their declared catalog.
    apply: () => unknownBalanceEntries,
  });
  const ledger = createLedger({
    balances,
    events,
    store: new MemoryLedgerStore(),
  });
  const id = accountId("typed");
  const key = eventId("event");
  const account: AccountId = id;
  const eventKey: EventId = key;
  void [account, eventKey];
  // @ts-expect-error IDs are distinct nominal types.
  const swapped: AccountId = eventKey;
  void swapped;
  // @ts-expect-error Floating point amounts are not representable.
  amount(USD, 1.5);
  // @ts-expect-error Debit and credit must use the same commodity.
  entry(balances.cash, balances.token, amount(USD, 1n));
  // @ts-expect-error Quantity commodity is constrained by the debit, not inferred as a union.
  entry(balances.external, balances.cash, amount(TOKEN, 1n));
  // @ts-expect-error Payload schema rejects the wrong commodity statically.
  events.deposit.v1({ quantity: amount(TOKEN, 1n) });
  // @ts-expect-error Event versions are closed by the configured catalog.
  events.deposit.v3({});
  // @ts-expect-error Required payload properties cannot be omitted.
  events.deposit.v1({});
  // @ts-expect-error Constructors accept schema input, not transformed output.
  events.deposit.v2({ cents: 3n });
  createLedger({
    balances,
    events,
    store: new MemoryLedgerStore(),
    // @ts-expect-error Invariants must return an explicit acceptance decision.
    invariants: [() => {}],
  });
  const otherBalances = defineBalances({
    source: balance(USD),
    destination: balance(USD),
  });
  const otherVersion = eventVersion({
    schema: z.strictObject({}),
    balances: otherBalances,
    apply: () => [
      entry(otherBalances.source, otherBalances.destination, amount(USD, 1n)),
    ],
  });
  // @ts-expect-error One event catalog cannot mix different balance catalogs.
  defineEvents(balances, {
    valid: event({
      v1: eventVersion({
        schema: z.strictObject({}),
        balances,
        apply: () => [entry(balances.external, balances.cash, amount(USD, 1n))],
      }),
    }),
    invalid: event({ v2: otherVersion }),
  });
  createLedger({
    balances: otherBalances,
    // @ts-expect-error Event catalogs belong to the balance catalog they were defined with.
    events,
    store: new MemoryLedgerStore(),
  });
  const committed = await ledger.recordEvent({
    id: key,
    accountId: id,
    event: events.deposit.v2({ cents: "3" }),
  });
  const stored: EventsOf<typeof events> = committed.event;
  if (stored.type === "deposit") {
    if (stored.version === 1) {
      const dollars: Amount<"USD"> = stored.payload.quantity;
      void dollars;
    } else {
      const source: string = stored.payload.cents;
      void source;
    }
  } else {
    const tokens: Amount<"TOKEN"> = stored.payload.quantity;
    void tokens;
  }
  const current = await ledger.getBalances(id);
  const dollars: Amount<"USD"> = current.cash;
  void dollars;
  for await (const record of ledger.readJournal(id)) {
    if (record.event.type === "mint") {
      const tokens: Amount<"TOKEN"> = record.event.payload.quantity;
      void tokens;
    }
  }
}
