// ---------------------------------------------------------------------------
// Spend-budget alerts.
// usage_logs already records every LLM call (model, tokens, estimated cost).
// This module periodically sums the day/month totals and, when they cross a NEW
// 10% bracket of a configured limit, POSTs a short warning to a Discord or
// Slack incoming webhook so an unexpected bill can't creep up silently.
// Everything here is best-effort and non-blocking: a failing webhook or a bad
// DB read must NEVER delay or fail the customer's reply.
// ---------------------------------------------------------------------------

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { restaurants, usageLogs } from "@/lib/db/schema";

const ALERT_URL = process.env.ALERT_WEBHOOK_URL ?? "";
const DAILY_LIMIT = Number(process.env.DAILY_SPEND_LIMIT_USD ?? 0);
const MONTHLY_LIMIT = Number(process.env.MONTHLY_SPEND_LIMIT_USD ?? 0);

// One DB sum per 5 minutes, shared across the whole process. Loose by design:
// the alert is a heads-up, not a real-time meter.
const CHECK_INTERVAL_MS = 300_000;
let lastCheckAt = 0;
let inflight: Promise<void> | null = null;

// Bracket = Math.floor(spend/limit * 10), so each new 10% band alerts once per
// process (10%, 20%, … 100%, 110%, …). Bounded memory: ~20-40 entries max.
const alertedBrackets = new Set<string>();

export async function sendAlert(text: string): Promise<void> {
  if (!ALERT_URL) return;
  const isSlack = /slack/i.test(ALERT_URL);
  const body = isSlack ? { text } : { content: text };
  try {
    const res = await fetch(ALERT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) {
      console.error(
        `[ALERT] webhook ${res.status} ${(await res.text()).slice(0, 300)}`
      );
    }
  } catch (err) {
    console.error(
      `[ALERT] webhook error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function sumSpendSince(period: "day" | "month"): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${usageLogs.costUsd}), 0)::float8` })
    .from(usageLogs)
    .where(
      period === "day"
        ? sql`${usageLogs.createdAt} >= date_trunc('day', now())`
        : sql`${usageLogs.createdAt} >= date_trunc('month', now())`
    );
  return rows[0]?.total ?? 0;
}

async function topSpendersToday(): Promise<string[]> {
  const rows = await db
    .select({
      name: restaurants.name,
      total: sql<number>`coalesce(sum(${usageLogs.costUsd}), 0)::float8`,
    })
    .from(usageLogs)
    .innerJoin(restaurants, eq(usageLogs.restaurantId, restaurants.id))
    .where(sql`${usageLogs.createdAt} >= date_trunc('day', now())`)
    .groupBy(restaurants.id, restaurants.name)
    .orderBy(sql`coalesce(sum(${usageLogs.costUsd}), 0) desc`)
    .limit(3);
  return rows.map((r) => `${r.name}: $${r.total.toFixed(2)}`);
}

/**
 * Throttled (once per 5 min per process) daily/monthly budget check. Call it
 * fire-and-forget from the reply path — it never blocks or throws outward.
 */
export async function maybeCheckSpendBudget(): Promise<void> {
  if (ALERT_URL === "" || (DAILY_LIMIT <= 0 && MONTHLY_LIMIT <= 0)) return;
  const now = Date.now();
  if (now - lastCheckAt < CHECK_INTERVAL_MS) return;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const parts: string[] = [];
      let shouldSend = false;

      if (DAILY_LIMIT > 0) {
        const spent = await sumSpendSince("day");
        const bracket = Math.floor((spent / DAILY_LIMIT) * 10);
        const key = `day:${bracket}`;
        if (bracket >= 1 && !alertedBrackets.has(key)) {
          alertedBrackets.add(key);
          shouldSend = true;
          parts.push(
            `Daily spend $${spent.toFixed(2)} / $${DAILY_LIMIT} = ${Math.round(
              (spent / DAILY_LIMIT) * 100
            )}%`
          );
        }
      }

      if (MONTHLY_LIMIT > 0) {
        const spent = await sumSpendSince("month");
        const bracket = Math.floor((spent / MONTHLY_LIMIT) * 10);
        const key = `month:${bracket}`;
        if (bracket >= 1 && !alertedBrackets.has(key)) {
          alertedBrackets.add(key);
          shouldSend = true;
          parts.push(
            `Monthly spend $${spent.toFixed(2)} / $${MONTHLY_LIMIT} = ${Math.round(
              (spent / MONTHLY_LIMIT) * 100
            )}%`
          );
        }
      }

      if (!shouldSend) return;
      const top = await topSpendersToday().catch(() => []);
      const msg = `[SPEND] ${parts.join(" | ")}${top.length ? `\nTop today: ${top.join(", ")}` : ""}`;
      await sendAlert(msg);
    } catch (err) {
      console.error(
        `[ALERT] budget check failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      lastCheckAt = Date.now();
      inflight = null;
    }
  })();

  return inflight;
}