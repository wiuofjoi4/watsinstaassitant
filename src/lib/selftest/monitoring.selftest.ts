// ---------------------------------------------------------------------------
// M9 monitoring selftest.
// Run: npx tsx src/lib/selftest/monitoring.selftest.ts
//
// 1) Offline / no-network first:
//    - redact() masks {token,password,secret,authorization,apiKey,customerToken}
//      values and deep-copies without mutating input.
//    - log() never throws, and a console spy proves the emitted line contains
//      "[REDACTED]" and NO secret (info/error/debug sinks all covered).
//    - aggregateHealth with the gateway URL pointed at a DEAD port: resolves
//      (no throw), gateway.ok=false, gateway.reachable=false.
//    - AggregateHealth resolves even when a probe throws (global fetch mocked
//      to throw) — Promise.allSettled catches it.
//    - GATEWAY_HEALTH_URL blank/missing → gateway probe skipped gracefully:
//      gateway.ok=true, reachable=false, NOT fatal.
//    All aggregateHealth calls temporarily blank the AI key env vars so the
//    real AI API is NEVER hit offline.
// 2) DB-gated (real DATABASE_URL else SKIP, exit 0): getDbStatus() → ok=true
//    and countRecentErrors() → a finite number (read-only, nothing written).
// Never prints secrets (no env values, no connection strings).
// ---------------------------------------------------------------------------
import "dotenv/config";
import { aggregateHealth, countRecentErrors } from "@/lib/monitoring/health";
import { log, monitor, redact } from "@/lib/monitoring/logger";
import { getDbStatus } from "@/lib/db/reliability";
import { rawClient } from "@/lib/db";
import { isPlaceholder } from "@/lib/env";

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
}

/** Temporarily blank the AI key env vars (restored afterwards) — guarantees
 *  probeAIHealth() short-circuits to configured:false without networking. */
