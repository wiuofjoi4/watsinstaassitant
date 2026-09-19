// Self-test for the M1 connection-reliability layer: backoff policy, disconnect
// classification, reconnect tracker/pause gate, and the session notifier.
// PURE in-memory — no network, no WhatsApp socket, no DB.
// Run: npx tsx gateway/src/selftest-conn.ts   (exit 1 on any FAIL)
import { DisconnectReason } from "@whiskeysockets/baileys";
import {
  backoffDelayFor,
  MAX_BACKOFF_MS,
  JITTER_MULTIPLIER,
  shouldRetryAfterDisconnect,
  getReconnectStats,
} from "./conn/backoff";
import {
  isRateLimited,
  isDuplicateMessage,
  noteConnectionFailure,
  noteConnectionSuccess,
  getReconnectGate,
  getReconnectInfo,
  subscribeSession,
  onSessionOpen,
  onSessionClose,
  emitSessionOpen,
  emitSessionClose,
  MAX_CONSECUTIVE_FAILURES,
} from "./conn/state";

// ---------------------------------------------------------------------------
// tiny test harness
// ---------------------------------------------------------------------------
const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, cond: boolean, detail = ""): void {
  results.push({ name, ok: cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function sample(fn: () => number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(fn());
  return out;
}
let uniq = 0;
function uid(): string {
  return `selftest-${Date.now()}-${uniq++}`;
}

// ---------------------------------------------------------------------------
// 1. backoff: grows exponentially, stays in [0, MAX+maxJitter], jitter varies
// ---------------------------------------------------------------------------
const closeBase = 5_000;
const a0 = sample(() => backoffDelayFor("close-retry", 0), 2000);
const a1 = sample(() => backoffDelayFor("close-retry", 1), 2000);
const a2 = sample(() => backoffDelayFor("close-retry", 2), 2000);
const a3 = sample(() => backoffDelayFor("close-retry", 3), 2000);
// window is capped at MAX from attempt 4 onward (5→10→20→40→60→60…)
const capped = sample(() => backoffDelayFor("close-retry", 10), 2000);

check(
  "backoff: delay grows (mean attempt1 > 1.5x attempt0)",
  mean(a1) > mean(a0) * 1.5,
  `${mean(a0).toFixed(0)}ms → ${mean(a1).toFixed(0)}ms`
);
check(
  "backoff: delay grows (mean attempt2 > 1.5x attempt1)",
  mean(a2) > mean(a1) * 1.5,
  `${mean(a1).toFixed(0)}ms → ${mean(a2).toFixed(0)}ms`
);
check(
  "backoff: delay grows (mean attempt3 > 1.5x attempt2)",
  mean(a3) > mean(a2) * 1.5,
  `${mean(a2).toFixed(0)}ms → ${mean(a3).toFixed(0)}ms`
);
check(
  "backoff: attempt0 mean near base window (5s)",
  Math.abs(mean(a0) - closeBase) < closeBase * 0.3,
  `mean=${mean(a0).toFixed(0)}ms base=${closeBase}ms`
);

const maxAllowed = MAX_BACKOFF_MS * (1 + JITTER_MULTIPLIER);
const all = [...a0, ...a1, ...a2, ...a3, ...capped];
check(
  `backoff: every sample within [0, MAX+maxJitter]=[0, ${maxAllowed}]`,
  all.every((v) => v >= 0 && v <= maxAllowed),
  `min=${Math.min(...all)}ms max=${Math.max(...all)}ms`
);
check(
  "backoff: capped sampling respects the 60s window (±50%)",
  Math.max(...capped) <= maxAllowed && Math.min(...capped) >= MAX_BACKOFF_MS * 0.5 - 1,
  `capped range ${Math.min(...capped)}ms..${Math.max(...capped)}ms`
);
check(
  "backoff: jitter varies across calls",
  new Set(a0).size > 100,
  `${new Set(a0).size} distinct of ${a0.length}`
);
check(
  "backoff: hung and startup never wait",
  backoffDelayFor("hung", 9) === 0 && backoffDelayFor("startup", 9) === 0
);
check(
  "backoff: logged-out keeps its own 2s base",
  backoffDelayFor("logged-out", 0) >= 1000 && backoffDelayFor("logged-out", 0) <= 3000,
  backoffDelayFor("logged-out", 0).toString()
);

// ---------------------------------------------------------------------------
// 2. shouldRetryAfterDisconnect: discard vs retry classification
// ---------------------------------------------------------------------------
check(
  "disconnect: loggedOut (401) → discard creds, no retry",
  shouldRetryAfterDisconnect(DisconnectReason.loggedOut) === false
);
check(
  "disconnect: forbidden (403) → discard creds",
  shouldRetryAfterDisconnect(DisconnectReason.forbidden) === false
);
check(
  "disconnect: badSession (500) → discard creds",
  shouldRetryAfterDisconnect(DisconnectReason.badSession) === false
);
check(
  "disconnect: connectionReplaced (440) → retry, creds kept",
  shouldRetryAfterDisconnect(DisconnectReason.connectionReplaced) === true
);
check(
  "disconnect: connectionClosed (428) → retry, creds kept",
  shouldRetryAfterDisconnect(DisconnectReason.connectionClosed) === true
);
check(
  "disconnect: connectionLost/timedOut (408) → retry",
  shouldRetryAfterDisconnect(DisconnectReason.connectionLost) === true
);
check(
  "disconnect: multideviceMismatch (411) → retry",
  shouldRetryAfterDisconnect(DisconnectReason.multideviceMismatch) === true
);
check(
  "disconnect: no code (generic close) → retry",
  shouldRetryAfterDisconnect(undefined) === true &&
    shouldRetryAfterDisconnect(null) === true
);

// ---------------------------------------------------------------------------
// 3. state: rate limit, dedup, reconnect tracker (pause after 10 fails)
// ---------------------------------------------------------------------------
const jid = `${uid()}@s.whatsapp.net`;
let tripped = false;
for (let i = 0; i < 15; i++) {
  if (isRateLimited(jid)) tripped = true;
}
check("state: 15 rapid marks stay under the limit", tripped === false);
check("state: 16th mark in the window is rate-limited", isRateLimited(jid) === true);

const dup = uid();
check("state: duplicate id not seen on first pass", isDuplicateMessage(dup) === false);
check("state: repeat id is deduped", isDuplicateMessage(dup) === true);

const rp = uid();
for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
  noteConnectionFailure(rp, "close-retry", 428);
}
const gate = getReconnectGate(rp);
check(
  `state: tracker pauses after ${MAX_CONSECUTIVE_FAILURES} failures`,
  gate.kind === "paused",
  `failures=${getReconnectInfo(rp).failures}`
);
check(
  "state: failure count is surfaced",
  getReconnectInfo(rp).failures === MAX_CONSECUTIVE_FAILURES
);
check(
  "state: pause is ~5 minutes out",
  gate.kind === "paused" && gate.pausedUntil > Date.now() + 4 * 60_000
);
check(
  "state: stats mirror the consecutive fails",
  getReconnectStats(rp)?.consecutiveFails === MAX_CONSECUTIVE_FAILURES
);

noteConnectionSuccess(rp);
check(
  "state: success resets the gate",
  getReconnectGate(rp).kind === "ok" && getReconnectInfo(rp).failures === 0
);
check(
  "state: success resets the stats",
  getReconnectStats(rp)?.consecutiveFails === 0
);

const rd = uid();
check("state: untouched restaurant gate is ok", getReconnectGate(rd).kind === "ok");
noteConnectionFailure(rd, "close-retry", 408);
check(
  "state: single failure defers, does not pause",
  getReconnectGate(rd).kind === "deferred",
  `failures=${getReconnectInfo(rd).failures}`
);
noteConnectionSuccess(rd);

// ---------------------------------------------------------------------------
// 4. session notifier: open/close events, unsubscribe, swallowed callbacks
// ---------------------------------------------------------------------------
const rn = uid();
const got: string[] = [];
const offOpen = onSessionOpen(rn, (ev) => got.push(`open:${ev.restaurantId}`));
const offClose = onSessionClose(rn, (ev) => got.push(`close:${ev.restaurantId}`));
emitSessionOpen(rn);
emitSessionClose(rn);
check(
  "notifier: open then close delivered in order",
  got.join(",") === `open:${rn},close:${rn}`,
  got.join(",")
);
offOpen();
offClose();
emitSessionOpen(rn);
check("notifier: unsubscribed callbacks are not called again", got.length === 2, `got ${got.length}`);

const rerr = uid();
const boom = subscribeSession(rerr, () => {
  throw new Error("boom");
});
let crashed = false;
try {
  emitSessionOpen(rerr);
} catch {
  crashed = true;
}
check("notifier: a throwing callback is swallowed", crashed === false);
boom();

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------
const fails = results.filter((r) => !r.ok).length;
console.log(
  `\n${results.length - fails}/${results.length} checks passed` +
    (fails > 0 ? ` — ${fails} FAILED` : "")
);
process.exit(fails > 0 ? 1 : 0);