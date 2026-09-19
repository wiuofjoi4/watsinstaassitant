// ---------------------------------------------------------------------------
// M9 /api/cron/healthcheck — Vercel cron (every ~5 min).
//
// Runs the aggregate probes and, when something is down, sends the owner ONE
// throttled Telegram/webhook alert per kind, then ALWAYS answers 200 so the
// scheduler never retry-spams the function on a degraded system.
//
//   - Throttle: module-level lastAlertByKind map. Never re-alerts the same
//     kind more than once per HEALTHCHECK_ALERT_MINUTES (default 5), and the
//     "ai_not_configured" advisory at most once per 12 hours. In-memory is
//     intentional: a warm lambda keeps the window; a cold lambda may re-alert
//     once after a fresh start, which is preferable to missing an outage.
//   - Kinds: gateway_down, ai_down, db_down, ai_not_configured.
//   - Alerts contain a one-line summary with counts only — no secrets, no
//     URLs with keys, no gateway bodies.
//
// Guard: the standard cron policy used by /api/cron/cleanup — Vercel Cron's
// `Authorization: Bearer $CRON_SECRET` OR the gateway secret. Unconfigured
// secrets are treated as UNCONFIGURED-AUTH and rejected (env.ts policy).
// ---------------------------------------------------------------------------
import { NextResponse } from "next/server";
import { aggregateHealth } from "@/lib/monitoring/health";
import type { AggregateHealth } from "@/lib/monitoring/health";
import { sendAlert } from "@/lib/alerts";
import { gatewaySecretOk } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const DEFAULT_ALERT_MINUTES = 5;
const AI_NOT_CONFIGURED_INTERVAL_MS = 12 * 60 * 60 * 1000;

const HEALTHCHECK_ALERT_MINUTES = Math.max(
  1,
  Number(process.env.HEALTHCHECK_ALERT_MINUTES ?? DEFAULT_ALERT_MINUTES) ||
    DEFAULT_ALERT_MINUTES
);

const lastAlertByKind = new Map<string, number>();

function alertIntervalMs(kind: string): number {
  return kind === "ai_not_configured"
    ? AI_NOT_CONFIGURED_INTERVAL_MS
    : HEALTHCHECK_ALERT_MINUTES * 60_000;
}

/** Map outstanding failures to their alert kinds. Not-configured AI has its own kind. */
function collectKinds(health: AggregateHealth): string[] {
  const kinds: string[] = [];
  if (!health.db.ok) kinds.push("db_down");
  if (!health.ai.ok) kinds.push(health.ai.configured ? "ai_down" : "ai_not_configured");
  if (!health.gateway.ok) kinds.push("gateway_down");
  return kinds;
}

function isAuthorized(req: Request): boolean {
  const cronSecret = (process.env.CRON_SECRET ?? "").trim();
  const authHeader = req.headers.get("authorization") ?? "";
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return true;
  if (gatewaySecretOk(req)) return true;
  return false;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const health = await aggregateHealth();

  const kinds = collectKinds(health);
  const due = kinds.filter((kind) => {
    const last = lastAlertByKind.get(kind) ?? 0;
    return now - last >= alertIntervalMs(kind);
  });

  let alertSent = false;
  if (due.length > 0) {
    const counts =
      `db=${health.db.ok ? "ok" : "down"}` +
      ` ai=${health.ai.ok ? "ok" : health.ai.configured ? "unreachable" : "not-configured"}` +
      ` gateway=${health.gateway.ok ? "ok" : health.gateway.reachable ? "degraded" : "unreachable"}` +
      ` recentErrors=${health.recentErrors}`;
    await sendAlert(`[HEALTH] ${due.join(", ")} — ${counts}`);
    alertSent = true;
    for (const kind of due) lastAlertByKind.set(kind, now);
  }

  // Always 200 once authorized — a not-ok system still mints a healthy cron.
  return NextResponse.json({ ok: health.ok, alertSent, kinds }, { status: 200 });
}