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
    max: 5,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
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