import express from "express";
import {
  Browsers,
  makeWASocket,
  type WASocket,
} from "@whiskeysockets/baileys";
import postgres from "postgres";
import qrcode from "qrcode";
import { PgAuthState } from "./auth";
import { logger } from "./logger";
import { handleMessage } from "./parse";
import { deliver, sendFallback } from "./deliver";
import { FallbackReplies } from "./deliver";
import { createHealthHandler } from "./routes/health";
import { startOutboxLoop, cancelOutboxLoop } from "./queueClient";
import {
  isDuplicateMessage,
  isRateLimited,
  recordClose,
  sessions,
  noteConnectionFailure,
  noteConnectionSuccess,
  getReconnectGate,
  consumePauseWarning,
  emitSessionOpen,
  emitSessionClose,
  type Session,
} from "./conn/state";
import {
  shouldRetryAfterDisconnect,
  getReconnectStats,
  type ReconnectReason,
} from "./conn/backoff";

const PORT = Number(process.env.PORT ?? 4000);
const PLATFORM_URL = process.env.PLATFORM_URL ?? "http://localhost:3000";
const GATEWAY_SECRET = process.env.GATEWAY_SECRET ?? "dev-secret";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? 15000);

// ---------------------------------------------------------------------------
// Env guard — fail loud at boot in production when critical config is missing
// or still a placeholder. The platform side now REJECTS calls without a real
// GATEWAY_SECRET, so running without one silently kills every webhook call;
// better to refuse to start than to look like it works.
// ---------------------------------------------------------------------------
function isPlaceholder(v: string): boolean {
  const t = v.trim();
  if (t === "") return true;
  return (
    /^(https?:\/\/)?(localhost|0\.0\.0\.0|127\.0\.0\.1)$/i.test(t) ||
    /change[_-]?me|changeme|your[-_]?\w+|xxx+|y{3,}|^\*+$|^=+$|^<.*>$|^dev-secret$/i.test(
      t
    )
  );
}
if (process.env.NODE_ENV === "production") {
  const missing: string[] = [];
  if (isPlaceholder(GATEWAY_SECRET)) missing.push("GATEWAY_SECRET");
  if (!DATABASE_URL) missing.push("DATABASE_URL");
  if (isPlaceholder(PLATFORM_URL) || PLATFORM_URL === "http://localhost:3000") {
    missing.push("PLATFORM_URL");
  }
  if (missing.length > 0) {
    logger.error(
      { missing },
      "FATAL: missing/placeholder env in production — refusing to start. " +
        "Set GATEWAY_SECRET, DATABASE_URL and PLATFORM_URL to real values."
    );
    process.exit(1);
  }
  logger.info({ platform: PLATFORM_URL }, "env check OK");
}

const sql = DATABASE_URL
  ? postgres(DATABASE_URL, {
      ssl: process.env.NODE_ENV === "production" ? "require" : "prefer",
      max: 4,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
    })
  : null;

function headers(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-gateway-secret": GATEWAY_SECRET,
  };
}

async function syncFromPlatform(): Promise<
  | {
      restaurants: Array<{
        id: string;
        name: string;
        agentEnabled: boolean;
        whatsappStatus: string;
        whatsappLinked: boolean;
        whatsappJid: string | null;
        instagramStatus: string;
      }>;
    }
  | undefined
> {
  try {
    const res = await fetch(`${PLATFORM_URL}/api/sync`, { headers: headers() });
    if (!res.ok) return undefined;
    return (await res.json()) as Awaited<ReturnType<typeof syncFromPlatform>>;
  } catch (err) {
    logger.error(`sync failed: ${String(err)}`);
    return undefined;
  }
}

async function postStatus(
  restaurantId: string,
  event: "qr_ready" | "connected" | "disconnected",
  jid?: string | null
): Promise<void> {
  try {
    await fetch(`${PLATFORM_URL}/api/webhooks/status`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ restaurantId, channel: "whatsapp", event, jid }),
    });
  } catch (err) {
    logger.error(`status post failed: ${String(err)}`);
  }
}

