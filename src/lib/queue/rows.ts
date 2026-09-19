// ---------------------------------------------------------------------------
// M3 job queue DB layer: snake_case <-> MessageJob mapping plus the claim /
// complete / ack SQL. Uses rawClient (postgres-js) only — this table has no
// drizzle model. Complete writes guard on the lease token so a stale caller
// can never clobber a job that a newer run re-claimed.
// ---------------------------------------------------------------------------
import type { JobStatus, MessageJob } from "./types";
import { rawClient } from "@/lib/db";

function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return new Date(String(v)).toISOString();
}

function normalizeResultJson(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** Shared snake_case -> camelCase mapper (single source of truth). */
export function messageJobFromRow(row: Record<string, unknown>): MessageJob {
  return {
    id: String(row.id),
    restaurantId: String(row.restaurant_id),
    channel: "whatsapp",
    remoteJid: String(row.remote_jid),
    messageId: row.message_id == null ? null : String(row.message_id),
    payload:
      row.payload != null && typeof row.payload === "object"
        ? (row.payload as Record<string, unknown>)
        : {},
    status: row.status as JobStatus,
    attempts: Number(row.attempts) || 0,
    nextAttemptAt: toIso(row.next_attempt_at),
    leaseToken: row.lease_token == null ? null : String(row.lease_token),
    leaseExpiresAt: toIso(row.lease_expires_at),
    resultJson: normalizeResultJson(row.result),
    error: row.error == null ? null : String(row.error),
    createdAt: toIso(row.created_at) ?? "",
    updatedAt: toIso(row.updated_at) ?? "",
    deliveredAt: toIso(row.delivered_at),
  };
}

/**
 * Atomic claim of ONE queued job for a restaurant (FOR UPDATE SKIP LOCKED +
 * 45s lease). When `jobId` is given, claims THAT specific queued job (used by
 * the gateway to run the exact job it just enqueued); otherwise claims the
 * oldest claimable job. Returns null when nothing is claimable. Status is set
 * to 'processing' here; lease_expires_at guards against stuck leases.
 */
export async function claimQueuedJob(
  restaurantId: string,
  leaseSeconds = 45,
  jobId?: string
): Promise<MessageJob | null> {
  const rows = await rawClient`
    update repli.message_jobs
    set
      status = 'processing',
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
      updated_at = now()
    where id = (
      select id from repli.message_jobs
      where restaurant_id = ${restaurantId}
        and status = 'queued'
        and (next_attempt_at is null or next_attempt_at <= now())
        ${jobId ? rawClient`and id = ${jobId}` : rawClient``}
      order by created_at
      limit 1
      for update skip locked
    )
    returning *
  `;
  return rows.length > 0 ? messageJobFromRow(rows[0]) : null;
}

export const claimRestaurantJob = claimQueuedJob;

/** Complete a claimed job as successful: status -> ready, +1 attempt. */
export async function storeJobResult(
  jobId: string,
  leaseToken: string,
  resultJson: string
): Promise<MessageJob | null> {
  const rows = await rawClient`
    update repli.message_jobs
    set
      status = 'ready',
      result = ${resultJson}::jsonb,
      error = null,
      attempts = attempts + 1,
      updated_at = now()
    where id = ${jobId} and lease_token = ${leaseToken}
    returning *
  `;
  return rows.length > 0 ? messageJobFromRow(rows[0]) : null;
}

/** Complete a claimed job as failed: status -> failed, error stored (<2000). */
export async function storeJobError(
  jobId: string,
  leaseToken: string,
  error: string
): Promise<MessageJob | null> {
  const rows = await rawClient`
    update repli.message_jobs
    set
      status = 'failed',
      error = ${error.slice(0, 2000)},
      updated_at = now()
    where id = ${jobId} and lease_token = ${leaseToken}
    returning *
  `;
  return rows.length > 0 ? messageJobFromRow(rows[0]) : null;
}

/**
 * Ack a deliverable job. Mutates ONLY when the job is 'ready'/'sending':
 * delivered -> 'sent' (+ delivered_at, error cleared), expired -> 'expired'.
 * Returns false (no mutation) for any other status or unknown id.
 */
export async function acknowledgeJob(
  jobId: string,
  mode: "delivered" | "expired"
): Promise<boolean> {
  const rows =
    mode === "delivered"
      ? await rawClient`
          update repli.message_jobs
          set status = 'sent', delivered_at = now(), error = null, updated_at = now()
          where id = ${jobId} and status in ('ready', 'sending')
          returning id
        `
      : await rawClient`
          update repli.message_jobs
          set status = 'expired', updated_at = now()
          where id = ${jobId} and status in ('ready', 'sending')
          returning id
        `;
  return rows.length > 0;
}