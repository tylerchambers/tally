import { z } from "zod";
import { LedgerError } from "./errors.ts";
import {
  type BalanceDefinitions,
  type Balances,
  nameSchema,
  parse,
  parseBalances,
} from "./primitives.ts";
import { clone } from "./serialization.ts";
import type { BalanceVector, StoredEntry, StoredEvent } from "./store.ts";

export interface RuntimeVersion {
  readonly construct: (payload: unknown) => unknown;
  readonly validate: (payload: unknown) => void;
  readonly run: (
    payload: unknown,
    balances: BalanceVector,
  ) => readonly StoredEntry[];
}

export type EventVersion<S extends z.ZodType> = RuntimeVersion &
  Readonly<{ schema: S }>;
export type VersionOptions<
  S extends z.ZodType,
  B extends BalanceDefinitions,
> = Readonly<{
  schema: S;
  balances: B;
  apply: (payload: z.output<S>, current: Balances<B>) => readonly StoredEntry[];
}>;

/**
 * Declare immutable accounting semantics. Payloads persist as schema input; rules receive
 * parsed output, so deterministic transforms/defaults replay correctly. Schema callbacks and
 * apply must be synchronous and pure: no clock, randomness, I/O, or mutable external state.
 * Introduce a new version rather than changing a version already present in durable history.
 */
export function eventVersion<
  S extends z.ZodType,
  const B extends BalanceDefinitions,
>(options: VersionOptions<S, B>): EventVersion<S> {
  const { schema, apply } = options;
  const balances = clone(options.balances);
  return Object.freeze({
    schema,
    construct: (payload: unknown) => {
      const detached = clone(payload);
      parse(schema, detached);
      return detached;
    },
    validate: (payload: unknown) => {
      parse(schema, clone(payload));
    },
    run: (payload: unknown, current: BalanceVector) =>
      apply(
        parse(schema, clone(payload)),
        parseBalances(balances, clone(current)),
      ),
  });
}

export type VersionDefinitions = Readonly<
  Record<string, EventVersion<z.ZodType>>
>;
export type EventDefinition<V extends VersionDefinitions = VersionDefinitions> =
  Readonly<{ versions: V }>;

export function event<const V extends VersionDefinitions>(
  versions: V,
): EventDefinition<V> {
  const entries = Object.entries(versions);
  if (entries.length === 0)
    throw new LedgerError(
      "VALIDATION",
      "An event requires at least one version",
    );
  for (const [name] of entries)
    parse(
      z
        .string()
        .regex(/^v[1-9][0-9]*$/u)
        .refine((key) => Number.isSafeInteger(Number(key.slice(1)))),
      name,
    );
  // Preserve the exact version keys while severing the caller's mutable object.
  return Object.freeze({ versions: Object.freeze({ ...versions }) });
}

const catalog = Symbol("event catalog");
export type EventCatalog = Readonly<{
  [catalog]: (type: string, version: number) => RuntimeVersion | undefined;
}>;
type NumberOf<V> = V extends `v${infer N extends number}` ? N : never;
type Constructor<N extends string, V extends string, S extends z.ZodType> = (
  payload: z.input<S>,
) => Readonly<{ type: N; version: NumberOf<V>; payload: z.input<S> }>;
type Constructors<D extends Readonly<Record<string, EventDefinition>>> = {
  readonly [N in keyof D]: {
    readonly [V in keyof D[N]["versions"]]: Constructor<
      N & string,
      V & string,
      D[N]["versions"][V]["schema"]
    >;
  };
};
export type DefinedEvents<D extends Readonly<Record<string, EventDefinition>>> =
  Constructors<D> & EventCatalog;
export type EventsOf<E> = {
  [N in keyof E]: {
    [V in keyof E[N]]: E[N][V] extends (...args: never[]) => infer R
      ? R
      : never;
  }[keyof E[N]];
}[keyof E] &
  StoredEvent;

export function defineEvents<
  const D extends Readonly<Record<string, EventDefinition>>,
>(definitions: D): DefinedEvents<D> {
  const runtime = new Map<string, ReadonlyMap<number, RuntimeVersion>>();
  const constructors: Record<
    string,
    Readonly<Record<string, (payload: unknown) => StoredEvent>>
  > = {};
  for (const [name, definition] of Object.entries(definitions)) {
    parse(nameSchema, name);
    const versions = new Map<number, RuntimeVersion>();
    const named: Record<string, (payload: unknown) => StoredEvent> = {};
    for (const [key, version] of Object.entries(definition.versions)) {
      const number = Number(key.slice(1));
      const snapshot = Object.freeze({
        construct: version.construct,
        validate: version.validate,
        run: version.run,
      });
      versions.set(number, snapshot);
      named[key] = (payload) =>
        Object.freeze({
          type: name,
          version: number,
          payload: snapshot.construct(payload),
        });
    }
    runtime.set(name, versions);
    constructors[name] = Object.freeze(named);
  }
  if (runtime.size === 0)
    throw new LedgerError("VALIDATION", "At least one event is required");
  // This mapped construction retains every catalog name, version literal and schema.
  return Object.freeze(
    Object.assign(constructors, {
      [catalog]: (type: string, version: number) =>
        runtime.get(type)?.get(version),
    }),
  ) as DefinedEvents<D>;
}

export function resolveVersion(
  events: EventCatalog,
  value: StoredEvent,
): RuntimeVersion {
  const version = events[catalog](value.type, value.version);
  if (!version)
    throw new LedgerError(
      "UNKNOWN_EVENT",
      `Unknown event ${value.type} v${value.version}`,
    );
  version.validate(value.payload);
  return version;
}
