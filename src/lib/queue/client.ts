// ---------------------------------------------------------------------------
// M3 job queue public surface. enqueueMessageJob is the ONLY write path M2
// calls: dedup is enforced by the unique partial index
// (restaurant_id, channel, message_id) WHERE message_id IS NOT NULL — a
// conflict returns the existing row's id with duplicate:true. queueDepth /
// stuckCount are lightweight read helpers for M9 monitoring.
// ---------------------------------------------------------------------------
import type { IncomingMessageInput } from "@/lib/agent/engine";
import { rawClient } from "@/lib/db";
import type { EnqueueResult, JobResultPayload } from "./types";

function assertJobInput(input: IncomingMessageInput): void {
  if (!input || typeof input !== "object") {
    throw new Error("invalid job payload");
  }
  if (typeof input.restaurantId !== "string" || !input.restaurantId.trim()) {
    throw new Error("restaurantId is required");
  }
  if (input.channel !== "whatsapp") {
    throw new Error("job queue supports whatsapp channel only");
  }
  if (typeof input.remoteJid !== "string" || !input.remoteJid.trim()) {
    throw new Error("remoteJid is required");
  }
  const ct = input.contentType;
  if (ct !== "text" && ct !== "image" && ct !== "voice" && ct !== "video") {
    throw new Error("invalid contentType");
  }
}

/**
 * Idempotent enqueue. Returns { jobId, duplicate:false } for a fresh insert
 * and { jobId, duplicate:true } with the EXISTING id when messageId was seen
 * before. Throws on any DB error — the caller (M2) owns the sync fallback.
 */
export async function enqueueMessageJob(
  input: IncomingMessageInput
): Promise<EnqueueResult> {
  assertJobInput(input);
  const restaurantId = input.restaurantId.trim();
  const channel = "whatsapp" as const;
  const remoteJid = input.remoteJid.trim();
  const messageId = input.messageId ?? null;

  return rawClient.begin(async (tx) => {
    const inserted = await tx`
      insert into repli.message_jobs (
        restaurant_id, channel, remote_jid, message_id, payload
      ) values (
        ${restaurantId}, ${channel}, ${remoteJid}, ${messageId}, ${JSON.stringify(input)}
      )
      on conflict (restaurant_id, channel, message_id)
      where message_id is not null
      do nothing
      returning id
    `;
    if (inserted.length > 0) {
      return { jobId: String(inserted[0].id), duplicate: false };
    }
    const existing = await tx`
      select id from repli.message_jobs
      where restaurant_id = ${restaurantId}
        and channel = ${channel}
        and message_id = ${messageId}
      limit 1
    `;
    if (existing.length === 0) {
      throw new Error(
        `duplicate job vanished mid-enqueue (messageId=${messageId})`
      );
    }
    return { jobId: String(existing[0].id), duplicate: true };
  });
}

/** Parse a MessageJob.resultJson into the agent result payload (null-safe). */
export function parseResultJson(
  resultJson: string | null
): JobResultPayload | null {
  if (!resultJson) return null;
  try {
    return JSON.parse(resultJson) as JobResultPayload;
  } catch {
    return null;
  }
}

/** Count of queued jobs, optionally scoped to one restaurant. */
export async function queueDepth(restaurantId?: string): Promise<number> {
  const rows = restaurantId
    ? await rawClient`
        select count(*)::int as depth
        from repli.message_jobs
        where status = 'queued' and restaurant_id = ${restaurantId}
      `
    : await rawClient`
        select count(*)::int as depth
        from repli.message_jobs
        where status = 'queued'
      `;
  return Number(rows[0]?.depth ?? 0);
}

/** Jobs stuck in 'processing' past their lease — a claim never completed. */
export async function stuckCount(): Promise<number> {
  const rows = await rawClient`
    select count(*)::int as stuck
    from repli.message_jobs
    where status = 'processing' and lease_expires_at < now()
  `;
  return Number(rows[0]?.stuck ?? 0);
}