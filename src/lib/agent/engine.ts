import OpenAI from "openai";
import { randomUUID } from "crypto";
import { after } from "next/server";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, rawClient } from "@/lib/db";
import {
  agentConfigs,
  conversations,
  errorLogs,
  messages,
  restaurants,
  telegramOrderDeliveries,
  usageLogs,
} from "@/lib/db/schema";
import { newId } from "@/lib/utils";
import { first } from "@/lib/db/query";
import { notifyTelegramOrder } from "@/lib/telegram";
import { buildSystemPrompt, type BusinessProfile } from "./prompt";
import {
  completeWithFallback,
  estimateCostUsd,
  getAgentModel,
  getWhisperClient,
  isAIConfigured,
  TRANSCRIBE_MODEL,
  type KeyLabel,
} from "@/lib/ai/client";
import {
  condenseMessages,
  parseOrderBlock,
  renderContextBlock,
  stripOrderBlock,
  ORDER_STATE_CLOSE,
  ORDER_STATE_OPEN,
  type CondensedContext,
} from "./summary";
import { logEnvBanner } from "@/lib/env";
import { maybeCheckSpendBudget } from "@/lib/alerts";

// Per-process env checklist (idempotent). Runs on the cold start of any lambda
// that hosts the agent so misconfiguration is impossible to miss in logs.
logEnvBanner();

export type Channel = "whatsapp" | "instagram";
export type IncomingContentType = "text" | "image" | "voice" | "video";

export interface IncomingMessageInput {
  restaurantId: string;
  channel: Channel;
  remoteJid: string;
  customerName?: string | null;
  contentType: IncomingContentType;
  text?: string | null;
  mediaUrl?: string | null;
  mediaMime?: string | null;
  mediaBase64?: string | null;
  messageId?: string | null;
}

export interface AgentOrderResult {
  ready: boolean;
  items: { name: string; qty: number; price: number }[];
  total?: number;
  phone?: string | null;
  address?: string | null;
  customerName?: string | null;
  /** The model's raw ready:true BEFORE sanitizeOrder zeroed it for a missing
   * phone — lets the engine honor a genuinely finalized order (e.g. WhatsApp
   * privacy/lid JIDs expose no number) while still blocking empty blocks. */
  rawReady?: boolean;
}

function normalizeItems(
  items: AgentOrderResult["items"]
): { name: string; qty: number; price: number }[] {
  return (Array.isArray(items) ? items : [])
    .map((i) => ({
      name: String(i.name ?? ""),
      qty: Number(i.qty) || 1,
      price: Number(i.price) || 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.qty - b.qty);
}

function orderFingerprint(order: AgentOrderResult): string {
  return `${order.phone ?? ""}|${Number(order.total) || 0}|${JSON.stringify(
    normalizeItems(order.items)
  )}`;
}

/** True when a stored push matches this order (phone + total + items), so a
 * redundant model re-echo of the SAME order isn't pushed twice. */
function sameFingerprint(
  itemsJson: string,
  storedTotal: number | null,
  order: AgentOrderResult
): boolean {
  let stored: { name: string; qty: number; price: number }[] = [];
  try {
    stored = normalizeItems(JSON.parse(itemsJson));
  } catch {
    return false;
  }
  const sameItems = JSON.stringify(stored) === JSON.stringify(normalizeItems(order.items));
  const sameTotal =
    (!Number(order.total) && !storedTotal) || Number(storedTotal) === Number(order.total);
  return sameItems && sameTotal;
}

// WhatsApp sender JID → phone. Handles "9647xxxxxxxx@s.whatsapp.net" and the
// LID-shaped "9647xxxxxxxx:2@s.whatsapp.net" (strip the ":instance" suffix and
// drop non-digits). "claims" too short (<7 digits) are LID placeholders — not a
// real phone, so return null and let the flow ask/collect normally.
export function jidToPhone(jid: string | null | undefined): string | null {
  if (!jid || typeof jid !== "string") return null;
  const [local, server] = jid.split("@");
  const sv = server ?? "";
  // Only real user JIDs carry a phone. "lid" IDs, groups, broadcast/newsletter
  // channels are numeric but NOT phone numbers — never treat them as one.
  if (!["s.whatsapp.net"].includes(sv)) return null;
  const digits = (local ?? "").split(":")[0].replace(/\D/g, "");
  return digits.length >= 7 ? digits : null;
}

// The owner demands reply text WITHOUT emojis, so this is a hard guarantee on
// top of the prompt instruction (models are unreliable about following it).
const EMOJI_RE = /[\p{Extended_Pictographic}\u200d\ufe0e\ufe0f]/gu;
export function stripEmojis(text: string): string {
  return (text ?? "").replace(EMOJI_RE, "").replace(/\s{2,}/g, " ").trim();
}

export interface AgentReply {
  text: string;
  transcribedFromVoice?: string | null;
  order?: AgentOrderResult | null;
  costUsd: number;
  usedModel: string;
}

export interface MenuImage {
  id: string;
  mime: string;
  base64: string;
  url: string;
}

interface MenuImageRaw {
  id: string;
  mime: string;
  base64: string;
}

function parseMenuImages(raw: string | null | undefined): MenuImageRaw[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as MenuImageRaw[];
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (x) => x && typeof x.base64 === "string" && typeof x.mime === "string"
    );
  } catch {
    return [];
  }
}

const HISTORY_LIMIT = 24;

// Reliability budgets (ms). The whole handler must finish well inside the
// Vercel webhook ceiling (60s) or the gateway gets NOTHING → customer sees no
// reply. Budgets are deliberately below the gateway's own 55s platform timeout
// so the gateway always gets a reply (or aborts) BEFORE the lambda is killed.
// The engine makes exactly ONE LLM call per turn, but that call can chain
// through several model/key fallbacks (see completeWithFallback); 20s gives
// the fail-over chain room to succeed on the backup model after the primary
// free model returns 429/5xx, instead of every hiccup dropping to the "خلل
// بسيط" apology.
const REPLY_BUDGET_MS = 20_000;
const TRANSCRIBE_TIMEOUT_MS = 10_000;

// Cap the model's reply length. A realistic reply = 1-3 short Iraqi-dialect
// sentences (~40-80 tokens) plus the [ORDER_STATE] JSON block (up to a few
// hundred tokens for a big order with a long address). 500 gives generous
// headroom over any natural reply while cutting off a runaway model — output
// tokens are the most expensive ones, so this caps both cost and latency with
// no quality loss on normal replies.
const MAX_REPLY_TOKENS = 500;

