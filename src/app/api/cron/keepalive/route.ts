import { NextResponse } from "next/server";
import { rawClient } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Keep-alive (cron-job.org → every 5 minutes):
 *  1. pings the database so the Supabase pooling connection stays warm,
 *  2. hits the gateway's /health on Render,
 *  3. warms the most-used Vercel functions (login, link page, link-status,
 *     admin pages) so the first user click after idle is not a cold start.
 */
export async function GET() {
  const results: Record<string, unknown> = {};

  try {
    await rawClient`select 1`;
    results.db = true;
  } catch {
    results.db = false;
  }

  const gatewayUrl = process.env.GATEWAY_HEALTH_URL;
  if (gatewayUrl) {
    try {
      const res = await fetch(gatewayUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      results.gateway = res.ok;
    } catch {
      results.gateway = false;
    }
  } else {
    results.gateway = null as unknown as boolean;
    return NextResponse.json({ ok: true, skipped: true, ...results });
  }

  // Warm frequently-used functions with a self-contained prefix.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://watsinstaassitant.vercel.app";
  // Never include this route itself in the warm list — a self-call would just
  // queue more invocations.
  const warmPaths = [`${appUrl}/login`, `${appUrl}/admin`];
  try {
    const rows = (await rawClient`
    select link_token from repli.restaurants where link_token is not null limit 3
  `) as Array<{ link_token: string }>;
    for (const r of rows) {
      warmPaths.push(`${appUrl}/link/${encodeURIComponent(r.link_token)}`);
      warmPaths.push(
        `${appUrl}/api/link-status?token=${encodeURIComponent(r.link_token)}`
      );
    }
  } catch {
    // warming is best-effort; never fail the keep-alive because of it
  }

  const warmed = await Promise.allSettled(
    warmPaths.map((p) =>
      fetch(p, {
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      }).then((res) => ({ path: p.replace(appUrl, ""), ok: res.ok, status: res.status }))
    )
  );

  results.warm = warmed.map((w) =>
    w.status === "fulfilled" ? w.value : { path: "?", ok: false }
  );
  const allOk =
    (results.db as boolean) &&
    (results.gateway as boolean) &&
    warmed.every((w) => w.status === "fulfilled" && (w.value as { ok: boolean }).ok);

  return NextResponse.json({ ok: allOk, ...results });
}