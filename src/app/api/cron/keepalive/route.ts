import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Keep-alive: Vercel cron pings the gateway's /health on Render every 5
 * minutes so the free instance never sits idle for the 15-minute spin-down
 * window. No-op when GATEWAY_HEALTH_URL is not configured.
 */
export async function GET() {
  const url = process.env.GATEWAY_HEALTH_URL;
  if (!url) {
    return NextResponse.json({ ok: true, skipped: true });
  }
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    return NextResponse.json({ ok: res.ok, status: res.status });
  } catch {
    return NextResponse.json({ ok: false }, { status: 502 });
  }
}