// Every query goes through withSchema("identity"): this service touches only its own schema.
import { Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";
import type { IdentityDatabase } from "./schema.ts";

export const SCHEMA = "identity";

export type Db = Kysely<IdentityDatabase>;
export type Tx = Transaction<IdentityDatabase>;
/** Anything that can run an identity query: the database or a transaction. */
export type Queryable = Db | Tx;

export function connect(connectionString: string): Db {
  return new Kysely<IdentityDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }) });
}

export const q = (db: Queryable) => db.withSchema(SCHEMA);
