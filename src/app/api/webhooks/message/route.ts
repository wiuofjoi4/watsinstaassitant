import { NextResponse } from "next/server";
import { handleIncomingMessage, type IncomingMessageInput } from "@/lib/agent/engine";
import { gatewaySecretOk } from "@/lib/env";
import { isDuplicateIngest, dedupKeyForWhatsApp } from "@/lib/ingest/dedup";
import { enqueueMessageJob } from "@/lib/queue/client";

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

function buildIncomingMessageInput(body: IncomingBody): IncomingMessageInput {
  return {
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
  };
}

/**
 * Legacy inline path (WEBHOOK_MODE === "sync", or enqueue/dedup failed and we
 * must still give the gateway a real reply). Response shape is byte-for-byte
 * what the gateway has always consumed.
 */
async function runLegacyInline(body: IncomingBody, t0: number) {
  try {
    const result = await handleIncomingMessage(buildIncomingMessageInput(body));
    const elapsed = Date.now() - t0;
    const replyText = result?.replyText ?? "";
    console.error(
      `[WEBHOOK] ${body.restaurantId} ${body.channel}/${body.remoteJid} ` +
        `finished after ${elapsed}ms hasReply=${replyText ? true : false} ` +
        `replyLen=${replyText.length} images=${(result?.menuImages ?? []).length} ` +
        `costUsd=${(result?.costUsd ?? 0).toFixed(4)}`
    );
    return NextResponse.json({
      reply: replyText
        ? {
            text: replyText,
            ...(result?.replyParts?.length
              ? { parts: result.replyParts }
              : {}),
          }
        : null,
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

  // Legacy routing (rollback flag). Inline engine call, no dedup, no queue.
  if (process.env.WEBHOOK_MODE === "sync") {
    return runLegacyInline(body, t0);
  }

  // Default async mode: durable dedup → enqueue → fast 200 {accepted, jobId}.
  try {
    const key = dedupKeyForWhatsApp({
      messageId: body.messageId,
      restaurantId: body.restaurantId,
      remoteJid: body.remoteJid,
      text: body.text,
    });
    const duplicate = await isDuplicateIngest(key);
    if (duplicate) {
      console.info(
        `[WEBHOOK-DEDUP] ${body.restaurantId} whatsapp duplicate messageId=${body.messageId ?? "n/a"}`
      );
      return NextResponse.json({
        accepted: false,
        duplicate: true,
        reply: null,
        silent: true,
      });
    }

    const { jobId } = await enqueueMessageJob(buildIncomingMessageInput(body));

    // A missing jobId is a broken ack (not a real acceptance) — never send an
    // empty 200. Fall back so the gateway still gets a real reply.
    if (!jobId) {
      console.error(
        `[WEBHOOK-ENQUEUE-MISSING-JOBID] ${body.restaurantId} whatsapp/${body.remoteJid}`
      );
      return runLegacyInline(body, t0);
    }

    console.error(
      `[WEBHOOK-ACCEPTED] ${body.restaurantId} whatsapp/${body.remoteJid} ` +
        `jobId=${jobId} after ${Date.now() - t0}ms`
    );
    return NextResponse.json({ accepted: true, jobId });
  } catch (err) {
    // Dedup or enqueue failed (DB down usually) — customer must not be
    // silenced. Fall back to the inline legacy path.
    console.error(
      `[WEBHOOK-FALLBACK] ${body.restaurantId} whatsapp/${body.remoteJid} ` +
        `after ${Date.now() - t0}ms error=${err instanceof Error ? err.message : String(err)}`
    );
    return runLegacyInline(body, t0);
  }
}