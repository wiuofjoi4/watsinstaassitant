import OpenAI from "openai";
import { after } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentConfigs,
  conversations,
  errorLogs,
  messages,
  restaurants,
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
  getProvider,
  getWhisperClient,
  isAIConfigured,
  TRANSCRIBE_MODEL,
  type KeyLabel,
} from "@/lib/ai/client";

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
// reply. Every LLM call is bounded individually and the handler tracks one
// overall deadline. These are deliberately below the gateway's own 55s
// platform call timeout so the gateway always gets a reply (or aborts) BEFORE
// the lambda is killed — never a silent gap.
const REPLY_BUDGET_MS = 12_000;
const SIDE_BUDGET_MS = 4_000;
const TRANSCRIBE_TIMEOUT_MS = 10_000;
const HANDLER_DEADLINE_MS = 35_000;

// Graceful Iraqi-dialect fallback for a confirmed customer-facing error. The
// CUSTOMER must see this instead of silence or a raw technical string.
const GRACEFUL_FALLBACK =
  "عذراً صار خلل بسيط، جرب مرة ثانية بعد شوي 🙏";
// Used when the DB is unreachable — same graceful tone, distinct wording so
// ops can tell the two apart in logs without the customer seeing anything raw.
const DB_DOWN_REPLY =
  "عذراً صار تعطل بسيط بالخادم، كرر رسالتك بعد دقيقة 🙏";

// --- Per-conversation request locking (race conditioning) ---
// Two rapid messages from the same customer can hit different Vercel lambda
// instances and run handleIncomingMessage concurrently, causing interleaved /
// duplicated AI replies and overwritten state. We serialize per
// (restaurant + channel + remoteJid) so messages are processed in order.
const conversationLocks = new Map<string, Promise<unknown>>();
const conversationLockSeen = new Map<string, number>();

async function withConversationLock<T>(
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = conversationLocks.get(key) ?? Promise.resolve();
  // Chain onto the previous worker whether it succeeded or failed; the next
  // message is NOT skipped just because the prior one errored.
  const next = prev.then(fn, fn);
  conversationLocks.set(key, next.then(() => undefined, () => undefined));
  conversationLockSeen.set(key, Date.now());

  // Bounded memory: every ~200 messages, drop locks not touched in 10 minutes.
  if (conversationLocks.size > 2048) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, last] of conversationLockSeen) {
      if (last < cutoff) {
        conversationLocks.delete(k);
        conversationLockSeen.delete(k);
      }
    }
  }
  return next;
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

function toHistory(rows: { direction: string; text: string | null }[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  for (const row of rows) {
    if (!row.text) continue;
    history.push(
      row.direction === "in"
        ? { role: "user", content: row.text }
        : { role: "assistant", content: row.text }
    );
  }
  return history;
}

async function buildMessages(
  profile: BusinessProfile,
  conversationId: string,
  input: IncomingMessageInput,
  menuNote?: string
): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
  // History is a NICETY, not a hard dependency. If the DB hiccups here, reply
  // from the current message only — never throw (a throw lands in the AI catch
  // and the customer gets the "try again" apology even though the AI works).
  let historyRows: { direction: string; text: string | null }[] = [];
  try {
    historyRows = await db
      .select({ direction: messages.direction, text: messages.text })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY_LIMIT);
  } catch (err) {
    console.error("[ENGINE] history fetch failed — replying with current message only", err);
  }

  // Oldest → newest. The last element is the just-stored *incoming* message
  // (stored by this turn in handleIncomingMessage before buildMessages runs).
  // We drop it from the assistant history so the current user message is NOT
  // duplicated — otherwise the model sees the same input twice back-to-back,
  // which garbles role alternation and skews the reply/dialect.
  const history = historyRows.reverse();
  history.pop();
  const historyMessages = toHistory(history);

  const systemPrompt =
    (profile.config.systemPrompt || buildSystemPrompt(profile)) +
    (menuNote ? `\n\n${menuNote}` : "");
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
    ...historyMessages,
    { role: "user", content },
  ];
}

