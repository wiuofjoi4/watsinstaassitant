import { NextResponse } from "next/server";
import { rawClient } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Keep-alive: hits the gateway's /health on Render and pings the database so
 * the Vercel function and the Supabase pooling connection stay warm between
 * user visits (cron-job.org → /api/cron/keepalive every 5 minutes).
 */
export async function GET() {
  const results: Record<string, boolean> = {};

  try {
    await rawClient`select 1`;
    results.db = true;
  } catch {
    results.db = false;
  }

  const url = process.env.GATEWAY_HEALTH_URL;
  if (!url) {
    results.gateway = null as unknown as boolean;
    return NextResponse.json({ ok: true, skipped: true, ...results });
  }
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    results.gateway = res.ok;
    return NextResponse.json({ ok: res.ok && results.db, ...results });
  } catch {
    results.gateway = false;
    return NextResponse.json({ ok: false, ...results }, { status: 502 });
  }
}