function ensureSession(restaurantId: string): void {
  const existing = sessions.get(restaurantId);
  if (!existing) {
    void startSession(restaurantId);
    return;
  }

  // NEVER tear down an existing session from here. This is the root cause of the
  // recurring "Scan → no reply" + "Stream Errored (conflict)" cycles and the
  // "drops every few hours": the old guard killed any session older than 90s
  // that wasn't connected and had no QR. But the exact moment a freshly scanned
  // QR transitions the socket to "connecting" (qr null, not yet open), the loop
  // discarded the stored creds and killed the socket — destroying the pairing
  // mid-handshake → WhatsApp drops it with 440 conflict, and the owner is forced
  // to re-scan. Long-up reconnects had the same fate.
  //
  // Recovery is the job of the socket's own connection.update ("close" → retry;
  // "loggedOut" → discard + fresh QR) and of makeWASocket's catch → retry.
  // Safety net below covers the only case those can't: a hung socket that never
  // fired a close event (no open, no qr ever, up for 10+ min). It restarts the
  // socket but KEEPS stored creds — a real pairing handshake finishes in
  // seconds, so this can never hit a live pairing.
  const hungLongWithoutPairing =
    !existing.connected &&
    !existing.qrOnce &&
    Date.now() - existing.startedAt > 10 * 60_000;
  if (!hungLongWithoutPairing) return;

  logger.warn(`restarting hung socket for ${restaurantId} (no open/no qr for 10m)`);
  try {
    existing.socket.end(undefined);
  } catch {}
  sessions.delete(restaurantId);
  void startSession(restaurantId);
}

// A per-restaurant mutex: startSession can be triggered from several places
// (ensureSession's loop, the close handler's retry, the makeWASocket catch)
// and concurrent calls create TWO sockets for the same WhatsApp device — the
// second one gets the stream killed with "errored (conflict)" and can take the
// whole line down. Only one creation attempt may be in flight at a time.
const starting = new Set<string>();

// Pending reconnect timers (one per restaurant). startSession defers itself
// when conn/state says the restaurant is still in backoff; this map dedupes so
// the 15s sync loop and the close handler can't stack duplicate restarts.
const restartTimers = new Map<string, NodeJS.Timeout>();

async function startSession(restaurantId: string): Promise<void> {
  // GATE: honor the reconnect tracker before creating a socket. A restaurant
  // paused after MAX_CONSECUTIVE_FAILURES is held until pausedUntil passes
  // (logged once, never silently dropped); a deferred one is re-scheduled for
  // its backoff time and never started early.
  const gate = getReconnectGate(restaurantId);
  if (gate.kind === "paused") {
    if (consumePauseWarning(restaurantId)) {
      logger.error(
        `[RECONNECT] ${restaurantId} is paused until ` +
          `${new Date(gate.pausedUntil).toISOString()} (` +
          `${getReconnectStats(restaurantId)?.consecutiveFails ?? "?"} consecutive ` +
          "failures) — auto-reconnect held. It resumes when the pause expires."
      );
    }
    return;
  }
  if (gate.kind === "deferred") {
    const existing = restartTimers.get(restaurantId);
    if (existing) return; // already scheduled — sync loop and close can race
    const wait = Math.max(0, gate.until - Date.now());
    const t = setTimeout(() => {
      if (restartTimers.get(restaurantId) === t) restartTimers.delete(restaurantId);
      void startSession(restaurantId);
    }, wait);
    restartTimers.set(restaurantId, t);
    return;
  }
  if (starting.has(restaurantId)) return;
  starting.add(restaurantId);
  try {
    await startSessionInner(restaurantId);
  } finally {
    starting.delete(restaurantId);
  }
}

