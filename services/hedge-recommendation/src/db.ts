// Every query goes through withSchema("hedge_recommendation"): this service touches only its own schema.
import { Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";
import type { HedgeRecommendationDatabase } from "./schema.ts";

export const SCHEMA = "hedge_recommendation";

export type Db = Kysely<HedgeRecommendationDatabase>;
export type Tx = Transaction<HedgeRecommendationDatabase>;
export type Queryable = Db | Tx;

const DATE_OID = 1082;
const NUMERIC_OID = 1700;

/** Dates come back as YYYY-MM-DD strings and numerics as exact strings, never as JavaScript dates or floats. */
export function connect(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    types: { getTypeParser: (oid: number, format?: "text" | "binary") => (oid === DATE_OID || oid === NUMERIC_OID ? (v: string) => v : pg.types.getTypeParser(oid, format as "text")) },
  });
  return new Kysely<HedgeRecommendationDatabase>({ dialect: new PostgresDialect({ pool }) });
}

export const q = (db: Queryable) => db.withSchema(SCHEMA);
