// Per-restaurant reconnect/retry delay policy — exponential backoff with
// multiplicative jitter (Phase-2 upgrade of the fixed-delay extraction).
//
// Delay for a `reason` and an `attempt` (0-based consecutive failure count):
//
//   window = min(MAX_BACKOFF_MS, BASE * 2^attempt)
//   delay  = window * random(0.5, 1.5)
//
// Algorithm choice, documented: multiplicative ("equal-style") jitter around
// the doubling window rather than pure full-jitter (random 0..window). The
// ±50% band keeps every retry meaningfully delayed (no 0ms thundering herd
// while a network is flapping) while still spreading retry times enough that
// a fleet of restaurants does not reconnect in lockstep. The widest single
// delay is MAX_BACKOFF_MS * 1.5 (90s for the 60s cap).
//
// Contract for the connection layer: every path that must re-establish a
// session after a failure calls `backoffDelayFor(reason, attempt)` (or relies
// on conn/state to pick the delay and gate `startSession`), and classifies the
// disconnect with `shouldRetryAfterDisconnect` BEFORE deciding whether stored
// creds survive a close.

export type ReconnectReason =
  | "close-retry" // socket closed with a retryable disconnect reason
  | "logged-out" // device was unlinked → discard creds, re-pair fresh
  | "socket-throw" // makeWASocket threw while constructing
  | "hung" // watchdog killed a hung socket (no open/no qr for 10+ min)
  | "startup"; // initial session start

/** Base delay per reconnect reason (the fixed policy this module upgrades). */
const BASE_DELAYS_MS: Record<ReconnectReason, number> = {
  "close-retry": 5_000,
  "logged-out": 2_000,
  "socket-throw": 10_000,
  hung: 0,
  startup: 0,
};

/** Hard cap on the doubling window (jitter may push a delay up to 1.5x). */
export const MAX_BACKOFF_MS = 60_000;

/** Jitter band around a window: multiply by a factor in [1-J, 1+J]. */
export const JITTER_MULTIPLIER = 0.5;

export function backoffDelayFor(reason: ReconnectReason, attempt = 0): number {
  const base = BASE_DELAYS_MS[reason];
  if (base === 0) return 0; // hung / startup never wait
  const window = Math.min(
    base * Math.pow(2, Math.max(0, attempt)),
    MAX_BACKOFF_MS
  );
  // [0.5, 1.5): 1 - J + rand() * 2J  ==  0.5 + rand()
  const factor = 1 - JITTER_MULTIPLIER + Math.random() * (2 * JITTER_MULTIPLIER);
  return Math.round(window * factor);
}

/**
 * Classifies a Baileys disconnect code. Returns `true` when the connection is
 * retryable WITHOUT touching stored creds; `false` means the pairing itself is
 * dead and the owner must re-pair (discard creds + fresh QR).
 *
 *   loggedOut (401), forbidden (403), badSession (500) → false (discard)
 *   everything else, incl. connectionReplaced (440), connectionClosed (428),
 *   connectionLost / timedOut (408), multideviceMismatch (411) → true (retry)
 *
 * `null`/`undefined` (no status code) is a generic network close → retryable.
 */
export function shouldRetryAfterDisconnect(
  code: number | null | undefined
): boolean {
  if (code === null || code === undefined) return true;
  return !(
    code === 401 || // DisconnectReason.loggedOut
    code === 403 || // DisconnectReason.forbidden
    code === 500 // DisconnectReason.badSession
  );
}

// ---------------------------------------------------------------------------
// Reconnect stats — in-memory only, per restaurant, for diagnostics/monitoring
// (`getReconnectStats`, surfaced through the health snapshot). Not a backfill
// for conn/state's functional pause gate: conn/state drives these counters
// through noteReconnectFailure/noteReconnectSuccess below so stats and gating
// can never drift apart. Nothing here is persisted; a restart loses it.
// ---------------------------------------------------------------------------
export interface ReconnectStat {
  consecutiveFails: number;
  lastReason: ReconnectReason | null;
  lastCode: number | null;
}

const reconnectStats = new Map<string, ReconnectStat>();

export function noteReconnectFailure(
  restaurantId: string,
  reason: ReconnectReason,
  code: number | null
): ReconnectStat {
  const cur = reconnectStats.get(restaurantId) ?? {
    consecutiveFails: 0,
    lastReason: null,
    lastCode: null,
  };
  const next: ReconnectStat = {
    consecutiveFails: cur.consecutiveFails + 1,
    lastReason: reason,
    lastCode: code,
  };
  reconnectStats.set(restaurantId, next);
  return next;
}

export function noteReconnectSuccess(restaurantId: string): ReconnectStat {
  const next: ReconnectStat = {
    consecutiveFails: 0,
    lastReason: null,
    lastCode: null,
  };
  reconnectStats.set(restaurantId, next);
  return next;
}

export function getReconnectStats(
  restaurantId: string
): ReconnectStat | undefined {
  return reconnectStats.get(restaurantId);
}