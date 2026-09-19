import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { dbInFlightCount } from "./reliability";

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
    // Per-instance agent turns run several DB queries in parallel (profile,
    // conversation upsert, message upsert, context load, ...). max=2 sat back
    // and serialized the rest behind two sockets — queueing that read as a
    // hang and tripped the gateway's 55s abort ("frequent disconnections").
    // 4 sockets per warm instance stays well under the transaction pooler cap
    // (~60) while giving parallel queries a slot. (M7 hardening: the audit
    // explicitly flagged "pool max=2 per warm lambda".)
    max: 4,
    // Supabase transaction pooler (PgBouncer) does not support prepared
    // statements.
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
    // Deterministically recycle pooled sockets every 30min — BEFORE the
    // pooler/LB idle window can reap a long-lived server connection out from
    // under us (a client socket that outlives its server twin is the one that
    // produces the next `write CONNECT_TIMEOUT`). postgres-js' default is a
    // random 30–60min; pinning the 30min floor keeps recycle timing lumpy-free
    // without ever recycling faster than today's minimum.
    max_lifetime: 1800,
    // TCP keep-alive every 30s (postgres-js accepts `number`, default 60s).
    // Probes keep the socket visibly alive through idle-window reapers at no
    // application-layer cost — fewer surprise closes, fewer reconnects.
    keep_alive: 30,
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

export interface PoolStats {
  /** Queries currently checked out (counted by `acquireDbSlot`). */
  active: number;
  /** Upper bound: pool `max` minus active (see note below). */
  idle: number;
  /** 0 — postgres-js' internal query queue is not observable. */
  pending: number;
}

/**
 * Pool stats hook (additive, M7). postgres-js 3.4.9 keeps its internal
 * connection queues (connect/open/busy/idle...) as module closures and exposes
 * NO `sql.count` / `sql.reserved` / per-socket counters on the Sql object
 * (verified against node_modules/postgres/types + src). So these are truthful
 * approximations derived from the app-level in-flight counter behind
 * `acquireDbSlot()` (src/lib/db/reliability.ts):
 *   - active  = queries currently checked out via acquireDbSlot; it is 0 if
 *               callers never opt in (the pool counter only knows acquires
 *               made through it — slotted calls are the whole signal).
 *   - idle    = pool `max` minus active; an UPPER BOUND on idle sockets, never
 *               a real socket census.
 *   - pending = always 0; the true pending query queue is inside postgres-js'
 *               unobservable closure state.
 * Never routes through the lazy proxy (must not force a connection).
 */
export function rawPoolStats(): PoolStats {
  const active = dbInFlightCount();
  return {
    active,
    idle: client ? Math.max(0, client.options.max - active) : 0,
    pending: 0,
  };
}