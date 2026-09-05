import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { restaurants } from "@/lib/db/schema";
import { first } from "@/lib/db/query";
import { handleIncomingMessage } from "@/lib/agent/engine";

export const runtime = "nodejs";
export const maxDuration = 60;

interface TestBody {
  restaurantId: string;
  senderId?: string;
  customerName?: string | null;
  text?: string;
}

export async function POST(req: Request) {
  const expected = process.env.GATEWAY_SECRET;
  if (!expected || req.headers.get("x-gateway-secret") !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: TestBody;
  try {
    body = (await req.json()) as TestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.restaurantId) {
    return NextResponse.json({ error: "restaurantId is required" }, { status: 400 });
  }

  const restaurant = await first(
    db.select().from(restaurants).where(eq(restaurants.id, body.restaurantId))
  );
  if (!restaurant) {
    return NextResponse.json({ error: "Restaurant not found" }, { status: 404 });
  }

  const senderId = body.senderId ?? "test-synthetic-instagram-sender";
  const text = body.text ?? "مرحبا، عندكم شاورما؟";

  const result = await handleIncomingMessage({
    restaurantId: restaurant.id,
    channel: "instagram",
    remoteJid: senderId,
    customerName: body.customerName ?? "المشتري التجريبي",
    contentType: "text",
    text,
  });

  return NextResponse.json({
    reply: result?.replyText ?? "",
    generatedPrice: result?.costUsd ?? 0,
    conversationJid: senderId,
    channel: "instagram",
    agentEnabled: restaurant.agentEnabled,
    igLinked: restaurant.instagramLinked,
  });
}