async function startSessionInner(restaurantId: string): Promise<void> {
  logger.info(`starting session for ${restaurantId}`);
  const auth = new PgAuthState(restaurantId, sql);
  await auth.ready;

  let socket: WASocket;
  try {
    socket = makeWASocket({
      logger,
      auth: auth.state,
      browser: Browsers.ubuntu("Chrome"),
      syncFullHistory: false,
      // Keep the device line flagged ONLINE on WhatsApp's servers the moment the
      // socket opens — an apparently-dormant device is exactly what triggers
      // server-side session invalidation and a forced QR re-pair.
      markOnlineOnConnect: true,
    });
  } catch (err) {
    logger.error(`makeWASocket threw for ${restaurantId}: ${String(err)}`);
    // Route through the reconnect tracker so socket-throw obeys the backoff
    // policy (base 10s, growing) and honors a pause. Not a hardcoded 10s.
    noteConnectionFailure(restaurantId, "socket-throw", null);
    void startSession(restaurantId);
    return;
  }

  const session: Session = {
    socket,
    restaurantId,
    auth,
    qr: null,
    connected: false,
    lastJid: null,
    startedAt: Date.now(),
  };
  sessions.set(restaurantId, session);

  socket.ev.on("creds.update", auth.saveCreds);

  socket.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    session.connectionState = connection ?? session.connectionState;
    if (lastDisconnect?.error) {
      session.lastError = `${String(lastDisconnect.error)}`;
    }
    if (qr) {
      session.qr = qr;
      session.qrOnce = true;
      if (session.lastJid) {
        // This is a RE-PAIR, not a first pairing: the WhatsApp session was
        // previously connected and is being forced to re-authenticate. Loud log
        // so the owner's Telegram alert (platform status route) has context.
        logger.warn(
          `re-pair required for ${restaurantId} (was connected as ${session.lastJid}) — QR presented`
        );
      }
      void postStatus(restaurantId, "qr_ready");
    }
    if (connection === "open") {
      // A successfully connected socket means the failure streak is over —
      // clear any pending restart and reset the reconnect tracker.
      const pendingRestart = restartTimers.get(restaurantId);
      if (pendingRestart) {
        clearTimeout(pendingRestart);
        restartTimers.delete(restaurantId);
      }
      noteConnectionSuccess(restaurantId);
      session.connected = true;
      session.qr = null;
      const jid = socket.user?.id ?? null;
      session.lastJid = jid;
      // Keep the device line alive server-side. WhatsApp drops sockets that stay
      // idle too long (408 → forced re-pair needs a fresh QR scan). A gentle
      // "available" presence every 2 minutes prevents that while the socket
      // stays healthy. Clear any stale timer from a previous connect first.
      if (session.heartbeat) clearInterval(session.heartbeat);
      session.heartbeat = setInterval(() => {
        try {
          void session.socket.sendPresenceUpdate("available").catch(() => {});
        } catch {}
      }, 120_000);
      session.heartbeat.unref?.();
      void postStatus(restaurantId, "connected", jid);
      emitSessionOpen(restaurantId);
    }
    if (connection === "close") {
      session.connected = false;
      if (session.heartbeat) {
        clearInterval(session.heartbeat);
        session.heartbeat = undefined;
      }
      recordClose(restaurantId, connection, lastDisconnect);
      sessions.delete(restaurantId);
      void session.socket.end(undefined);
      emitSessionClose(restaurantId);

      // Classify the disconnect BEFORE deciding whether stored creds survive.
      // A logged-out / bad-session code means the pairing itself is dead →
      // discard creds and present a fresh QR. Everything else (conflict or
      // replaced 440, connection closed 428, lost/timed-out 408, ...) is a
      // transport blip → reconnect quietly with creds preserved.
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
        ?.output?.statusCode;
      const shouldRetry = shouldRetryAfterDisconnect(code);
      const reason: ReconnectReason = shouldRetry ? "close-retry" : "logged-out";
      // Records the failure and computes nextAttemptAt from the backoff policy
      // (or pauses the restaurant after 10 consecutive failures). startSession
      // below honors that gate.
      noteConnectionFailure(restaurantId, reason, code ?? null);

      if (!shouldRetry) {
        // True unlink / invalid session: drop stored creds so a fresh QR is
        // generated for re-pairing, and tell the platform the line is down.
        void postStatus(restaurantId, "disconnected");
        try {
          void session.auth
            .discard()
            .catch(() => undefined)
            .then(() => void startSession(restaurantId));
        } catch {
          void startSession(restaurantId);
        }
      } else {
        // Retryable: reconnect on the tracker's nextAttemptAt (startSession
        // gates itself). No "disconnected" post — the account is still paired
        // and this is a self-healing blip, not an unlink.
        void startSession(restaurantId);
      }
    }
  });

  socket.ev.on("messages.upsert", async ({ messages: upserts, type }) => {
    if (type !== "notify") return;
    // Per-message isolation: one failed message must not abort delivery of the
    // rest of the batch (a throw here would silently skip every later message).
    for (const m of upserts) {
      if (m.key.fromMe) continue;
      const remoteJid = m.key.remoteJid;
      if (!remoteJid) continue;

      // Rate limit: reject messages beyond the per-customer cap BEFORE any
      // processing or API calls. The customer gets a friendly nudge to slow
      // down instead of silence or an error.
      if (isRateLimited(remoteJid)) {
        logger.warn(`rate limited ${restaurantId}/${remoteJid}`);
        await sendFallback(
          restaurantId,
          remoteJid,
          FallbackReplies.rateLimit
        );
        continue;
      }

      // Dedup: WhatsApp sometimes re-delivers the same message event.
      // Skip silently — the customer already received a reply the first time.
      const msgId = m.key.id;
      if (msgId && isDuplicateMessage(msgId)) {
        logger.info(`dedup skip ${restaurantId}/${remoteJid} msg=${msgId}`);
        continue;
      }

      try {
        const content = await handleMessage(session, m);
        if (content) {
          // M1↔M8 contract: deliver(restaurantId, remoteJid, parsed, messageId?)
          // — m.key.id is the idempotency key the platform queue dedups on.
          await deliver(restaurantId, remoteJid, content, msgId ?? undefined);
        }
      } catch (err) {
        logger.error(
          `messages.upsert handler threw for ${restaurantId}/${remoteJid}: ${String(err)}`
        );
        // Guarantee the customer still hears something even on an unexpected
        // exception in parsing/delivery for this message.
        await sendFallback(restaurantId, remoteJid, FallbackReplies.generic);
      }
    }
  });
}

