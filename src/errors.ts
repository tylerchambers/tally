export type LedgerErrorCode =
  | "VALIDATION"
  | "IDEMPOTENCY_CONFLICT"
  | "CONCURRENCY"
  | "INVARIANT"
  | "UNKNOWN_EVENT"
  | "CORRUPT_HISTORY"
  | "PROJECTION_MISSING"
  | "REVISION_OUT_OF_RANGE";

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LedgerError";
  }
}
