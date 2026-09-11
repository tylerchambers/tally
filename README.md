# Tally

An embeddable TypeScript ledger for tracking money, tokens, or other fungible quantities without losing the explanation for each balance change.

Your application defines **facts** such as `depositReceived` or `withdrawalSent`. A versioned accounting rule turns each fact into balanced entries. The ledger commits the fact, its entries, and the updated balances atomically.

```text
Typed event → versioned accounting rule → double-entry movements → balances
                        immutable journal preserves both why and how
```

## Why a ledger instead of a balance column?

A balance column tells you what is available now, but not how it got there. This library keeps the explanation and the current value consistent:

- **Unit mistakes fail early.** Commodity types distinguish USD from BTC; `bigint` atomic units avoid floating-point rounding.
- **Retries do not duplicate accounting effects.** A durable event ID identifies the original fact, even after later events change the account.
- **Rules have one home.** Application code records facts rather than assembling arbitrary debit/credit instructions at each call site.
- **History survives corrections.** Correcting events append new movements instead of rewriting earlier records.
- **Storage stays yours.** Use the reference memory store, the PostgreSQL adapter, or your own implementation. There is no service to deploy or application container to adopt.

This is an accounting kernel, not a payment processor, authorization layer, exchange-rate service, or general-purpose event bus. Each account is one consistency boundary; one event cannot atomically move value across two ledger accounts.

## Quickstart

### 1. Set up the checkout

