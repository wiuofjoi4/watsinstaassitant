// ---------------------------------------------------------------------------
// M3 job queue — frozen types. The whole system (M2 webhooks, M8 delivery,
// M9 monitoring) imports these; do not change without the Combiner.
// ---------------------------------------------------------------------------

export type JobStatus =
  | "queued"
  | "processing"
  | "ready"
  | "sending"
  | "sent"
  | "failed"
  | "expired";

export interface MessageJob {
  id: string;
  restaurantId: string;
  channel: "whatsapp";
  remoteJid: string;
  messageId: string | null;
  /** IncomingMessageInput (frozen engine shape) as plain JSON. */
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  nextAttemptAt: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  resultJson: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

export interface JobResultPayload {
  replyText: string;
  replyParts?: string[];
  silent?: boolean;
  images?: Array<{ base64: string; mime: string }>;
  transcription?: string | null;
  order?: unknown;
  costUsd?: number;
  model?: string;
}

export interface EnqueueResult {
  jobId: string;
  duplicate: boolean;
}

export interface ClaimResult {
  job: MessageJob | null;
}