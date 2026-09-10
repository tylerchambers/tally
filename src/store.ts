/**
 * Identifies an account within a store; validate untrusted strings with accountId().
 */
export type AccountId = string & { readonly __brand: "AccountId" };
/**
 * Identifies an event globally within a store, not merely within its account.
 */
export type EventId = string & { readonly __brand: "EventId" };
/**
 * Counts committed events per account, starting at zero and advancing by one.
 */
export type Revision = bigint;
/**
 * Stores an exact atomic quantity without display precision or floating-point math.
 */
export type StoredAmount = Readonly<{ commodity: string; atomic: bigint }>;
/**
 * Binds an account-local balance name to its fixed commodity.
 */
export type StoredBalance = Readonly<{ name: string; commodity: string }>;
/**
 * Moves a positive quantity from debit to credit within one commodity.
 */
export type StoredEntry = Readonly<{
  debit: StoredBalance;
  credit: StoredBalance;
  amount: StoredAmount;
}>;
/**
 * Maps account-local balance names to exact totals; negative totals are permitted.
 */
export type BalanceVector = Readonly<Record<string, StoredAmount>>;
/**
 * Preserves an event's versioned payload for replay without a storage-owned schema.
 */
export type StoredEvent = Readonly<{
  type: string;
  version: number;
  payload: unknown;
}>;
/**
 * Carries persistable context that participates in event identity.
 */
export type Metadata = Readonly<Record<string, unknown>>;
/**
 * Defines the caller-supplied identity hashed for idempotency, before derivation.
 */
export type StoredEnvelope = Readonly<{
  id: EventId;
  accountId: AccountId;
  event: StoredEvent;
  effectiveAt?: Date;
  metadata?: Metadata;
}>;
/**
 * Preserves the committed envelope and derived entries for audit and replay.
 * Readonly types do not freeze nested payloads or dates at runtime.
 */
export type JournalRecord = StoredEnvelope &
  Readonly<{
    revision: Revision;
    entries: readonly StoredEntry[];
    recordedAt: Date;
    fingerprint: string;
  }>;
/**
 * Separates durable progress from its disposable projection. Null balances mean
 * a missing projection; an unknown account instead has revision zero and {}.
 */
export type Head = Readonly<{
  revision: Revision;
  balances: BalanceVector | null;
}>;
/**
 * Proposes a journal append and its complete resulting balance projection.
 */
export type Commit = Readonly<{
  record: JournalRecord;
  balances: BalanceVector;
}>;
/**
 * Distinguishes a new append, an identical retry, and a revision race.
 * Idempotent results contain the original record, not the retry's derivation.
 */
export type CommitResult =
  | Readonly<{ status: "committed" | "idempotent"; record: JournalRecord }>
  | Readonly<{ status: "conflict" }>;
/**
 * Selects revisions after an exclusive lower bound through an inclusive upper
 * bound; omitted bounds mean zero and the head captured when iteration starts.
 */
export type JournalRange = Readonly<{ after?: Revision; through?: Revision }>;

/**
 * Keeps persistence and transaction policy outside ledger rules.
 *
 * Implementations must capture inputs before suspension and return detached
 * values, not necessarily frozen objects. Caller mutation must never change
 * stored state. Committed history is append-only, and event IDs are globally
 * unique within the store. All mutations must preserve these rules atomically.
 */
export interface LedgerStore {
  /**
   * Returns the head in constant time with respect to history length.
   * Unknown accounts have revision zero and {}; deleted projections have null
   * balances while retaining their durable revision.
   */
  load(accountId: AccountId): Promise<Head>;
  /**
   * Returns a detached record by global event ID, or null when absent.
   * Allows retries to resolve before state-sensitive rules are evaluated.
   */
  findEvent(id: EventId): Promise<JournalRecord | null>;
  /**
   * Atomically checks event identity before comparing the account revision.
   *
   * After validating the record, identical fingerprints return the original
   * record before revision or derivation checks; different fingerprints throw
   * IDEMPOTENCY_CONFLICT. Fingerprints cover the full envelope, including
   * metadata and effectiveAt, but exclude derived fields.
   *
   * New writes compare expectedRevision, validate the complete entry fold, then
   * append the event and entries and update the projection and revision together.
   * Revision conflicts and failures must leave no durable effects or reserved ID.
   */
  commit(
    accountId: AccountId,
    expectedRevision: Revision,
    commit: Commit,
  ): Promise<CommitResult>;
  /**
   * Yields detached records in revision order from a snapshot bounded when
   * iteration starts, excluding later appends. After is exclusive; through is
   * inclusive. Persistent adapters must use bounded batches rather than load an
   * unbounded history. Snapshot consistency does not require frozen results.
   */
  journal(
    accountId: AccountId,
    range?: JournalRange,
  ): AsyncIterable<JournalRecord>;
  /**
   * Repairs only the projection after verifying it against the journal fold.
   * Returns false if expectedRevision is stale; incorrect totals throw
   * VALIDATION. Extra zero balances are allowed. Comparison, verification, and
   * replacement must be atomic and must never advance the durable revision.
   */
  replaceProjection(
    accountId: AccountId,
    expectedRevision: Revision,
    balances: BalanceVector,
  ): Promise<boolean>;
  /**
   * Administratively removes the projection without deleting history or
   * advancing the revision. Unknown accounts remain absent. Callers must
   * authorize this operation; new commits require rebuilding the projection.
   */
  deleteProjection(accountId: AccountId): Promise<void>;
}
