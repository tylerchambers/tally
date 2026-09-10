/** Canonical boundary utilities for application-supplied LedgerStore adapters. */
export { clone, decode, encode, fingerprint } from "./serialization.ts";
export {
  assertIdempotent,
  foldEntries,
  parseRecord,
  parseVector,
  validateCommit,
} from "./storage-validation.ts";
export type {
  AccountId,
  BalanceVector,
  Commit,
  CommitResult,
  EventId,
  Head,
  JournalRange,
  JournalRecord,
  LedgerStore,
  Revision,
  StoredEnvelope,
} from "./store.ts";
