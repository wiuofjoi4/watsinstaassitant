import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { restaurants } from "@/lib/db/schema";
import { first } from "@/lib/db/query";
import { handleIncomingMessage } from "@/lib/agent/engine";
import {
  sendInstagramImage,
  sendInstagramText,
  verifyHubSignature,
} from "@/lib/instagram/client";

export const runtime = "nodejs";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Deduplication — in-memory, per message mid
// Instagram (Meta) can re-deliver the same webhook within seconds. This
// prevents double-processing. Works reliably when Vercel runs a single
// warm instance. During cold starts or heavy concurrency, two lambda
// instances *could* both see the same mid — the conversation lock inside
// engine.ts is the safety net that serializes them.
// For bullet-proof multi-instance dedup, a shared DB table would be needed.
// ---------------------------------------------------------------------------
const IG_DEDUP_TTL_MS = 15 * 60_000;
const seenIgMids = new Map<string, number>();

function isIgDuplicate(mid: string): boolean {
  const now = Date.now();
  const prev = seenIgMids.get(mid);
  if (prev !== undefined && now - prev < IG_DEDUP_TTL_MS) return true;
  seenIgMids.set(mid, now);
  return false;
}

// Periodic cleanup
setInterval(() => {
  const cutoff = Date.now() - IG_DEDUP_TTL_MS;
  for (const [id, ts] of seenIgMids) {
    if (ts < cutoff) seenIgMids.delete(id);
  }
}, 120_000);

interface MessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
  };
}

interface Entry {
  id: string;
  messaging?: MessagingEvent[];
}

interface Payload {
  object?: string;
  entry?: Entry[];
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    return new Response(challenge ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return new Response("Verification failed", { status: 403 });
}

export async function POST(req: Request) {
  const appSecret = process.env.INSTAGRAM_APP_SECRET;

  if (appSecret) {
    const raw = await req.text();
    const sig = req.headers.get("x-hub-signature-256");
    if (!verifyHubSignature(appSecret, raw, sig)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    let payload: Payload;
    try {
      payload = JSON.parse(raw) as Payload;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const entries = payload.entry ?? [];
    for (const entry of entries) {
      const events = entry.messaging ?? [];
      if (events.length === 0) continue;

      const igId = events[0].recipient?.id ?? entry.id;
      const restaurant = await first(
        db
          .select()
          .from(restaurants)
          .where(eq(restaurants.instagramIgId, igId))
      );

      for (const event of events) {
        const text = event.message?.text?.trim();
        if (!text) continue;

        const senderId = event.sender?.id;
        if (!senderId) continue;

        if (!restaurant) {
          console.warn("instagram webhook: no restaurant for igId", igId);
          continue;
        }

        // Dedup: skip if this Instagram mid was already processed recently.
        // Prevents double AI calls and double replies from webhook retries.
        const mid = event.message?.mid;
        if (mid && isIgDuplicate(mid)) {
          console.info(`instagram dedup skip mid=${mid} restaurant=${restaurant.id}`);
          continue;
        }

        let replyText = "";
        let result: Awaited<ReturnType<typeof handleIncomingMessage>> | null = null;
        try {
          result = await handleIncomingMessage({
            restaurantId: restaurant.id,
            channel: "instagram",
            remoteJid: senderId,
            contentType: "text",
            text,
            messageId: event.message?.mid ?? null,
          });
          replyText = result?.replyText ?? "";
        } catch (err) {
          console.error("instagram webhook: engine error", err);
        }

        if (replyText && restaurant.instagramToken) {
          const sent = await sendInstagramText({
            igId: restaurant.instagramIgId ?? igId,
            accessToken: restaurant.instagramToken,
            recipientId: senderId,
            text: replyText,
          });
          if (!sent.ok) {
            console.error("instagram webhook: send failed", sent.error);
          }
        }

        for (const img of (result?.menuImages ?? []).slice(0, 6)) {
          if (!restaurant.instagramToken) break;
          const sentImg = await sendInstagramImage({
            igId: restaurant.instagramIgId ?? igId,
            accessToken: restaurant.instagramToken,
            recipientId: senderId,
            imageUrl: img.url,
          });
          if (!sentImg.ok) {
            console.error("instagram webhook: image send failed", sentImg.error);
          }
        }
      }
    }
  }

  return NextResponse.json({ status: "ok" });
}