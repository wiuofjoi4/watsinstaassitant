// ---------------------------------------------------------------------------
// M7 database-reliability selftest.
// Run: npx tsx src/lib/selftest/reliability.selftest.ts
//
// 1) Offline (no DB): isTransientDbError classification table, withDbRetry
//    (transient-then-success, exhaustion rethrow, non-retryable abort, custom
//    filter), withQueryTimeout (never-resolving promise rejects ~150ms), and
//    acquireDbSlot counter/cap semantics (incl. double-release safety).
// 2) DB-gated (real DATABASE_URL else SKIP, exit 0): getDbStatus() → ok=true
//    with a sane latency and a populated pool approximation. READ-ONLY
//    `SELECT 1` — nothing is written, created, or wiped.
// Never prints secrets (no env values, no connection strings).
// ---------------------------------------------------------------------------
import "dotenv/config";
import {
  acquireDbSlot,
  dbInFlightCount,
  getDbStatus,
  isTransientDbError,
  pruneDeadConnections,
  withDbRetry,
  withQueryTimeout,
} from "@/lib/db/reliability";
import { rawClient } from "@/lib/db";
import { rawPoolStats } from "@/lib/db/raw";
import { isPlaceholder } from "@/lib/env";

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
}

/** Realistic node system error: `code` + `message` both set. */
function nodeErr(code: string): Error {
  return Object.assign(new Error(code), { code });
}

