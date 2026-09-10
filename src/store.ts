export type AccountId = string & { readonly __brand: "AccountId" };
export type EventId = string & { readonly __brand: "EventId" };
export type Revision = bigint;
export type StoredAmount = Readonly<{ commodity: string; atomic: bigint }>;
export type StoredBalance = Readonly<{ name: string; commodity: string }>;
export type StoredEntry = Readonly<{
  debit: StoredBalance;
  credit: StoredBalance;
  amount: StoredAmount;
}>;
export type BalanceVector = Readonly<Record<string, StoredAmount>>;
export type StoredEvent = Readonly<{
  type: string;
  version: number;
  payload: unknown;
}>;
export type Metadata = Readonly<Record<string, unknown>>;
export type StoredEnvelope = Readonly<{
  id: EventId;
  accountId: AccountId;
  event: StoredEvent;
  effectiveAt?: Date;
  metadata?: Metadata;
}>;
export type JournalRecord = StoredEnvelope &
  Readonly<{
    revision: Revision;
    entries: readonly StoredEntry[];
    recordedAt: Date;
    fingerprint: string;
  }>;
export type Head = Readonly<{
  revision: Revision;
  balances: BalanceVector | null;
}>;
export type Commit = Readonly<{
  record: JournalRecord;
  balances: BalanceVector;
}>;
export type CommitResult =
  | Readonly<{ status: "committed" | "idempotent"; record: JournalRecord }>
  | Readonly<{ status: "conflict" }>;
export type JournalRange = Readonly<{ after?: Revision; through?: Revision }>;

/**
 * Application-owned persistence boundary. Returned values must be detached from stored state;
 * inputs must be captured before suspension. Never mutate or delete committed history.
 * Event IDs are globally unique within a store (not scoped to an account).
 */
export interface LedgerStore {
  /** Constant-time in history length. Unknown account: revision zero, empty vector.
   * A deleted projection is null, with its durable journal revision preserved. */
  load(accountId: AccountId): Promise<Head>;
  /** Global lookup used before evaluating potentially state-sensitive rules on retries. */
  findEvent(id: EventId): Promise<JournalRecord | null>;
  /**
   * Atomic compare-and-append. Identical fingerprint returns the original record BEFORE
   * revision/derivation checks. Different content throws IDEMPOTENCY_CONFLICT.
   * New writes compare expectedRevision, validate the complete entry fold, append event
   * and entries, and update projection/revision together. Conflict has no durable effects.
   * Fingerprints cover the full envelope, including metadata/effectiveAt, not derived fields.
   */
  commit(
    accountId: AccountId,
    expectedRevision: Revision,
    commit: Commit,
  ): Promise<CommitResult>;
  /** Ordered immutable snapshot, captured when iteration starts; after exclusive, through inclusive.
   * Stream bounded batches rather than loading an unbounded history into memory. */
  journal(
    accountId: AccountId,
    range?: JournalRange,
  ): AsyncIterable<JournalRecord>;
  /** CAS repair: verify balances equal the journal fold, replace only the projection,
   * and return false if the durable revision changed. Never advance the revision. */
  replaceProjection(
    accountId: AccountId,
    expectedRevision: Revision,
    balances: BalanceVector,
  ): Promise<boolean>;
  /** Administrative operation: preserve journal and durable revision. */
  deleteProjection(accountId: AccountId): Promise<void>;
}
