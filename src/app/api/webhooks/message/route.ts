import { NextResponse } from "next/server";
import { handleIncomingMessage } from "@/lib/agent/engine";
import { gatewaySecretOk } from "@/lib/env";

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

export async function POST(req: Request) {
  if (!gatewaySecretOk(req)) {
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

  const t0 = Date.now();
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
    const elapsed = Date.now() - t0;
    const replyText = result?.replyText ?? "";
    console.error(
      `[WEBHOOK] ${body.restaurantId} ${body.channel}/${body.remoteJid} ` +
        `finished after ${elapsed}ms hasReply=${replyText ? true : false} ` +
        `replyLen=${replyText.length} images=${(result?.menuImages ?? []).length} ` +
        `costUsd=${(result?.costUsd ?? 0).toFixed(4)}`
    );
    return NextResponse.json({
      reply: replyText ? { text: replyText } : null,
      silent: result?.silent === true,
      images: (result?.menuImages ?? []).map((i) => ({
        base64: i.base64,
        mime: i.mime,
      })),
      agency: result?.order ?? null,
      generatedPrice: result?.costUsd ?? 0,
    });
  } catch (err) {
    console.error(
      `[WEBHOOK-ERROR] ${body.restaurantId} ${body.channel}/${body.remoteJid} ` +
        `after ${Date.now() - t0}ms error=${err instanceof Error ? err.message : String(err)}`
    );
    return NextResponse.json(
      { error: "Internal error processing message" },
      { status: 500 }
    );
  }
}