import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";
import { migrate, PostgresLedgerStore } from "../../src/postgres/index.ts";

const environment = z
  .object({
    TEST_DATABASE_URL: z.url().refine((value) => {
      const url = new URL(value);
      return (
        (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
        url.hostname.length > 0 &&
        url.pathname.length > 1
      );
    }, "TEST_DATABASE_URL must be a PostgreSQL URL with a host and database name"),
  })
  .safeParse(process.env);
if (!environment.success) {
  throw new Error(
    "PostgreSQL integration tests require TEST_DATABASE_URL pointing to a disposable PostgreSQL server; the role must have CREATEDB",
    { cause: environment.error },
  );
}
const databaseUrl = environment.data.TEST_DATABASE_URL;

type PostgresFixture = {
  store: PostgresLedgerStore;
  database: PostgresJsDatabase;
  client: postgres.Sql;
  url: string;
  dispose(): Promise<void>;
};

export async function createPostgresFixture(): Promise<PostgresFixture> {
  const administration = postgres(databaseUrl, { max: 1 });
  const adminDatabase = drizzle(administration);
  const name = `ledger_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  try {
    await adminDatabase.execute(sql`CREATE DATABASE ${sql.identifier(name)}`);
  } catch (cause) {
    await administration.end();
    throw new Error(
      "Unable to create an isolated integration database; TEST_DATABASE_URL must permit CREATEDB",
      { cause },
    );
  }
  const client = postgres(url.toString(), { max: 8 });
  const database = drizzle(client);
  try {
    await migrate(database);
  } catch (cause) {
    await client.end();
    await adminDatabase.execute(sql`DROP DATABASE ${sql.identifier(name)}`);
    await administration.end();
    throw cause;
  }
  return {
    store: new PostgresLedgerStore(database),
    database,
    client,
    url: url.toString(),
    async dispose(): Promise<void> {
      try {
        await client.end();
        await adminDatabase.execute(sql`DROP DATABASE ${sql.identifier(name)}`);
      } finally {
        await administration.end();
      }
    },
  };
}
