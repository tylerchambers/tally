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
export const nameSchema = z
  .string()
  .max(256)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/u)
  .refine(
    (value) => !["constructor", "prototype", "__proto__"].includes(value),
  );
export const commoditySchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9._:-]*$/u);

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

export function accountId(value: string): AccountId {
  // Branding follows validation of the external identifier representation.
  return parse(identifierSchema, value) as AccountId;
}

export function eventId(value: string): EventId {
  return parse(identifierSchema, value) as EventId;
}

export function commodity<const C extends string>(value: C): C {
  parse(commoditySchema, value);
  return value;
}

export type Commodity = string;
export type Amount<C extends string = string> = Readonly<{
  commodity: C;
  atomic: bigint;
}>;
export type Balance<
  C extends string = string,
  N extends string = string,
> = Readonly<{ commodity: C; name: N }>;
export type Entry<C extends string = string> = Readonly<{
  debit: Balance<C>;
  credit: Balance<C>;
  amount: Amount<C>;
}>;
export type BalanceDefinitions = Readonly<Record<string, Balance>>;
export type Balances<B extends BalanceDefinitions> = {
  readonly [K in keyof B]: Amount<B[K]["commodity"]>;
};

export function amountSchema<const C extends string>(
  unit: C,
): z.ZodType<Amount<C>, Amount<C>> {
  commodity(unit);
  return z
    .strictObject({ commodity: z.literal(unit), atomic: z.bigint() })
    .readonly();
}

export function amount<const C extends string>(
  unit: C,
  atomic: bigint,
): Amount<C> {
  return parse(amountSchema(unit), { commodity: unit, atomic });
}

export function balance<const C extends string>(
  unit: C,
): Readonly<{ commodity: C }> {
  return Object.freeze({ commodity: commodity(unit) });
}

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

/** Move a strictly positive amount: debit decreases, credit increases. Both units must match. */
export function entry<const C extends string>(
  debit: Balance<C>,
  credit: Balance<NoInfer<C>>,
  quantity: Amount<NoInfer<C>>,
): Entry<C> {
  // Runtime validation proves every component matches the debit's inferred commodity.
  return parseEntry({ debit, credit, amount: quantity }) as Entry<C>;
}

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

export function parseEntry(value: unknown): StoredEntry {
  const parsed = parse(entrySchema, value);
  return Object.freeze({
    debit: Object.freeze(parsed.debit),
    credit: Object.freeze(parsed.credit),
    amount: Object.freeze(parsed.amount),
  });
}

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
