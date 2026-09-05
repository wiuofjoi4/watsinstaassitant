import { NextResponse } from "next/server";
import { handleIncomingMessage } from "@/lib/agent/engine";

export const runtime = "nodejs";
export const maxDuration = 60;

interface IncomingBody {
  restaurantId: string;
  channel: "whatsapp" | "instagram";
  remoteJid: string;
  customerName?: string | null;
  contentType?: "text" | "image" | "voice" | "video";
  text?: string | null;
  mediaUrl?: string | null;
  mediaMime?: string | null;
  mediaBase64?: string | null;
  messageId?: string | null;
}

function validSecret(req: Request): boolean {
  const expected = process.env.GATEWAY_SECRET;
  if (!expected) return true;
  return req.headers.get("x-gateway-secret") === expected;
}

export async function POST(req: Request) {
  if (!validSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: IncomingBody;
  try {
    body = (await req.json()) as IncomingBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.restaurantId || !body.remoteJid || !body.channel) {
    return NextResponse.json(
      { error: "restaurantId, channel and remoteJid are required" },
      { status: 400 }
    );
  }

  if (body.channel !== "whatsapp" && body.channel !== "instagram") {
    return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  }

  try {
    const result = await handleIncomingMessage({
      restaurantId: body.restaurantId,
      channel: body.channel,
      remoteJid: body.remoteJid,
      customerName: body.customerName ?? null,
      contentType: body.contentType ?? "text",
      text: body.text ?? null,
      mediaUrl: body.mediaUrl ?? null,
      mediaMime: body.mediaMime ?? null,
      mediaBase64: body.mediaBase64 ?? null,
      messageId: body.messageId ?? null,
    });

    return NextResponse.json({
      reply: result?.replyText ? { text: result.replyText } : null,
      agency: result?.order ?? null,
      generatedPrice: result?.costUsd ?? 0,
    });
  } catch (err) {
    console.error("webhook/message error", err);
    return NextResponse.json(
      { error: "Internal error processing message" },
      { status: 500 }
    );
  }
}