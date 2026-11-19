// Every query goes through withSchema("data_source"): this service touches only its own schema.
import { Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";
import type { DataSourceDatabase } from "./schema.ts";

export const SCHEMA = "data_source";

export type Db = Kysely<DataSourceDatabase>;
export type Tx = Transaction<DataSourceDatabase>;
export type Queryable = Db | Tx;

const DATE_OID = 1082;

/** Dates come back as YYYY-MM-DD strings, never as JavaScript dates shifted by a time zone. */
export function connect(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    types: { getTypeParser: (oid: number, format?: "text" | "binary") => (oid === DATE_OID ? (v: string) => v : pg.types.getTypeParser(oid, format as "text")) },
  });
  return new Kysely<DataSourceDatabase>({ dialect: new PostgresDialect({ pool }) });
}

export const q = (db: Queryable) => db.withSchema(SCHEMA);
