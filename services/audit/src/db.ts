// Every query goes through withSchema("audit"): this service touches only its own schema.
import { Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";
import type { AuditDatabase } from "./schema.ts";

export const SCHEMA = "audit";

export type Db = Kysely<AuditDatabase>;
export type Tx = Transaction<AuditDatabase>;
export type Queryable = Db | Tx;

const INT8_OID = 20;

/** Positions (bigint) come back as strings, never as lossy numbers. */
export function connect(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    types: { getTypeParser: (oid: number, format?: "text" | "binary") => (oid === INT8_OID ? (v: string) => v : pg.types.getTypeParser(oid, format as "text")) },
  });
  return new Kysely<AuditDatabase>({ dialect: new PostgresDialect({ pool }) });
}

export const q = (db: Queryable) => db.withSchema(SCHEMA);