function withAiDisabled(fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ["GEMINI_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]) {
    saved[k] = process.env[k];
    process.env[k] = "";
  }
  return fn().finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

async function offlineTests(): Promise<void> {
  // ---- redact(): masks the required key names, recursion-safe ------------
  const masked = redact({
    token: "a",
    password: "b",
    secret: "c",
    authorization: "d",
    apiKey: "e",
    customerToken: "f",
    nested: { openaiKey: "g", inner: { key: "h", ok: true } },
    keep: "visible",
    counts: [1, { token: "i" }],
  }) as Record<string, unknown>;
  for (const k of ["token", "password", "secret", "authorization", "apiKey", "customerToken"]) {
    assert(masked[k] === "[REDACTED]", `redact masks "${k}"`);
  }
  assert(
    (masked.nested as Record<string, unknown>).openaiKey === "[REDACTED]",
    "redact masks camelCase key variants"
  );
  assert(masked.keep === "visible", "redact leaves non-secret values alone");
  const inner = masked.nested as { inner?: Record<string, unknown> };
  assert(
    inner && typeof inner.inner === "object" && inner.inner.key === "[REDACTED]",
    "redact recurses into nested objects"
  );
  const counts = masked.counts as unknown[];
  assert(
    Array.isArray(counts) && (counts[1] as Record<string, unknown>).token === "[REDACTED]",
    "redact recurses into arrays"
  );
  const source = { apiKey: "value" };
  redact(source);
  assert(source.apiKey === "value", "redact does not mutate its input");
  console.log("OFFLINE-OK: redact masks key/secret/token/... and deep-copies");

  // ---- log(): no throw + secrets never reach the output ------------------
  const originalLog = console.log;
  const originalError = console.error;
  const originalDebug = console.debug;
  const captured: string[] = [];
  console.log = (m?: unknown) => captured.push(String(m));
  console.error = (m?: unknown) => captured.push(String(m));
  console.debug = (m?: unknown) => captured.push(String(m));
  try {
    log("info", "selftest", { authToken: "s3cr3t-1", ok: 1 });
    monitor.error("selftest", { password: "s3cr3t-2" });
    log("debug", "selftest", { apiKey: "s3cr3t-3", nested: { customerToken: "s3cr3t-4" } });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.debug = originalDebug;
  }
  const joined = captured.join("\n");
  for (const secret of ["s3cr3t-1", "s3cr3t-2", "s3cr3t-3", "s3cr3t-4"]) {
    assert(!joined.includes(secret), `log output does not leak "${secret}"`);
  }
  assert(joined.split("[REDACTED]").length >= 4, "log output shows [REDACTED] for each secret");
  for (const line of captured) {
    const parsed = JSON.parse(line) as { ts?: string; level?: string; event?: string };
    assert(typeof parsed.ts === "string", "log line has ts first");
    assert(typeof parsed.level === "string", "log line has level");
    assert(parsed.event === "selftest", "log line carries the event name");
    assert(
      Object.keys(parsed)[0] === "ts" && Object.keys(parsed)[2] === "event",
      "log line key order is ts, level, event, ...fields"
    );
  }
  console.log("OFFLINE-OK: log() emits redacted JSON, ts/level/event order, never throws");

  // ---- aggregateHealth: dead gateway port resolves, flagged, no throw ----
  await withAiDisabled(async () => {
    const dead = await aggregateHealth({
      getGatewayHealthUrl: () => "http://127.0.0.1:59999/health",
    });
    assert(dead.gateway.ok === false, "dead-port gateway → gateway.ok=false");
    assert(dead.gateway.reachable === false, "dead-port gateway → reachable=false");
    assert(typeof dead.gateway.latencyMs === "number", "gateway latency captured on failure");
    assert(typeof dead.ok === "boolean", "overall ok is a boolean");
    assert(typeof dead.ts === "string" && /^\d{4}-\d{2}-\d{2}/.test(dead.ts), "ts is ISO");
    console.log("OFFLINE-OK: aggregateHealth dead-port → ok=false, reachable=false, resolves");

    // ---- throw-path stability: a throwing probe is absorbed (allSettled) --
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("mocked fetch boom");
    }) as typeof fetch;
    try {
      const thr = await aggregateHealth({
        getGatewayHealthUrl: () => "http://127.0.0.1:59999/health",
      });
      assert(thr.gateway.ok === false, "throwing gateway probe → gateway.ok=false");
      assert(thr.gateway.reachable === false, "throwing gateway probe → reachable=false");
      assert(typeof thr.ok === "boolean" && typeof thr.db.ok === "boolean", "aggregate still resolves");
    } finally {
      globalThis.fetch = realFetch;
    }
    console.log("OFFLINE-OK: aggregateHealth absorbs a throwing probe (allSettled)");

    // ---- missing/blank GATEWAY_HEALTH_URL → skipped gracefully ------------
    const skipped = await aggregateHealth({ getGatewayHealthUrl: () => "" });
    assert(skipped.gateway.ok === true, "blank gateway URL → ok=true (graceful skip)");
    assert(skipped.gateway.reachable === false, "blank gateway URL → reachable=false");
    console.log("OFFLINE-OK: missing GATEWAY_HEALTH_URL skips gracefully, not fatal");
  });
}

async function dbTests(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl || isPlaceholder(dbUrl)) {
    console.log("SKIP: no real DATABASE_URL (DB probes skipped; exit 0)");
    return;
  }
  try {
    const status = await getDbStatus();
    assert(status.ok === true, "getDbStatus reports ok against a real DB");
    const recent = await countRecentErrors();
    assert(
      Number.isInteger(recent) && recent >= 0,
      `countRecentErrors is a non-negative integer (got ${recent})`
    );
    console.log(`DB-OK: getDbStatus ok=true latencyMs=${status.latencyMs} recentErrors=${recent}`);
  } finally {
    await rawClient.end();
  }
}

async function main(): Promise<void> {
  await offlineTests();
  await dbTests();
  console.log("PASS: monitoring selftest");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});