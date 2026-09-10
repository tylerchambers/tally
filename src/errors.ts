/**
 * Provides machine-readable failures without requiring message matching.
 * VALIDATION rejects input; IDEMPOTENCY_CONFLICT rejects event-ID reuse;
 * CONCURRENCY exhausts optimistic attempts; INVARIANT rejects candidate balances;
 * UNKNOWN_EVENT lacks a registered version; CORRUPT_HISTORY signals inconsistent
 * persisted data or rule drift; PROJECTION_MISSING requires rebuild; and
 * REVISION_OUT_OF_RANGE exceeds the durable account head.
 */
export type LedgerErrorCode =
  | "VALIDATION"
  | "IDEMPOTENCY_CONFLICT"
  | "CONCURRENCY"
  | "INVARIANT"
  | "UNKNOWN_EVENT"
  | "CORRUPT_HISTORY"
  | "PROJECTION_MISSING"
  | "REVISION_OUT_OF_RANGE";

/**
 * Carries a stable ledger failure code and an optional underlying cause.
 * Schema callbacks, accounting rules, and storage may also throw other errors.
 */
export class LedgerError extends Error {
  /**
   * Creates a coded failure, preserving an underlying cause when supplied.
   */
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LedgerError";
  }
}