// Combined per-turn budget accounting (worst case, still well under the 60s
// Vercel ceiling and the 55s gateway timeout): lock wait (5s) + transcription
// (10s, voice only) + AI reply (12s) ≈ 27s. The lock wait is deliberately kept
// small so a busy restaurant's rapid-fire messages can never eat the whole
// turn on lock polling alone — a queue backlog must not become the reason a
// customer gets nothing.
const LOCK_WAIT_BUDGET_MS = 5_000;

// The order-state contract appended to every call. The ONE reply of the turn
// doubles as the order extractor: when the model updates/closes an order it
// appends a self-describing block. The next turn's context re-condenses that
// block without any extra LLM call — model-agnostic, minimal tokens. The phone
// rule differs per channel: on WhatsApp the number is auto-known (sender jid),
// on Instagram it must be collected like before.
function orderContract(senderPhone?: string | null): string {
  const phoneKnown = !!senderPhone && /^\d{4,}$/.test(senderPhone);
  return `\n\n[إجراء إلزامي في نهاية ردك]
عندما تُحدِّث أو تُكمل طلباً للزبون (أصناف أو كميات أو هاتف أو عنوان)، أضف في نهاية ردك — في سطر مستقل غير موجَّه للزبون — الكتلة التالية حرفياً:
${ORDER_STATE_OPEN}{"items":[{"name":"اسم الصنف","qty":1,"price":3.5}],"total":3.5,"phone":"07701234567","address":"العنوان","customerName":"الاسم","ready":true}${ORDER_STATE_CLOSE}
القيود الصارمة:
- استخدم أسعار المنيو أعلاه حرفياً؛ إن جهلت الثمن فاجعل price=0.
- جميع الأسعار بالدينار العراقي حصراً: price للصنف والمجموع total أرقام بالدينار (مثل price:25000) — لا تستخدم الدولار، ولا تفصل الآلاف بفاصلة عشرية في القيم الرقمية.
${
  phoneKnown
    ? `- هاتف الزبون معروف تلقائياً من واتساب. ضعه في حقل phone ولا تطلب الرقم من الزبون أبداً.
- ready=true عندما تتوفر الأصناف (الهاتف لا يُنتظر، فهو مُجلب آلياً).`
    : `- ready=true فقط إذا توفَّرت الأصناف ورقم الهاتف معاً (وإن توفر العنوان احفظه أيضاً).`
}
- في كل تحديث للطلب أعد كتابة الكتلة بالحالة الكاملة (لا تلخص جزئياً).
- مع كل طلب توصيل اسأل عن العنوان مجدداً — حتى لنفس الزبون الذي أعطاه في طلب سابق — ولا تعيد استخدام عنوان قديم إلا إذا صرّح الزبون بنفسه به.
- إن لم تكن المحادثة عن طلب جارٍ فلا تكتب الكتلة إطلاقاً.`;
}

// Graceful formal Iraqi-dialect fallback for a confirmed customer-facing error — NO emojis.
const GRACEFUL_FALLBACK =
  "عذراً صار خلل بسيط، جرب مرة ثانية بعد شوي.";
// Used when the DB is unreachable — same graceful tone, distinct wording so
// ops can tell the two apart in logs without the customer seeing anything raw.
const DB_DOWN_REPLY =
  "عذراً صار تعطل بسيط بالخادم، كرر رسالتك بعد دقيقة.";

// --- Per-conversation request locking (race conditioning) ---
// Two rapid messages from the same customer can hit different Vercel lambda
// instances and run handleIncomingMessage concurrently, causing interleaved /
// duplicated AI replies and overwritten state. We serialize per
// (restaurant + channel + remoteJid) so messages are processed in order.
//
// Implemented as a tiny `conversation_locks` table (see migrate.ts) because
// the database is Supabase's transaction pooler (PgBouncer): session-level
// advisory locks would leak across pooled connections. The acquisition is a
// single atomic `INSERT ... ON CONFLICT ... WHERE expires_at < now()` so the
// lock is visible to ALL lambda instances, auto-reclaims stale locks (crash or
// timeout safety) via a 30s TTL, and never holds a long transaction.

const LOCK_RETRY_MS = 300;
let lockAcquisitionCount = 0;

async function acquireConversationLock(
  lockKey: string,
  token: string
): Promise<boolean> {
  // Opportunistic purge of expired rows — table stays bounded forever.
  lockAcquisitionCount++;
  if (lockAcquisitionCount % 100 === 0) {
    await rawClient`DELETE FROM repli.conversation_locks WHERE expires_at < now()`.catch(
      () => {}
    );
  }
  const rows = await rawClient`
    INSERT INTO repli.conversation_locks (lock_key, token, expires_at)
    VALUES (${lockKey}, ${token}, now() + interval '30 seconds')
    ON CONFLICT (lock_key) DO UPDATE
      SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
      WHERE repli.conversation_locks.expires_at < now()
    RETURNING token
  `;
  return (rows[0] as { token: string } | undefined)?.token === token;
}

async function releaseConversationLock(lockKey: string, token: string): Promise<void> {
  // Only release if we still own it — never touch another holder's lock.
  await rawClient`
    DELETE FROM repli.conversation_locks
    WHERE lock_key = ${lockKey} AND token = ${token}
  `.catch(() => {});
}

