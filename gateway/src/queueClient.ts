import { logger } from "./logger";
import {
  platformHeaders,
  sendReadyJob,
  ackJob,
  FallbackReplies,
  type ReadyJobResult,
} from "./deliver";
import type { Session } from "./conn/state";

// ---------------------------------------------------------------------------
// Outbox resume loop (Module 8 contract).
//
// Every 30s the loop scans each CONNECTED session's /api/jobs/pending and
// delivers any `ready` job the inline turn never finalised (socket dropped
// mid-turn, poll budget exhausted with the socket down, gateway restart, ...).
// The gateway therefore "never loses a reply": once the platform marks a
// result ready, this loop delivers it after reconnect with the same
// compose+send+ack routine as the inline path.
//
// Wire-up (index.ts / Combiner): startOutboxLoop(() => sessions).
// Singleton guarded: a second start is refused, cancelOutboxLoop() clears the
// timer. The loop never throws and never crashes the process — every sweep is
// wrapped in try/catch and each session is isolated.
// ---------------------------------------------------------------------------

const PLATFORM_URL = process.env.PLATFORM_URL ?? "http://localhost:3000";
const OUTBOX_INTERVAL_DEFAULT_MS = 30_000;
const OUTBOX_FETCH_TIMEOUT_MS = 15_000;

let outboxTimer: NodeJS.Timeout | null = null;

export function startOutboxLoop(
  getSessions: () => Map<string, Session>,
  intervalMs: number = OUTBOX_INTERVAL_DEFAULT_MS
): void {
  if (outboxTimer) {
    logger.warn("outbox loop already running — refusing to double-start");
    return;
  }
  outboxTimer = setInterval(() => {
    void sweepOutbox(getSessions).catch((err) => {
      logger.error(`outbox sweep crashed: ${String(err)}`);
    });
  }, intervalMs);
  outboxTimer.unref?.();
  logger.info(`outbox resume loop started (interval ${intervalMs}ms)`);
}

export function cancelOutboxLoop(): void {
  if (outboxTimer) {
    clearInterval(outboxTimer);
    outboxTimer = null;
    logger.info("outbox resume loop stopped");
  }
}

/** Test seam: run one sweep immediately without waiting for the timer. */
export async function __runOutboxSweep(
  getSessions: () => Map<string, Session>
): Promise<void> {
  await sweepOutbox(getSessions);
}

interface PendingJob {
  id: string;
  status?: string;
  channel?: string;
  remoteJid?: string | null;
  result?: ReadyJobResult | null;
  resultJson?: string | null;
}

/** Accept the result either as a parsed object (`result`) or JSON text. */
function parsePendingResult(job: PendingJob): ReadyJobResult | null {
  if (job.result && typeof job.result === "object") return job.result;
  if (typeof job.resultJson === "string" && job.resultJson.trim().length > 0) {
    try {
      const parsed = JSON.parse(job.resultJson) as ReadyJobResult;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      logger.warn(`outbox: job ${job.id} has malformed resultJson`);
      return null;
    }
  }
  return null;
}

async function outboxFallback(
  session: Session,
  remoteJid: string,
  text: string
): Promise<void> {
  try {
    await session.socket.sendMessage(remoteJid, { text });
  } catch (err) {
    logger.error(
      `outbox: fallback send failed for ${session.restaurantId}/${remoteJid}: ${String(err)}`
    );
  }
}

async function sweepOutbox(
  getSessions: () => Map<string, Session>
): Promise<void> {
  let sessionsList: Session[] = [];
  try {
    sessionsList = [...getSessions().values()];
  } catch (err) {
    logger.error(`outbox: getSessions threw: ${String(err)}`);
    return;
  }
  for (const session of sessionsList) {
    if (!session?.connected) continue;
    try {
      const res = await fetch(
        `${PLATFORM_URL}/api/jobs/pending?restaurantId=${encodeURIComponent(
          session.restaurantId
        )}`,
        { headers: platformHeaders(), signal: AbortSignal.timeout(OUTBOX_FETCH_TIMEOUT_MS) }
      );
      if (!res.ok) {
        logger.warn(`outbox: jobs/pending returned ${res.status} for ${session.restaurantId}`);
        continue;
      }
      const data = (await res.json()) as { ok?: boolean; jobs?: PendingJob[] };
      if (data.ok === false || !Array.isArray(data.jobs)) continue;
      for (const job of data.jobs) {
        if (job.status !== "ready") continue;
        if (job.channel && job.channel !== "whatsapp") continue;
        if (!session.connected) break; // gone mid-batch — stop for this session
        const remoteJid = job.remoteJid ?? session.lastJid;
        if (!remoteJid) {
          logger.warn(`outbox: job ${job.id} has no remoteJid — skipping`);
          continue;
        }
        const result = parsePendingResult(job);
        if (!result) {
          logger.warn(`outbox: job ${job.id} is ready without a result — acking expired`);
          await ackJob(job.id, { expired: true });
          continue;
        }
        const outcome = await sendReadyJob(session.restaurantId, remoteJid, result, session);
        switch (outcome.kind) {
          case "sent":
            await ackJob(job.id, { delivered: true });
            break;
          case "empty":
            // Ready job with neither text nor images — still promise a reply,
            // then expire the job so it never resends.
            await outboxFallback(session, remoteJid, FallbackReplies.generic);
            await ackJob(job.id, { expired: true });
            break;
          case "sendFailed":
          case "disconnected":
            // Socket trouble — leave the job pending (NO ack); the next sweep
            // or a later reconnect will try again. Never mark delivered here.
            break;
        }
      }
    } catch (err) {
      logger.warn(`outbox: sweep error for ${session.restaurantId}: ${String(err)}`);
    }
  }
}