// ---------------------------------------------------------------------------
// M7 — DB reliability layer. Additive surface for callers to adopt: retry on
// transient disconnect, a caller-level query-timeout backstop, a soft
// in-flight concurrency cap, and a never-throwing status probe for the M9
// health route. Nothing here adds per-query overhead to the hot path — these
// are opt-in wrappers that the Combiner / M2 / M3 / M5 / M6 / M9 / M10 call
// when they want a safety net.
//
// NOTE (import cycle, deliberate): this module imports `getRawClient` /
// `rawPoolStats` from "./raw", and "./raw" imports `dbInFlightCount` from
// here. Both cross-module symbols are used only INSIDE function bodies, never
// at module evaluation time, so the cycle is safe (neither module touches the
// other's bindings before full evaluation).
// ---------------------------------------------------------------------------

import { getRawClient, rawPoolStats } from "./raw";

/** Class 08 = connection_exception / connection_failure (08000-08xxxx, 08P01). */
const TRANSIENT_CODE_08 = /^08/;
/** Deadlock + the three shutdown/startup classes. */
const TRANSIENT_SQLSTATE = new Set(["40P01", "57P01", "57P02", "57P03"]);
/** Node network system errors (code AND errno carry the same token). */
const TRANSIENT_NODE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
]);
/** postgres-js' own ConnectionError codes (src/errors.js, connection.js). */
const TRANSIENT_PGJS_CODES = new Set([
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);
/**
 * Message-level markers for errors that travel without a `code` (undici's
 * "fetch failed", node's "socket hang up") plus our own soft-cap sentinel, so
 * withDbRetry treats a saturated pool as transient too.
 */
const TRANSIENT_MESSAGE =
  /socket hang up|fetch failed|db concurrency cap reached/i;

/**
 * Conservative transient-failure classifier — the default retry filter for
 * `withDbRetry`. TRUE only for connection/socket/shutdown/deadlock-level
 * failures; schema violations (42xxx), unique conflicts (23505), check
 * constraints, bad input and other user errors are NEVER classified transient
 * and therefore never retried.
 */
export function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; errno?: unknown; message?: unknown };
  const code =
    typeof e.code === "string"
      ? e.code
      : typeof e.errno === "string"
        ? e.errno
        : "";
  if (code) {
    if (TRANSIENT_NODE_CODES.has(code)) return true;
    if (TRANSIENT_SQLSTATE.has(code)) return true;
    if (TRANSIENT_PGJS_CODES.has(code)) return true;
    if (TRANSIENT_CODE_08.test(code)) return true;
  }
  const msg = typeof e.message === "string" ? e.message : "";
  return TRANSIENT_MESSAGE.test(msg);
}

export interface DbRetryOptions {
  /** Total executions of `fn` (default 3, minimum 1). */
  attempts?: number;
  /** Exponential base in ms (default 200). */
  baseMs?: number;
  /** Backoff ceiling in ms (default 2000). */
  maxMs?: number;
  /** Custom retry filter; defaults to `isTransientDbError`. */
  shouldRetry?: (err: unknown) => boolean;
}

/** Floor between attempts — prevents a stampede when many lambdas retry together. */
const RETRY_FLOOR_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry `fn` on transient failures with exponential + full-ish jitter
 * (random 0.5–1.0 of the window, floored at 20ms). When attempts are
 * exhausted — or a non-retryable error surfaces — the LAST error is rethrown;
 * this function never swallows the final error.
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  opts: DbRetryOptions = {}
): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 3));
  const baseMs = Math.max(0, opts.baseMs ?? 200);
  const maxMs = Math.max(baseMs, opts.maxMs ?? 2000);
  const shouldRetry = opts.shouldRetry ?? isTransientDbError;

  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts - 1 || !shouldRetry(err)) throw err;
      const windowMs = Math.min(maxMs, baseMs * 2 ** attempt);
      const delayMs = Math.max(
        RETRY_FLOOR_MS,
        windowMs * (0.5 + Math.random() * 0.5)
      );
      await sleep(delayMs);
    }
  }
  throw lastErr; // unreachable: attempts >= 1, so the loop always throws or returns
}

/**
 * Caller-level timeout backstop for an awaited query promise. Rejects with
 * `db query timed out after Nms` and does NOT abort the underlying query
 * (postgres-js already bounds hung sockets at `connect_timeout`; this only
 * caps how long a caller waits on one promise). The timer is cleared on
 * settle, so nothing leaks.
 */
export function withQueryTimeout<T>(p: Promise<T>, ms = 8000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`db query timed out after ${ms}ms`));
    }, ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export interface DbSlot {
  /** Returns this slot to the pool (idempotent; safe to call twice). */
  release(): void;
  /** The live module-level in-flight counter (shared by all slots). */
  slot(): number;
}

/** Soft-cap sentinel — classified transient so withDbRetry retries it. */
export const DB_CONCURRENCY_CAP_EXCEEDED = "db concurrency cap reached";

let inFlight = 0;
let capCached: number | null = null;

function dbMaxInflight(): number {
  if (capCached === null) {
    const v = Number(process.env.DB_MAX_INFLIGHT);
    capCached = Number.isFinite(v) && v > 0 ? Math.floor(v) : 250;
  }
  return capCached;
}

/**
 * Opt-in in-flight slot guard: acquire a slot before a query; the module
 * counter is shared by every caller in the process and drives `rawPoolStats`.
 * When the counter is at/above the soft cap (DB_MAX_INFLIGHT, default 250)
 * this throws a transient-classified error immediately so `withDbRetry` can
 * back off instead of piling onto a saturated pool. Purely optional — not
 * wired into any query path; the Combiner decides where it is used.
 */
export function acquireDbSlot(): DbSlot {
  if (inFlight >= dbMaxInflight()) {
    throw new Error(DB_CONCURRENCY_CAP_EXCEEDED);
  }
  inFlight += 1;
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      inFlight -= 1;
    },
    slot(): number {
      return inFlight;
    },
  };
}

/** Read-only view of the in-flight counter (feeds `rawPoolStats`). */
export function dbInFlightCount(): number {
  return inFlight;
}

export interface DbStatus {
  ok: boolean;
  latencyMs: number;
  pool: ReturnType<typeof rawPoolStats>;
}

/**
 * Health probe for the M9 route: one timed `SELECT 1`. Never throws — on any
 * failure it reports ok=false with the elapsed latency and pool approximation.
 */
export async function getDbStatus(): Promise<DbStatus> {
  const started = Date.now();
  let ok = false;
  try {
    await getRawClient()`select 1 as ok`;
    ok = true;
  } catch {
    ok = false;
  }
  return { ok, latencyMs: Date.now() - started, pool: rawPoolStats() };
}

/**
 * No-op by design: postgres-js 3.4.9 exposes no per-socket management (its
 * connection queues are module closures; `sql.reserve()` hands back a full
 * dedicated client and `sql.end()` closes the whole pool). There is no real,
 * safe "close just the dead sockets" mechanism worth inventing here — pool
 * hygiene is instead handled by `max_lifetime`/`idle_timeout`/`keep_alive`
 * in raw.ts. Kept as a hook so callers can call it without a branch.
 */
export async function pruneDeadConnections(): Promise<void> {
  return;
}