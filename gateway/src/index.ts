import express from "express";
import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  getContentType,
  makeWASocket,
  type WASocket,
} from "@whiskeysockets/baileys";
import postgres from "postgres";
import pino from "pino";
import qrcode from "qrcode";
import { PgAuthState } from "./auth";

const PORT = Number(process.env.PORT ?? 4000);
const PLATFORM_URL = process.env.PLATFORM_URL ?? "http://localhost:3000";
const GATEWAY_SECRET = process.env.GATEWAY_SECRET ?? "dev-secret";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? 15000);

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const sql = DATABASE_URL
  ? postgres(DATABASE_URL, {
      ssl: process.env.NODE_ENV === "production" ? "require" : "prefer",
      max: 4,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
    })
  : null;

interface Session {
  socket: WASocket;
  restaurantId: string;
  auth: PgAuthState;
  qr: string | null;
  connected: boolean;
  lastJid: string | null;
  startedAt: number;
}

const sessions = new Map<string, Session>();

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
  if (existing && (existing.connected || existing.qr)) return;
  if (existing && Date.now() - existing.startedAt < 90_000) return;
  if (existing) {
    // Alive but stuck (e.g. restored creds hit logged-out) → drop stored creds
    // and restart so the owner gets a fresh QR.
    try {
      void existing.auth.flush();
      existing.socket.end(undefined);
    } catch {}
    sessions.delete(restaurantId);
  }
  void startSession(restaurantId);
}

async function startSession(restaurantId: string): Promise<void> {
  logger.info(`starting session for ${restaurantId}`);
  const auth = new PgAuthState(restaurantId, sql);
  await auth.ready;

  const socket = makeWASocket({
    logger,
    auth: auth.state,
    browser: Browsers.ubuntu("Chrome"),
    syncFullHistory: false,
  });

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
    if (qr) {
      session.qr = qr;
      void postStatus(restaurantId, "qr_ready");
    }
    if (connection === "open") {
      session.connected = true;
      session.qr = null;
      const jid = socket.user?.id ?? null;
      session.lastJid = jid;
      void postStatus(restaurantId, "connected", jid);
    }
    if (connection === "close") {
      session.connected = false;
      void postStatus(restaurantId, "disconnected");
      sessions.delete(restaurantId);
      void session.socket.end(undefined);

      const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
        ?.output?.statusCode;
      const shouldRetry = code === DisconnectReason.loggedOut ? false : true;
      if (shouldRetry) {
        setTimeout(() => startSession(restaurantId), 5_000);
      } else {
        // The owner removed the device from WhatsApp → drop stored creds so a
        // fresh QR is generated for re-pairing.
        try {
          void session.auth.flush();
        } catch {}
        setTimeout(() => startSession(restaurantId), 2_000);
      }
    }
  });

  socket.ev.on("messages.upsert", async ({ messages: upserts, type }) => {
    if (type !== "notify") return;
    for (const m of upserts) {
      if (m.key.fromMe) continue;
      const remoteJid = m.key.remoteJid;
      if (!remoteJid) continue;

      const content = await handleMessage(session, m);
      if (content) {
        await deliver(restaurantId, remoteJid, content);
      }
    }
  });
}

interface ParsedMessage {
  contentType: "text" | "image" | "voice" | "video";
  text?: string | null;
  mediaBase64?: string;
  mediaMime?: string;
}

async function handleMessage(
  session: Session,
  m: any
): Promise<ParsedMessage | null> {
  try {
    const msg = m.message;
    if (!msg) return null;
    const type = getContentType(msg);
    if (type === "conversation") return { contentType: "text", text: msg.conversation ?? "" };
    if (type === "extendedTextMessage")
      return { contentType: "text", text: msg.extendedTextMessage?.text ?? "" };

    const isImage = type === "imageMessage";
    const isVideo = type === "videoMessage";
    const isAudio = type === "audioMessage";
    if (isImage || isVideo || isAudio) {
      let buffer: Buffer | undefined;
      try {
        buffer = (await downloadMediaMessage(
          m,
          "buffer",
          {},
          { logger, reuploadRequest: m.upload }
        )) as Buffer | undefined;
      } catch (err) {
        logger.warn(`media download failed: ${String(err)}`);
      }
      const mime =
        msg[type]?.mimetype ??
        (isImage ? "image/jpeg" : isAudio ? "audio/ogg" : "video/mp4");
      if (buffer && buffer.length > 0) {
        return {
          contentType: isImage ? "image" : isAudio ? "voice" : "video",
          mediaBase64: buffer.toString("base64"),
          mediaMime: mime,
          text: null,
        };
      }
      return {
        contentType: isImage ? "image" : isAudio ? "voice" : "video",
        text: isImage ? "[image]" : isAudio ? "[voice]" : "[video]",
      };
    }
    return { contentType: "text", text: JSON.stringify(msg) };
  } catch (err) {
    logger.error(`handleMessage error: ${String(err)}`);
    return null;
  }
}

async function deliver(
  restaurantId: string,
  remoteJid: string,
  parsed: ParsedMessage
): Promise<boolean> {
  try {
    const res = await fetch(`${PLATFORM_URL}/api/webhooks/message`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        restaurantId,
        channel: "whatsapp",
        remoteJid,
        contentType: parsed.contentType,
        text: parsed.text,
        mediaBase64: parsed.mediaBase64,
        mediaMime: parsed.mediaMime,
      }),
    });
    if (!res.ok) {
      logger.error(`webhook message returned ${res.status}`);
      return false;
    }
    const data = (await res.json()) as { reply?: { text?: string } | null };
    const replyText = data.reply?.text;
    if (!replyText || replyText.trim().length === 0) return false;

    const session = sessions.get(restaurantId);
    if (!session) return false;

    // Human-like: small random delay before replying
    const delay = 800 + Math.floor(Math.random() * 1800);
    await new Promise((r) => setTimeout(r, delay));

    await session.socket.sendMessage(remoteJid, { text: replyText });
    return true;
  } catch (err) {
    logger.error(`deliver failed: ${String(err)}`);
    return false;
  }
}

// --- HTTP server: QR endpoint + health ---
const app = express();
app.use(express.json());

app.get("/health", async (_req, res) => {
  let db = "ok";
  if (sql) {
    try {
      await sql`select 1`;
    } catch {
      db = "down";
    }
  }
  res.json({
    ok: db === "ok",
    db,
    sessions: sessions.size,
    connected: [...sessions.values()].filter((s) => s.connected).length,
    uptime: Math.round(process.uptime()),
  });
});

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
          try {
            void s.auth.flush();
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

app.listen(PORT, () => {
  logger.info(`Repli gateway listening on :${PORT}`);
  void loop();
  setInterval(() => void loop(), SYNC_INTERVAL_MS);
});