import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

const url = process.env.DATABASE_URL ?? "postgresql://localhost:5432/repli";

/**
 * Supabase: use the transaction pooler (port 6543) for serverless.
 * `prepare: false` is required because PgBouncer in transaction mode
 * does not support prepared statements.
 */
export const rawClient = postgres(url, {
  ssl: process.env.NODE_ENV === "production" ? "require" : "prefer",
  max: 5,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(rawClient, { schema });

export type Db = typeof db;