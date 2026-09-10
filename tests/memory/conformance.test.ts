import { MemoryLedgerStore } from "../../src/memory.ts";
import { storeConformance } from "../../src/testing/conformance.ts";

storeConformance("MemoryLedgerStore", async () => ({
  store: new MemoryLedgerStore(),
  dispose: () => Promise.resolve(),
}));
