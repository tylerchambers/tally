import { z } from "zod";
import { LedgerError } from "./errors.ts";
import {
  type BalanceDefinitions,
  type Balances,
  type CatalogEntry,
  nameSchema,
  parse,
  parseBalances,
} from "./primitives.ts";
import { clone, encode } from "./serialization.ts";
import type { BalanceVector, StoredEntry, StoredEvent } from "./store.ts";

const versionBalances = Symbol("event version balances");
const versionInvariant = Symbol("event version invariant");

/**
 * Provides schema-erased operations for catalog lookup and rule verification.
 */
export interface RuntimeVersion {
  /**
   * Validates a detached payload while retaining its pre-transform representation.
   */
  readonly construct: (payload: unknown) => unknown;
  /**
   * Checks a detached payload against the version's schema without running rules.
   */
  readonly validate: (payload: unknown) => void;
  /**
   * Applies synchronous rules to parsed output and detached, validated balances.
   */
  readonly run: (
    payload: unknown,
    balances: BalanceVector,
  ) => readonly StoredEntry[];
}

/**
 * Retains the schema type so constructors infer input rather than parsed output.
 */
export type EventVersion<
  S extends z.ZodType,
  B extends BalanceDefinitions = BalanceDefinitions,
> = RuntimeVersion &
  Readonly<{
    schema: S;
    [versionBalances]: B;
    [versionInvariant]: (balances: B) => B;
  }>;
/**
 * Binds validation and accounting rules into one durable version contract.
 */
export type VersionOptions<
  S extends z.ZodType,
  B extends BalanceDefinitions,
> = Readonly<{
  /**
   * Accepts persisted z.input values and produces the z.output supplied to apply.
   * Callbacks must remain synchronous and deterministic for replay.
   */
  schema: S;
  /**
   * Defines the exact balance vector accepted by this version.
   */
  balances: B;
  /**
   * Returns catalog-owned, commodity-safe entries without side effects; may run
   * again on conflicts or verify. Purity is the caller's responsibility.
   */
  apply: (
    payload: z.output<S>,
    current: Balances<B>,
  ) => readonly CatalogEntry<B>[];
}>;

/**
 * Declares accounting semantics that must not change once stored in history.
 * Payloads persist as z.input; rules receive z.output, so deterministic transforms
 * and defaults replay correctly. Schema callbacks and apply must be synchronous
 * and pure: no clock, randomness, I/O, or mutable external state. Add a version
 * instead of changing existing semantics; freezing cannot enforce callback purity.
 */
export function eventVersion<
  S extends z.ZodType,
  const B extends BalanceDefinitions,
>(options: VersionOptions<S, B>): EventVersion<S, B> {
  const { schema, apply } = options;
  const balances = clone(options.balances);
  return Object.freeze({
    schema,
    [versionBalances]: balances,
    [versionInvariant]: (value: B) => value,
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

/**
 * Maps v-prefixed positive safe-integer keys to durable accounting versions.
 */
type AnyEventVersion = RuntimeVersion &
  Readonly<{ schema: z.ZodType; [versionBalances]: BalanceDefinitions }>;
export type VersionDefinitions = Readonly<Record<string, AnyEventVersion>>;
/**
 * Groups versions under the event name later assigned by defineEvents.
 */
export type EventDefinition<V extends VersionDefinitions = VersionDefinitions> =
  Readonly<{ versions: V }>;

/**
 * Snapshots a nonempty version map after validating keys such as v1 and v2.
 * Retain old versions while their events remain in durable history.
 */
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
const catalogBalances = Symbol("event catalog balances");
/**
 * Carries runtime version lookup and balance identity alongside typed constructors.
 */
export type EventCatalog<B extends BalanceDefinitions> = Readonly<{
  [catalog]: (type: string, version: number) => RuntimeVersion | undefined;
  [catalogBalances]: (balances: B) => B;
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
/**
 * Infers event names, versions, and schema-input constructors from definitions.
 */
type VersionsOfDefinitions<
  D extends Readonly<Record<string, EventDefinition>>,
> = D[keyof D] extends infer Definition
  ? Definition extends EventDefinition<infer V>
    ? V[keyof V]
    : never
  : never;
type RequireBalanceCatalog<
  B extends BalanceDefinitions,
  D extends Readonly<Record<string, EventDefinition>>,
> =
  Exclude<VersionsOfDefinitions<D>, EventVersion<z.ZodType, B>> extends never
    ? unknown
    : Readonly<{ __allEventVersionsMustUseBalances: B }>;
export type DefinedEvents<
  B extends BalanceDefinitions,
  D extends Readonly<Record<string, EventDefinition>>,
> = Constructors<D> & EventCatalog<B>;
/**
 * Derives the stored event union, retaining z.input payloads for each version.
 */
export type EventsOf<E> = {
  [N in keyof E]: {
    [V in keyof E[N]]: E[N][V] extends (...args: never[]) => infer R
      ? R
      : never;
  }[keyof E[N]];
}[keyof E] &
  StoredEvent;

/**
 * Creates a nonempty frozen catalog of validated, typed event constructors.
 * Constructors detach and validate payloads but retain their input representation;
 * constructing an event neither runs accounting rules nor persists it.
 */
export function defineEvents<
  const B extends BalanceDefinitions,
  const D extends Readonly<Record<string, EventDefinition>>,
>(
  balances: B,
  definitions: D & RequireBalanceCatalog<B, D>,
): DefinedEvents<B, D> {
  const runtime = new Map<string, ReadonlyMap<number, RuntimeVersion>>();
  const constructors: Record<
    string,
    Readonly<Record<string, (payload: unknown) => StoredEvent>>
  > = {};
  const encodedBalances = encode(balances);
  for (const [name, definition] of Object.entries(definitions)) {
    parse(nameSchema, name);
    const versions = new Map<number, RuntimeVersion>();
    const named: Record<string, (payload: unknown) => StoredEvent> = {};
    for (const [key, version] of Object.entries(definition.versions)) {
      if (encode(version[versionBalances]) !== encodedBalances)
        throw new LedgerError(
          "VALIDATION",
          "Every event version must use the catalog passed to defineEvents",
        );
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
      [catalogBalances]: (value: B) => value,
    }),
  ) as DefinedEvents<B, D>;
}

/**
 * Resolves and validates a persisted event, throwing UNKNOWN_EVENT for a missing
 * name or version and VALIDATION for schema rejection.
 */
export function resolveVersion<B extends BalanceDefinitions>(
  events: EventCatalog<B>,
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