// --- HTTP server: QR endpoint + health ---
const app = express();
app.use(express.json());

app.get("/health", createHealthHandler({ getSql: () => sql }));

app.get("/qr/:restaurantId/whatsapp", async (req, res) => {
  const session = sessions.get(req.params.restaurantId);
  if (!session || !session.qr) {
    res.status(404).json({ error: "QR not ready" });
    return;
  }
  res.setHeader("cache-control", "no-store");
  try {
    let dataUri: string = session.qr;
    if (!dataUri.startsWith("data:")) {
      dataUri = await qrcode.toDataURL(dataUri);
    }
    const base64 = dataUri.replace(/^data:image\/png;base64,/, "");
    const buf = Buffer.from(base64, "base64");
    res.setHeader("content-type", "image/png");
    res.send(buf);
  } catch (err) {
    logger.error(`qr render failed: ${String(err)}`);
    res.status(500).json({ error: "QR render failed" });
  }
});

app.get("/qr/:restaurantId/:channel", (_req, res) => {
  res.status(404).json({ error: "Only whatsapp channel is supported for now" });
});

// Test-only endpoint: inject a synthetic inbound message and run the full
// pipeline (handleMessage -> deliver -> agent reply -> real WhatsApp send).
// Guarded by the gateway secret to prevent spam.
app.post("/test/ingest", async (req, res) => {
  const secretHeader = req.headers["x-gateway-secret"] ?? "";
  if (secretHeader !== GATEWAY_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const restaurantId = (req.body?.restaurantId ?? "seed-restaurant-1") as string;
  const text = (req.body?.text ?? "مرحبا، عندكم شاورما؟") as string;
  const session = sessions.get(restaurantId);
  if (!session) {
    res.status(404).json({ error: "No active session" });
    return;
  }
  const remoteJid = (req.body?.remoteJid ??
    session.lastJid ??
    session.socket.user?.id) as string;
  if (!remoteJid) {
    res.status(400).json({ error: "remoteJid unavailable" });
    return;
  }

  try {
    const synthetic = {
      key: { remoteJid, fromMe: false, id: `test-${Date.now()}` },
      message: { conversation: text },
      messageTimestamp: Math.floor(Date.now() / 1000),
    };
    const parsed = await handleMessage(session, synthetic as any);
    if (!parsed) {
      res.status(422).json({ error: "Payload could not be parsed", remoteJid });
      return;
    }
    const delivered = await deliver(restaurantId, remoteJid, parsed);
    res.json({ ok: true, remoteJid, parsedText: parsed.text ?? null, delivered });
  } catch (err) {
    logger.error(`test/ingest failed: ${String(err)}`);
    res.status(500).json({ error: String(err) });
  }
});

// --- Platform sync loop ---
async function loop() {
  const data = await syncFromPlatform();
  if (data) {
    for (const r of data.restaurants) {
      const wantSession =
        r.whatsappStatus === "waiting" || r.whatsappLinked;
      if (wantSession) {
        ensureSession(r.id);
      } else if (!r.whatsappLinked && sessions.has(r.id)) {
        // platform says no longer linked/waiting → stop quietly
        const s = sessions.get(r.id);
        if (s) {
          const pending = restartTimers.get(r.id);
          if (pending) {
            clearTimeout(pending);
            restartTimers.delete(r.id);
          }
          try {
            void s.auth.discard();
            s.socket.end(undefined);
          } catch {}
          sessions.delete(s.restaurantId);
          await postStatus(r.id, "disconnected");
        }
      }
    }
  }
}

async function shutdown(): Promise<void> {
  logger.info("shutting down");
  cancelOutboxLoop();
  for (const t of restartTimers.values()) clearTimeout(t);
  restartTimers.clear();
  const flushes = [...sessions.values()].map((s) => s.auth.flush());
  await Promise.allSettled(flushes).catch(() => undefined);
  for (const s of sessions.values()) {
    try {
      s.socket.end(undefined);
    } catch {}
  }
  if (sql) await sql.end({ timeout: 2 }).catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

process.on("unhandledRejection", (err) => {
  logger.error(`unhandledRejection: ${String(err)}`);
});

process.on("uncaughtException", (err) => {
  logger.error(`uncaughtException: ${String(err)}`);
});

app.listen(PORT, () => {
  logger.info(`Repli gateway listening on :${PORT}`);
  startOutboxLoop(() => sessions);
  void loop();
  setInterval(() => void loop(), SYNC_INTERVAL_MS);
});