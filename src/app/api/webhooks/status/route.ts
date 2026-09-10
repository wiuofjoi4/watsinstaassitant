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
  const linked =
    body.event === "connected" ? true : body.event === "disconnected" ? false : undefined;

  if (body.channel === "whatsapp") {
    await db
      .update(restaurants)
      .set({
        whatsappStatus: status,
        whatsappLinked: linked === undefined ? undefined : linked,
        whatsappJid: body.jid ?? undefined,
      })
      .where(eq(restaurants.id, body.restaurantId));
  } else {
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
  // Telegram alert channel is configured.
  if (
    body.channel === "whatsapp" &&
    body.event === "qr_ready" &&
    wasLinked
  ) {
    const qrUrl = `${GATEWAY_PUBLIC_URL}/qr/${encodeURIComponent(body.restaurantId)}/whatsapp`;
    void sendAlert(
      `[واست] اتصال واتساب انقطع ويحتاج إعادة ربط! امسح QR جديداً خلال دقائق حتى يرجع الرد الآلي:\n${qrUrl}`
    ).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}