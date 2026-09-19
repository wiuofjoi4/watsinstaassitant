// ---------------------------------------------------------------------------
// M9 platform aggregate health — GET only.
//
// Consumed by:
//   (a) the owner's uptime checks,
//   (b) the internal /api/cron/healthcheck cron (which calls aggregateHealth
//       directly rather than looping through HTTP).
//
// Auth: when a real GATEWAY_SECRET is configured, and ALWAYS in production,
// the caller must present x-gateway-secret (env.ts policy — a missing or
// placeholder secret never falls back to "allow everything", so the public
// surface cannot leak operational detail). Only a dev build with no secret
// configured is left unauthenticated.
//
// The response is the AggregateHealth (ok / db / ai / gateway / recentErrors /
// ts) with cache-control: no-store. It never contains secrets, and the gateway
// URL (with any keys in it) is never logged or echoed back.
// ---------------------------------------------------------------------------
import { NextRequest, NextResponse } from "next/server";
import { aggregateHealth } from "@/lib/monitoring/health";
import { gatewaySecretOk, isGatewaySecretConfigured } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const needAuth =
    isGatewaySecretConfigured() || process.env.NODE_ENV === "production";
  if (needAuth && !gatewaySecretOk(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const health = await aggregateHealth();
  return NextResponse.json(health, {
    headers: { "cache-control": "no-store, max-age=0" },
  });
}