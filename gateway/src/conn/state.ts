import type { WASocket } from "@whiskeysockets/baileys";
import { PgAuthState } from "../auth";
import { logger } from "../logger";
import {
  backoffDelayFor,
  noteReconnectFailure,
  noteReconnectSuccess,
  type ReconnectReason,
} from "./backoff";

export interface Session {
  socket: WASocket;
  restaurantId: string;
  auth: PgAuthState;
  qr: string | null;
  connected: boolean;
  lastJid: string | null;
  startedAt: number;
  connectionState?: string;
  lastError?: string;
  qrOnce?: boolean;
  /** Presence heartbeat timer — keeps the WhatsApp socket alive server-side so
   * the device line is not silently dropped (error 408 / forced re-pair). */
  heartbeat?: NodeJS.Timeout;
}

/** Stored live sessions, keyed by restaurantId. Single instance today (Render);
 * the sync loop + reconnects all go through here. */
export const sessions = new Map<string, Session>();

export interface RecentEvent {
  at: string;
  connection?: string;
  errorCode?: number;
  error?: string;
}
export const recent = new Map<string, RecentEvent>();

export function recordClose(
  restaurantId: string,
  connection: string | undefined,
  lastDisconnect?: unknown
): void {
  const errObj = lastDisconnect as { error?: { output?: { statusCode?: number }; message?: string; stack?: string }; message?: string } | null;
  const code = errObj?.error?.output?.statusCode;
  const errText =
    errObj?.error?.message ??
    errObj?.error?.stack?.split("\n")[0] ??
    errObj?.message ??
    (errObj?.error ? JSON.stringify(errObj.error).slice(0, 400) : null);
  recent.set(restaurantId, {
    at: new Date().toISOString(),
    connection,
    errorCode: code,
    error: errText ?? undefined,
  });
}

/** Live snapshot of every session for the health endpoint and monitoring. */
export function getSessionsSnapshot(): Array<{
  restaurantId: string;
  connection: string;
  hasQr: boolean;
  qrOnce: boolean;
  connected: boolean;
  ageSeconds: number;
  lastError: string | null;
}> {
  return [...sessions.values()].map((s) => ({
    restaurantId: s.restaurantId,
    connection: s.connectionState ?? "pending",
    hasQr: !!s.qr,
    qrOnce: !!s.qrOnce,
    connected: s.connected,
    ageSeconds: Math.round((Date.now() - s.startedAt) / 1000),
    lastError: s.lastError ?? null,
  }));
}

