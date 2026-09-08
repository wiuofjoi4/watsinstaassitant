import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

const url = process.env.DATABASE_URL ?? "postgresql://localhost:5432/repli";

/**
 * Supabase: use the transaction pooler (port 6543) for serverless.
 * `prepare: false` is required because PgBouncer in transaction mode
 * does not support prepared statements.
 *
 * The connection is created lazily on first use. During local builds the env
 * may hold masked/placeholder values, so importing this module must never
 * connect or parse the URL itself. `db`/`rawClient` are proxies that resolve
 * to the real client on first query.
 */
let client: ReturnType<typeof postgres> | undefined;

function createClient(): ReturnType<typeof postgres> {
  return postgres(url, {
    ssl: process.env.NODE_ENV === "production" ? "require" : "prefer",
    // Keep the per-instance pool tiny: Vercel keeps many lambda instances warm,
    // and the Supabase transaction pooler (port 6543) caps pooled connections
    // (~60). max=1 pools on each warm instance would queue requests behind a
    // single socket; max=2 gives a small safety margin without saturating the
    // pooler / producing `write CONNECT_TIMEOUT` storms.
    max: 2,
    prepare: false,
    // Keep pooled sockets alive long so warm lambda instances don't churn
    // TCP/TLS reconnects to the Singapore pooler on every turn (each reconnect
    // is a chance for a `write CONNECT_TIMEOUT`).
    idle_timeout: 300,
    // Short connect timeout: when the DB is unreachable, fail in ~8s instead of
    // letting every queued query stall and blow the 60s Vercel function budget
    // (a DB-down window previously looked like "reply takes >1 minute, then
    // nothing").
    connect_timeout: 8,
  });
}

export function getRawClient(): ReturnType<typeof postgres> {
  if (!client) client = createClient();
  return client;
}

function makeProxy<T>(): T {
  const callable = function () {
    /* replaced by the apply trap below */
  } as never;
  const target = {
    get(_t: unknown, p: PropertyKey): unknown {
      return Reflect.get(getRawClient() as never, p);
    },
    apply(_t: unknown, thisArg: unknown, args: unknown[]): unknown {
      return Reflect.apply(getRawClient() as never, thisArg, args);
    },
    has(_t: unknown, p: PropertyKey): boolean {
      return p in getRawClient();
    },
  };
  return new Proxy(callable, target) as T;
}

/** Raw postgres-js client (tagged templates), lazily connected. */
export const rawClient: ReturnType<typeof postgres> = makeProxy();

/** Drizzle ORM instance wired to the lazy client. */
export const db = drizzle(makeProxy() as ReturnType<typeof postgres>, { schema });

export type Db = typeof db;