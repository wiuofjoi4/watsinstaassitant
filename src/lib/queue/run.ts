// ---------------------------------------------------------------------------
// M3 claim + execute. runNextJob is called by POST /api/jobs/run: atomically
// claims ONE queued job for a restaurant, runs the frozen engine entry point
// and stores the JobResultPayload. Engine failures become a `failed` job with
// the error text — a job is never left stuck in `processing`.
// ---------------------------------------------------------------------------
import {
  handleIncomingMessage,
  type IncomingMessageInput,
  type RunResult,
} from "@/lib/agent/engine";
import { parseResultJson, queueDepth } from "./client";
import { claimQueuedJob, storeJobError, storeJobResult } from "./rows";
import type { JobResultPayload, MessageJob } from "./types";

export interface RunJobOutcome {
  job: (MessageJob & { result: JobResultPayload | null }) | null;
  queuedCount: number;
}

export function toJobResultPayload(result: RunResult | null): JobResultPayload {
  if (!result) return { replyText: "" };
  const payload: JobResultPayload = {
    replyText: result.replyText ?? "",
    transcription: result.transcription ?? null,
    order: result.order ?? undefined,
    costUsd: result.costUsd ?? 0,
    model: result.model ?? undefined,
  };
  if (result.replyParts && result.replyParts.length > 0) {
    payload.replyParts = result.replyParts;
  }
  if (result.silent === true) payload.silent = true;
  if (result.menuImages && result.menuImages.length > 0) {
    payload.images = result.menuImages.map((i) => ({
      base64: i.base64,
      mime: i.mime,
    }));
  }
  return payload;
}

async function safeQueueDepth(restaurantId: string): Promise<number> {
  try {
    return await queueDepth(restaurantId);
  } catch {
    return 0;
  }
}

export async function runNextJob(
  restaurantId: string,
  jobId?: string
): Promise<RunJobOutcome> {
  const claimed = await claimQueuedJob(restaurantId, 45, jobId);
  if (!claimed) {
    return { job: null, queuedCount: await safeQueueDepth(restaurantId) };
  }
  const leaseToken = claimed.leaseToken ?? "";
  try {
    const input = (claimed.payload ?? {}) as unknown as IncomingMessageInput;
    const result = await handleIncomingMessage(input);
    const updated =
      (await storeJobResult(
        claimed.id,
        leaseToken,
        JSON.stringify(toJobResultPayload(result))
      )) ?? claimed;
    return {
      job: { ...updated, result: parseResultJson(updated.resultJson) },
      queuedCount: await safeQueueDepth(restaurantId),
    };
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    console.error(
      `[JOBS/RUN] restaurant=${restaurantId} job=${claimed.id} error=${error}`
    );
    const updated = (await storeJobError(claimed.id, leaseToken, error)) ?? claimed;
    return {
      job: { ...updated, result: parseResultJson(updated.resultJson) },
      queuedCount: await safeQueueDepth(restaurantId),
    };
  }
}