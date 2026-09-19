import { logger } from "./logger";
import { sessions, type Session } from "./conn/state";
import type { ParsedMessage } from "./parse";

// ---------------------------------------------------------------------------
// Reply delivery + guaranteed fallback messaging (Module 8 contract).
// EVERY code path that produced no outbound text/images must end in a
// customer-facing reply — never silence, never a raw error. All replies use
// the platform's Iraqi Arabic dialect and carry NO emojis (the platform strips
// them before the reply is produced; the gateway sends replies as-is).
//
// Async fast-ack flow (WEBHOOK_MODE=async, default):
//   1. POST /api/webhooks/message with messageId → { accepted:true, jobId }.
//   2. Poll GET /api/jobs/result until a terminal status (ready/sent/failed/
//      expired), bounded by PLATFORM_TIMEOUT_MS.
//   3. ready   → compose (pacing preserved) + send + POST /api/jobs/ack
//                {delivered:true}. silent results send NOTHING and ack
//                delivered. A job with neither text nor images gets the
//                generic fallback then ack {expired:true}.
//      failed  → generic fallback + ack {expired:true} (never resends).
//      expired → send nothing, return false.
//      sent    → already acked by another path, return true.
//   Poll budget exhausted:
//      socket connected → generic fallback + ack {expired:true}, return true.
//      socket DOWN      → leave the job pending (NO ack) so the outbox resume
//                         loop delivers the real reply after reconnect, false.
//
// The legacy sync shape ({ reply } with no `accepted` field) runs the ORIGINAL
// inline path byte-for-byte (deliverLegacy below) — only messageId plumbing
// was added to the outbound webhook body.
// ---------------------------------------------------------------------------

const PLATFORM_URL = process.env.PLATFORM_URL ?? "http://localhost:3000";
const GATEWAY_SECRET = process.env.GATEWAY_SECRET ?? "dev-secret";

// Graceful fallback replies — Iraqi Arabic dialect, matching the platform's
// tone. The CUSTOMER never sees a raw error / stack trace: on any failure we
// send one of these instead of silence.
const FALLBACK_REPLY_GENERIC =
  "عذراً صار تعطل بسيط بالخادم، كرر رسالتك بعد دقيقة 🙏";
const FALLBACK_REPLY_MEDIA_TOO_LARGE =
  "عذراً، الصورة كبيرة هواية وما قدرت أقراها. أرسل صورة أصغر أو اكتب الوصف بالكلام 🙏";
const FALLBACK_REPLY_RATE_LIMIT =
  "تعال شوي رجاءً، وحدة وحدة 🙏";

// Cap this under Vercel's 60s function budget so the abort fires BEFORE the
// platform lambda is killed. If we wait too long, the platform gets nothing
// and neither placeholder NOR reply can be sent.
export const PLATFORM_TIMEOUT_MS = 55_000;

// Guard against multi-MB base64 payloads blowing up the webhook request /
// function memory. WhatsApp images routinely exceed 1MB base64.
export const MAX_MEDIA_BASE64_LENGTH = 4_000_000; // ~3MB binary

// Per-poll cap on a /api/jobs/result fetch. Kept under the remaining poll
// budget so a single slow request can't blow the whole 55s window by itself.
const JOB_POLL_FETCH_TIMEOUT_MS = 15_000;

// Platform job-surface test seams (offline self-tests ONLY). Production keeps
// the frozen defaults: ~2s between polls, PLATFORM_TIMEOUT_MS total budget.
let pollBudgetMs = PLATFORM_TIMEOUT_MS;
let pollIntervalMs = 2_000;
export function __setPollBudget(ms: number): void {
  pollBudgetMs = ms;
}
export function __setPollInterval(ms: number): void {
  pollIntervalMs = ms;
}

export function platformHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-gateway-secret": GATEWAY_SECRET,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Best-effort: send a fallback text to the customer if the session is up.
 * Returns true when the message was handed to an open socket. */
export async function sendFallback(
  restaurantId: string,
  remoteJid: string,
  text: string
): Promise<boolean> {
  const session = sessions.get(restaurantId);
  if (!session?.connected) return false;
  try {
    await session.socket.sendMessage(remoteJid, { text });
    logger.info(
      `fallback sent to ${remoteJid} for ${restaurantId}: ${text.slice(0, 40)}`
    );
    return true;
  } catch (err) {
    logger.error(
      `fallback send failed for ${restaurantId} ${remoteJid}: ${String(err)}`
    );
    return false;
  }
}