async function withConversationLock<T>(
  lockKey: string,
  fn: () => Promise<T>
): Promise<T> {
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_BUDGET_MS;
  let acquired = false;

  // Wait for the lock: poll briefly, mirroring the previous in-memory queue so
  // rapid consecutive messages from the same customer still run in order.
  while (!acquired && Date.now() < deadline) {
    try {
      acquired = await acquireConversationLock(lockKey, token);
    } catch (err) {
      // DB hiccup — don't block the customer's turn on lock bookkeeping.
      console.error(`[LOCK] acquire error ${lockKey}: ${(err as Error).message}`);
      break;
    }
    if (!acquired) {
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }

  if (acquired) {
    try {
      return await fn();
    } finally {
      await releaseConversationLock(lockKey, token);
    }
  }
  // Lock unavailable within budget (or DB down) — process anyway so the
  // customer still gets a reply rather than being dropped or blocked forever.
  return fn();
}

/** Resolve `p`, but reject after `ms` so side-work can never block the reply. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("deadline exceeded")), Math.max(0, ms))
    ),
  ]);
}

async function getBusiness(restaurantId: string): Promise<BusinessProfile | null> {
  const restaurant = await first(
    db.select().from(restaurants).where(eq(restaurants.id, restaurantId))
  );
  if (!restaurant) return null;

  let config = await first(
    db.select().from(agentConfigs).where(eq(agentConfigs.restaurantId, restaurantId))
  );

  if (!config) {
    const id = newId();
    config = {
      id,
      restaurantId,
      businessName: restaurant.name,
      tone: "friendly",
      languages: "ar,en",
      hours: "",
      deliveryPolicy: "",
      menu: "",
      policies: "",
      customInstructions: "",
      systemPrompt: "",
      temperature: 0.7,
      askPhone: true,
      askAddress: true,
      updatedAt: new Date(),
    };
    // Race-safe: two concurrent first-messages for the same restaurant may both
    // miss the read above. `ON CONFLICT (restaurant_id) DO NOTHING` lets one
    // win and the other fall through to a re-read instead of throwing on the
    // unique index (which previously bubbled up → silent 500 → no reply).
    await db
      .insert(agentConfigs)
      .values(config)
      .onConflictDoNothing({ target: agentConfigs.restaurantId });
    config =
      (await first(
        db.select().from(agentConfigs).where(eq(agentConfigs.restaurantId, restaurantId))
      )) ?? config;
  }

  return { restaurant, config };
}

async function upsertConversation(
  restaurantId: string,
  channel: Channel,
  remoteJid: string,
  customerName?: string | null
) {
  let conversation = await first(
    db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.restaurantId, restaurantId),
          eq(conversations.channel, channel),
          eq(conversations.remoteJid, remoteJid)
        )
      )
  );

  if (!conversation) {
    const id = newId();
    const row = {
      id,
      restaurantId,
      channel,
      remoteJid,
      customerName: customerName ?? null,
      status: "open",
      pinned: false,
      lastMessageAt: new Date(),
    };
    try {
      await db.insert(conversations).values(row);
    } catch (err) {
      // Race: two concurrent messages for the same (restaurant, channel, jid).
      // Re-read instead of throwing (which previously bubbled up to a 500 and
      // left the customer with no reply).
      if (/unique|duplicate/i.test(err instanceof Error ? err.message : String(err))) {
        const existing = await first(
          db
            .select()
            .from(conversations)
            .where(
              and(
                eq(conversations.restaurantId, restaurantId),
                eq(conversations.channel, channel),
                eq(conversations.remoteJid, remoteJid)
              )
            )
        );
        if (existing) {
          await db
            .update(conversations)
            .set({ lastMessageAt: new Date() })
            .where(eq(conversations.id, existing.id));
          return existing;
        }
      }
      throw err;
    }
    conversation = await first(
      db.select().from(conversations).where(eq(conversations.id, id))
    );
  } else if (customerName && conversation.customerName !== customerName) {
    await db
      .update(conversations)
      .set({ customerName, lastMessageAt: new Date() })
      .where(eq(conversations.id, conversation.id));
  } else {
    await db
      .update(conversations)
      .set({ lastMessageAt: new Date() })
      .where(eq(conversations.id, conversation.id));
  }

  return conversation!;
}

async function storeMessage(data: {
  conversationId: string;
  direction: "in" | "out";
  contentType: IncomingContentType;
  text?: string | null;
  mediaUrl?: string | null;
  mediaMime?: string | null;
  transcription?: string | null;
  status?: "sent" | "delivered" | "failed";
  error?: string | null;
}) {
  await db
    .insert(messages)
    .values({
      id: newId(),
      conversationId: data.conversationId,
      direction: data.direction,
      contentType: data.contentType,
      text: data.text ?? null,
      mediaUrl: data.mediaUrl ?? null,
      mediaMime: data.mediaMime ?? null,
      transcription: data.transcription ?? null,
      status: data.status ?? "sent",
      error: data.error ?? null,
    });
}

async function transcribeVoice(input: IncomingMessageInput): Promise<string | null> {
  let fileData: Buffer | null = null;
  if (input.mediaBase64) {
    fileData = Buffer.from(input.mediaBase64, "base64");
  } else if (input.mediaUrl) {
    const res = await fetch(input.mediaUrl);
    if (!res.ok) return null;
    fileData = Buffer.from(await res.arrayBuffer());
  }
  if (!fileData || fileData.length === 0) return null;

  const mime = input.mediaMime ?? "audio/mpeg";
  const format = (mime.split("/")[1] ?? "mpeg").replace("mp4", "m4a");

  try {
    // Prefer the Whisper API when an OpenAI key is available — it's purpose-built
    // for audio. Fall back to Gemini's multimodal transcription when only Gemini
    // keys are configured.
    const whisperClient = getWhisperClient();
    if (whisperClient) {
      const plain = fileData.buffer.slice(
        fileData.byteOffset,
        fileData.byteOffset + fileData.byteLength
      ) as ArrayBuffer;
      const blob = new Blob([plain], { type: mime });
      const file = new File([blob], `voice.${format}`, { type: mime });
      const transcription = await whisperClient.audio.transcriptions.create(
        {
          model: TRANSCRIBE_MODEL,
          file,
        },
        { signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS) }
      );
      return transcription.text || null;
    }

    // Gemini-only path: use the audio input through the chat completion API.
    const res = await completeWithFallback(
      {
        model: getAgentModel(),
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You are a speech-to-text engine. Reply with ONLY the exact transcription text, no commentary.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Transcribe this audio." },
              { type: "input_audio", input_audio: { data: fileData.toString("base64"), format } },
            ] as never,
          } as OpenAI.Chat.Completions.ChatCompletionMessageParam,
        ],
      },
      { budgetMs: TRANSCRIBE_TIMEOUT_MS, timeoutMs: TRANSCRIBE_TIMEOUT_MS }
    );
    return res.choices[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error("transcribe error", err);
    return null;
  }
}

async function buildMessages(
  profile: BusinessProfile,
  input: IncomingMessageInput,
  context: CondensedContext,
  menuNote?: string,
  senderPhone?: string | null,
  clearedContext?: CondensedContext | null,
  clearNote?: string
): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
  // ONE request per turn: the current message + a compact deterministic
  // summary of everything before it. Never resend the raw log in every call —
  // that choked slow/free models (multi-request turns) and quadrupled tokens.
  // Always rebuild the system prompt here (buildSystemPrompt) instead of the
  // stored config.systemPrompt: the stored copy was frozen at save time and
  // still carried stale instructions (ORDER_SUMMARY, ask-for-phone, emojis).
  // On a NEW-order opener the cleared context replaces the condensed one so the
  // model never sees the previous order's items/address.
  const effectiveContext: CondensedContext =
    clearedContext ??
    (context.phone
      ? context
      : { ...context, phone: senderPhone ?? null });

  // Full menu only when this turn may actually need it — order/price/menu
  // intent, or a bare image (likely a food photo the model must map to the
  // menu). Social turns omit the menu text entirely; the condensed context
  // below already carries any items/prices already discussed. This is the
  // single biggest per-turn token saving (a long menu dwarfs every other
  // prompt section).
  const textForGate = input.text?.trim() ?? "";
  const menuNeeded =
    ORDER_INTENT.test(textForGate) ||
    MENU_QUESTION.test(textForGate) ||
    ((input.contentType === "image" || input.contentType === "video") &&
      textForGate === "");

  const systemPrompt =
    buildSystemPrompt(profile, { senderPhone, includeMenu: menuNeeded }) +
    orderContract(senderPhone) +
    (menuNote ? `\n\n${menuNote}` : "") +
    (clearNote ? `\n\n${clearNote}` : "") +
    `\n\n${renderContextBlock(effectiveContext)}`;

  const currentUserText = input.text ?? "";

  let content: OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"] =
    currentUserText;

  if (input.contentType === "image" || input.contentType === "video") {
    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    parts.push({
      type: "text",
      text: currentUserText || "The customer sent this image/video.",
    });
    if (input.mediaBase64 && input.mediaMime) {
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${input.mediaMime};base64,${input.mediaBase64}`,
        },
      });
    } else if (input.mediaUrl) {
      parts.push({ type: "image_url", image_url: { url: input.mediaUrl } });
    }
    content = parts;
  }

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content },
  ];
}

// Cheap heuristic to skip the extractOrder LLM call when the message clearly
// isn't an order — halves quota burn on casual chat (free-tier Gemini quota
// exhaustion is the #1 cause of the "try again" apology, so every saved call
// keeps the quota alive for real replies). The old ORDER_HINT matched any
// food/menu word, so price questions like "كم سعر الشاورما؟" fired a full
// extractOrder LLM call every turn. The gate below only fires on an explicit
// order intent (an ask/request verb), keeping browsing turns at ONE LLM call.
const ORDER_INTENT =
  /[أا]?طل[بب]|[أا]ريد|ابريد|ابي|ابغ[يى]|ابه|ودي|بگطع|گطعلي|عطني|اعطيني|آخذ|اخذ|بطلب|\b(i want|i'?d like|want|order|give me|get me|i'?ll take)\b/i;

// A bare confirmation ("تمام", "نعم", "موافق"...) is not an order by itself,
// but when it closes a chat that already carries order context (a product or
// a phone number in the recent exchange) the Telegram push must still fire.
const ORDER_CONFIRM =
  /تمام|نعم|اكيد|أكيد|موافق|زين|هيه|اوكي|أوكي|صحيح|تم\b|[أا]تفقنا|خلاص|\b(ok|okay|yes|agree|confirmed|fine|sure|right|sounds good)\b/i;

// A message signaling a brand-NEW order (not a continuation of a stocked one).
// Only matters once there is already order material in the conversation — on a
// fresh chat there is nothing to reset. Distinguishing start vs. continue keeps
// "السلام عليكم ممكن اطلب" from re-closing a previous order and re-pushing it.
const ORDER_START =
  /عندي طلب|ابي اطلب|أريد اطلب|أريد أطلب|ابي بطلب|ابي اكل|أريد بطلب|بغيت اطلب|بطلع اطلب|ممكن اطلب|اطلب منكم|اطلب طلب|طلب جديد|أريد اطلب جديد|ودي اطلب|ابه اطلب|ودي بطلب|راح اطلب|طلبة منك|أريد اطلب مني/i;

// Explicit continuation phrases ("زين اطلبهم"، "نفس الطلب") signal the customer
// is ADDING to the current order — must NOT be treated as a fresh start.
const ORDER_CONTINUE =
  /اطلبهم|اطلبها|اطلبو|اضيف|أضيف|زد عليهم|كثر|نفس الطلب|نفس الاصناف|نفس الأصناف|اطلبلي|اسويها/i;

// Recover the most recent [ORDER_STATE] block the bot itself stored, so a
// bare-confirmation turn ("زين، خلاص" with no block in the model's reply) can
// still close & push the pending order instead of silently dropping it. Scoped
// to the last 3h so a stale block from an earlier chat never resurrects into a
// fresh confirmation.
async function findLastStoredOrder(
  conversationId: string,
  restaurantId: string
): Promise<AgentOrderResult | null> {
  try {
    const cutoff = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const rows = await db
      .select({ text: messages.text })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.direction, "out"),
          gte(messages.createdAt, cutoff)
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(6);
    for (const row of rows) {
      if (!row.text) continue;
      const stored = parseOrderBlock(row.text);
      if (stored && stored.items.length > 0) return stored;
    }
  } catch (err) {
    await insertErrorBestEffort(
      restaurantId,
      "agent",
      "findLastStoredOrder failed",
      err
    );
  }
  return null;
}

// Menu-delivery gate: the FULL menu is only worth its tokens on turns that
// actually touch the menu — asking for availability, prices, or the menu
// itself, or starting an order. On purely social/browsing/confirming turns
// the menu text is omitted from the prompt entirely (the condensed order
// context below already carries any items/prices/users discussing). The gate
// is deliberately broad: a real price/availability question must never be
// missed, because that's the one place a halluncipated price escapes.
const MENU_QUESTION =
  /عندك|عندكم|موجود|متوفر|توفر|يتوفر|الكو|شكد|بشكد|كم سعر|سعره|سعر|أسعار|اسعار|بالسعر|بأي سعر|المنيو|المينيو|قائمه|قائمة|الأصناف|الصنف|اكل|أكل|شنو اكلكم|شو اكلكم|شنو الأكل|شو الأكل|what.*(price|cost)|price|menu|how much|have you got|do you have/i;

// ── Standard script intents (deterministic, guarantee the Iraqi-dialect turn
// templates below, independent of how the model behaves that day). ──────────
const SCRIPT_GREETING =
  /^(?:السلام عليكم|سلام عليكم|السلام عليكي|سلام|هلو|هلا|ہلا|ابل|آبل|صباح الخير|مساء الخير|مسا الخير|مرحبا|أهلاً|اهلا|حياك)/i;

// Custant price question: "بيش الكباب"، "شكد الشاورما"، "بكم"، "كم سعر".
const SCRIPT_PRICE_ASK =
  /بيش|بشكد|بچم|بكم|شكد|شكلها|شكلوا|شلون سعره|سعره|سعر?|بأي سعر|كم سعر|بسعر|كم يكلف|كم واجد|how much|what'?s the price|price|cost/i;

// Customer asking to SEE the menu (not order verbs, not a price question).
const SCRIPT_MENU_REQUEST =
  /(?:شنو|شو|ممكن|أرسلي|ارسل)?\s*عد(?:كم|اك).{0,14}(?:منيو|اكل|أكل)|المنيو|المينيو|منيو|منيوه|القائمة|قائمه|قائمة|شنو عندكم|شنو متوفر|شنو موجود|ابعت(?:لي|ي)?.{0,6}منيو|ارسل.{0,8}منيو|شلون المنيو|بيات المنيو/i;

// Customer tracking their order ("شلون طلبي"، "وين طلبي"، "طلبي وصل؟"). The
// distinctive possessive "طلبي"/"الطلب" + a status/where word, in ANY order,
// AND never an order verb ("اطلبي" = "order for me"), never a price ask.
const SCRIPT_STATUS_SUBJECT = /طلبي|اوردر|أوردر|الطلب|الاوردر|طلبك/;
const SCRIPT_STATUS_ASK =
  /وين|وصل|وصلت|وصلني|اكتمل|اكتملت|جاهز|توصل|جهزت|خلص|صارت|شلون|شنو|باقي|تأخير|استعلام|بعدني|طلق|وصلني|تواصل|وينه|ويني/;

const NOT_STATUS_REQUEST = /اطلبي|اطلبه|أطلبيه|اطلبيه|بيش|بشكد|شكد/;

// Menu → price lookup used by the canned "بيش X" reply. Conservative: only a
// SINGLE best-matching menu line with an unambiguous numeric price is answered
// deterministically; anything ambiguous falls back to the model (never guess).
function findMenuPrice(
  text: string,
  menu: string
): { item: string; price: number; priceText: string } | null {
  const norm = (s: string) =>
    s
      .replace(/[\u064B-\u0652\u0670]/g, "")
      .replace(/[أإآ]/g, "ا")
      .replace(/ة/g, "ه")
      .replace(/[ىي]/g, "ي")
      .replace(/ال/g, " ")
      .replace(/[^\u0600-\u06FFa-zA-Z0-9\s]/g, " ")
      .toLowerCase();
  const tokens = (s: string) =>
    norm(s).split(/\s+/).filter((w) => w.length >= 3);

  const phrase = tokens(text.replace(SCRIPT_PRICE_ASK, " "));
  if (phrase.length === 0) return null;

  const lines = menu.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  let best: { line: string; score: number; price: number; name: string } | null = null;
  for (const line of lines) {
    const priceMatch = line.match(/(\d[\d,]*(?:\.\d+)?)/);
    if (!priceMatch) continue;
    const price = Number(priceMatch[1].replace(/[,\s]/g, ""));
    if (!Number.isFinite(price) || price <= 0) continue;
    if (priceMatch.index === undefined) continue;
    const lineTokens = tokens(line);
    if (lineTokens.length === 0) continue;
    const score = phrase.filter((w) => lineTokens.includes(w)).length;
    if (score === 0) continue;
    if (!best || score > best.score)
      best = {
        line,
        score,
        price,
        name: line.slice(0, priceMatch.index).trim().replace(/[—ـ\-:].*$/, "").trim(),
      };
  }
  if (!best) return null;
  // Ambiguity: another line ties on the same score → ask the model instead of
  // risking the wrong item's price.
  const ties = lines.filter(
    (l) =>
      l !== best!.line &&
      tokens(l).filter((w) => phrase.includes(w)).length === best!.score
  );
  if (ties.length > 0 || best.score < 1) return null;
const priceText = String(best.price);
  return { item: best.name.trim(), price: best.price, priceText };
}

export interface RunResult {
  replyText: string;
  /** true when the turn deliberately requires NO customer reply (human
   * handling the chat) — the gateway must not auto-fallback in this case. */
  silent?: boolean;
  transcription?: string | null;
  order?: AgentOrderResult | null;
  costUsd: number;
  model: string;
  menuImages?: MenuImage[];
  createOrderProps?: Partial<{
    customerName: string | null;
    phone: string | null;
    address: string | null;
  }>;
}