export function getRecentEvents(): Array<{
  restaurantId: string;
  at: string;
  connection: string | null;
  errorCode: number | null;
  error: string | null;
}> {
  return [...recent.entries()].map(([restaurantId, ev]) => ({
    restaurantId,
    at: ev.at,
    connection: ev.connection ?? null,
    errorCode: ev.errorCode ?? null,
    error: ev.error ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Rate limiter — per remoteJid, sliding window
// ---------------------------------------------------------------------------
const RATE_LIMIT_MAX = 15; // messages per window
const RATE_LIMIT_WINDOW_MS = 60_000; // 60 seconds
const rateLimitBuckets = new Map<string, number[]>();

export function isRateLimited(remoteJid: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  let timestamps = rateLimitBuckets.get(remoteJid);
  if (!timestamps) {
    timestamps = [];
    rateLimitBuckets.set(remoteJid, timestamps);
  }
  // Drop timestamps outside the window
  while (timestamps.length > 0 && timestamps[0] <= windowStart) {
    timestamps.shift();
  }
  if (timestamps.length >= RATE_LIMIT_MAX) {
    return true;
  }
  timestamps.push(now);
  return false;
}

// Periodic cleanup: every 2 minutes drop buckets with no recent activity.
// Prevents unbounded memory growth when many customers message once and leave.
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
  for (const [jid, ts] of rateLimitBuckets) {
    if (ts.length === 0 || ts[ts.length - 1] < cutoff) {
      rateLimitBuckets.delete(jid);
    }
  }
}, 120_000);

// ---------------------------------------------------------------------------
// Message deduplication — in-memory, per message.key.id
// WhatsApp sometimes re-delivers the same message event. This prevents
// double-processing (double AI call, double reply).
// Safe in single-instance gateway (Render). Would need a shared store
// (DB table or Redis) if the gateway ever runs multi-instance.
// ---------------------------------------------------------------------------
const DEDUP_TTL_MS = 15 * 60_000; // keep seen IDs for 15 minutes
const seenMessageIds = new Map<string, number>(); // key.id → timestamp

export function isDuplicateMessage(keyId: string): boolean {
  const now = Date.now();
  const prev = seenMessageIds.get(keyId);
  if (prev !== undefined && now - prev < DEDUP_TTL_MS) {
    return true; // already processed recently
  }
  seenMessageIds.set(keyId, now);
  return false;
}

// Merge cleanup with the rate-limiter interval (runs every 2 minutes).
// Entries older than DEDUP_TTL_MS are dropped. Overwritten below so both
// maps are cleaned in the same timer tick.
setInterval(() => {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  for (const [id, ts] of seenMessageIds) {
    if (ts < cutoff) seenMessageIds.delete(id);
  }
}, 120_000);

/** Debug/scrape accessor so diagnostics never reach into the module internals. */
export function getSeenMessageCount(): number {
  return seenMessageIds.size;
}

export function logGatewayState(stage: string): void {
  logger.info(
    `[GATEWAY] ${stage} sessions=${sessions.size} ` +
      `connected=${[...sessions.values()].filter((s) => s.connected).length}`
  );
}

// ---------------------------------------------------------------------------
// Reconnect gate — per-restaurant attempt tracking. `noteConnectionFailure`
// records the failure (sharing counters with conn/backoff's stats), computes
// the next allowed attempt time from the backoff policy, and pauses the
// restaurant outright (5 minutes) once it hits MAX_CONSECUTIVE_FAILURES so a
// dead device never hot-spins the socket layer. `startSession` (index.ts)
// consults `getReconnectGate` before creating a socket; success clears the
// tracker entirely.
// ---------------------------------------------------------------------------
export const MAX_CONSECUTIVE_FAILURES = 10;
export const PAUSE_ON_MAX_FAILURES_MS = 5 * 60_000; // 5 minutes

export interface ReconnectTrackerInfo {
  failures: number;
  nextAttemptAt: number; // epoch ms — earliest time a new attempt may start
  pausedUntil: number; // epoch ms — 0 when not paused
}

const reconnectTrackers = new Map<
  string,
  ReconnectTrackerInfo & { pauseWarned: boolean }
>();

export function noteConnectionFailure(
  restaurantId: string,
  reason: ReconnectReason,
  code: number | null
): void {
  const stat = noteReconnectFailure(restaurantId, reason, code);
  const prev = reconnectTrackers.get(restaurantId);
  const t: ReconnectTrackerInfo & { pauseWarned: boolean } = {
    failures: stat.consecutiveFails,
    nextAttemptAt: Date.now() + backoffDelayFor(reason, stat.consecutiveFails - 1),
    pausedUntil: prev?.pausedUntil ?? 0,
    pauseWarned: prev?.pauseWarned ?? false,
  };
  if (stat.consecutiveFails >= MAX_CONSECUTIVE_FAILURES) {
    t.pausedUntil = Date.now() + PAUSE_ON_MAX_FAILURES_MS;
    t.pauseWarned = false;
    logger.error(
      `[RECONNECT] ${restaurantId} reached ${MAX_CONSECUTIVE_FAILURES} consecutive ` +
        `failures (reason=${reason}, code=${code ?? "n/a"}) — pausing auto-reconnect ` +
        `for ${PAUSE_ON_MAX_FAILURES_MS / 60_000} minutes to stop hot-spinning. ` +
        "The platform health/monitoring should surface this; a sync restart after " +
        "the pause resumes the session."
    );
  }
  reconnectTrackers.set(restaurantId, t);
}

/** Resets the failure count/gate on a successful connection. */
export function noteConnectionSuccess(restaurantId: string): void {
  noteReconnectSuccess(restaurantId);
  reconnectTrackers.delete(restaurantId);
}

export type ReconnectGate =
  | { kind: "ok" }
  | { kind: "deferred"; until: number }
  | { kind: "paused"; pausedUntil: number };

export function getReconnectGate(restaurantId: string): ReconnectGate {
  const t = reconnectTrackers.get(restaurantId);
  if (!t) return { kind: "ok" };
  const now = Date.now();
  if (t.pausedUntil > now) return { kind: "paused", pausedUntil: t.pausedUntil };
  if (t.nextAttemptAt > now) return { kind: "deferred", until: t.nextAttemptAt };
  return { kind: "ok" };
}

/** True only on the FIRST query while paused, so callers can log once. */
export function consumePauseWarning(restaurantId: string): boolean {
  const t = reconnectTrackers.get(restaurantId);
  if (!t || t.pausedUntil <= Date.now() || t.pauseWarned) return false;
  t.pauseWarned = true;
  return true;
}

export function getReconnectInfo(restaurantId: string): ReconnectTrackerInfo {
  const t = reconnectTrackers.get(restaurantId);
  return {
    failures: t?.failures ?? 0,
    nextAttemptAt: t?.nextAttemptAt ?? 0,
    pausedUntil: t?.pausedUntil ?? 0,
  };
}

/** Read-only snapshot for the health endpoint / monitoring. */
export function getReconnectSnapshot(): Array<
  ReconnectTrackerInfo & { restaurantId: string }
> {
  return [...reconnectTrackers.entries()].map(([restaurantId, t]) => ({
    restaurantId,
    failures: t.failures,
    nextAttemptAt: t.nextAttemptAt,
    pausedUntil: t.pausedUntil,
  }));
}

// ---------------------------------------------------------------------------
// Session open/close notifier — a tiny synchronous in-memory Pub/Sub (map of
// restaurantId → set of callbacks). M8 subscribes to resume its outbox after a
// reconnect; M9 may hook alerting here. Per-callback errors are swallowed so a
// broken listener can never crash the socket path.
// ---------------------------------------------------------------------------
export interface SessionEvent {
  restaurantId: string;
  event: "open" | "close";
}
export type SessionEventCallback = (ev: SessionEvent) => void;

const sessionListeners = new Map<string, Set<SessionEventCallback>>();

export function subscribeSession(
  restaurantId: string,
  cb: SessionEventCallback
): () => void {
  let set = sessionListeners.get(restaurantId);
  if (!set) {
    set = new Set();
    sessionListeners.set(restaurantId, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
    if (set?.size === 0) sessionListeners.delete(restaurantId);
  };
}

export function onSessionOpen(
  restaurantId: string,
  cb: SessionEventCallback
): () => void {
  return subscribeSession(restaurantId, (ev) => {
    if (ev.event === "open") cb(ev);
  });
}

export function onSessionClose(
  restaurantId: string,
  cb: SessionEventCallback
): () => void {
  return subscribeSession(restaurantId, (ev) => {
    if (ev.event === "close") cb(ev);
  });
}

function emitSessionEvent(restaurantId: string, event: "open" | "close"): void {
  const set = sessionListeners.get(restaurantId);
  if (!set) return;
  for (const cb of [...set]) {
    try {
      cb({ restaurantId, event });
    } catch (err) {
      logger.warn(
        `session event callback threw for ${restaurantId}/${event}: ${String(err)}`
      );
    }
  }
}

export function emitSessionOpen(restaurantId: string): void {
  emitSessionEvent(restaurantId, "open");
}

export function emitSessionClose(restaurantId: string): void {
  emitSessionEvent(restaurantId, "close");
}