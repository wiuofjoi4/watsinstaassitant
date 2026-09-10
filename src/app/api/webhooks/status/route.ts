import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { restaurants } from "@/lib/db/schema";
import { gatewaySecretOk } from "@/lib/env";

export const runtime = "nodejs";

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

  return NextResponse.json({ ok: true });
}