Install [mise](https://mise.jdx.dev/getting-started.html), then clone and build the project:

```sh
git clone https://github.com/tylerchambers/tally.git
cd tally
mise trust
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run build
mise exec -- bun examples/basic.ts
```

The repository pins Bun through `mise.toml`. The build produces ESM JavaScript and TypeScript declarations in `dist/`; package-name imports below resolve through those artifacts. The existing example covers deposits, reservations, a second commodity, idempotent retries, and projection rebuilding.

This quickstart works from source without assuming a registry release. To install this checkout into another Bun project, build it, run `mise exec -- bun pm pack --destination /tmp/tally-package`, then run `bun add /tmp/tally-package/tylerchambers-tally-0.1.0.tgz zod` in that project. Import the package exports, not files under `src/` or hashed build chunks.

### 2. Define the accounting model

Save the following as `quickstart.ts` in the repository root, then run `mise exec -- bun quickstart.ts`:

```ts
import { z } from "zod";
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
} from "@tylerchambers/tally";
import { MemoryLedgerStore } from "@tylerchambers/tally/memory";

const balances = defineBalances({
  external: balance("USD"),
  available: balance("USD"),
});

const events = defineEvents(balances, {
  depositReceived: event({
    v1: eventVersion({
      balances,
      schema: z.strictObject({ quantity: amountSchema("USD") }),
      apply: ({ quantity }) => [
        entry(balances.external, balances.available, quantity),
      ],
    }),
  }),
});

const store = new MemoryLedgerStore();
const ledger = createLedger({
  balances,
  events,
  store,
  invariants: [(proposed) => proposed.available.atomic >= 0n],
});

const account = accountId("customer-42");
const deposit = {
  id: eventId("bank-transfer-001"),
  accountId: account,
  event: events.depositReceived.v1({ quantity: amount("USD", 10_000n) }),
};

const first = await ledger.recordEvent(deposit);
const retry = await ledger.recordEvent(deposit);
const current = await ledger.getBalances(account);

process.stdout.write(`Available: ${current.available.atomic} USD cents\n`);
process.stdout.write(`Revision: ${first.revision}; retry: ${retry.revision}\n`);
```

Expected output:

```text
Available: 10000 USD cents
Revision: 1; retry: 1
```

Here USD atomic units mean cents, so `10_000n` is $100.00. The library does not assign decimal precision to commodity labels; your application owns that convention. A posting **subtracts from the debit and adds to the credit**. After this deposit, `external` is `-10_000n` and `available` is `10_000n`; the USD total remains zero. Negative balances are valid unless an application invariant prohibits them.

An entry requires a strictly positive amount, distinct balance names, and the same commodity on both sides. Each event must produce at least one entry. A multi-commodity event produces separate entries for each commodity; USD and BTC are never directly balanced against each other.

The memory adapter is process-local: restarting the program discards its history. Use PostgreSQL for durable records.

## The runtime API

Ordinary application code needs two operations:

| Operation | Result and intended use |
| --- | --- |
| `ledger.recordEvent(envelope)` | Returns the committed journal record, or the original record for an identical retry. New events advance the account revision once. |
| `ledger.getBalances(accountId)` | Returns the typed current balance vector without replaying history. An unknown account starts at zero. |

Administrative and historical operations use the same accounting model:

| Operation | Result and intended use |
| --- | --- |
| `ledger.getBalances(accountId, { at: { revision } })` | Replays entries through that revision. Revision zero is the zero vector; a future revision is rejected. |
| `ledger.readJournal(accountId, { after, through })` | Streams records with `after` exclusive and `through` inclusive. The default upper bound is captured when iteration starts. |
| `ledger.rebuild(accountId)` | Reconstructs balances from persisted entries and replaces the projection only if the durable revision still matches. Returns the rebuilt vector. |
| `ledger.verify(accountId)` | Replays history, reruns each recorded event's rule, checks invariants and the captured projection, and returns `{ revision, balances }`. Does not repair anything. |

Current reads do not grow with account history. Historical reads, rebuilds, and verification traverse the requested history; the PostgreSQL journal uses bounded keyset pages. Verification describes its captured revision, not a guarantee that no later event has committed.

### Event identity and ordering

- `EventId` is unique **across all accounts in a store**. Namespace IDs when different upstream systems can issue the same identifier.
- Identity covers the account, event type/version/payload, optional `effectiveAt`, and optional `metadata`. Object key order is canonicalized. Different metadata or effective time is different content, even if accounting entries would be identical.
- Reusing an ID with different content throws `IDEMPOTENCY_CONFLICT`. Do not generate a new ID merely because a request timed out: retry the same envelope to find the winning commit.
- Derived entries, recording time, and revision are not part of request identity. An identical retry returns their original committed values.
- Revision is the account's canonical order. `effectiveAt` is descriptive domain time; it does not reorder history or provide time-based balance queries.

On a revision conflict, the ledger reloads balances and reruns the rule and invariants. `maxAttempts` defaults to 8 and accepts integers from 1 to 1,000. Exhaustion throws `CONCURRENCY`. This bounded policy covers revision conflicts, not arbitrary database/network failures, and has no built-in backoff.

### Versioned rules and invariants

`defineEvents(balances, definitions)` binds every event version to one balance catalog; mixing versions built for another catalog fails at compile time and at runtime. `eventVersion({ schema, balances, apply })` uses the schema to infer payload types and the balance definitions to infer both `apply(input, current)`'s current-state argument and its permitted entries. A rule can return only entries between balances in that catalog with one shared commodity. `createLedger()` accepts the event catalog only with those same balance definitions. Callers use constructors such as `events.depositReceived.v1(payload)`; the persisted event contains `type`, numeric `version`, and `payload`.

The payload is stored as validated **schema input**. Rules receive parsed **schema output**, so a deterministic Zod transform can convert an input string to a `bigint` and repeat that conversion during verification. Different inputs remain different facts even if they transform to the same output.

Rules, schema callbacks/defaults, and invariants must be synchronous and deterministic. They must not perform I/O or depend on the current clock, randomness, metadata, or mutable external state. Retries and verification can execute them more than once. The library isolates supplied data; it cannot sandbox a callback's external dependencies.

Once a version is committed, retain its schema and rule unchanged while it must remain available to typed journal readers or verification, and introduce a new version for different treatment. Balance replay and projection rebuilding use persisted entries and do not require the historical rule. Keep the balance catalog compatible with stored history. Invariants must return `true` to accept the proposed state; `false` or a thrown exception aborts the write. Verification also evaluates the **currently configured** invariants, so changing them can reject old states even when their original rules have not changed.

For a correction, define and record a new event whose rule makes the compensating entries. There is no history-editing API.

## PostgreSQL

### Start the local database

Docker Compose provides a development database on `127.0.0.1:55439`:

```sh
docker compose up -d --wait postgres
```

The checked-in credentials are for local development only. The named volume preserves data between starts; `docker compose down` stops the service without deleting that volume.

### Supply the adapter

In the quickstart, keep the balance/event definitions and replace the memory-store construction and subsequent calls with this composition code. Add these imports at the top of the file:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migrate, PostgresLedgerStore } from "@tylerchambers/tally/postgres";
```

Then construct and own the connection explicitly:

```ts
const config = z.object({
  DATABASE_URL: z.url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "postgres:" || protocol === "postgresql:";
  }),
}).parse(process.env);

