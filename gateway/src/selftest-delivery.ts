// Self-test for the M8 delivery layer: fast-ack + poll + outbox resume +
// fallback decisions. PURE offline — globalThis.fetch is stubbed and the
// sockets are fakes. deliver() sends via conn/state's `sessions` map (that is
// its DI seam), so each case registers a fake session under a unique
// restaurant id and asserts on the recorded send calls. The outbox loop is
// driven through an injected getSessions map + the __runOutboxSweep seam.
//
// Run: npx tsx gateway/src/selftest-delivery.ts   (exit 1 on any FAIL)
import {
  deliver,
  FallbackReplies,
  __setPollBudget,
  __setPollInterval,
} from "./deliver";
import {
  startOutboxLoop,
  cancelOutboxLoop,
  __runOutboxSweep,
} from "./queueClient";
import { sessions, type Session } from "./conn/state";

// ---------------------------------------------------------------------------
// tiny test harness
// ---------------------------------------------------------------------------
const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, cond: boolean, detail = ""): void {
  results.push({ name, ok: cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
let uniq = 0;
function uid(prefix: string): string {
  return `${prefix}-m8-${Date.now()}-${uniq++}`;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type FetchMock = (
  url: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

const originalFetch = globalThis.fetch;

function setFetch(mock: FetchMock): void {
  (globalThis as { fetch: FetchMock }).fetch = mock;
}
function restoreFetch(): void {
  (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface SentCall {
  kind: "text" | "image" | "presence";
  to?: string;
  text?: string;
  imageLen?: number;
  mimetype?: string;
}

/** Offline fake WHATsApp session. `connected:false` simulates a dropped socket. */
function makeFakeSession(
  restaurantId: string,
  connected = true
): { session: Session; calls: SentCall[] } {
  const calls: SentCall[] = [];
  const socket: any = {
    sendMessage: async (to: string, content: any) => {
      if (content?.image) {
        calls.push({
          kind: "image",
          to,
          imageLen: (content.image as Buffer).length,
          mimetype: content.mimetype,
        });
      } else {
        calls.push({ kind: "text", to, text: content?.text ?? "" });
      }
      return {};
    },
    sendPresenceUpdate: async (kind: string, to: string) => {
      calls.push({ kind: "presence", to });
      return {};
    },
  };
  const session = {
    socket,
    restaurantId,
    auth: {} as never,
    qr: null,
    connected,
    lastJid: `${restaurantId}@s.whatsapp.net`,
    startedAt: Date.now(),
  } as unknown as Session;
  return { session, calls };
}

const registered: string[] = [];
function registerSession(s: Session): void {
  sessions.set(s.restaurantId, s);
  registered.push(s.restaurantId);
}
function cleanupSessions(): void {
  for (const id of registered) sessions.delete(id);
  registered.length = 0;
}

// ---------------------------------------------------------------------------
// Case A — legacy sync shape: reply + parts, no `accepted` → old inline path
// ---------------------------------------------------------------------------
async function caseLegacy(): Promise<void> {
  const rid = uid("legacy");
  const { session, calls } = makeFakeSession(rid);
  registerSession(session);
  let gotAck = false;
  let bodySeen: any = null;
  setFetch(async (url, init) => {
    const u = String(url);
    if (u.includes("/api/webhooks/message")) {
      bodySeen = JSON.parse(String(init?.body));
      return jsonResponse({ reply: { text: "رد", parts: ["أ", "ب"] }, silent: false });
    }
    if (u.includes("/api/jobs/ack")) gotAck = true;
    return jsonResponse({ ok: true });
  });
  const result = await deliver(
    rid,
    session.lastJid!,
    { contentType: "text", text: "اهلا" },
    "msg-legacy"
  );
  check("A: legacy deliver returns true", result === true);
  check("A: webhook body carries messageId", bodySeen?.messageId === "msg-legacy", JSON.stringify(bodySeen));
  const presence = calls.filter((c) => c.kind === "presence").length > 0;
  check("A: typing indicator shown first", presence, `calls=${calls.length}`);
  const texts = calls.filter((c) => c.kind === "text").map((c) => c.text);
  check("A: parts sent in order with pacing", texts.join("|") === "أ|ب", texts.join("|"));
  check("A: no ack call in legacy mode", gotAck === false);
}

// ---------------------------------------------------------------------------
// Case B — accepted + poll processing → ready: compose + send + ack delivered
// ---------------------------------------------------------------------------
async function caseAcceptedReady(): Promise<void> {
  const rid = uid("ready");
  const { session, calls } = makeFakeSession(rid);
  registerSession(session);
  let pollCalls = 0;
  const acks: Array<{ jobId: string; body: any }> = [];
  setFetch(async (url, init) => {
    const u = String(url);
    if (u.includes("/api/webhooks/message")) {
      return jsonResponse({ accepted: true, jobId: "j1" });
    }
    if (u.includes("/api/jobs/result")) {
      pollCalls++;
      if (pollCalls === 1) {
        return jsonResponse({ ok: true, status: "processing" });
      }
      return jsonResponse({
        ok: true,
        status: "ready",
        result: {
          replyText: "g",
          replyParts: ["x"],
          silent: false,
          images: [
            { base64: Buffer.from("hello", "utf8").toString("base64"), mime: "image/png" },
          ],
        },
      });
    }
    if (u.includes("/api/jobs/ack")) {
      acks.push({ jobId: "j1", body: JSON.parse(String(init?.body)) });
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: true, jobs: [] });
  });
  const result = await deliver(
    rid,
    session.lastJid!,
    { contentType: "text", text: "اهلا" },
    "msg-b"
  );
  check("B: ready deliver returns true", result === true);
  check("B: polled until ready", pollCalls >= 2, `pollCalls=${pollCalls}`);
  const kinds = calls.map((c) => c.kind).join(",");
  const texts = calls.filter((c) => c.kind === "text").map((c) => c.text);
  const images = calls.filter((c) => c.kind === "image");
  check(
    "B: images sent before text (current behavior)",
    kinds.includes("image") && kinds.indexOf("image") < kinds.indexOf("text"),
    kinds
  );
  check("B: text sent", texts.join("|") === "x", texts.join("|"));
  check("B: image sent", images.length === 1, `images=${images.length}`);
  check(
    "B: ack delivered:true called",
    acks.length === 1 && acks[0].jobId === "j1" && acks[0].body.delivered === true,
    JSON.stringify(acks)
  );
}

// ---------------------------------------------------------------------------
// Case C — accepted + poll → failed: fallback + ack expired, returns true
// ---------------------------------------------------------------------------
async function caseFailed(): Promise<void> {
  const rid = uid("failed");
  const { session, calls } = makeFakeSession(rid);
  registerSession(session);
  const acks: Array<{ jobId: string; body: any }> = [];
  setFetch(async (url, init) => {
    const u = String(url);
    if (u.includes("/api/webhooks/message")) {
      return jsonResponse({ accepted: true, jobId: "j3" });
    }
    if (u.includes("/api/jobs/result")) {
      return jsonResponse({ ok: true, status: "failed", error: "boom" });
    }
    if (u.includes("/api/jobs/ack")) {
      acks.push({ jobId: "j3", body: JSON.parse(String(init?.body)) });
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: true, jobs: [] });
  });
  const result = await deliver(
    rid,
    session.lastJid!,
    { contentType: "text", text: "اهلا" },
    "msg-c"
  );
  check("C: failed deliver returns true", result === true);
  const texts = calls.filter((c) => c.kind === "text").map((c) => c.text);
  check("C: generic fallback sent", texts.includes(FallbackReplies.generic), texts.join(" | "));
  check(
    "C: ack expired:true called",
    acks.length === 1 && acks[0].jobId === "j3" && acks[0].body.expired === true,
    JSON.stringify(acks)
  );
}

// ---------------------------------------------------------------------------
// Case D — accepted + poll timeout, socket UP → fallback + ack expired
// ---------------------------------------------------------------------------
async function caseTimeoutConnected(): Promise<void> {
  const rid = uid("timeout-up");
  const { session, calls } = makeFakeSession(rid);
  registerSession(session);
  __setPollBudget(60);
  __setPollInterval(1);
  let resultCalls = 0;
  const acks: Array<{ jobId: string; body: any }> = [];
  setFetch(async (url, init) => {
    const u = String(url);
    if (u.includes("/api/webhooks/message")) {
      return jsonResponse({ accepted: true, jobId: "j4" });
    }
    if (u.includes("/api/jobs/result")) {
      resultCalls++;
      return jsonResponse({ ok: true, status: "processing" });
    }
    if (u.includes("/api/jobs/ack")) {
      acks.push({ jobId: "j4", body: JSON.parse(String(init?.body)) });
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: true, jobs: [] });
  });
  const result = await deliver(
    rid,
    session.lastJid!,
    { contentType: "text", text: "اهلا" },
    "msg-d"
  );
  __setPollBudget(200);
  __setPollInterval(1);
  check("D: timeout+connected returns true", result === true);
  check("D: polled before giving up", resultCalls > 0, `resultCalls=${resultCalls}`);
  check(
    "D: fallback sent after budget exhausted",
    calls.filter((c) => c.kind === "text").some((c) => c.text === FallbackReplies.generic),
    calls.map((c) => c.kind).join(",")
  );
  check(
    "D: ack expired:true after budget",
    acks.length === 1 && acks[0].jobId === "j4" && acks[0].body.expired === true,
    JSON.stringify(acks)
  );
}

// ---------------------------------------------------------------------------
// Case E — accepted + poll timeout, socket DOWN → no fallback, no ack, false
// ---------------------------------------------------------------------------
async function caseTimeoutDisconnected(): Promise<void> {
  const rid = uid("timeout-down");
  const { session, calls } = makeFakeSession(rid, false);
  registerSession(session);
  __setPollBudget(60);
  __setPollInterval(1);
  let ackSeen = false;
  setFetch(async (url) => {
    const u = String(url);
    if (u.includes("/api/webhooks/message")) {
      return jsonResponse({ accepted: true, jobId: "j5" });
    }
    if (u.includes("/api/jobs/result")) {
      return jsonResponse({ ok: true, status: "processing" });
    }
    if (u.includes("/api/jobs/ack")) {
      ackSeen = true;
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: true, jobs: [] });
  });
  const result = await deliver(
    rid,
    session.lastJid!,
    { contentType: "text", text: "اهلا" },
    "msg-e"
  );
  __setPollBudget(200);
  __setPollInterval(1);
  check("E: timeout+disconnected returns false", result === false);
  check("E: no fallback attempted (socket down)", calls.length === 0, `calls=${calls.length}`);
  check("E: no ack call (job left pending)", ackSeen === false);
}

// ---------------------------------------------------------------------------
// Case F — accepted:false + duplicate:true → silently skip, returns true
// ---------------------------------------------------------------------------
async function caseDuplicate(): Promise<void> {
  const rid = uid("duplicate");
  const { session, calls } = makeFakeSession(rid);
  registerSession(session);
  let ackSeen = false;
  setFetch(async (url) => {
    const u = String(url);
    if (u.includes("/api/webhooks/message")) {
      return jsonResponse({ accepted: false, duplicate: true, reply: null, silent: true });
    }
    if (u.includes("/api/jobs/ack")) {
      ackSeen = true;
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: true, jobs: [] });
  });
  const result = await deliver(
    rid,
    session.lastJid!,
    { contentType: "text", text: "اهلا" },
    "msg-f"
  );
  check("F: duplicate returns true", result === true);
  check(
    "F: nothing sent (only the pre-POST composing indicator)",
    calls.filter((c) => c.kind !== "presence").length === 0,
    calls.map((c) => c.kind).join(",")
  );
  check("F: no ack call", ackSeen === false);
}

// ---------------------------------------------------------------------------
// Outbox — ready job resumed: composed + sent + acked; timer loop lifecycle
// ---------------------------------------------------------------------------
async function caseOutbox(): Promise<void> {
  const rid = uid("outbox");
  const fakeMap = new Map<string, Session>();
  const { session, calls } = makeFakeSession(rid);
  fakeMap.set(rid, session);

  const acks: Array<{ jobId: string; body: any }> = [];
  let pendingCalls = 0;
  setFetch(async (url, init) => {
    const u = String(url);
    if (u.includes("/api/jobs/pending")) {
      pendingCalls++;
      if (pendingCalls === 1) {
        // First (manual) sweep returns a real text job → compose+send+ack.
        return jsonResponse({
          ok: true,
          jobs: [
            {
              id: "ob-1",
              status: "ready",
              channel: "whatsapp",
              remoteJid: session.lastJid,
              result: { replyText: "تم", replyParts: [], silent: false },
            },
          ],
        });
      }
      // Later (timer) sweeps return a silent job → acked delivered instantly,
      // so the timer lifecycle assert is fast and deterministic (no 2-5s
      // pacing delay in the way).
      return jsonResponse({
        ok: true,
        jobs: [
          {
            id: "ob-2",
            status: "ready",
            channel: "whatsapp",
            remoteJid: session.lastJid,
            result: { silent: true },
          },
        ],
      });
    }
    if (u.includes("/api/jobs/ack")) {
      acks.push({ jobId: "ob-1", body: JSON.parse(String(init?.body)) });
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: true, jobs: [] });
  });

  // Manual sweep first (deterministic single-pass assertion).
  await __runOutboxSweep(() => fakeMap);
  check(
    "outbox: ready job composed and sent",
    calls.filter((c) => c.kind === "text").some((c) => c.text === "تم"),
    calls.map((c) => c.kind).join(",")
  );
  check(
    "outbox: ack delivered:true",
    acks.length === 1 && acks[0].jobId === "ob-1" && acks[0].body.delivered === true,
    JSON.stringify(acks)
  );

  // Timer mode: short interval, double-start must be a no-op, cancel stops it.
  const acksBefore = acks.length;
  startOutboxLoop(() => fakeMap, 15);
  startOutboxLoop(() => fakeMap, 15); // guarded singleton — must not throw/duplicate
  await sleep(150);
  cancelOutboxLoop();
  check("outbox: timer loop ran and acked", acks.length > acksBefore, `acks=${acks.length}`);
  const acksAfterCancel = acks.length;
  await sleep(60);
  check("outbox: cancel stops the loop (no leaked timer)", acks.length === acksAfterCancel, `acks=${acks.length}`);
}

async function main(): Promise<void> {
  // Fast offline polling: 1ms intervals keep the poll tests instant. Real
  // production defaults (2000ms / 55s) are untouched by the running gateway.
  __setPollInterval(1);
  __setPollBudget(200);

  await caseLegacy();
  await caseAcceptedReady();
  await caseFailed();
  await caseTimeoutConnected();
  await caseTimeoutDisconnected();
  await caseDuplicate();
  await caseOutbox();

  cleanupSessions();
  restoreFetch();
  __setPollInterval(2000);
  __setPollBudget(55_000);

  const fails = results.filter((r) => !r.ok).length;
  console.log(
    `\n${results.length - fails}/${results.length} checks passed` +
      (fails > 0 ? ` — ${fails} FAILED` : "")
  );
  process.exit(fails > 0 ? 1 : 0);
}

void main().catch((err) => {
  console.error("selftest-delivery crashed:", err);
  restoreFetch();
  process.exit(1);
});