/** Public textual fallbacks so tests/route handlers reuse the exact strings. */
export const FallbackReplies = {
  generic: FALLBACK_REPLY_GENERIC,
  mediaTooLarge: FALLBACK_REPLY_MEDIA_TOO_LARGE,
  rateLimit: FALLBACK_REPLY_RATE_LIMIT,
};

// ---------------------------------------------------------------------------
// Ready-job composition (shared by the inline poll path and the outbox loop)
// ---------------------------------------------------------------------------

/** Result payload frozen by the M3 job API: `{ replyText, replyParts?, silent?,
 * images?: [{base64,mime}], ... }` (extra engine fields are ignored here). */
export interface ReadyJobResult {
  replyText?: string | null;
  replyParts?: string[];
  silent?: boolean;
  images?: Array<{ base64?: string; mime?: string }>;
}

export type SendReadyOutcome =
  | { kind: "sent" } // everything produced was delivered (or the job was silent)
  | { kind: "empty" } // produced neither text nor images
  | { kind: "sendFailed" } // a send threw while the socket still reported connected
  | { kind: "disconnected" }; // session dropped before/and or during the send

/**
 * Compose + send a ready job's result with the exact consumer-visible behavior
 * of the legacy inline path: best-effort composing indicator, 2-5s natural
 * "typing" delay before the first send, images BEFORE text (one image per
 * message, an image failure never blocks the text), text parts with a
 * 1200-2400ms pause between them like a person typing while they think.
 *
 * A `silent` job sends NOTHING and reports { kind: "sent" } so the caller acks
 * it delivered. `disconnected` means the caller must leave the job pending
 * (no ack) for the outbox resume loop to finish after reconnect.
 */
export async function sendReadyJob(
  restaurantId: string,
  remoteJid: string,
  result: ReadyJobResult,
  session: Session
): Promise<SendReadyOutcome> {
  if (result.silent === true) return { kind: "sent" };
  if (!session?.connected) return { kind: "disconnected" };

  try {
    await session.socket.sendPresenceUpdate("composing", remoteJid);
  } catch {
    // Typing indicator is best-effort — never fail the turn over it.
  }

  const typingDelay = 2000 + Math.floor(Math.random() * 3000);
  await sleep(typingDelay);
  if (!session.connected) return { kind: "disconnected" };

  // Send images one at a time; a failure on one image must NOT prevent the
  // text (the main reply) from going out.
  let imagesSent = false;
  for (const img of result.images ?? []) {
    if (!img.base64) continue;
    const buf = Buffer.from(img.base64, "base64");
    if (buf.length === 0) continue;
    try {
      await session.socket.sendMessage(remoteJid, {
        image: buf,
        mimetype: img.mime ?? "image/jpeg",
      });
      imagesSent = true;
    } catch (err) {
      logger.error(
        `sendReadyJob: image send failed for ${restaurantId}/${remoteJid}: ${String(err)}`
      );
      if (!session.connected) return { kind: "disconnected" };
    }
  }

  // Send the reply as a natural short sequence: either the split parts (each
  // with a pause between, like a person typing while they think) or the
  // single text when the reply was short.
  const replyText = result.replyText;
  const replyParts = Array.isArray(result.replyParts)
    ? result.replyParts.filter((p) => p && p.trim().length > 0)
    : [];
  const texts = replyParts.length > 0 ? replyParts : replyText ? [replyText] : [];
  let textSent = false;
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (!t || t.trim().length === 0) continue;
    try {
      await session.socket.sendMessage(remoteJid, { text: t });
      textSent = true;
    } catch (err) {
      logger.error(
        `sendReadyJob: reply send failed for ${restaurantId}/${remoteJid}: ${String(err)}`
      );
      if (!session.connected) return { kind: "disconnected" };
      return { kind: "sendFailed" };
    }
    if (i < texts.length - 1) {
      await sleep(1200 + Math.floor(Math.random() * 1200));
    }
  }
  if (textSent) return { kind: "sent" };
  if (imagesSent) return { kind: "sent" };
  return { kind: "empty" };
}

// ---------------------------------------------------------------------------
// Job ack + poll helpers
// ---------------------------------------------------------------------------