const client = postgres(config.DATABASE_URL, { max: 8 });
try {
  const database = drizzle(client);
  await migrate(database);

  const ledger = createLedger({
    balances,
    events,
    store: new PostgresLedgerStore(database),
    invariants: [(proposed) => proposed.available.atomic >= 0n],
  });
  const account = accountId("postgres-customer-42");
  await ledger.recordEvent({
    id: eventId("postgres-bank-transfer-001"),
    accountId: account,
    event: events.depositReceived.v1({ quantity: amount("USD", 10_000n) }),
  });
  const current = await ledger.getBalances(account);
  process.stdout.write(`Available: ${current.available.atomic} USD cents\n`);
} finally {
  await client.end();
}
```

Run the adapted file against the development database:

```sh
DATABASE_URL=postgres://ledger:ledger-test@127.0.0.1:55439/ledger mise exec -- bun quickstart.ts
```

In another project, declare `drizzle-orm` and `postgres` as direct dependencies because its composition code imports them. In a long-running application, keep the client open for the application's lifetime and close it at shutdown, not after every event.

`migrate(database)` is explicit, transactional, and safe to repeat for the same migration. It creates the fixed `typed_ledger` schema and checks the recorded migration checksum; it does not audit all live schema objects for drift. Migrations are forward-only. Run them under a deployment role with DDL privileges, rather than granting those privileges to every request handler.

The adapter commits journal records, entry rows, revision, and projection in one transaction. SQL constraints protect entry quantities and commodities; triggers reject history updates, deletes, truncation, and entry inserts outside the original event transaction. These are safeguards against accidental mutation, not tamper-proofing against a privileged database owner. Backups, access control, and database operations remain the embedding application's responsibility.

### Repairing projections

The journal is authoritative; the current-balance projection is disposable. `ledger.rebuild(account)` repairs a missing or semantically incorrect projection using revision-checked replacement. If the stored projection cannot even be decoded or validated, explicitly call `store.deleteProjection(account)` before rebuilding. Deletion is administrative: until repair finishes, current reads and new writes fail with `PROJECTION_MISSING`. It never deletes history or resets the durable revision.

Rebuilding folds stored entries without resolving or executing accounting rules, so retired event versions do not prevent projection recovery. It still validates journal structure, entries, fingerprints, account identity, and contiguous revisions. Use `verify()` with the complete historical catalog to check that retained rules still explain those entries. Do not use a rebuild to conceal corrupt history or rule drift.

## Writing a storage adapter

Implement [`LedgerStore`](src/store.ts), using `@tylerchambers/tally/storage` for the canonical codec, fingerprinting, record/vector validation, and entry-fold helpers. A custom store must preserve these semantics:

1. Capture input before an async suspension and detach all returned records/projections from durable state.
2. Enforce globally unique event IDs. Return identical retries before revision or newly derived balance checks; reject different content.
3. Compare revisions and commit the entire event, all entries, projection, and next revision atomically. A conflict or failure must leave no partial state.
4. Stream ordered, bounded journal snapshots. Preserve history independently of the current projection.
5. Verify projection replacements against the journal and reject stale repairs without changing the revision.

Run the shipped Bun conformance suite against a fresh store factory. Each invocation must create an isolated, empty store and return its `store` plus an asynchronous `dispose()` method that releases its resources. Import `storeConformance` from `@tylerchambers/tally/testing`; see the [memory binding](tests/memory/conformance.test.ts) and [PostgreSQL fixture](tests/postgres/fixture.ts) for concrete implementations. The suite covers idempotency, concurrency, atomicity, reconstruction, detachment, serialization, and range semantics; database adapters should additionally test their own transaction and schema failure paths against the real database.

### Persistence values

The canonical codec preserves `bigint`, valid `Date`, strings, booleans, finite numbers, `null`, dense arrays, and plain data objects. It distinguishes a bigint from a string containing the same digits. Accounting quantities still require `bigint`; support for ordinary numbers is for other payload/metadata fields.

Omit absent optional properties rather than assigning `undefined`. Unsupported values—including functions, symbols, sparse arrays, cyclic objects, maps, sets, invalid dates, and non-finite numbers—are rejected instead of silently losing information. Serialization is bounded to 128 levels. Do not replace the codec with plain `JSON.stringify()`, which cannot preserve these accounting payloads.

## Failure handling

Catch `LedgerError` and branch on `error.code`, not message text. Causes are retained when errors are translated.

| Code | Meaning |
| --- | --- |
| `VALIDATION` | A boundary value or accounting entry violates the contract. |
| `IDEMPOTENCY_CONFLICT` | The ID already belongs to different envelope content. |
| `CONCURRENCY` | The bounded write or rebuild attempts were exhausted. |
| `INVARIANT` | A proposed or verified state failed an application invariant. |
| `UNKNOWN_EVENT` | The configured catalog does not contain the recorded name/version. |
| `CORRUPT_HISTORY` | History, projection, or recorded accounting effects are inconsistent. |
| `PROJECTION_MISSING` | Current state cannot be used until its projection is rebuilt. |
| `REVISION_OUT_OF_RANGE` | The requested revision exceeds the account's durable history. |

Not every thrown error is a `LedgerError`: database failures and unexpected rule defects can propagate. A failed persisted-value check can also surface as `VALIDATION` at the adapter boundary. Treat detailed messages and causes as internal diagnostics rather than automatically exposing them to callers.

## Development and verification

| Command | Checks |
| --- | --- |
| `mise exec -- bun run format` | Biome formatting, import organization, and safe fixes. |
| `mise exec -- bun run check` | Pinned Bun version, Biome with warnings treated as failures, strict native TypeScript, and core/memory tests. |
| `mise exec -- bun run test:integration` | Real-PostgreSQL conformance and database-specific regressions. Requires `TEST_DATABASE_URL`. |
| `mise exec -- bun run build` | Clean ESM artifacts and declarations. |
| `node scripts/package-smoke.mjs` | Built package's runtime behavior and subpath imports under Node; build first. |

To run integration tests against the local Compose database:

```sh
TEST_DATABASE_URL=postgres://ledger:ledger-test@127.0.0.1:55439/ledger mise exec -- bun run test:integration
```

Use a disposable test server. The test role needs `CREATEDB`; each fixture creates and drops its own database. That privilege is a test-harness requirement, not a production runtime requirement. CI runs frozen dependency installation, the quality gate, PostgreSQL tests, build, and Node package smoke.

### Code map

- [`src/primitives.ts`](src/primitives.ts): exact units, named balances, and structurally balanced entries.
- [`src/events.ts`](src/events.ts): inferred event constructors and stable version resolution.
- [`src/ledger.ts`](src/ledger.ts): orchestration, invariants, optimistic retries, replay, and verification.
- [`src/store.ts`](src/store.ts): application-owned persistence contract.
- [`src/serialization.ts`](src/serialization.ts) and [`src/storage-validation.ts`](src/storage-validation.ts): lossless boundaries shared by adapters.
- [`src/memory.ts`](src/memory.ts) and [`src/postgres/`](src/postgres/): reference and durable storage.
- [`src/testing/conformance.ts`](src/testing/conformance.ts): reusable storage behavior suite.

API documentation follows the [Google TypeScript commenting guide](https://google.github.io/styleguide/tsguide.html#comments-and-documentation): terse JSDoc for consumer contracts and rationale, ordinary line comments for implementation details, and no repetition of TypeScript's type annotations.
