// Every query goes through withSchema("exposure_analysis"): this service touches only its own schema.
import { Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";
import type { ExposureAnalysisDatabase } from "./schema.ts";

export const SCHEMA = "exposure_analysis";

export type Db = Kysely<ExposureAnalysisDatabase>;
export type Tx = Transaction<ExposureAnalysisDatabase>;
export type Queryable = Db | Tx;

const DATE_OID = 1082;
const NUMERIC_OID = 1700;

/** Dates come back as YYYY-MM-DD strings and numerics as exact strings, never as JavaScript dates or floats. */
export function connect(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    types: { getTypeParser: (oid: number, format?: "text" | "binary") => (oid === DATE_OID || oid === NUMERIC_OID ? (v: string) => v : pg.types.getTypeParser(oid, format as "text")) },
  });
  return new Kysely<ExposureAnalysisDatabase>({ dialect: new PostgresDialect({ pool }) });
}

export const q = (db: Queryable) => db.withSchema(SCHEMA);
