// Every query goes through withSchema("fx_trade"): this service touches only its own schema.
import { Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";
import type { FxTradeDatabase } from "./schema.ts";

export const SCHEMA = "fx_trade";

export type Db = Kysely<FxTradeDatabase>;
export type Tx = Transaction<FxTradeDatabase>;
export type Queryable = Db | Tx;

const DATE_OID = 1082;
const NUMERIC_OID = 1700;

/** Dates come back as YYYY-MM-DD strings and numerics as exact strings, never as JavaScript dates or floats. */
export function connect(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    types: { getTypeParser: (oid: number, format?: "text" | "binary") => (oid === DATE_OID || oid === NUMERIC_OID ? (v: string) => v : pg.types.getTypeParser(oid, format as "text")) },
  });
  return new Kysely<FxTradeDatabase>({ dialect: new PostgresDialect({ pool }) });
}

export const q = (db: Queryable) => db.withSchema(SCHEMA);
