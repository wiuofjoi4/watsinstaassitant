import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { restaurants } from "@/lib/db/schema";
import { gatewaySecretOk } from "@/lib/env";
import { sendAlert } from "@/lib/alerts";
import { first } from "@/lib/db/query";

export const runtime = "nodejs";

const GATEWAY_PUBLIC_URL =
  process.env.GATEWAY_PUBLIC_URL ?? "https://repli-gateway.onrender.com";

// Re-link alerts for the same restaurant are throttled even if the gateway
// posts "qr_ready" repeatedly (restart, re-pair polling, redeploy). Once the
// owner is told to re-scan, telling them again every few minutes adds noise,
// not value. In-memory is intentional (same trade-off as the healthcheck cron):
// a warm instance keeps the window, a cold one may re-alert once — a genuine
// outage is still surfaced, just never spammed.
const QR_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes per restaurant
const lastQrAlertAt = new Map<string, number>();

interface StatusBody {
  restaurantId: string;
  channel: "whatsapp" | "instagram";
  event: "qr_ready" | "connected" | "disconnected";
  jid?: string | null;
  username?: string | null;
}

export async function POST(req: Request) {
  if (!gatewaySecretOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: StatusBody;
  try {
    body = (await req.json()) as StatusBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.restaurantId || !body.channel || !body.event) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  // Was this restaurant previously linked? A qr_ready AFTER it was linked means
  // the WhatsApp session was force-logged out (error 408 / stale creds) and the
  // owner must re-scan — the bot is silent until they do. Alert immediately so
  // downtime is minutes, not hours.
  let wasLinked = false;
  if (body.channel === "whatsapp") {
    try {
      const existing = await first(
        db
          .select({ whatsappLinked: restaurants.whatsappLinked })
          .from(restaurants)
          .where(eq(restaurants.id, body.restaurantId))
      );
      wasLinked = existing?.whatsappLinked === true;
    } catch {
      // Best-effort — never fail the status write over a read hiccup.
    }
  }

  const status =
    body.event === "connected" ? "connected" : body.event === "qr_ready" ? "waiting" : "disconnected";

  if (body.channel === "whatsapp") {
    await db
      .update(restaurants)
      .set({
        whatsappStatus: status,
        // A socket close is NOT an unlink: the device stays paired, and the
        // gateway auto-reconnects from stored creds. Only an explicit "connected"
        // flips linked to true; a transient drop must never clear it, or the
        // sync loop stops wanting a session and the bot stays dead with no QR
        // until a manual re-link. (grep: user bug "stops every few hours")
        whatsappLinked:
          body.event === "connected" ? true : undefined,
        whatsappJid: body.jid ?? undefined,
      })
      .where(eq(restaurants.id, body.restaurantId));
  } else {
    const linked =
      body.event === "connected" ? true : body.event === "disconnected" ? false : undefined;
    await db
      .update(restaurants)
      .set({
        instagramStatus: status,
        instagramLinked: linked === undefined ? undefined : linked,
        instagramUsername: body.username ?? undefined,
      })
      .where(eq(restaurants.id, body.restaurantId));
  }

  // Fire-and-forget (never blocks the status write): tell the owner a fresh QR
  // must be scanned to bring the bot back. Guarded inside sendAlert when no
  // Telegram alert channel is configured. Throttled per restaurant so a
  // repeated qr_ready (gateway restart / polling re-pair) does NOT re-alert
  // the owner every few minutes. A successful "connected" clears the window so
  // a later genuine crash still alerts promptly.
  if (body.channel === "whatsapp" && body.event === "connected") {
    lastQrAlertAt.delete(body.restaurantId);
  }
  if (
    body.channel === "whatsapp" &&
    body.event === "qr_ready" &&
    wasLinked
  ) {
    const now = Date.now();
    const last = lastQrAlertAt.get(body.restaurantId) ?? 0;
    if (now - last < QR_ALERT_COOLDOWN_MS) {
      return NextResponse.json({ ok: true, alertSkipped: true });
    }
    lastQrAlertAt.set(body.restaurantId, now);
    const qrUrl = `${GATEWAY_PUBLIC_URL}/qr/${encodeURIComponent(body.restaurantId)}/whatsapp`;
    void sendAlert(
      `[واست] اتصال واتساب انقطع ويحتاج إعادة ربط! امسح QR جديداً خلال دقائق حتى يرجع الرد الآلي:\n${qrUrl}`
    ).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}