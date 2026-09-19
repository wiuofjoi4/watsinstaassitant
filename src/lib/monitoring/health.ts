// ---------------------------------------------------------------------------
// M9 aggregate health for the platform.
//
// aggregateHealth() runs four probes CONCURRENTLY under Promise.allSettled so
// a throwing or hanging probe can NEVER fail the whole call, then folds them
// into one honest AggregateHealth. It never throws, never logs gateway URLs
// (or their bodies/keys), and treats missing configuration as a graceful skip:
//
//   - db      → getDbStatus() (M7, one timed SELECT 1, never throws).
//   - ai      → probeAIHealth() (M4, stateless, never throws; when no AI keys
//               are configured it returns { configured:false } without any
//               networking).
//   - gateway → GET {GATEWAY_HEALTH_URL} with a ~4s timeout; ok requires HTTP
//               200 AND body.ok === true. Unreachable → reachable:false,
//               ok:false. GATEWAY_HEALTH_URL missing/blank → skipped
//               gracefully (ok:true, reachable:false, NOT fatal).
//   - recentErrors → redacted count against the existing repli.error_logs
//               table over the last hour (the same source the admin dashboard
//               reads). Any failure → 0; never fatal.
//
// overall ok = db.ok && ai.ok && gateway.ok. A not-configured AI is honest:
// the agent cannot run without keys, so ai.ok is false and the cron maps it to
// its own throttled "ai_not_configured" advisory.
// ---------------------------------------------------------------------------

import { probeAIHealth } from "@/lib/ai/client";
import { getDbStatus } from "@/lib/db/reliability";
import { rawClient } from "@/lib/db";

export interface AggregateHealth {
  ok: boolean;
  db: { ok: boolean; latencyMs?: number };
  ai: {
    configured: boolean;
    provider: string | null;
    ok: boolean;
    error?: string;
    latencyMs?: number;
  };
  gateway: {
    ok: boolean;
    latencyMs?: number;
    reachable: boolean;
    detail?: unknown;
  };
  recentErrors: number;
  ts: string;
}

const GATEWAY_PROBE_TIMEOUT_MS = 4000;

/**
 * Best-effort census of errors RECORDED in the last hour (repli.error_logs).
 * Uses the admin dashboard's source table/column. Any DB hiccup → 0 — the
 * count is advisory, never something that can fail the health aggregate.
 */
export async function countRecentErrors(): Promise<number> {
  try {
    const rows = (await rawClient`
      select count(*)::int as n
      from repli.error_logs
      where created_at >= now() - interval '1 hour'
    `) as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

/** Gateway probe. Shaped so the URL and its query string NEVER leave this module. */
async function probeGateway(
  url: string
): Promise<AggregateHealth["gateway"]> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(GATEWAY_PROBE_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      return {
        ok: false,
        reachable: true,
        latencyMs: Date.now() - started,
        detail: { status: res.status },
      };
    }
    let body: { ok?: unknown } | null = null;
    try {
      body = (await res.json()) as { ok?: unknown };
    } catch {
      body = null;
    }
    const ok = body !== null && body.ok === true;
    return {
      ok,
      reachable: true,
      latencyMs: Date.now() - started,
      detail: ok ? { status: res.status } : { status: res.status, bodyOk: false },
    };
  } catch {
    return {
      ok: false,
      reachable: false,
      latencyMs: Date.now() - started,
      detail: { error: "unreachable" },
    };
  }
}

/** Probe a consumer via `deps` (test seam) or the default env var. */
function resolveGatewayUrl(deps: {
  getGatewayHealthUrl?: () => string;
}): string {
  const fn = deps.getGatewayHealthUrl ?? (() => process.env.GATEWAY_HEALTH_URL);
  return fn() ?? "";
}

export async function aggregateHealth(deps: {
  getGatewayHealthUrl?: () => string;
} = {}): Promise<AggregateHealth> {
  const gatewayUrl = resolveGatewayUrl(deps).trim();

  const [dbRes, aiRes, gwRes, errRes] = await Promise.allSettled([
    getDbStatus(),
    probeAIHealth(),
    gatewayUrl !== ""
      ? probeGateway(gatewayUrl)
      : Promise.resolve<AggregateHealth["gateway"]>({
          ok: true,
          reachable: false,
          detail: { skipped: true },
        }),
    countRecentErrors(),
  ]);

  const db =
    dbRes.status === "fulfilled"
      ? { ok: dbRes.value.ok, latencyMs: dbRes.value.latencyMs }
      : { ok: false };

  const ai =
    aiRes.status === "fulfilled"
      ? {
          configured: aiRes.value.configured,
          provider: aiRes.value.provider,
          ok: aiRes.value.ok,
          error: aiRes.value.error,
          latencyMs: aiRes.value.latencyMs,
        }
      : {
          configured: false,
          provider: null,
          ok: false,
          error: "ai probe threw",
        };

  const gateway =
    gwRes.status === "fulfilled"
      ? gwRes.value
      : { ok: false, reachable: false, detail: { error: "gateway probe threw" } };

  const recentErrors = errRes.status === "fulfilled" ? errRes.value : 0;

  return {
    ok: db.ok && ai.ok && gateway.ok,
    db,
    ai,
    gateway,
    recentErrors,
    ts: new Date().toISOString(),
  };
}