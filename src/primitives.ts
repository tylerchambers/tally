import { z } from "zod";
import { LedgerError } from "./errors.ts";
import type {
  AccountId,
  BalanceVector,
  EventId,
  StoredEntry,
} from "./store.ts";

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value && !/\p{Cc}/u.test(value));
/**
 * Validates catalog keys, excluding reserved prototype-related names.
 */
export const nameSchema = z
  .string()
  .max(256)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/u)
  .refine(
    (value) => !["constructor", "prototype", "__proto__"].includes(value),
  );
/**
 * Validates commodity labels without assigning precision or conversion rules.
 */
export const commoditySchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9._:-]*$/u);

/**
 * Returns schema output, translating validation failures to VALIDATION errors.
 */
export function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new LedgerError("VALIDATION", result.error.message, {
      cause: result.error,
    });
  return result.data;
}

/**
 * Validates and brands an account key without creating an account in storage.
 * Requires 1–256 characters with no surrounding whitespace or control characters.
 */
export function accountId(value: string): AccountId {
  // Branding follows validation of the external identifier representation.
  return parse(identifierSchema, value) as AccountId;
}

/**
 * Validates and brands an idempotency key, unique across accounts in one store.
 * Uses the same representation constraints as accountId; does not reserve the ID.
 */
export function eventId(value: string): EventId {
  return parse(identifierSchema, value) as EventId;
}

/**
 * Validates a commodity label while preserving its literal type for unit checks.
 */
export function commodity<const C extends string>(value: C): C {
  parse(commoditySchema, value);
  return value;
}

/**
 * Names an application-defined unit; its atomic scale is a caller convention.
 */
export type Commodity = string;
/**
 * Couples signed integer atomic units with a commodity to avoid floating-point
 * arithmetic and accidental cross-unit transfers. Negative balances are allowed.
 */
export type Amount<C extends string = string> = Readonly<{
  commodity: C;
  atomic: bigint;
}>;
/**
 * Identifies a named bucket and its only accepted commodity within an account.
 */
export type Balance<
  C extends string = string,
  N extends string = string,
> = Readonly<{ commodity: C; name: N }>;
/**
 * Transfers positive atomic units between distinct buckets of one commodity:
 * debit decreases the source and credit increases the destination.
 */
export type Entry<C extends string = string> = Readonly<{
  debit: Balance<C>;
  credit: Balance<C>;
  amount: Amount<C>;
}>;
/**
 * Defines the bucket catalog shared by an account's rules and balance vector.
 */
export type BalanceDefinitions = Readonly<Record<string, Balance>>;
/**
 * Derives every valid posting from a balance catalog, retaining exact bucket names
 * and excluding pairs whose commodities differ.
 */
export type CatalogEntry<B extends BalanceDefinitions> = {
  readonly [D in keyof B]: {
    readonly [C in keyof B]: B[C]["commodity"] extends B[D]["commodity"]
      ? B[D]["commodity"] extends B[C]["commodity"]
        ? Readonly<{
            debit: B[D];
            credit: B[C];
            amount: Amount<B[D]["commodity"]>;
          }>
        : never
      : never;
  }[keyof B];
}[keyof B];
/**
 * Derives every bucket's amount type from its catalog commodity.
 */
export type Balances<B extends BalanceDefinitions> = {
  readonly [K in keyof B]: Amount<B[K]["commodity"]>;
};

/**
 * Builds a strict, readonly amount schema for one commodity; accepts either sign.
 */
export function amountSchema<const C extends string>(
  unit: C,
): z.ZodType<Amount<C>, Amount<C>> {
  commodity(unit);
  return z
    .strictObject({ commodity: z.literal(unit), atomic: z.bigint() })
    .readonly();
}

/**
 * Creates a frozen amount in caller-defined atomic units, without decimal scaling.
 */
export function amount<const C extends string>(
  unit: C,
  atomic: bigint,
): Amount<C> {
  return parse(amountSchema(unit), { commodity: unit, atomic });
}

/**
 * Creates a frozen commodity specification; defineBalances supplies its name.
 */
export function balance<const C extends string>(
  unit: C,
): Readonly<{ commodity: C }> {
  return Object.freeze({ commodity: commodity(unit) });
}

/**
 * Creates a nonempty frozen catalog, inferring bucket names and commodity literals
 * so rules can refer to validated definitions instead of repeating strings.
 */
export function defineBalances<
  const B extends Readonly<Record<string, Readonly<{ commodity: string }>>>,
>(
  definitions: B,
): { readonly [K in keyof B]: Balance<B[K]["commodity"], K & string> } {
  const result = Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => {
      parse(nameSchema, name);
      return [
        name,
        Object.freeze({ name, commodity: commodity(definition.commodity) }),
      ];
    }),
  );
  if (Object.keys(result).length === 0)
    throw new LedgerError("VALIDATION", "At least one balance is required");
  // Each own key is preserved and attached as its balance's name above.
  return Object.freeze(result) as {
    readonly [K in keyof B]: Balance<B[K]["commodity"], K & string>;
  };
}

/**
 * Creates a positive transfer, rejecting equal bucket names or mismatched units
 * at runtime as well as preserving commodity constraints in TypeScript.
 */
export function entry<const D extends Balance, const C extends Balance>(
  debit: D,
  credit: C,
  quantity: Amount<NoInfer<D["commodity"]>> & Amount<NoInfer<C["commodity"]>>,
): Readonly<{ debit: D; credit: C; amount: Amount<D["commodity"]> }> {
  // Runtime validation proves every component matches the debit's inferred commodity.
  return parseEntry({ debit, credit, amount: quantity }) as Readonly<{
    debit: D;
    credit: C;
    amount: Amount<D["commodity"]>;
  }>;
}

/**
 * Validates positive, same-commodity transfers between distinct named buckets.
 * Catalog membership is checked separately by the ledger.
 */
export const entrySchema = z
  .strictObject({
    debit: z.strictObject({ name: nameSchema, commodity: commoditySchema }),
    credit: z.strictObject({ name: nameSchema, commodity: commoditySchema }),
    amount: z.strictObject({
      commodity: commoditySchema,
      atomic: z.bigint().positive(),
    }),
  })
  .refine(
    (item) =>
      item.debit.name !== item.credit.name &&
      item.debit.commodity === item.credit.commodity &&
      item.debit.commodity === item.amount.commodity,
  );

/**
 * Validates and freezes a transfer and its components before accounting use.
 */
export function parseEntry(value: unknown): StoredEntry {
  const parsed = parse(entrySchema, value);
  return Object.freeze({
    debit: Object.freeze(parsed.debit),
    credit: Object.freeze(parsed.credit),
    amount: Object.freeze(parsed.amount),
  });
}

/**
 * Validates an exact catalog-shaped vector, rejecting extra or missing buckets
 * and commodity mismatches before returning typed, frozen balances.
 */
export function parseBalances<B extends BalanceDefinitions>(
  definitions: B,
  value: BalanceVector,
): Balances<B> {
  const expectedNames = Object.keys(definitions);
  if (Object.keys(value).length !== expectedNames.length)
    throw new LedgerError(
      "VALIDATION",
      "Balance vector does not match configured balances",
    );
  const result: Record<string, Amount> = {};
  for (const [name, definition] of Object.entries(definitions))
    result[name] = parse(amountSchema(definition.commodity), value[name]);
  // Exact keys and each configured commodity have been checked above.
  return Object.freeze(result) as Balances<B>;
}
