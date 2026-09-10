import { describe, expect, it } from "bun:test";
import { LedgerError } from "../../src/errors.ts";
import { accountId, eventId } from "../../src/primitives.ts";
import { clone, decode, encode, fingerprint } from "../../src/serialization.ts";

describe("canonical persistence encoding", () => {
  it("preserves exact bigint, negative zero, marker-like objects and prototype-named data", () => {
    const value: unknown = JSON.parse(
      '{"__proto__":{"admin":true},"constructor":"ordinary","nested":["bigint","12"]}',
    );
    const data = {
      value,
      atomic: 123456789012345678901234567890n,
      negativeZero: -0,
      date: new Date("2025-01-01T00:00:00.000Z"),
    };
    const restored = clone(data);
    expect(restored).toEqual(data);
    expect(Object.is(restored.negativeZero, -0)).toBe(true);
    if (typeof restored.value !== "object" || restored.value === null)
      throw new Error("Decoded object lost its shape");
    expect(Object.getPrototypeOf(restored.value)).toBe(Object.prototype);
    expect(Object.hasOwn(restored.value, "__proto__")).toBe(true);
  });

  it("canonicalizes object order but keeps semantic type and array order distinct", () => {
    expect(encode({ b: 2n, a: 1n })).toBe(encode({ a: 1n, b: 2n }));
    expect(encode(2n)).not.toBe(encode("2"));
    expect(encode([1n, 2n])).not.toBe(encode([2n, 1n]));
    expect(() => decode('["bigint","01"]')).toThrow(LedgerError);
    expect(() => decode('["object",[["a",["null"]],["a",["null"]]]]')).toThrow(
      LedgerError,
    );
  });

  it("rejects data whose persistence would silently lose information", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date("invalid"),
      new Map(),
      { missing: undefined },
      [undefined],
      cycle,
    ]) {
      expect(() => encode(value)).toThrow(LedgerError);
    }
    let invoked = false;
    const getter = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        invoked = true;
        return "secret";
      },
    });
    expect(() => encode(getter)).toThrow(LedgerError);
    expect(invoked).toBe(false);
  });

  it("fingerprints facts independently of derived journal fields", () => {
    const envelope = {
      id: eventId("event"),
      accountId: accountId("account"),
      event: { type: "deposit", version: 1, payload: { atomic: 2n } },
    };
    const journal = {
      ...envelope,
      revision: 42n,
      recordedAt: new Date("2025-01-01T00:00:00.000Z"),
      entries: [],
      fingerprint: "not part of identity",
    };
    expect(fingerprint(journal)).toBe(fingerprint(envelope));
    expect(
      fingerprint({ ...envelope, metadata: { reason: "correction" } }),
    ).not.toBe(fingerprint(envelope));
  });
});
