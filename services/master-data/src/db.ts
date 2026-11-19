// Every query goes through withSchema("master_data"): this service touches only its own schema.
import { Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";
import type { MasterDataDatabase } from "./schema.ts";

export const SCHEMA = "master_data";

export type Db = Kysely<MasterDataDatabase>;
export type Tx = Transaction<MasterDataDatabase>;
export type Queryable = Db | Tx;

const DATE_OID = 1082;

/** Dates come back as YYYY-MM-DD strings, never as JavaScript dates shifted by a time zone. */
export function connect(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    types: { getTypeParser: (oid: number, format?: "text" | "binary") => (oid === DATE_OID ? (v: string) => v : pg.types.getTypeParser(oid, format as "text")) },
  });
  return new Kysely<MasterDataDatabase>({ dialect: new PostgresDialect({ pool }) });
}

export const q = (db: Queryable) => db.withSchema(SCHEMA);