/** Best-effort POST /api/jobs/ack. Never throws. */
export async function ackJob(
  jobId: string,
  body: { delivered?: boolean; expired?: boolean }
): Promise<boolean> {
  try {
    const res = await fetch(`${PLATFORM_URL}/api/jobs/ack`, {
      method: "POST",
      headers: platformHeaders(),
      body: JSON.stringify({ jobId, ...body }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return true;
    logger.warn(`jobs/ack returned ${res.status} for ${jobId} — job stays pending`);
    return false;
  } catch (err) {
    logger.warn(`jobs/ack failed for ${jobId}: ${String(err)}`);
    return false;
  }
}

interface JobPollResponse {
  ok?: boolean;
  status?: string;
  result?: ReadyJobResult;
  error?: string | null;
}

interface WebhookResponse {
  accepted?: boolean;
  jobId?: string;
  duplicate?: boolean;
  reply?: { text?: string; parts?: string[] } | null;
  images?: Array<{ base64?: string; mime?: string }>;
  silent?: boolean;
}

/**
 * Trigger the platform to claim + execute a queued job. This is the link the
 * plan requires (M8 worker → POST /api/jobs/run): the webhook only ENQUEUES
 * ({accepted, jobId}); nothing in the platform runs the engine on its own, so
 * the queue would sit `queued` forever and the poll below would burn its whole
 * budget before the fallback fired. We fire the claim from the connected
 * session that owns the turn. Returns true when the run route accepted the
 * request (job was claimed or already finalised server-side).
 */
async function triggerJobRun(
  restaurantId: string,
  jobId: string,
  timeoutMs: number
): Promise<boolean> {
  try {
    const res = await fetch(`${PLATFORM_URL}/api/jobs/run`, {
      method: "POST",
      headers: platformHeaders(),
      body: JSON.stringify({ restaurantId, jobId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn(`jobs/run returned ${res.status} for ${jobId} — will keep polling`);
      return false;
    }
    const data = (await res.json()) as {
      ok?: boolean;
      job?: { id?: string; status?: string } | null;
    };
    if (data.ok === false) {
      logger.warn(`jobs/run ok:false for ${jobId} — will keep polling`);
      return false;
    }
    logger.info(
      `jobs/run executed job ${data.job?.id ?? jobId} (status ${data.job?.status ?? "?"})`
    );
    return true;
  } catch (err) {
    logger.warn(`jobs/run trigger failed for ${jobId}: ${String(err)} — will keep polling`);
    return false;
  }
}

/**
 * Poll GET /api/jobs/result?jobId= every ~2s up to the poll budget and act on
 * the first terminal status. Transient fetch/HTTP errors are logged and the
 * poll continues — only the deadline decides "give up".
 *
 * The trigger fires `/api/jobs/run` once before polling (the queue has no
 * self-executor), and RE-fires it whenever the job is still `queued` and our
 * last trigger is stale — so a transient trigger failure can never strand the
 * job until the budget expires.
 */
async function deliverJob(
  restaurantId: string,
  remoteJid: string,
  jobId: string
): Promise<boolean> {
  const deadline = Date.now() + pollBudgetMs;
  let lastRunTriggerAt = 0;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    // Ensure the platform is actually executing our job — fire the claim every
    // time the job is still queued (or we couldn't confirm a status) and the
    // previous trigger is older than one poll interval, so a dropped trigger
    // or network blip self-heals instead of stranding the job.
    const shouldReTrigger = { value: true };
    try {
      const res = await fetch(
        `${PLATFORM_URL}/api/jobs/result?jobId=${encodeURIComponent(jobId)}`,
        {
          headers: platformHeaders(),
          signal: AbortSignal.timeout(
            Math.min(JOB_POLL_FETCH_TIMEOUT_MS, Math.max(1_000, remaining))
          ),
        }
      );
      if (!res.ok) {
        logger.warn(`jobs/result returned ${res.status} for ${jobId} — keep polling`);
      } else {
        const data = (await res.json()) as JobPollResponse;
        if (data.ok === false) {
          logger.warn(
            `jobs/result ok:false (${data.error ?? "unknown"}) for ${jobId} — keep polling`
          );
        } else {
          const status = data.status ?? "";
          // Only "processing" (or "sending") proves the platform owns the job
          // right now; anything else (queued, empty, indeterminate) may still
          // need the trigger to claim it.
          shouldReTrigger.value =
            status !== "processing" && status !== "sending";
          if (status === "ready") return await handleReady(restaurantId, remoteJid, jobId, data.result ?? {});
          if (status === "sent") {
            logger.info(`deliver: job ${jobId} already sent (acked by another path)`);
            return true;
          }
          if (status === "expired") {
            logger.info(`deliver: job ${jobId} expired on the platform — sending nothing`);
            return false;
          }
          if (status === "failed" || (!status && data.error)) {
            logger.error(
              `deliver: job ${jobId} failed for ${restaurantId}/${remoteJid}: ${data.error ?? "unknown"}`
            );
            await sendFallback(restaurantId, remoteJid, FALLBACK_REPLY_GENERIC);
            await ackJob(jobId, { expired: true }); // never resend this failed job
            return true;
          }
          // processing / sending (or an error-less unknown) → keep polling
        }
      }
    } catch (err) {
      logger.warn(
        `deliver: jobs/result poll threw for ${jobId}: ${String(err)} — keep polling`
      );
    }

    if (shouldReTrigger.value && Date.now() - lastRunTriggerAt >= pollIntervalMs) {
      lastRunTriggerAt = Date.now();
      await triggerJobRun(restaurantId, jobId, Math.max(5_000, pollIntervalMs * 2));
    }

    await sleep(pollIntervalMs);
  }

  // Poll budget exhausted and the job never reached a terminal status.
  const session = sessions.get(restaurantId);
  if (session?.connected) {
    logger.warn(
      `deliver: poll budget exhausted for ${jobId} (socket up) — fallback + expire`
    );
    await sendFallback(restaurantId, remoteJid, FALLBACK_REPLY_GENERIC);
    await ackJob(jobId, { expired: true });
    return true;
  }
  // Socket is DOWN so a fallback is impossible — leave the job pending (NO ack).
  // The outbox resume loop picks up the `ready` result after reconnect.
  logger.warn(
    `deliver: poll budget exhausted for ${jobId} and socket down for ${restaurantId} — leaving job pending for outbox resume`
  );
  return false;
}

/** A job reached `ready`: silent → ack delivered with no send; otherwise
 * compose+send, then ack. A disconnected socket means the job is left pending
 * so the outbox loop delivers it after reconnect. */
async function handleReady(
  restaurantId: string,
  remoteJid: string,
  jobId: string,
  result: ReadyJobResult
): Promise<boolean> {
  if (result.silent === true) {
    logger.info(`deliver: job ${jobId} is silent (human took over) — ack delivered, send nothing`);
    await ackJob(jobId, { delivered: true });
    return true;
  }
  const session = sessions.get(restaurantId);
  if (!session?.connected) {
    logger.warn(
      `deliver: job ${jobId} ready but socket down for ${restaurantId} — leaving pending for outbox resume`
    );
    return true;
  }
  const outcome = await sendReadyJob(restaurantId, remoteJid, result, session);
  switch (outcome.kind) {
    case "sent":
      await ackJob(jobId, { delivered: true });
      return true;
    case "empty":
      // Platform finalised the job with neither text nor images — keep the
      // guarantee to always reply, then expire the job so it never resends.
      await sendFallback(restaurantId, remoteJid, FALLBACK_REPLY_GENERIC);
      await ackJob(jobId, { expired: true });
      return true;
    case "sendFailed":
      await sendFallback(restaurantId, remoteJid, FALLBACK_REPLY_GENERIC);
      await ackJob(jobId, { expired: true });
      return true;
    case "disconnected":
      logger.warn(
        `deliver: socket dropped while sending job ${jobId} — leaving pending for outbox resume`
      );
      return true;
  }
}

/**
 * Legacy sync webhook shape ({ reply } without an `accepted` field) — the
 * ORIGINAL inline path, preserved logic-for-logic: silent turns send nothing,
 * images go first, then parts/text with human pacing.
 */
async function deliverLegacy(
  restaurantId: string,
  remoteJid: string,
  data: WebhookResponse
): Promise<boolean> {
  // A "silent" turn (human currently handling this chat in the dashboard)
  // deliberely requires NO bot reply — do not auto-fallback over the human.
  if (data.silent === true) return false;
  const replyText = data.reply?.text;
  const replyParts = Array.isArray(data.reply?.parts)
    ? data.reply!.parts!.filter((p) => p && p.trim().length > 0)
    : [];
  const session = sessions.get(restaurantId);
  if (!session?.connected) {
    // Session dropped (WhatsApp disconnect) — nothing to send to. Still log.
    logger.warn(
      `deliver: no connected session for ${restaurantId} (${remoteJid}) ${Date.now()}`
    );
    return false;
  }

  // Human-like pacing (style guide §5): 2-5s natural "typing" delay before
  // the first message, and a short pause between split parts.
  const typingDelay = 2000 + Math.floor(Math.random() * 3000);
  await sleep(typingDelay);

  // Send images one at a time; a failure on one image must NOT prevent the
  // text (the main reply) from going out.
  let imagesSent = false;
  for (const img of data.images ?? []) {
    if (!img.base64) continue;
    const buf = Buffer.from(img.base64, "base64");
    if (buf.length === 0) continue;
    try {
      await session.socket.sendMessage(remoteJid, {
        image: buf,
        mimetype: img.mime ?? "image/jpeg",
      });
      imagesSent = true;
    } catch (err) {
      logger.error(
        `deliver: image send failed for ${restaurantId}/${remoteJid}: ${String(err)}`
      );
    }
  }

  // Send the reply as a natural short sequence: either the split parts (each
  // with a pause between, like a person typing while they think) or the
  // single text when the reply was short.
  let textSent = false;
  const texts = replyParts.length > 0 ? replyParts : replyText ? [replyText] : [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (!t || t.trim().length === 0) continue;
    try {
      await session.socket.sendMessage(remoteJid, { text: t });
      textSent = true;
    } catch (err) {
      logger.error(
        `deliver: reply send failed for ${restaurantId}/${remoteJid}: ${String(err)}`
      );
      // The text send itself failed — make sure the customer still gets a
      // graceful notice rather than silence.
      await sendFallback(restaurantId, remoteJid, FALLBACK_REPLY_GENERIC);
      return false;
    }
    if (i < texts.length - 1) {
      await sleep(1200 + Math.floor(Math.random() * 1200));
    }
  }
  if (textSent) return true;

  if (!imagesSent) {
    // Platform said OK but produced neither text nor images (e.g. restaurant
    // not found / agent disabled). We promised to always reply — send the
    // graceful fallback instead of the silent black hole.
    await sendFallback(restaurantId, remoteJid, FALLBACK_REPLY_GENERIC);
    return false;
  }
  return true;
}

export async function deliver(
  restaurantId: string,
  remoteJid: string,
  parsed: ParsedMessage,
  messageId?: string
): Promise<boolean> {
  try {
    // Over-sized media would blow the webhook request / function memory and
    // produce a silent failure. Reject it up-front with a graceful message.
    if (
      parsed.mediaBase64 &&
      parsed.mediaBase64.length > MAX_MEDIA_BASE64_LENGTH
    ) {
      logger.warn(
        `media too large (${parsed.mediaBase64.length} base64 chars) for ${restaurantId}/${remoteJid}`
      );
      await sendFallback(restaurantId, remoteJid, FALLBACK_REPLY_MEDIA_TOO_LARGE);
      return false;
    }

    // Show a typing indicator right away so the customer knows the bot is
    // working — this is a cheap, near-instant signal while the platform LLM
    // call runs.
    try {
      const session = sessions.get(restaurantId);
      if (session?.connected) {
        await session.socket.sendPresenceUpdate("composing", remoteJid);
      }
    } catch {
      // Typing indicator is best-effort — never fail the turn over it.
    }

    const res = await fetch(`${PLATFORM_URL}/api/webhooks/message`, {
      method: "POST",
      headers: platformHeaders(),
      body: JSON.stringify({
        restaurantId,
        channel: "whatsapp",
        remoteJid,
        messageId: messageId ?? null,
        contentType: parsed.contentType,
        text: parsed.text,
        mediaBase64: parsed.mediaBase64,
        mediaMime: parsed.mediaMime,
      }),
      // Vercel kills the webhook at 60s — never let this call hang past it so
      // we can log cleanly and the platform's next message doesn't queue up.
      signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.error(`webhook message returned ${res.status} for ${restaurantId}`);
      await sendFallback(restaurantId, remoteJid, FALLBACK_REPLY_GENERIC);
      return false;
    }
    const data = (await res.json()) as WebhookResponse;

    // Async fast-ack: the platform enqueued a durable job — poll until ready.
    if (data.accepted === true && data.jobId) {
      return await deliverJob(restaurantId, remoteJid, data.jobId);
    }
    // Platform deduped this messageId — the customer already got a reply.
    if (data.accepted === false && data.duplicate === true) {
      logger.info(
        `deliver: platform deduped ${restaurantId}/${remoteJid} (messageId=${messageId ?? "?"}) — nothing to send`
      );
      return true;
    }
    // Legacy sync shape — the original inline reply path, preserved unchanged.
    return await deliverLegacy(restaurantId, remoteJid, data);
  } catch (err) {
    logger.error(
      `deliver failed for ${restaurantId}/${remoteJid}: ${String(err)}`
    );
    await sendFallback(restaurantId, remoteJid, FALLBACK_REPLY_GENERIC);
    return false;
  }
}