// Cheap heuristic to skip the extractOrder LLM call when the message clearly
// isn't an order — halves quota burn on casual chat (free-tier Gemini quota
// exhaustion is the #1 cause of the "try again" apology, so every saved call
// keeps the quota alive for real replies).
const ORDER_HINT =
  /[أا]طل[بب]|وج[بب][ةه]|عشا|غدا|فط[وو]|[أا]كل|شاورما|برجر|باستا|بيزا|كبس|مندي|عدس|سل[ةط]|مشروب|عصير|كولا|ذبيح|منيو[ق]?|توصيل|عنوان|نمر[ية]|رقم/;

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

async function extractOrder(
  profile: BusinessProfile,
  conversationId: string
): Promise<AgentOrderResult | null> {
  const historyRows = await db
    .select({ direction: messages.direction, text: messages.text })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(30);
  const historyMessages = toHistory(historyRows.reverse());

  const payload = JSON.stringify({
    ready: false,
    items: [],
    total: null,
    phone: null,
    address: null,
    customerName: null,
  });

  try {
    const res = await completeWithFallback(
      {
        model: getAgentModel(),
        temperature: 0,
        response_format: getProvider() === "openrouter" ? undefined : { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              `You extract order details from a restaurant customer conversation.`,
              `Only set "ready" to true when items AND the customer's phone are confirmed.`,
              `Return strictly this JSON shape: ${payload}`,
              `"items" is an array of {name: string, qty: number, price: number}. Use the menu prices above; if unsure, keep the products the customer agreed on and price=0.`,
              `"total" is the sum. "phone" and "address" may be null if not mentioned.`,
            ].join("\n"),
          },
          ...historyMessages,
        ],
      },
      { budgetMs: SIDE_BUDGET_MS, timeoutMs: SIDE_BUDGET_MS + 2_000 }
    );
    const raw = res.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw.startsWith("```") ? raw.replace(/```json|```/g, "").trim() : raw) as AgentOrderResult;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function isOrderMessage(
  profile: BusinessProfile,
  conversationId: string,
  currentText: string
): Promise<boolean> {
  const trimmed = currentText.trim();
  if (!trimmed) return false;

  const historyRows = await db
    .select({ direction: messages.direction, text: messages.text })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(14);
  const historyMessages = toHistory(historyRows.reverse()).slice(-10);

  try {
    const res = await completeWithFallback(
      {
        model: getAgentModel(),
        temperature: 0,
        response_format: getProvider() === "openrouter" ? undefined : { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              `You classify a restaurant customer's latest message.`,
              `"isOrder": true only when the customer is requesting to PURCHASE/ORDER food items now (e.g. "أريد 2 شاورما", "أبغى برغر كبير", "اطلب لي كولا", "نعم أريد أن أطلب").`,
              `"isOrder": false for questions and small talk (e.g. "مرحبا", "عندكم منيو؟", "كم سعر الشاورما؟", "وش تعملون؟").`,
              `Reply only with JSON: {"isOrder": true or false}.`,
            ].join("\n"),
          },
          ...historyMessages,
          { role: "user", content: trimmed },
        ],
      },
      { budgetMs: SIDE_BUDGET_MS, timeoutMs: SIDE_BUDGET_MS + 2_000 }
    );
    const raw = res.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(
      raw.startsWith("```") ? raw.replace(/```json|```/g, "").trim() : raw
    ) as { isOrder?: boolean };
    return parsed.isOrder === true;
  } catch {
    return false;
  }
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
        "عذراً، خدمة الطلبات متوقفة حالياً. تواصل مع المطعم مباشرة 🙏",
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
  const deadline = Date.now() + HANDLER_DEADLINE_MS;
  let replyText = "";
  let costUsd = 0;
  const usedModel = getAgentModel();
  let usedKeyLabel: KeyLabel | undefined;
  let extractPromise: Promise<AgentOrderResult | null> | null = null;

  let sendMenuImages = false;
  const rawMenuImages = parseMenuImages(profile.restaurant.menuImages);
  const menuToggle =
    input.channel === "whatsapp"
      ? profile.restaurant.autoMenuWhatsapp
      : profile.restaurant.autoMenuInstagram;
  if (menuToggle && rawMenuImages.length > 0 && hasAI) {
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
    if (!alreadySentMenu && effectiveText.trim() !== "") {
      // Bounded classifier — never blocks the reply beyond a few seconds even
      // if the AI is slow or on quota.
      const isOrder = await withDeadline(
        isOrderMessage(profile, conversation.id, effectiveText),
        Math.min(SIDE_BUDGET_MS, Math.max(0, deadline - Date.now()))
      ).catch(() => null);
      step("isOrderMessage");
      sendMenuImages = isOrder !== true;
    }
  }

  if (!hasAI || effectiveText.trim() === "") {
    replyText =
      "عذراً، أني ما قدرت أعالج رسالتك. ترجع ترسلها مرة ثانية؟ 😊";
  } else {
    // extractOrder is a third LLM call of a turn: run it in parallel with the
    // main reply (both only read history) so a real order still fits inside
    // the 60s function budget. Skip it when the menu classifier already ruled
    // out an order, the human is handling the chat, OR the text is a casual
    // greeting that clearly holds no order (saves quota on the free tier).
    const orderHint =
      ORDER_HINT.test(effectiveText) ||
      input.contentType === "voice" ||
      input.contentType === "image";
    const canExtract =
      conversation.status !== "manual" &&
      !(menuToggle && sendMenuImages) &&
      orderHint;
    extractPromise = canExtract
      ? extractOrder(profile, conversation.id).catch(() => null)
      : null;
    try {
      const messagesList = await buildMessages(
        profile,
        conversation.id,
        input,
        sendMenuImages
          ? `Note for THIS reply only: you will also send the customer the menu pictures along with your text. Acknowledge in one short line that you are sending the menu, and do NOT repeat the whole menu in text.`
          : undefined
      );
      const res = await completeWithFallback(
        {
          model: getAgentModel(),
          temperature: profile.config.temperature,
          messages: messagesList,
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
        replyText = "عذراً صار خلل بسيط، جرب مرة ثانية بعد شوي 🙏";
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      replyText =
        "عذراً صار خلل بسيط، جرب مرة ثانية بعد شوي 🙏";
      await insertErrorBestEffort(input.restaurantId, "agent", `model error: ${message}`, err);
    }
  }

  if (replyText) {
    try {
      await db
        .insert(messages)
        .values({
          id: newId(),
          conversationId: conversation.id,
          direction: "out",
          contentType: "text",
          text: replyText,
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

  // Ride the parallel extraction (launched alongside the main reply). Manually
  // handled conversations return early above and never reach this point. The
  // wait is bounded by the handler deadline so extraction can never push the
  // webhook past its Vercel budget — the customer reply already succeeded.
  const order = extractPromise
    ? await withDeadline(
        extractPromise,
        Math.min(SIDE_BUDGET_MS, Math.max(0, deadline - Date.now()))
      ).catch(() => null)
    : null;
  step("extractOrder");
  if (order && order.ready) {
    try {
      await db
        .update(conversations)
        .set({ status: "order_pending" })
        .where(eq(conversations.id, conversation.id));
    } catch (err) {
      await insertErrorBestEffort(input.restaurantId, "agent", "order status update failed", err);
    }
    // Push the confirmed order (date + order + address) to the restaurant's
    // Telegram bot, and log it so any user who messages the bot can read it.
    // Runs under `after()` (post-response) so it gets the route's full 60s
    // maxDuration instead of the shrinking handler deadline — a slow/cold DB
    // insert previously left deliveries stranded with no Telegram message and
    // no log. Failures are logged (see notifyTelegramOrder) and re-logged here.
    after(() => {
      withDeadline(notifyTelegramOrder(input.restaurantId, order), 20_000).catch((err) =>
        insertErrorBestEffort(input.restaurantId, "telegram", "notifyTelegramOrder failed", err)
      );
    });
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