async function offlineTests(): Promise<void> {
  // ---- isTransientDbError classification table --------------------------
  const cases: Array<[string, unknown, boolean]> = [
    ["code 57P01 admin_shutdown", { code: "57P01" }, true],
    ["code 57P02 crash_shutdown", { code: "57P02" }, true],
    ["code 57P03 cannot_connect_now", { code: "57P03" }, true],
    ["code 40P01 deadlock", { code: "40P01" }, true],
    ["code 08006 connection_failure", { code: "08006" }, true],
    ["code 08003 connection_does_not_exist", { code: "08003" }, true],
    ["code 08P01 protocol_violation", { code: "08P01" }, true],
    ["code ECONNRESET", { code: "ECONNRESET" }, true],
    ["code ECONNREFUSED", { code: "ECONNREFUSED" }, true],
    ["code ETIMEDOUT", { code: "ETIMEDOUT" }, true],
    ["code EHOSTUNREACH", { code: "EHOSTUNREACH" }, true],
    ["postgres-js CONNECT_TIMEOUT", { code: "CONNECT_TIMEOUT" }, true],
    ["errno ECONNREFUSED", { errno: "ECONNREFUSED" }, true],
    ["message 'socket hang up'", new Error("socket hang up"), true],
    ["message 'fetch failed'", new TypeError("fetch failed"), true],
    ["soft-cap sentinel", new Error("db concurrency cap reached"), true],
    ["schema violation 42P01", { code: "42P01" }, false],
    ["unique violation 23505", { code: "23505" }, false],
    ["generic error", new Error("boom"), false],
    ["null input", null, false],
    ["non-object input", "ECONNRESET", false],
  ];
  for (const [label, err, expected] of cases) {
    assert(
      isTransientDbError(err) === expected,
      `isTransientDbError(${label}) === ${expected}`
    );
  }
  console.log("OFFLINE-OK: isTransientDbError classification table");

  // ---- withDbRetry: transient-then-success -------------------------------
  const runs: string[] = [];
  const value = await withDbRetry(
    async () => {
      runs.push("run");
      if (runs.length < 3) throw nodeErr("ECONNRESET");
      return "seeded-value";
    },
    { attempts: 4, baseMs: 5, maxMs: 10 }
  );
  assert(value === "seeded-value", "withDbRetry returns the value after transients");
  assert(runs.length === 3, `withDbRetry retried exactly the transients (ran ${runs.length})`);

  // ---- withDbRetry: exhaustion rethrows the LAST error -------------------
  const lastErr = new Error("socket hang up");
  let exhaustedAttempts = 0;
  let exhaustedThrown: unknown;
  try {
    await withDbRetry(
      async () => {
        exhaustedAttempts += 1;
        throw lastErr;
      },
      { attempts: 3, baseMs: 5, maxMs: 10 }
    );
  } catch (err) {
    exhaustedThrown = err;
  }
  assert(exhaustedAttempts === 3, `withDbRetry exhausted attempts (ran ${exhaustedAttempts})`);
  assert(exhaustedThrown === lastErr, "withDbRetry rethrows the last error (identity)");

  // ---- withDbRetry: non-transient errors abort after one attempt ---------
  let abortCalls = 0;
  let abortThrown: unknown;
  try {
    await withDbRetry(
      async () => {
        abortCalls += 1;
        throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
      },
      { attempts: 5, baseMs: 5, maxMs: 10 }
    );
  } catch (err) {
    abortThrown = err;
  }
  assert(abortCalls === 1, "schema violation aborts after ONE attempt");
  assert(
    abortThrown instanceof Error && abortThrown.message.includes("relation does not exist"),
    "non-transient error propagates unchanged"
  );

  // ---- withDbRetry: custom shouldRetry filter ----------------------------
  let filterCalls = 0;
  const filtered = await withDbRetry(
    async () => {
      filterCalls += 1;
      if (filterCalls === 1) throw new Error("boom");
      return "filtered";
    },
    { attempts: 3, baseMs: 5, maxMs: 10, shouldRetry: (e) => e instanceof Error && e.message === "boom" }
  );
  assert(
    filtered === "filtered" && filterCalls === 2,
    "custom shouldRetry honours the supplied filter"
  );
  console.log("OFFLINE-OK: withDbRetry (success, exhaustion, abort, custom filter)");

  // ---- withQueryTimeout --------------------------------------------------
  const started = Date.now();
  let timeoutMsg = "";
  try {
    await withQueryTimeout(new Promise<never>(() => {}), 150);
  } catch (err) {
    timeoutMsg = err instanceof Error ? err.message : String(err);
  }
  const elapsed = Date.now() - started;
  assert(
    /^db query timed out after 150ms$/.test(timeoutMsg),
    `withQueryTimeout rejects with the timeout message (got "${timeoutMsg}")`
  );
  assert(elapsed >= 100, `timeout did not fire too early (${elapsed}ms)`);
  assert(
    elapsed < 800,
    `timeout resolved its timer shortly after ms (${elapsed}ms — clearTimeout on settle works)`
  );

  const resolvedLater = Promise.resolve("fast");
  const viaTimeout = await withQueryTimeout(resolvedLater, 1000);
  assert(viaTimeout === "fast", "withQueryTimeout passes settled values through");
  console.log(`OFFLINE-OK: withQueryTimeout (reject at ~150ms, settle passthrough)`);

  // ---- acquireDbSlot: soft cap + counter + double-release ----------------
  // Set DB_MAX_INFLIGHT BEFORE the first acquire so the memoized cap is 3.
  process.env.DB_MAX_INFLIGHT = "3";
  const parked: Array<{ release(): void; slot(): number }> = [];
  for (let i = 0; i < 3; i++) parked.push(acquireDbSlot());
  assert(dbInFlightCount() === 3, "acquireDbSlot counts 3 concurrent slots");
  assert(parked[0].slot() === 3, "slot() reports the shared in-flight counter");
  let capHit = false;
  try {
    acquireDbSlot();
  } catch (err) {
    capHit = err instanceof Error && err.message === "db concurrency cap reached";
  }
  assert(capHit, "4th acquire over the soft cap throws the sentinel");
  assert(
    isTransientDbError(new Error("db concurrency cap reached")),
    "cap sentinel classifies as transient (so withDbRetry will back off)"
  );
  for (const s of parked) s.release();
  assert(dbInFlightCount() === 0, "releasing every slot returns the counter to zero");
  parked[0].release(); // double release must be a no-op
  assert(dbInFlightCount() === 0, "double-release is a no-op");
  assert(
    rawPoolStats().active === 0 && rawPoolStats().pending === 0,
    "rawPoolStats reflects a drained counter (no client connected yet)"
  );

  const a = acquireDbSlot();
  const b = acquireDbSlot();
  assert(a.slot() === 2 && b.slot() === 2, "two slots share the counter");
  a.release();
  assert(dbInFlightCount() === 1, "release decrements the shared counter");
  b.release();
  assert(dbInFlightCount() === 0, "counter drained to zero");
  delete process.env.DB_MAX_INFLIGHT;
  console.log("OFFLINE-OK: acquireDbSlot (cap, counter, double-release)");

  // ---- pruneDeadConnections (no-op hook resolves) ------------------------
  await pruneDeadConnections();
  console.log("OFFLINE-OK: pruneDeadConnections resolves (no-op by design)");
}

async function dbTests(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl || isPlaceholder(dbUrl)) {
    console.log("SKIP: no real DATABASE_URL (getDbStatus DB probe skipped; exit 0)");
    return;
  }

  try {
    const status = await getDbStatus();
    assert(status.ok === true, "getDbStatus reports ok against a real DB");
    assert(
      Number.isFinite(status.latencyMs) &&
        status.latencyMs >= 0 &&
        status.latencyMs < 5000,
      `SELECT 1 latency sane (${status.latencyMs}ms)`
    );
    assert(typeof status.pool.active === "number", "status.pool.active is a number");
    assert(typeof status.pool.idle === "number", "status.pool.idle is a number");
    assert(typeof status.pool.pending === "number", "status.pool.pending is a number");
    console.log(
      `DB-OK: getDbStatus ok=true latencyMs=${status.latencyMs} pool=${JSON.stringify(status.pool)}`
    );
  } finally {
    await rawClient.end();
  }
}

async function main(): Promise<void> {
  await offlineTests();
  await dbTests();
  console.log("PASS: reliability selftest");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});