/** Best-effort error log: a DB failure while writing the log itself must
 * never, ever fail the customer's turn (a 500 here = silent no-reply). */
async function insertErrorBestEffort(
  restaurantId: string,
  source: string,
  message: string,
  err?: unknown
): Promise<void> {
  try {
    await db.insert(errorLogs).values({
      id: newId(),
      restaurantId,
      source,
      message: `${source}: ${message}`,
      stack: err instanceof Error ? (err.stack ?? null) : null,
    });
  } catch {
    // Swallow — logging must not break the reply path.
  }
}

export async function handleIncomingMessage(
  input: IncomingMessageInput
): Promise<RunResult | null> {
  // Serialize concurrent messages from the same customer so they don't race.
  const lockKey = `${input.restaurantId}:${input.channel}:${input.remoteJid}`;
  return withConversationLock(lockKey, () => runIncomingMessage(input));
}

async function runIncomingMessage(
  input: IncomingMessageInput
): Promise<RunResult | null> {
  const t0 = Date.now();
  const step = (label: string) =>
    console.error(`[ENGINE] ${label} after ${Date.now() - t0}ms`);
  step("start");

  let profile: BusinessProfile | null = null;
  let profileErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      profile = await getBusiness(input.restaurantId);
      profileErr = null;
      break;
    } catch (err) {
      profileErr = err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (profileErr) {
    // DB unreachable/hiccup — reply gracefully instead of throwing (a 500
    // would reach the gateway and the customer would hear nothing at all).
    await insertErrorBestEffort(input.restaurantId, "agent", "db error at getBusiness", profileErr);
    return { replyText: DB_DOWN_REPLY, costUsd: 0, model: getAgentModel() };
  }
  if (!profile) {
    // Restaurant not found in DB (deleted / mismatched id) but the gateway
    // still holds a live session. MUST reply — an empty/null reply here turns
    // into a silent black hole on the WhatsApp side. Log it and send a graceful
    // fallback instead of null.
    await insertErrorBestEffort(input.restaurantId, "agent", "restaurant not found", new Error(`no restaurant row for ${input.restaurantId}`));
    return { replyText: GRACEFUL_FALLBACK, costUsd: 0, model: getAgentModel() };
  }
  if (!profile.restaurant.agentEnabled) {
    // Agent paused by the restaurant owner. Previously returned empty text,
    // which the gateway treated as "nothing to send" → silent no-reply. Reply
    // gracefully so the customer isn't left hanging.
    return {
      replyText:
        "عذراً، خدمة الطلبات متوقفة حالياً. تواصل مع المطعم مباشرة.",
      costUsd: 0,
      model: getAgentModel(),
    };
  }
  step("getBusiness");

  let transcription: string | null = null;
  let effectiveText = input.text ?? "";
  if (input.contentType === "voice") {
    try {
      transcription = await transcribeVoice(input);
    } catch {
      transcription = null;
    }
    effectiveText = transcription ?? input.text ?? "";
    if (transcription) {
      input.text = effectiveText;
    }
  }

  let conversation!: NonNullable<Awaited<ReturnType<typeof upsertConversation>>>;
  let earlyErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      conversation = await upsertConversation(
        input.restaurantId,
        input.channel,
        input.remoteJid,
        input.customerName
      );
      step("upsertConversation");

      await storeMessage({
        conversationId: conversation.id,
        direction: "in",
        contentType: input.contentType,
        text: input.text ?? null,
        mediaUrl: input.mediaUrl ?? null,
        mediaMime: input.mediaMime ?? null,
        transcription: input.contentType === "voice" ? transcription : null,
      });
      step("storeMessage");
      earlyErr = null;
      break;
    } catch (err) {
      earlyErr = err;
      // Transient egress/pooler blip — back off briefly and re-attempt once
      // (postgres.js reconnects a fresh socket on the retry).
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (earlyErr) {
    await insertErrorBestEffort(input.restaurantId, "agent", "db error storing incoming", earlyErr);
    return { replyText: DB_DOWN_REPLY, costUsd: 0, model: getAgentModel() };
  }

  const hasAI = isAIConfigured();
  let replyText = "";
  let costUsd = 0;
  const usedModel = getAgentModel();
  let usedKeyLabel: KeyLabel | undefined;

  // ONE cheap deterministic read of the recent log. It feeds (a) the compact
  // "conversation so far" context and (b) the order-intent gate — there is no
  // separate LLM classifier nor extractor, so a turn is exactly ONE request.
  let historyRows: { direction: string; text: string | null }[] = [];
  try {
    historyRows = await db
      .select({ direction: messages.direction, text: messages.text })
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY_LIMIT);
  } catch (err) {
    // A DB hiccup must not break the turn — reply from the current message.
    console.error("[ENGINE] history fetch failed — replying with current message only", err);
  }
  // Oldest → newest; drop the just-stored current message so it isn't seen
  // twice (it is sent as the live user message below).
  historyRows.reverse();
  historyRows.pop();
  const context = condenseMessages(historyRows);

  // The customer's phone comes from WhatsApp itself (sender number) — never
  // make the customer type it. The sender number is applied as the
  // AUTHORITATIVE phone on every completed order below (the owner verifies from
  // WhatsApp). Instagram: its remoteJid is an internal user ID, NOT a phone —
  // leave it to be asked there.
  const senderPhone =
    input.channel === "whatsapp" ? jidToPhone(input.remoteJid) : null;
  const effectiveContext: CondensedContext =
    context.phone || !senderPhone
      ? context
      : { ...context, phone: senderPhone };

  const orderIntent =
    ORDER_INTENT.test(effectiveText) ||
    (ORDER_CONFIRM.test(effectiveText) && context.hasOrderMaterial);

  // A NEW-order opener on a chat that already holds old order material. The
  // model must start from scratch (cleared context + note) instead of
  // confirming/re-pushing the previous order. (grep: user bug #2)
  const isOrderStart =
    ORDER_START.test(effectiveText) &&
    !ORDER_CONTINUE.test(effectiveText) &&
    context.hasOrderMaterial;
  // Items/address/total are wiped from the context handed to the model (phone
  // kept — it comes from the WhatsApp sender anyway). Old order state never
  // leaks into a fresh order.
  const clearedContext: CondensedContext | null =
    isOrderStart && context.hasOrderMaterial
      ? {
          ...context,
          items: [],
          total: null,
          address: null,
          hasOrderMaterial: false,
        }
      : null;
  const newOrderNote = clearedContext
    ? `Note for THIS turn only: the customer is STARTING a NEW order. Disregard any previous items, quantities, prices or address from earlier turns — this is a fresh order. Do NOT carry over, summarize or confirm the old one. Ask for the current items and the delivery address again.`
    : undefined;

  let sendMenuImages = false;
  const rawMenuImages = parseMenuImages(profile.restaurant.menuImages);
  const menuToggle =
    input.channel === "whatsapp"
      ? profile.restaurant.autoMenuWhatsapp
      : profile.restaurant.autoMenuInstagram;
  if (
    menuToggle &&
    rawMenuImages.length > 0 &&
    hasAI &&
    effectiveText.trim() !== "" &&
    !orderIntent
  ) {
    let alreadySentMenu = false;
    try {
      const lastOut = await first(
        db
          .select({ contentType: messages.contentType })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversation.id),
              eq(messages.direction, "out")
            )
          )
          .orderBy(desc(messages.createdAt))
          .limit(1)
      );
      alreadySentMenu = lastOut?.contentType === "image";
    } catch (err) {
      // DB hiccup while checking history — still answer; worst case the menu
      // pictures go out twice.
      await insertErrorBestEffort(input.restaurantId, "agent", "menu history read failed", err);
    }
    sendMenuImages = !alreadySentMenu;
  }

  // ── Standard-script turns are answered DETERMINISTICALLY so the scripted
  // Iraqi-dialect phrases don't depend on how today's model behaves. Greeting →
  // menu, menu request, order-status inquiry, and a clean "بيش <item>" price
  // lookup. Anything else falls through to the LLM below (which carries the
  // same script in its system prompt). ─────────────────────────────────────
  let cannedReply: string | null = null;
  if (input.contentType === "text" && effectiveText.trim() !== "") {
    const textNorm = effectiveText.trim();
    const menuText = profile.config.menu || "";
    const menuImagesPresent = rawMenuImages.length > 0;
    const hasMenu = menuText.trim() !== "" || menuImagesPresent;

    const greeting = textNorm.match(SCRIPT_GREETING);
    if (
      greeting &&
      hasMenu &&
      !context.hasOrderMaterial &&
      !ORDER_INTENT.test(textNorm.replace(SCRIPT_GREETING, "")) &&
      !SCRIPT_PRICE_ASK.test(textNorm.replace(SCRIPT_GREETING, "")) &&
      !SCRIPT_MENU_REQUEST.test(textNorm.replace(SCRIPT_GREETING, "")) &&
      !ORDER_CONFIRM.test(textNorm.replace(SCRIPT_GREETING, ""))
    ) {
      cannedReply = `وعليكم السلام، أهلاً بيك في ${profile.config.businessName || profile.restaurant.name}، تفضل هذا المنيو`;
      sendMenuImages = menuImagesPresent && sendMenuImages;
    }
    if (
      !cannedReply &&
      hasMenu &&
      SCRIPT_MENU_REQUEST.test(textNorm) &&
      !ORDER_INTENT.test(textNorm) &&
      !SCRIPT_PRICE_ASK.test(textNorm)
    ) {
      cannedReply = `هذا المنيو كامل عيني:\n\n${menuText.trim() || "تفضل صورة المنيو"}`;
      sendMenuImages = menuImagesPresent && sendMenuImages;
    }
    if (
      !cannedReply &&
      SCRIPT_STATUS_SUBJECT.test(textNorm) &&
      SCRIPT_STATUS_ASK.test(textNorm) &&
      !NOT_STATUS_REQUEST.test(textNorm)
    ) {
      cannedReply = "عيني، طلبك طلع من المطعم شوي ويصلك";
    }
    if (
      !cannedReply &&
      SCRIPT_PRICE_ASK.test(textNorm) &&
      !ORDER_INTENT.test(textNorm) &&
      !ORDER_CONFIRM.test(textNorm)
    ) {
      const found = findMenuPrice(textNorm, menuText);
      if (found) {
        cannedReply = `عيني، ${found.item} بـ ${found.priceText} دينار عراقي`;
      }
    }
  }
  if (cannedReply) {
    replyText = stripEmojis(cannedReply) || cannedReply;
  } else if (!hasAI || effectiveText.trim() === "") {
    replyText =
      "عذراً، أني ما قدرت أعالج رسالتك. ترجع ترسلها مرة ثانية؟";
  } else {
    try {
      const messagesList = await buildMessages(
        profile,
        input,
        context,
        sendMenuImages
          ? `Note for THIS reply only: you will also send the customer the menu pictures along with your text. Acknowledge in one short line that you are sending the menu, and do NOT repeat the whole menu in text.`
          : undefined,
        senderPhone,
        clearedContext,
        newOrderNote
      );
      const res = await completeWithFallback(
        {
          model: getAgentModel(),
          temperature: profile.config.temperature,
          messages: messagesList,
          max_tokens: MAX_REPLY_TOKENS,
        },
        { budgetMs: REPLY_BUDGET_MS, timeoutMs: REPLY_BUDGET_MS }
      );
      step("mainLLM");
      usedKeyLabel = res.keyLabel as KeyLabel | undefined;
      replyText = res.choices[0]?.message?.content?.trim() ?? "";
      // A "successful" call with an empty body is still a failed turn for the
      // customer — never leave the gateway with an empty reply (it currently
      // treats blank text + no images as "nothing to send" → silent no-reply).
      if (!replyText) {
        replyText = GRACEFUL_FALLBACK;
      }
      const usage = res.usage;
      const inTok = usage?.prompt_tokens ?? 0;
      const outTok = usage?.completion_tokens ?? 0;
      const audioSec = input.contentType === "voice" ? Math.max(1, Math.round((effectiveText.length ?? 0) / 15)) : 0;
      costUsd = estimateCostUsd(inTok, outTok, audioSec);

      // Usage/spend bookkeeping is best-effort: if the DB hiccups here, the
      // produced reply MUST still reach the customer (grep λ errors would
      // otherwise turn "reply ready" into "silence").
      try {
        await db
          .insert(usageLogs)
          .values({
            id: newId(),
            restaurantId: input.restaurantId,
            model: usedModel,
            keyLabel: usedKeyLabel ?? "",
            inputTokens: inTok,
            outputTokens: outTok,
            audioSeconds: audioSec,
            costUsd,
          });
        await db
          .update(restaurants)
          .set({ totalSpendUsd: sql`${restaurants.totalSpendUsd} + ${costUsd}` })
          .where(eq(restaurants.id, input.restaurantId));
      } catch (err) {
        await insertErrorBestEffort(input.restaurantId, "agent", "usage log write failed", err);
      }

      // Budget alerts are best-effort + non-blocking (throttled inside to one
      // DB sum per 5 min); a slow/errored check must never hold the reply.
      void maybeCheckSpendBudget().catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      replyText = GRACEFUL_FALLBACK;
      await insertErrorBestEffort(input.restaurantId, "agent", `model error: ${message}`, err);
    }
  }

  // The reply may carry one self-describing [ORDER_STATE] block: strip it from
  // the customer-facing text, but KEEP it in the stored log so the next turn
  // re-condenses it into the context without any extra LLM call.
  const rawReply = replyText;
  const parsedOrder = parseOrderBlock(rawReply);
  const cleanReply = stripOrderBlock(rawReply).trim();
  // Hard guarantee: no emojis reach the customer (the prompt alone is not
  // reliable on models). If stripping empties the reply, keep the original.
  if (cleanReply) replyText = stripEmojis(cleanReply) || cleanReply;

  // Deterministic closure so the Telegram push never depends on the model
  // remembering the [ORDER_STATE] format. Preference order:
  // 1) the block the model wrote this turn;
  // 2) parked in-context items when this turn carries order intent;
  // 3) the last block the bot itself stored, when the customer ONLY confirmed
  //    ("اوكي/زين") and no block came back — a stored-pending order must never
  //    be swallowed. A NEW-order opener (isOrderStart) never closes a previous
  //    order — it resets instead (see clearedContext above).
  let order: AgentOrderResult | null = parsedOrder;
  if (!order && !isOrderStart && orderIntent && context.hasOrderMaterial) {
    if (context.items.length > 0) {
      order = {
        ready: true,
        items: context.items,
        total:
          context.total ??
          context.items.reduce((s, i) => s + i.qty * i.price, 0),
        phone: effectiveContext.phone,
        address: effectiveContext.address,
        customerName: effectiveContext.customerName,
      };
    } else {
      const stored = await findLastStoredOrder(
        conversation.id,
        input.restaurantId
      );
      if (stored && stored.items.length > 0) {
        order = { ...stored, ready: true };
      }
    }
  }

  // WhatsApp: the sender's JID number is AUTHORITATIVE on every order turn —
  // any phone the model put in the block is overwritten with it (the owner
  // verifies delivery numbers straight from WhatsApp). Readiness is left
  // untouched: only the model's ready:true or the deterministic closure above
  // marks an order final.
  if (
    order &&
    order.items.length > 0 &&
    input.channel === "whatsapp" &&
    senderPhone
  ) {
    order = { ...order, phone: senderPhone };
  }

  // Fill a remaining phone gap on finalized orders (Instagram typed number, or
  // WhatsApp when the sender's JID carried none). NEVER force a blocked/open
  // order to ready:true — only the model's ready flag or the deterministic
  // closure above may finalize an order, or a half-collected order would be
  // pushed to Telegram mid-conversation.
  if (
    order &&
    order.items.length > 0 &&
    order.ready === true &&
    !order.phone &&
    effectiveContext.phone
  ) {
    order = { ...order, phone: effectiveContext.phone };
  }

  // Honor the model's own ready intent even when a missing phone made the
  // sanitizer drop it — a confirmed order is confirmed, just without a
  // callable number (privacy/lid JIDs). Loudly warn ops instead of silently
  // swallowing the push.
  if (order && order.items.length > 0 && parsedOrder?.rawReady === true) {
    order = { ...order, ready: true };
  }
  if (order && order.ready && !order.phone) {
    await insertErrorBestEffort(
      input.restaurantId,
      "telegram",
      `confirmed order pushed WITHOUT a phone (WhatsApp JID exposes no number: ${input.remoteJid})`
    );
  }

  if (rawReply && rawReply.trim() !== "") {
    try {
      await db
        .insert(messages)
        .values({
          id: newId(),
          conversationId: conversation.id,
          direction: "out",
          contentType: "text",
          text: rawReply,
          status: "sent",
        });
    } catch (err) {
      // The reply already succeeded from the AI side — a store failure must
      // not turn a working turn into a silent 500.
      await insertErrorBestEffort(input.restaurantId, "agent", "reply store failed", err);
    }
  }

  const menuImages: MenuImage[] = [];
  if (sendMenuImages) {
    const appBase = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const base = new Date().getTime();
    for (let i = 0; i < rawMenuImages.length; i++) {
      const img = rawMenuImages[i];
      if (!img.base64) continue;
      const url = `${appBase}/api/media/${profile.restaurant.id}/${img.id}`;
      menuImages.push({
        id: img.id,
        mime: img.mime,
        base64: img.base64,
        url,
      });
      try {
        await db.insert(messages).values({
          id: newId(),
          conversationId: conversation.id,
          direction: "out",
          contentType: "image",
          mediaUrl: url,
          mediaMime: img.mime,
          status: "sent",
          createdAt: new Date(base + i + 1),
        });
      } catch (err) {
        await insertErrorBestEffort(input.restaurantId, "agent", "menu image store failed", err);
      }
    }
  }

  if (conversation.status === "manual") {
    // A human has taken over this chat in the dashboard. Deliberately do NOT
    // auto-reply here — the `silent` flag tells the gateway to stand down
    // (no fallback) rather than auto-replying as the bot.
    return {
      replyText: "",
      silent: true,
      costUsd,
      model: usedModel,
      transcription,
      order: null,
      menuImages,
    };
  }

  // Push every CONFIRMED order (date + order + address) to the restaurant's
  // Telegram bot, and log it so any user who messages the bot can read it.
  // There is deliberately NO once-per-conversation gate: a returning customer's
  // NEXT order must also reach Telegram (the old status == order_pending guard
  // silently swallowed every later order from the same customer). Re-echo
  // protection instead dedups against the most recent push — same restaurant + 
  // phone + total + items within 5 minutes — because some models re-emit the
  // [ORDER_STATE] block on no-op turns, which would otherwise spam Telegram
  // with the same order twice. Runs under `after()` (post-response) so it gets
  // the route's full 60s maxDuration instead of the shrinking handler deadline.
  // The callback MUST return the awaited promise: an un-awaited floating
  // promise lets Next consider `after` done instantly and the lambda is torn
  // down before the insert+send completes.
  if (order && order.ready) {
    const fingerprint = orderFingerprint(order);
    let duplicate = false;
    try {
      const cutoff = new Date(Date.now() - 5 * 60_000);
      const recent = await db
        .select({
          total: telegramOrderDeliveries.total,
          itemsJson: telegramOrderDeliveries.itemsJson,
        })
        .from(telegramOrderDeliveries)
        .where(
          and(
            eq(telegramOrderDeliveries.restaurantId, input.restaurantId),
            order.phone
              ? eq(telegramOrderDeliveries.phone, order.phone)
              : undefined,
            gte(telegramOrderDeliveries.requestedAt, cutoff)
          )
        )
        .orderBy(desc(telegramOrderDeliveries.requestedAt))
        .limit(3);
      duplicate = recent.some(
        (r) => r.itemsJson && sameFingerprint(r.itemsJson, r.total, order)
      );
    } catch (err) {
      // A dedup probe must never block the push — better a rare duplicate than
      // a swallowed confirmed order.
      await insertErrorBestEffort(input.restaurantId, "telegram", "order dedup probe failed", err);
    }
    if (duplicate) {
      await insertErrorBestEffort(
        input.restaurantId,
        "telegram",
        `duplicate order push skipped (${fingerprint})`
      );
    } else {
      try {
        await db
          .update(conversations)
          .set({ status: "order_pending" })
          .where(eq(conversations.id, conversation.id));
      } catch (err) {
        await insertErrorBestEffort(input.restaurantId, "agent", "order status update failed", err);
      }
      after(async () => {
        try {
          await withDeadline(notifyTelegramOrder(input.restaurantId, order), 20_000);
        } catch (err) {
          await insertErrorBestEffort(input.restaurantId, "telegram", "notifyTelegramOrder failed", err);
        }
      });
    }
  }

  // Structured outcome log — lets ops diagnose intermittent failures from logs
  // without scraping: did we produce a reply, how long did it take, which
  // provider/model served it, and which fallback (if any) fired.
  console.error(
    `[ENGINE-END] ${input.restaurantId} ${input.channel}/${input.remoteJid} ` +
      `elapsed=${Date.now() - t0}ms hasReply=${replyText ? true : false} ` +
      `replyLen=${replyText.length} model=${usedModel} cost=${costUsd.toFixed(4)} ` +
      `fallback=${replyText === GRACEFUL_FALLBACK || replyText === DB_DOWN_REPLY ? "yes" : "no"}`
  );

  return {
    replyText,
    transcription,
    order,
    costUsd,
    model: usedModel,
    menuImages,
  };
}

export async function markOutgoingFailed(
  restaurantId: string,
  conversationId: string,
  error: string
): Promise<void> {
  await db
    .insert(errorLogs)
    .values({
      id: newId(),
      restaurantId,
      source: "gateway",
      message: error,
    });
  const lastOut = await first(
    db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.direction, "out")
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(1)
  );
  if (lastOut) {
    await db
      .update(messages)
      .set({ status: "failed", error })
      .where(eq(messages.id, lastOut.id));
  }
}